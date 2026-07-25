/**
 * Run-host protocol: the wire contract between a detached run-host process
 * (src/runner-host/host.ts) and the backstage server (src/server/host-client.ts).
 *
 * A run host is a small standalone bun process that owns ONE agent run (the
 * Claude/Codex SDK driver plus its CLI child). It is spawned as a transient
 * systemd unit OUTSIDE the backstage.service cgroup, so a backstage restart —
 * graceful or crash — never touches the run. Backstage connects to the host's
 * unix socket as a client; if backstage goes down mid-run, the host keeps
 * working and the new backstage process reattaches to the same socket.
 *
 * Framing: newline-delimited JSON, both directions. JSON.stringify never emits
 * raw newlines, so a line is always exactly one message.
 *
 * The UNIX-SOCKET stream is LIVE-ONLY by design — no event replay. A
 * reattaching backstage missed some stream events, but the transcript jsonl on
 * disk is the durable copy (viewers re-sync from it on watch), and everything
 * else a consumer needs to catch up is carried in `hello`: the engine session
 * id, any asks still blocked waiting for a human, and the terminal event if
 * the run already ended. The WS transport (remote sandboxes) layers seq/ack
 * replay on top — see `seq` below and src/runner-host/ws-buffer.ts — because
 * there the transcript is NOT host-visible, so a flaky link would otherwise
 * lose mid-run events for good.
 */

import type { StreamEvent, ImageInput } from "../server/run-events";
import type { GitIdentity } from "../server/shared/user-mappings";

/** Everything a host needs to drive one run — a serializable RunAgentOpts. */
export interface RunHostSpec {
  hostId: string;
  /** Backstage session this run belongs to (busy/steer/cancel key, journal). */
  bksSessionId: string;
  prompt: string;
  /** Engine session id to resume (claude session id / codex thread id). */
  engineSessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  model?: string;
  images?: ImageInput[];
  forkSession?: boolean;
  resumeSessionAt?: string;
  /** mcp-config.json allowlist (automation scoping); omitted = all servers. */
  mcpServers?: string[];
  /**
   * opensession-* in-process servers to expose via the RPC proxy (mcp-proxy.ts →
   * backstage-rpc.sock). Names must match what the backstage-side builder
   * produces for this session. Empty/omitted for automation-owned sessions.
   */
  proxyMcpServers?: string[];
  /** Per-run bearer for the RPC socket; maps to {sessionId, user} on the backstage side. */
  rpcToken?: string;
  /**
   * Per-run bearer for the WS transport (Phase 3). Present = this run's host
   * dials backstage's /backstage/run-ws/<hostId> WS route instead of serving a
   * unix socket in its run dir; the launcher passes it to the host process as
   * BKS_RUN_WS_TOKEN and registers it (keyed by hostId) so the route can
   * validate the dial-back. Persisted in spec.json so a restarted backstage
   * re-registers it on reattach (the host's WS reconnect must keep working).
   */
  wsToken?: string;
  reposNote?: string;
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  aws?: boolean;
  author?: GitIdentity | null;
  user?: string;
  fallbackModel?: string;
  /** Reasoning effort for the run (UI scale; each runner normalizes it). */
  effort?: string;
  /** OpenAI priority service tier for ChatGPT OAuth Codex runs. */
  fastMode?: boolean;
  /** Pinned account in the active model provider's pool; pool fallback applies. */
  accountId?: string;
  /** Hard accountId pin — never rotate into the shared pool (cost cap). */
  accountStrict?: boolean;
  /** Allow accounts spending usage-credits past their subscription limits. */
  usageCredits?: boolean;
  journalKind?: string;
}

/** Mutable host state, persisted to meta.json in the host dir. This is what a
 *  rebooting backstage reads to decide reattach vs finish vs resume. */
export interface RunHostMeta {
  hostId: string;
  pid: number;
  bksSessionId: string;
  startedAt: string;
  engineSessionId?: string;
  /** Terminal done/error StreamEvent once the run generator finished. */
  done?: StreamEvent;
  endedAt?: string;
}

export interface PendingAskView {
  askId: string;
  input: Record<string, unknown>;
}

