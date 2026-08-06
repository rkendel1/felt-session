/**
 * Run-host protocol: the wire contract between a detached run-host process
 * (the reference implementation: src/runner-host/host.ts) and the Open Session
 * server (src/server/host-client.ts).
 *
 * A run host is a small standalone process that owns ONE agent run (the
 * engine driver plus its CLI child). It is spawned OUTSIDE the server's
 * process group, so a server restart — graceful or crash — never touches the
 * run. The server connects to the host's unix socket as a client; if the
 * server goes down mid-run, the host keeps working and the new server
 * process reattaches to the same socket.
 *
 * Framing: newline-delimited JSON, both directions. JSON.stringify never emits
 * raw newlines, so a line is always exactly one message.
 *
 * The UNIX-SOCKET stream is LIVE-ONLY by design — no event replay. A
 * reattaching server missed some stream events, but the transcript jsonl on
 * disk is the durable copy (viewers re-sync from it on watch), and everything
 * else a consumer needs to catch up is carried in `hello`: the engine session
 * id, any asks still blocked waiting for a human, and the terminal event if
 * the run already ended. The WS transport (remote sandboxes) layers seq/ack
 * replay on top — see `seq` below and src/runner-host/ws-buffer.ts — because
 * there the transcript is NOT host-visible, so a flaky link would otherwise
 * lose mid-run events for good.
 */
import type { StreamEvent, ImageInput } from "./events";
import type { GitIdentity } from "./identity";

/**
 * What MCP surface a run gets. There is no implicit default: `"all"` is a
 * decision a caller has to write down, exactly like an allowlist is.
 *
 * This used to be `string[] | undefined`, where omitting the field meant every
 * configured connector. That default is how the github PR flows silently
 * mounted ~430 external tool schemas on 1,410 sessions to serve the ~20 that
 * ever called one (2026-08-03) — nobody chose it, they just didn't pass the
 * argument. Spelling `"all"` out costs a caller five characters and makes the
 * wide grant reviewable in a diff.
 *
 * `[]` is a third, distinct meaning: no external servers at all.
 */
export type McpScope = "all" | string[];

/** Everything a host needs to drive one run — a serializable RunAgentOpts. */
export interface RunHostSpec {
  hostId: string;
  /** Open Session session this run belongs to (busy/steer/cancel key, journal). */
  osSessionId: string;
  prompt: string;
  /** Engine session id to resume (claude session id / codex thread id). */
  engineSessionId?: string;
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  /** MCP OAuth identity: the session creator (see agent-runner RunAgentOpts). */
  mcpGrantUser?: string;
  model?: string;
  selectedModel?: string;
  transientFallback?: boolean;
  images?: ImageInput[];
  forkSession?: boolean;
  resumeSessionAt?: string;
  /** MCP scope for the run: an allowlist, [] for none, or "all". Optional
   *  for back-compat with specs sent before McpScope; absent reads as "all". */
  mcpServers?: McpScope;
  /**
   * opensession-* in-process servers to expose via the RPC proxy (mcp-proxy.ts →
   * opensession-rpc.sock). Names must match what the server-side builder
   * produces for this session. Empty/omitted for automation-owned sessions.
   */
  proxyMcpServers?: string[];
  /** Per-run bearer for the RPC socket; maps to {sessionId, user} on the server side. */
  rpcToken?: string;
  /**
   * Per-run bearer for the WS transport (Phase 3). Present = this run's host
   * dials the server's run-ws WS route (/opensession/run-ws/<hostId>; the
   * /backstage/* form is the legacy alias) instead of serving a
   * unix socket in its run dir; the launcher passes it to the host process as
   * OPENSESSION_RUN_WS_TOKEN and registers it (keyed by hostId) so the route can
   * validate the dial-back. Persisted in spec.json so a restarted server
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
 *  rebooting server reads to decide reattach vs finish vs resume. */
export interface RunHostMeta {
  hostId: string;
  pid: number;
  osSessionId: string;
  startedAt: string;
  engineSessionId?: string;
  selectedModel?: string;
  effectiveModel?: string;
  transientFallback?: boolean;
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
      osSessionId: string;
      engineSessionId?: string;
      /** "ended" = run finished while nobody was attached; `done` has the terminal event. */
      state: "running" | "ended";
      pendingAsks: PendingAskView[];
      selectedModel?: string;
      effectiveModel?: string;
      transientFallback?: boolean;
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
   * WS-transport keepalive (host → server every 30s). A unix socket never
   * idles out, but WS intermediaries (and Bun.serve's per-socket idle timer)
   * close quiet connections — e.g. during a minutes-long tool call with no
   * stream events. Answered with `pong`; the socket transport never sends it.
   */
  | { t: "ping" }
  /**
   * WS transport only: the host's replay buffer overflowed while the server
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
 *
 * Buffers BYTES, not a string. Decoding each chunk on arrival splits multi-byte
 * UTF-8 sequences at chunk boundaries — the socket cuts wherever it likes — and
 * each half decodes to U+FFFD, so `café` arrived as `caf<?><?>` and any line
 * carrying non-ASCII was silently corrupted (or dropped, when the replacement
 * chars landed inside JSON syntax). Accumulating the raw bytes and decoding
 * once per complete line makes the boundary invisible. Scanning each chunk from
 * where the last line ended also keeps a line assembled from many chunks linear
 * rather than re-scanning the whole pending buffer per chunk.
 */
export function ndjsonReader(
  onMsg: (msg: any) => void,
  label: string
): (data: Buffer | string) => void {
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  const emit = (line: Buffer) => {
    const text = line.toString();
    if (!text.trim()) return;
    try {
      onMsg(JSON.parse(text));
    } catch (e) {
      console.error(`[${label}] dropping malformed NDJSON line:`, e);
    }
  };
  return (data) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) {
        if (start < chunk.length) {
          const fragment = Buffer.from(chunk.subarray(start));
          fragments.push(fragment);
          fragmentBytes += fragment.length;
        }
        return;
      }
      const tail = chunk.subarray(start, newline);
      if (fragments.length) {
        const line = Buffer.concat([...fragments, tail], fragmentBytes + tail.length);
        fragments = [];
        fragmentBytes = 0;
        emit(line);
      } else {
        emit(tail);
      }
      start = newline + 1;
    }
  };
}

/** Root of all run-host dirs: one subdir per host with spec/meta/journal/sock/log. */
export function runHostsDir(sessionsDir: string): string {
  return `${sessionsDir}/run-hosts`;
}

export const HOST_SOCK_NAME = "host.sock";
export const HOST_SPEC_NAME = "spec.json";
export const HOST_META_NAME = "meta.json";
export const HOST_JOURNAL_NAME = "journal.json";
export const HOST_LOG_NAME = "host.log";

/** The server-side RPC socket the mcp-proxy talks to. Stable path (the
 *  literal filename is historical — a wire constant, not branding). */
export function rpcSocketPath(sessionsDir: string): string {
  return `${sessionsDir}/opensession-rpc.sock`;
}