export type AskResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * WS transport only: host→server frames (except `hello`/`ping`, which are
 * per-connection transport chatter) carry a monotonic per-host `seq`. The
 * server acks its consumed watermark and dedupes replayed frames by it; the
 * unix-socket transport never sets it. See src/runner-host/ws-buffer.ts.
 */
export type HostToClientMsg = HostToClientPayload & { seq?: number };

type HostToClientPayload =
  | {
      t: "hello";
      hostId: string;
      pid: number;
      bksSessionId: string;
      engineSessionId?: string;
      /** "ended" = run finished while nobody was attached; `done` has the terminal event. */
      state: "running" | "ended";
      pendingAsks: PendingAskView[];
      done?: StreamEvent;
    }
  | { t: "event"; event: StreamEvent }
  | { t: "ask"; askId: string; input: Record<string, unknown> }
  /**
   * A steer/interrupt_steer arrived too late (run already finishing, or the
   * backend doesn't support steering). The client should queue the text for
   * delivery after the run instead — never drop a user's message.
   */
  | { t: "steer_failed"; text: string }
  /** Run generator finished; meta.done is written. Client should ack with shutdown. */
  | { t: "end"; done?: StreamEvent }
  /**
   * WS-transport keepalive (host → backstage every 30s). A unix socket never
   * idles out, but WS intermediaries (and Bun.serve's per-socket idle timer)
   * close quiet connections — e.g. during a minutes-long tool call with no
   * stream events. Answered with `pong`; the socket transport never sends it.
   */
  | { t: "ping" }
  /**
   * WS transport only: the host's replay buffer overflowed while backstage
   * was unreachable — frames `from..to` are gone from the stream (the
   * transcript jsonl still has everything). Sent once at replay time; the
   * server logs it.
   */
  | { t: "gap"; from: number; to: number };

export type ClientToHostMsg =
  | { t: "ask_answer"; askId: string; result: AskResult }
  | { t: "steer"; text: string }
  | { t: "interrupt_steer"; text: string }
  | { t: "cancel" }
  /** Ack of `end`: everything consumed, host may exit and the client cleans up the dir. */
  | { t: "shutdown" }
  /** WS keepalive answer (see `ping`). */
  | { t: "pong" }
  /**
   * WS transport only: server→host consumed-watermark ack (sent on socket
   * open, then periodically). `epoch` identifies the server-side seq record —
   * the host only replays into a matching epoch (src/runner-host/ws-buffer.ts).
   */
  | { t: "ack"; seq: number; epoch: string };

/**
 * Line-buffered NDJSON reader. Feed it raw socket chunks; it invokes onMsg per
 * complete JSON line. Malformed lines are logged and skipped (a torn line can
 * only happen on a crash mid-write, and losing one message beats killing the
 * connection).
 */
export function ndjsonReader(
  onMsg: (msg: any) => void,
  label: string
): (data: Buffer | string) => void {
  let buf = "";
  return (data) => {
    buf += data.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMsg(JSON.parse(line));
      } catch (e) {
        console.error(`[${label}] dropping malformed NDJSON line:`, e);
      }
    }
  };
}

const HOME = process.env.HOME || "/home/ubuntu";

/** Root of all run-host dirs: one subdir per host with spec/meta/journal/sock/log. */
export function runHostsDir(chatsDir: string): string {
  return `${chatsDir}/run-hosts`;
}

export const HOST_SOCK_NAME = "host.sock";
export const HOST_SPEC_NAME = "spec.json";
export const HOST_META_NAME = "meta.json";
export const HOST_JOURNAL_NAME = "journal.json";
export const HOST_LOG_NAME = "host.log";

/** The backstage-side RPC socket the mcp-proxy talks to. Stable path. */
export function rpcSocketPath(chatsDir: string): string {
  return `${chatsDir}/backstage-rpc.sock`;
}

/** Absolute paths of the host/proxy entrypoints and the bun binary, for spawning. */
export const BUN_BIN = `${HOME}/.bun/bin/bun`;
export const REPO_ROOT = `${HOME}/projects/tella-backstage`;
export const HOST_ENTRY = `${REPO_ROOT}/src/runner-host/host.ts`;
export const MCP_PROXY_ENTRY = `${REPO_ROOT}/src/runner-host/mcp-proxy.ts`;
