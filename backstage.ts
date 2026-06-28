#!/usr/bin/env bun

import { randomUUIDv7 } from "bun";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import homepage from "./src/frontend/index.html";
import { getAllSessions, deleteSession } from "./src/server/sessions";
import { parseTranscript } from "./src/server/jsonl-parser";
import { startWatching, stopAllWatchesForClient } from "./src/server/file-watcher";
import { listWorktrees, createWorktree, removeWorktree, reviveWorktree, sweepArchivedWorktrees } from "./src/server/worktree";
import { STRIPE_CONFIRM_TOOLS } from "./src/server/claude-runner";
import {
  runAgent,
  isAgentSessionBusy,
  cancelAgentRun,
  steerAgentRun,
  interruptAndSteerAgentRun,
  resumeInterruptedRuns,
  activeAgentRunCount,
} from "./src/server/agent-runner";
import type { ImageInput } from "./src/server/claude-runner";
import {
  KNOWN_MODELS,
  getDefaultModel,
  setDefaultModel,
  resolveModel,
  providerFor,
  modelLabel,
  formatModelList,
} from "./src/server/models";
import {
  listCodexAccountsPublic,
  addCodexAccount,
  removeCodexAccount,
} from "./src/server/codex-accounts";
import { getSessionDiff } from "./src/server/git-diff";
import {
  registerSessionControl,
  type SessionState,
  type SessionSummary,
} from "./src/server/session-control";
import { gitIdentityFor } from "./src/server/shared/user-mappings";
import { createSessionsMcpServer } from "./src/agents/slack/sessions-tools";
import { createAdminMcpServer } from "./src/agents/slack/admin-tools";
import { getPrDetails, getPrDiff, postPrComment } from "./src/server/pr-info";
import {
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomation,
  isAutomationRunning,
  startScheduler,
  getWebhookRoutes,
  setEventSessionCallback,
  automationDeniedTools,
  automationMcpServersByName,
} from "./src/server/automations";
import { getWikiTree, getWikiFile, searchWiki } from "./src/server/wiki";
import { startPlainArchiveSweep } from "./src/server/plain-archive";
import { setArchived, archiveOlderThan } from "./src/server/archive";
import { getConnections, addMcpServer, removeMcpServer } from "./src/server/connections";
import {
  listAccountsPublic,
  addAccount,
  removeAccount,
  refreshAllUsage,
  startUsagePoller,
} from "./src/server/claude-accounts";
import { startWebhookServer } from "./src/server/webhook-server";
import type { AgentModule } from "./src/agents/types";
import type { UnifiedSession, BackstageSessionFile } from "./src/server/types";

const PORT = parseInt(process.env.PORT || "3850");
const HOST = process.env.HOST || "127.0.0.1";
const HOME = process.env.HOME || "/home/ubuntu";
const BACKSTAGE_SESSIONS_DIR = `${HOME}/.backstage-sessions`;

mkdirSync(BACKSTAGE_SESSIONS_DIR, { recursive: true });

// --- Hot-reload support (bun --hot) ---------------------------------------
// Under `bun --hot`, editing a module re-evaluates this entry file in the SAME
// process, preserving `globalThis`. We exploit that so simple tweaks apply
// without dropping WebSocket clients or killing in-flight runs: live state
// (watchers, pending questions, queues) is parked on globalThis so the fresh
// module binding reuses the same instances, the HTTP/WS server is reloaded in
// place rather than rebound, and all one-time setup (agents, schedulers, timers,
// signal handlers) is guarded behind `__backstageBooted` so it never stacks.
// Long-lived agent *loop code* still needs a real restart — but that's now
// graceful (see SIGTERM handler below). A plain `bun run` (no --hot) just runs
// each branch once, exactly as before.
const g = globalThis as any;

// Cache sessions with short TTL
let sessionsCache: { data: UnifiedSession[]; ts: number } | null = null;
const CACHE_TTL = 2000;

function getCachedSessions(): UnifiedSession[] {
  if (sessionsCache && Date.now() - sessionsCache.ts < CACHE_TTL) {
    return sessionsCache.data;
  }
  const data = getAllSessions();
  // Sessions driven from the web UI run in-process; surface those too
  for (const s of data) {
    if (!s.isRunning && isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id)) {
      s.isRunning = true;
    }
  }
  sessionsCache = { data, ts: Date.now() };
  return data;
}

// In-process self-management MCP servers for INTERACTIVE Backstage sessions
// (web UI + loops) — the same michael-sessions / michael-admin tools the Slack
// agent gets, so you can list/steer sessions and manage automations/MCPs from a
// Michael session. Built fresh per run from the prompt's author. NEVER pass
// these to automation runs or to interactive resumes of automation-owned
// sessions — untrusted ticket text must not reach session-control / config
// tools. Backstage is Tailscale- and team-gated and already exposes all of this
// through its UI, so interactive users are treated as admin.
function interactiveMcpServers(user?: string): Record<string, unknown> {
  const createdBy = user || "Backstage";
  return {
    "michael-sessions": createSessionsMcpServer({ createdBy, isAdmin: true }),
    "michael-admin": createAdminMcpServer({
      channel: "backstage",
      userId: user || "backstage",
      isDM: false,
      isPrivate: false,
      createdBy,
      isAdmin: true,
    }),
  };
}

function findSession(sessionId: string): UnifiedSession | undefined {
  return getCachedSessions().find((s) => s.id === sessionId);
}

/** Derive the at-a-glance state + control surface for a session (for the MCP). */
function buildSummary(s: UnifiedSession): SessionSummary {
  const busyHere = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
  // External runs (CLI in tmux, another process) show as running via PID but
  // aren't in our activeRuns — observe-only, can't steer/cancel them.
  const runningExternal = !!s.isRunning && !busyHere;
  const pending = pendingAsks.get(s.id);
  const queuedCount = promptQueues.get(s.id)?.length || 0;

  let state: SessionState;
  if (s.archived) state = "archived";
  else if (pending) state = "waiting_question";
  else if (busyHere || s.isRunning) state = "running";
  else if (queuedCount > 0) state = "queued";
  else state = "idle";

  return {
    ...s,
    state,
    queuedCount,
    controllable: !runningExternal,
    ...(pending
      ? { pendingQuestion: { questionId: pending.questionId, questions: pending.questions } }
      : {}),
  };
}

function touchBackstageSession(
  bksId: string,
  patch: Partial<BackstageSessionFile>
): void {
  const path = `${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`;
  try {
    const data: BackstageSessionFile = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf-8"))
      : ({} as BackstageSessionFile);
    writeFileSync(
      path,
      JSON.stringify({ ...data, ...patch, lastActivity: new Date().toISOString() }, null, 2)
    );
    sessionsCache = null;
  } catch (e) {
    console.error(`Failed to update backstage session ${bksId}:`, e);
  }
}

// WebSocket client state
interface WSClientData {
  watchingSessionId: string | null;
  user: string | null;
}

// sessionId → sockets currently viewing that session (collaboration fan-out)
const sessionWatchers: Map<string, Set<any>> = (g.__sessionWatchers ??= new Map());

function joinSession(ws: any, sessionId: string) {
  let set = sessionWatchers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionWatchers.set(sessionId, set);
  }
  set.add(ws);
  broadcastPresence(sessionId);
}

function leaveSession(ws: any) {
  const sessionId = ws.data?.watchingSessionId;
  if (!sessionId) return;
  const set = sessionWatchers.get(sessionId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sessionWatchers.delete(sessionId);
    else broadcastPresence(sessionId);
  }
  ws.data.watchingSessionId = null;
}

function broadcastToSession(sessionId: string, msg: object, except?: any) {
  const set = sessionWatchers.get(sessionId);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) {
    if (ws === except) continue;
    try {
      ws.send(payload);
    } catch {}
  }
}

function broadcastPresence(sessionId: string) {
  const set = sessionWatchers.get(sessionId);
  const viewers = set
    ? Array.from(set, (ws: any) => ws.data?.user || "Anonymous")
    : [];
  broadcastToSession(sessionId, { type: "presence", sessionId, viewers });
}

// Interactive AskUserQuestion: questions broadcast to session watchers,
// answered from the UI, with a 10-minute timeout falling back to deny.
interface PendingAsk {
  questionId: string;
  questions: unknown[];
  resolve: (answers: Record<string, string> | null) => void;
}
const pendingAsks: Map<string, PendingAsk> = (g.__pendingAsks ??= new Map());

function makeAskHandler(sessionId: string) {
  return async (
    input: Record<string, unknown>
  ): Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > => {
    const questions = input.questions as unknown[] | undefined;
    if (!questions || questions.length === 0) {
      return { behavior: "allow", updatedInput: input };
    }

    const questionId = crypto.randomUUID();
    const answers = await new Promise<Record<string, string> | null>((resolve) => {
      const timeoutId = setTimeout(() => {
        pendingAsks.delete(sessionId);
        resolve(null);
      }, 10 * 60 * 1000);
      pendingAsks.set(sessionId, {
        questionId,
        questions,
        resolve: (a) => {
          clearTimeout(timeoutId);
          pendingAsks.delete(sessionId);
          resolve(a);
        },
      });
      broadcastToSession(sessionId, { type: "ask_question", sessionId, questionId, questions });
    });

    broadcastToSession(sessionId, { type: "ask_resolved", sessionId, questionId });

    if (!answers) {
      return {
        behavior: "deny",
        message:
          "Nobody answered within 10 minutes. Proceed with your best judgment and clearly note the open question and the assumption you made.",
      };
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  };
}

// Messages sent while a run is in flight queue up and deliver afterwards,
// the same way Claude Code handles interruptions.
const promptQueues: Map<string, Array<{ content: string; user?: string }>> = (g.__promptQueues ??=
  new Map());

// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];

function broadcastQueue(sessionId: string) {
  broadcastToSession(sessionId, {
    type: "queue_update",
    sessionId,
    queued: promptQueues.get(sessionId) || [],
  });
}

async function drainQueue(sessionId: string): Promise<void> {
  let queue;
  while ((queue = promptQueues.get(sessionId)) && queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    broadcastQueue(sessionId);
    const combined = batch
      .map((m) => (batch.length > 1 && m.user ? `[${m.user}] ${m.content}` : m.content))
      .join("\n\n");
    await runSessionPrompt(sessionId, combined, batch[0].user);
  }
}

async function runSessionPromptAndDrain(
  sessionId: string,
  content: string,
  user?: string,
  images?: ImageInput[]
): Promise<void> {
  await runSessionPrompt(sessionId, content, user, images);
  await drainQueue(sessionId);
}

/** Decode composer `data:<mediatype>;base64,<data>` URLs into runner ImageInputs. */
function parseImageDataUrls(urls?: unknown): ImageInput[] | undefined {
  if (!Array.isArray(urls)) return undefined;
  const out: ImageInput[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const m = u.match(/^data:([^;]+);base64,(.+)$/s);
    if (m && m[1].startsWith("image/")) out.push({ mediaType: m[1], data: m[2] });
  }
  return out.length ? out : undefined;
}

// Messages queued while a run we didn't start is in flight (Slack runs, CLI
// sessions in tmux, automations) have no drain loop of their own — watch the
// busy state and deliver the queue once the external run finishes.
const drainWatchers: Set<string> = (g.__drainWatchers ??= new Set());
function watchExternalRunAndDrain(sessionId: string): void {
  if (drainWatchers.has(sessionId)) return;
  drainWatchers.add(sessionId);
  const timer = setInterval(async () => {
    const session = findSession(sessionId);
    if (!session || !(promptQueues.get(sessionId) || []).length) {
      clearInterval(timer);
      drainWatchers.delete(sessionId);
      return;
    }
    if (isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id)) return;
    clearInterval(timer);
    drainWatchers.delete(sessionId);
    try {
      await drainQueue(sessionId);
    } catch (e) {
      console.error(`[queue] Drain after external run failed for ${sessionId}:`, e);
    }
  }, 3000);
}

/** Run a prompt against an existing session, broadcasting to all watchers. */
async function runSessionPrompt(
  sessionId: string,
  content: string,
  user?: string,
  images?: ImageInput[]
): Promise<void> {
  const session = findSession(sessionId);
  if (!session) return;

  // The engine session id depends on the session's model: codex models resume
  // the codex thread, claude models the claude session. A missing engine id
  // just means "first run on this provider" — a fresh thread/session starts.
  const provider = providerFor(session.model);
  const engineSessionId =
    provider === "codex" ? session.codexThreadId : session.claudeSessionId;
  if (provider === "claude" && !engineSessionId) {
    // Never swallow a message silently (queued ones land here on drain)
    console.error(`[queue] Can't deliver prompt for ${sessionId} — no claude session id`);
    broadcastToSession(sessionId, {
      type: "notice",
      message: "Couldn't deliver your message — the session has no Claude session id yet. Try again in a moment.",
    });
    return;
  }

  // A cleaned-up worktree makes the SDK spawn fail with a misleading "binary
  // not found" (ENOENT on the missing cwd) — revive it first. Same path as
  // before, so resuming the claude session keeps its history.
  let cwd = session.worktreeDir || `${HOME}/projects/tella-fusion`;
  if (session.worktreeDir && !existsSync(session.worktreeDir)) {
    if (session.branch) {
      broadcastToSession(sessionId, {
        type: "notice",
        message: `This session's worktree was cleaned up — recreating it from branch ${session.branch}…`,
      });
      try {
        cwd = await reviveWorktree(session.branch);
      } catch (e) {
        broadcastToSession(sessionId, {
          type: "notice",
          message: `Couldn't recreate the worktree (${e}); running in the main checkout instead.`,
        });
        cwd = `${HOME}/projects/tella-fusion`;
      }
    } else {
      broadcastToSession(sessionId, {
        type: "notice",
        message: "This session's worktree is gone; running in the main checkout.",
      });
      cwd = `${HOME}/projects/tella-fusion`;
    }
  }
  let prompt = content;
  if (session.goal) {
    prompt += `\n\n[Pinned session goal — keep working toward it and note how this turn advanced it: ${session.goal}]`;
  }

  // Resuming an automation-owned session must keep that automation's scoping
  // (MCP allowlist + tool denials) — otherwise a resume would silently hand it
  // every MCP server and drop the customer/identity write denials.
  const isAutomationSession = !!session.automation;
  const mcpServers = isAutomationSession
    ? automationMcpServersByName(session.automation!)
    : undefined;
  const deniedTools = isAutomationSession ? automationDeniedTools() : undefined;

  // Everyone viewing this session sees the prompt and the live run
  broadcastToSession(sessionId, { type: "stream_start", sessionId, by: user || "Anonymous" });
  broadcastToSession(sessionId, { type: "session_status", isRunning: true });

  let finalSessionId = engineSessionId || "";

  for await (const event of runAgent({
    prompt,
    sessionId: engineSessionId || undefined,
    cwd,
    mode: session.mode,
    model: session.model,
    images,
    mcpServers,
    // Self-management tools for normal sessions; withheld from automation
    // sessions (and their interactive resumes) — same gate as deniedTools above.
    inProcessMcp: isAutomationSession ? undefined : interactiveMcpServers(user),
    deniedTools,
    confirmTools: STRIPE_CONFIRM_TOOLS,
    aws: true, // sessions keep AWS read access (via injected creds)
    // Attribute any commits this turn makes to whoever sent the prompt.
    author: gitIdentityFor(user),
    journal: { bksSessionId: session.id, kind: "prompt" },
    onAskUser: makeAskHandler(sessionId),
  })) {
    switch (event.type) {
      case "init":
        finalSessionId = event.sessionId || finalSessionId;
        break;
      case "text_chunk":
        broadcastToSession(sessionId, { type: "stream_text", text: event.text });
        break;
      case "tool_use":
        broadcastToSession(sessionId, {
          type: "stream_tool_use",
          entry: {
            id: event.toolUseId || crypto.randomUUID(),
            type: "tool_use",
            content: `Using ${event.toolName}`,
            timestamp: new Date().toISOString(),
            toolName: event.toolName,
            toolInput: event.toolInput,
            toolUseId: event.toolUseId,
          },
        });
        break;
      case "tool_result":
        broadcastToSession(sessionId, {
          type: "stream_tool_result",
          entry: {
            // Same id scheme as the jsonl tail so the full (untruncated)
            // transcript entry upserts over this streamed copy
            id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
            type: "tool_result",
            content: event.content || "",
            timestamp: new Date().toISOString(),
            toolUseId: event.toolUseId,
            ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
          },
        });
        break;
      case "done":
        finalSessionId = event.sessionId || finalSessionId;
        sessionsCache = null;
        break;
      case "error":
        broadcastToSession(sessionId, { type: "error", message: event.content });
        break;
    }
  }

  // Persist activity on our own session store (slack/linear stores are read-only)
  if (session.source === "backstage") {
    touchBackstageSession(
      session.id,
      provider === "codex"
        ? { codexThreadId: finalSessionId || undefined }
        : { claudeSessionId: finalSessionId || undefined }
    );
  }

  broadcastToSession(sessionId, { type: "stream_done" });
  broadcastToSession(sessionId, { type: "session_status", isRunning: false });
}

/**
 * Backstage-native slash commands. Returns a notice string when the message
 * was consumed as a command, or null to send it to Claude as a normal prompt.
 */
function handleSlashCommand(
  session: UnifiedSession,
  text: string,
  user?: string
): string | null {
  if (
    !text.startsWith("/goal") &&
    !text.startsWith("/loop") &&
    !text.startsWith("/model") &&
    text !== "/help"
  ) {
    return null;
  }
  if (session.source !== "backstage") {
    if (text.startsWith("/model") && session.source === "slack") {
      return "Set the model from Slack instead — send /model <name> in the Slack thread (its session file is agent-owned).";
    }
    return "Slash commands only work on backstage-created sessions (Slack/Linear session files are agent-owned).";
  }

  if (text === "/help") {
    return [
      "Backstage commands:",
      "/goal <text> — pin a goal, appended to every prompt until cleared",
      "/goal clear — remove the goal",
      "/loop <interval> <prompt> — re-run a prompt on an interval (e.g. /loop 30m check CI and fix failures)",
      "/loop stop — stop the loop",
      "/model — show the session's model and what's available",
      "/model <name> — switch model (e.g. /model opus, /model gpt-5.5)",
    ].join("\n");
  }

  if (text === "/model" || text === "/model show" || text === "/model list") {
    return [
      `Current model: ${session.model || getDefaultModel()}${session.model ? "" : " (default)"}`,
      "",
      "Available models (set with /model <name or alias>):",
      formatModelList(session.model),
    ].join("\n");
  }
  if (text.startsWith("/model ")) {
    const input = text.slice("/model ".length).trim();
    const resolved = resolveModel(input);
    if (!resolved) {
      return [
        `Unknown model "${input}". Available:`,
        formatModelList(session.model),
      ].join("\n");
    }
    const prevProvider = providerFor(session.model);
    touchBackstageSession(session.id, {
      model: resolved.id,
      modelHistory: [
        ...(session.modelHistory || []),
        { model: resolved.id, at: new Date().toISOString(), by: user },
      ],
    });
    // Everyone watching sees the switch (pill + inline divider) immediately
    broadcastToSession(session.id, {
      type: "model_changed",
      sessionId: session.id,
      model: resolved.id,
      by: user,
    });
    const switchedProvider = prevProvider !== resolved.provider;
    return (
      `Model set to ${resolved.id} (${modelLabel(resolved.id)}). Applies from the next prompt.` +
      (switchedProvider
        ? resolved.provider === "codex"
          ? " Heads up: this switches the engine to Codex — the Claude conversation history doesn't carry over, so the next prompt starts a fresh Codex thread (switching back to a Claude model resumes the old history)."
          : " Heads up: this switches the engine back to Claude — the Codex thread's history doesn't carry over, but the earlier Claude history (if any) resumes."
        : "")
    );
  }

  if (text === "/goal" || text === "/goal show") {
    return session.goal ? `Current goal: ${session.goal}` : "No goal set. Use /goal <text>.";
  }
  if (text === "/goal clear") {
    touchBackstageSession(session.id, { goal: undefined });
    return "Goal cleared.";
  }
  if (text.startsWith("/goal ")) {
    const goal = text.slice("/goal ".length).trim();
    if (!goal) return "Usage: /goal <text>";
    touchBackstageSession(session.id, { goal });
    return `Goal pinned: ${goal} — it will ride along with every prompt until /goal clear.`;
  }

  if (text === "/loop" || text === "/loop status") {
    return session.loop
      ? `Loop active: every ${session.loop.intervalMinutes}m — "${session.loop.prompt}"`
      : "No loop set. Use /loop <interval> <prompt> (e.g. /loop 30m check CI).";
  }
  if (text === "/loop stop" || text === "/loop off" || text === "/loop clear") {
    touchBackstageSession(session.id, { loop: undefined });
    return "Loop stopped.";
  }
  if (text.startsWith("/loop ")) {
    const rest = text.slice("/loop ".length).trim();
    const match = rest.match(/^(\d+)\s*(m|min|h|hr)?\s+([\s\S]+)$/);
    if (!match) return "Usage: /loop <interval> <prompt> — e.g. /loop 30m check CI and fix failures";
    let minutes = parseInt(match[1]);
    if (match[2] === "h" || match[2] === "hr") minutes *= 60;
    minutes = Math.max(5, minutes);
    const prompt = match[3].trim();
    touchBackstageSession(session.id, {
      loop: { prompt, intervalMinutes: minutes, lastRunAt: new Date().toISOString(), setBy: user },
    });
    return `Loop set: every ${minutes}m — "${prompt}". First run in ${minutes}m; /loop stop to end it.`;
  }

  return null;
}

// Loop ticker: fire due session loops (skips busy/archived sessions).
// Guarded so a hot reload doesn't stack a second interval.
if (!g.__backstageBooted) {
  setInterval(() => {
    for (const session of getCachedSessions()) {
      const loop = session.loop;
      if (!loop || session.archived || session.source !== "backstage") continue;
      if (!session.claudeSessionId && !session.codexThreadId) continue;
      if (isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id)) continue;
      const last = loop.lastRunAt ? new Date(loop.lastRunAt).getTime() : 0;
      if (Date.now() - last < loop.intervalMinutes * 60_000) continue;
      touchBackstageSession(session.id, {
        loop: { ...loop, lastRunAt: new Date().toISOString() },
      });
      console.log(`[loop] Firing loop prompt for ${session.id} (every ${loop.intervalMinutes}m)`);
      void runSessionPromptAndDrain(session.id, loop.prompt, loop.setBy ? `${loop.setBy} (loop)` : "loop");
    }
  }, 60_000);
}

// Production frontend: build the SPA with code-splitting so the initial
// download is ~1MB instead of shipping every shiki grammar/theme (~10MB)
// upfront — the heavy chunks load on demand. Dev keeps the HMR HTMLBundle
// (`homepage`) below. Built once per process and parked on globalThis so a
// hot reload reuses it. Assets are content-hashed → safe to cache forever.
const IS_DEV = process.env.BACKSTAGE_DEV === "1";
const FRONTEND_DIST = `${import.meta.dir}/.frontend-dist`;

if (!IS_DEV && !g.__backstageFrontend) {
  console.log("Building frontend (split + minified)…");
  const srcDir = `${import.meta.dir}/src/frontend`;
  const result = await Bun.build({
    entrypoints: [`${srcDir}/App.tsx`],
    outdir: FRONTEND_DIST,
    minify: true,
    splitting: true,
    sourcemap: "none",
    publicPath: "/backstage/",
    naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "frontend build failed");
  }
  // Bun's HTML-entry splitting mis-points the bootstrap <script> at a leaf
  // chunk, so we build the JS entry and stitch index.html ourselves: keep the
  // source shell (icons, splash, manifest links) and point it at the hashed
  // entry + the extracted CSS.
  const entry = result.outputs.find((o) => o.kind === "entry-point");
  if (!entry) throw new Error("frontend build produced no entry point");
  const entryName = entry.path.split("/").pop();

  // Bun 1.3.14's CSS minifier strips the space after var(...) and breaks the
  // .panel-overlay / .sidebar-overlay inset (and a few color-mix percentages),
  // which knocks out the mobile overlay layer. Bypass it: write the source CSS
  // unmodified with a content-hashed name and serve it ourselves.
  const cssSrc = await Bun.file(`${srcDir}/styles/global.css`).text();
  const cssHash = Bun.hash(cssSrc).toString(36);
  const cssName = `global-${cssHash}.css`;
  await Bun.write(`${FRONTEND_DIST}/${cssName}`, cssSrc);

  let indexHtml = await Bun.file(`${srcDir}/index.html`).text();
  indexHtml = indexHtml.replace(
    '<script type="module" src="./App.tsx"></script>',
    `<script type="module" crossorigin src="/backstage/${entryName}"></script>`
  );
  indexHtml = indexHtml.replace("</head>", `  <link rel="stylesheet" href="/backstage/${cssName}">\n</head>`);
  g.__backstageFrontend = { indexHtml, gzip: new Map<string, Blob>() };
  console.log(`Frontend built: ${result.outputs.length} files → ${FRONTEND_DIST}`);
}

const frontend: { indexHtml: string; gzip: Map<string, Blob> } | null =
  IS_DEV ? null : g.__backstageFrontend;

// SPA entry: the HMR bundle in dev, the prebuilt index.html in prod.
const spaEntry = frontend
  ? () => new Response(frontend.indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } })
  : homepage;

console.log(`Starting Backstage server on ${HOST}:${PORT}...`);

// Reuse the listening server across hot reloads so existing WebSocket clients
// and in-flight runs survive a tweak; a fresh `bun run` just creates it once.
// (Session/agent logic still hot-updates: the registry below is re-registered
// on every reload, and per-message config is read fresh.)
const server: import("bun").Server<WSClientData> = (g.__backstageServer ??= Bun.serve<WSClientData>({
  port: PORT,
  hostname: HOST,
  // The plain-triage route waits for worktree+session boot (~15-60s);
  // Bun's default 10s idleTimeout would drop the connection mid-wait
  idleTimeout: 240,

  routes: {
    "/backstage": spaEntry,
    "/backstage/": spaEntry,
    "/backstage/index.html": spaEntry,
    // Client-side routes must serve the SPA shell, not the raw file
    "/backstage/new": spaEntry,
    "/backstage/session/*": spaEntry,
    "/backstage/automations": spaEntry,
    "/backstage/wiki": spaEntry,
    "/backstage/wiki/*": spaEntry,
    "/backstage/connections": spaEntry,
    "/backstage/archived": spaEntry,
  },

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Stream a local media file referenced by a `BACKSTAGE_VIDEO:` marker in a
    // tool's output, so the session viewer can play it inline (tools can't return
    // video blocks the way Read returns images). Path-scoped: absolute path under
    // /tmp or /home/ubuntu, no traversal, known media extension. Range-enabled
    // so the <video> scrubber can seek.
    if (path === "/backstage/media" && req.method === "GET") {
      const mediaPath = url.searchParams.get("path") || "";
      const mediaTypes: Record<string, string> = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      };
      const ext = mediaPath.slice(mediaPath.lastIndexOf(".")).toLowerCase();
      const scoped = mediaPath.startsWith("/tmp/") || mediaPath.startsWith("/home/ubuntu/");
      if (!mediaPath.startsWith("/") || mediaPath.includes("..") || !scoped || !mediaTypes[ext]) {
        return new Response("forbidden", { status: 403 });
      }
      const file = Bun.file(mediaPath);
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      const type = mediaTypes[ext];
      const size = file.size;
      const range = req.headers.get("range");
      const baseHeaders: Record<string, string> = {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
      };
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= size) end = size - 1;
        if (start > end) {
          return new Response("range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        }
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }
      return new Response(file, { headers: { ...baseHeaders, "Content-Length": String(size) } });
    }

    // App icons (KITT/red-M) — real PNGs so iOS home-screen and PWA installs
    // pick them up; data-URI apple-touch-icons don't work on iOS. Short cache
    // + must-revalidate so a refreshed design isn't pinned by a stale copy.
    const iconFiles: Record<string, string> = {
      "/backstage/apple-touch-icon.png": "apple-touch-icon.png", // 180×180
      "/backstage/icon-192.png": "icon-192.png",
      "/backstage/icon.png": "icon.png", // 512×512
    };
    if (iconFiles[path]) {
      return new Response(Bun.file(`${import.meta.dir}/src/frontend/${iconFiles[path]}`), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600, must-revalidate" },
      });
    }

    // iOS PWA launch images (apple-touch-startup-image). One PNG per device
    // resolution, generated by scripts/gen-splash.py. Filename is locked to the
    // apple-splash-<w>-<h>.png pattern so the path can't escape the folder.
    const splashMatch = path.match(/^\/backstage\/splash\/(apple-splash-\d+-\d+\.png)$/);
    if (splashMatch) {
      return new Response(Bun.file(`${import.meta.dir}/src/frontend/splash/${splashMatch[1]}`), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Built SPA assets (prod only). Content-hashed filenames → cache forever.
    // Served gzipped (computed once, then memoised) since the JS is large.
    const assetMatch = frontend && path.match(/^\/backstage\/([\w.-]+\.(?:js|css|map))$/);
    if (assetMatch) {
      const name = assetMatch[1];
      const file = Bun.file(`${FRONTEND_DIST}/${name}`);
      if (await file.exists()) {
        const type = name.endsWith(".css")
          ? "text/css"
          : name.endsWith(".map")
            ? "application/json"
            : "text/javascript";
        const headers: Record<string, string> = {
          "Content-Type": `${type}; charset=utf-8`,
          "Cache-Control": "public, max-age=31536000, immutable",
        };
        if ((req.headers.get("accept-encoding") || "").includes("gzip")) {
          let gz = frontend.gzip.get(name);
          if (!gz) {
            gz = new Blob([Bun.gzipSync(new Uint8Array(await file.arrayBuffer()))]);
            frontend.gzip.set(name, gz);
          }
          headers["Content-Encoding"] = "gzip";
          headers["Vary"] = "Accept-Encoding";
          return new Response(gz, { headers });
        }
        return new Response(file, { headers });
      }
    }
    if (path === "/backstage/manifest.webmanifest") {
      return Response.json(
        {
          name: "Michael",
          short_name: "Michael",
          start_url: "/backstage/",
          display: "standalone",
          background_color: "#0b0809",
          theme_color: "#0b0809",
          icons: [
            { src: "/backstage/icon-192.png?v=3", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/backstage/icon.png?v=3", sizes: "512x512", type: "image/png", purpose: "any" },
          ],
        },
        { headers: { "Content-Type": "application/manifest+json" } }
      );
    }

    // Land the user in a Plain triage session for a thread. If one already
    // exists for this thread, jump straight to it; otherwise start a fresh
    // triage run with the same context the automation gets on thread_created.
    // Linked from the Plain support cards.
    const plainTriageMatch = path.match(/^\/backstage\/plain-triage\/([^/]+)$/);
    if (plainTriageMatch && req.method === "GET") {
      const threadId = decodeURIComponent(plainTriageMatch[1]);

      const redirect = (to: string) =>
        new Response(null, { status: 302, headers: { Location: to } });

      // Reuse the most recent live (non-archived) session for this thread so
      // the card links to ongoing work instead of spawning a duplicate run.
      const existing = getCachedSessions()
        .filter((s) => s.plainThreadId === threadId && !s.archived)
        .sort(
          (a, b) =>
            new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
        )[0];
      if (existing) return redirect(`/backstage/session/${existing.id}`);

      const automation = listAutomations().find(
        (a) => a.eventKey === "plain:thread_created"
      );
      if (!automation) return redirect("/backstage/");

      // Build the same payload shape the webhook event carries
      let payload: Record<string, unknown> = { threadId };
      try {
        const { getThreadWithMessages } = await import("./src/agents/plain/api");
        const thread = await getThreadWithMessages(threadId);
        payload = {
          threadId,
          title: thread?.title || null,
          previewText: thread?.previewText || thread?.description || null,
          status: thread?.status || null,
          customer: {
            email: thread?.customer?.email?.email || null,
            fullName: thread?.customer?.fullName || null,
          },
        };
      } catch (e) {
        console.error(`[plain-triage] Thread lookup failed for ${threadId}:`, e);
      }

      const sessionId = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 120_000);
        void runAutomation(
          automation,
          (id) => {
            sessionsCache = null;
            clearTimeout(timer);
            resolve(id);
          },
          { trigger: "event", eventContext: JSON.stringify(payload, null, 2) }
        );
      });

      return redirect(sessionId ? `/backstage/session/${sessionId}` : "/backstage/");
    }

    // Health check (includes agent health — Tailscale-only, not public)
    if (path === "/backstage/api/health") {
      const agentHealth: Record<string, unknown> = {};
      for (const a of agents) {
        agentHealth[a.name] = a.health();
      }
      return Response.json({ ok: true, uptime: process.uptime(), agents: agentHealth });
    }

    // List sessions
    if (path === "/backstage/api/sessions" && req.method === "GET") {
      return Response.json(getCachedSessions());
    }

    // Get transcript for a session
    if (path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/) && req.method === "GET") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      if (!session.transcriptPath) return Response.json([]);
      return Response.json(parseTranscript(session.transcriptPath));
    }

    // Live git diff for a session's worktree (Changes tab)
    if (path.match(/^\/backstage\/api\/sessions\/(.+)\/diff$/) && req.method === "GET") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)\/diff$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
        return Response.json({
          branch: session.branch,
          baseRef: null,
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          rawPatch: "",
        });
      }
      try {
        return Response.json(await getSessionDiff(session.worktreeDir));
      } catch (e: any) {
        return Response.json({ error: e.message || String(e) }, { status: 500 });
      }
    }

    // PR details for a session's branch (PR tab)
    if (path.match(/^\/backstage\/api\/sessions\/(.+)\/pr$/) && req.method === "GET") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)\/pr$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      if (!session.branch) return Response.json(null);
      return Response.json(await getPrDetails(session.branch));
    }

    // PR diff for inline review in the PR tab
    if (path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-diff$/) && req.method === "GET") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-diff$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      if (!session.branch) return Response.json(null);
      return Response.json(await getPrDiff(session.branch));
    }

    // Post a comment on the session's PR (inline when path+line present)
    if (path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-comment$/) && req.method === "POST") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-comment$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      if (!session.branch) return Response.json({ error: "Session has no branch" }, { status: 400 });

      const body = await req.json().catch(() => null);
      if (!body?.text?.trim()) return Response.json({ error: "Empty comment" }, { status: 400 });

      const user = body.user || "Someone";
      const result = await postPrComment(session.branch, {
        body: `**${user}** via Michael:\n\n${body.text.trim()}`,
        path: body.path,
        line: body.line,
        startLine: body.startLine,
        side: body.side,
        startSide: body.startSide,
      });
      if ("error" in result) return Response.json(result, { status: 502 });
      return Response.json(result);
    }

    // Bulk-archive idle sessions
    if (path === "/backstage/api/sessions/archive-old" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const days = Math.max(1, parseInt(body.days) || 7);
      const count = archiveOlderThan(getAllSessions(), days);
      sessionsCache = null;
      return Response.json({ archived: count });
    }

    // Archive / unarchive a single session
    const archiveMatch = path.match(/^\/backstage\/api\/sessions\/(.+)\/archive$/);
    if (archiveMatch && req.method === "POST") {
      const sessionId = decodeURIComponent(archiveMatch[1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      const body = await req.json().catch(() => ({}));
      setArchived(sessionId, body.archived !== false);
      sessionsCache = null;
      return Response.json({ ok: true });
    }

    // Delete a session (+ optional worktree cleanup)
    if (path.match(/^\/backstage\/api\/sessions\/(.+)$/) && req.method === "DELETE") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

      const cleanWorktree = url.searchParams.get("worktree") === "true";
      try {
        deleteSession(session);
        if (cleanWorktree && session.worktreeDir && session.branch) {
          await removeWorktree(session.branch);
        }
        sessionsCache = null;
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // List worktrees
    if (path === "/backstage/api/worktrees" && req.method === "GET") {
      return Response.json(await listWorktrees());
    }

    // ── Automations ──
    if (path === "/backstage/api/automations" && req.method === "GET") {
      const list = listAutomations().map((a) => ({
        ...a,
        isRunning: isAutomationRunning(a.id),
      }));
      return Response.json(list);
    }

    if (path === "/backstage/api/automations" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
      const result = createAutomation(body);
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    }

    const autoRunMatch = path.match(/^\/backstage\/api\/automations\/([^/]+)\/run$/);
    if (autoRunMatch && req.method === "POST") {
      const automation = getAutomation(autoRunMatch[1]);
      if (!automation) return Response.json({ error: "Not found" }, { status: 404 });
      if (isAutomationRunning(automation.id)) {
        return Response.json({ error: "Already running" }, { status: 409 });
      }
      // Fire and forget; session shows up in the list once it boots
      void runAutomation(automation, () => {
        sessionsCache = null;
      });
      return Response.json({ ok: true });
    }

    const autoMatch = path.match(/^\/backstage\/api\/automations\/([^/]+)$/);
    if (autoMatch && req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
      const result = updateAutomation(autoMatch[1], body);
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    }

    if (autoMatch && req.method === "DELETE") {
      return deleteAutomation(autoMatch[1])
        ? Response.json({ ok: true })
        : Response.json({ error: "Not found" }, { status: 404 });
    }

    // ── Connections ──
    if (path === "/backstage/api/connections" && req.method === "GET") {
      const force = url.searchParams.get("refresh") === "1";
      const mcpServers = await getConnections(force);
      const agentHealth: Record<string, unknown> = {};
      for (const a of agents) agentHealth[a.name] = a.health();
      return Response.json({ mcpServers, agents: agentHealth });
    }

    if (path === "/backstage/api/connections/mcp" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
      const result = addMcpServer(body);
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    }

    const mcpDelMatch = path.match(/^\/backstage\/api\/connections\/mcp\/([^/]+)$/);
    if (mcpDelMatch && req.method === "DELETE") {
      const result = removeMcpServer(decodeURIComponent(mcpDelMatch[1]));
      if ("error" in result) return Response.json(result, { status: 404 });
      return Response.json(result);
    }

    // ── Claude account pool (tokens are never sent back, only masked) ──
    if (path === "/backstage/api/claude-accounts" && req.method === "GET") {
      return Response.json({ accounts: listAccountsPublic() });
    }

    if (path === "/backstage/api/claude-accounts" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body?.name || !body?.token) {
        return Response.json({ error: "name and token are required" }, { status: 400 });
      }
      const result = await addAccount(body.name, body.token);
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    }

    if (path === "/backstage/api/claude-accounts/refresh" && req.method === "POST") {
      await refreshAllUsage();
      return Response.json({ accounts: listAccountsPublic() });
    }

    const accountDelMatch = path.match(/^\/backstage\/api\/claude-accounts\/([^/]+)$/);
    if (accountDelMatch && req.method === "DELETE") {
      return removeAccount(decodeURIComponent(accountDelMatch[1]))
        ? Response.json({ ok: true })
        : Response.json({ error: "Not found" }, { status: 404 });
    }

    // ── Models available to sessions ──
    if (path === "/backstage/api/models" && req.method === "GET") {
      return Response.json({ models: KNOWN_MODELS, default: getDefaultModel() });
    }

    // Set (or clear, with model:null) the default model new sessions run on.
    if (path === "/backstage/api/models/default" && req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || !("model" in body)) {
        return Response.json({ error: "model is required (id, or null to clear)" }, { status: 400 });
      }
      try {
        const next = setDefaultModel(body.model ?? null);
        return Response.json({ default: next });
      } catch (e: any) {
        return Response.json({ error: e?.message || "Failed to set default model" }, { status: 400 });
      }
    }

    // ── Codex (OpenAI) account pool ──
    if (path === "/backstage/api/codex-accounts" && req.method === "GET") {
      return Response.json({ accounts: listCodexAccountsPublic() });
    }

    if (path === "/backstage/api/codex-accounts" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body?.name || !body?.value || !["api_key", "home"].includes(body?.kind)) {
        return Response.json(
          { error: "name, kind (api_key|home) and value are required" },
          { status: 400 }
        );
      }
      const result = addCodexAccount(body.name, body.kind, body.value);
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    }

    const codexAccountDelMatch = path.match(/^\/backstage\/api\/codex-accounts\/([^/]+)$/);
    if (codexAccountDelMatch && req.method === "DELETE") {
      return removeCodexAccount(decodeURIComponent(codexAccountDelMatch[1]))
        ? Response.json({ ok: true })
        : Response.json({ error: "Not found" }, { status: 404 });
    }

    // ── Wiki ──
    if (path === "/backstage/api/wiki/tree" && req.method === "GET") {
      return Response.json(getWikiTree());
    }

    if (path === "/backstage/api/wiki/file" && req.method === "GET") {
      const rel = url.searchParams.get("path") || "";
      const file = getWikiFile(rel);
      if (!file) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(file);
    }

    if (path === "/backstage/api/wiki/search" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      return Response.json(searchWiki(q));
    }

    // WebSocket upgrade
    if (path === "/backstage/ws") {
      const upgraded = server.upgrade(req, {
        data: { watchingSessionId: null, user: null },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // 404
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log("WebSocket client connected");
    },

    async message(ws, message) {
      let msg: any;
      try {
        msg = JSON.parse(String(message));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      switch (msg.type) {
        case "watch": {
          const sessionId = msg.sessionId;
          const session = findSession(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            return;
          }

          // Stop watching any previous session first
          stopAllWatchesForClient(ws);
          leaveSession(ws);

          const data = ws.data;
          data.watchingSessionId = sessionId;
          if (msg.user) data.user = msg.user;
          joinSession(ws, sessionId);

          // Send full transcript
          const entries = session.transcriptPath
            ? parseTranscript(session.transcriptPath)
            : [];
          ws.send(JSON.stringify({ type: "transcript_init", entries }));

          // Start file watcher
          if (session.transcriptPath) {
            startWatching(session.transcriptPath, ws);
          }

          // Pending interactive question, if any
          const pendingAsk = pendingAsks.get(sessionId);
          if (pendingAsk) {
            ws.send(
              JSON.stringify({
                type: "ask_question",
                sessionId,
                questionId: pendingAsk.questionId,
                questions: pendingAsk.questions,
              })
            );
          }

          // Current message queue for this session
          ws.send(
            JSON.stringify({
              type: "queue_update",
              sessionId,
              queued: promptQueues.get(sessionId) || [],
            })
          );

          // Send running status
          ws.send(
            JSON.stringify({
              type: "session_status",
              isRunning:
                session.isRunning ||
                isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id),
            })
          );
          break;
        }

        case "prompt": {
          const { sessionId, content, user } = msg;
          const images = parseImageDataUrls(msg.images);
          const session = findSession(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            return;
          }

          // Slash commands are handled by backstage itself
          const notice = handleSlashCommand(session, String(content || "").trim(), user);
          if (notice !== null) {
            ws.send(JSON.stringify({ type: "notice", message: notice }));
            sessionsCache = null;
            break;
          }

          // Busy → steer it into the running query (delivered at the next
          // turn boundary, Claude-Code style). Falls back to the queue when
          // the run isn't steerable: codex runs, runs owned by another
          // process (Slack handler, CLI in tmux), or a run that's finishing.
          if (isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id)) {
            const attributed = user ? `[${user}] ${content}` : content;
            if (steerAgentRun([session.claudeSessionId, session.codexThreadId, session.id], attributed)) {
              // The message itself lands in the transcript when its turn
              // starts; until then this notice is the visible receipt. Not
              // mirrored into promptQueues — the drain would re-deliver it.
              broadcastToSession(sessionId, {
                type: "notice",
                message: `Message from ${user || "you"} folded into the run — Michael picks it up at the next stopping point.`,
              });
              break;
            }
            const queue = promptQueues.get(sessionId) || [];
            queue.push({ content, user });
            promptQueues.set(sessionId, queue);
            broadcastQueue(sessionId);
            watchExternalRunAndDrain(sessionId);
            break;
          }

          // Codex sessions start a fresh thread on first prompt; Claude needs
          // a session id to resume.
          if (providerFor(session.model) === "claude" && !session.claudeSessionId) {
            ws.send(JSON.stringify({ type: "error", message: "No Claude session to resume" }));
            return;
          }

          await runSessionPromptAndDrain(sessionId, content, user, images);
          break;
        }

        case "interrupt_prompt": {
          // Esc-style redirect: stop the current turn, keep the session, and
          // continue right away with this message. Falls back to a normal
          // prompt (steer/queue/run) when there's nothing to interrupt.
          const { sessionId, content, user } = msg;
          const session = findSession(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            return;
          }
          const attributed = user ? `[${user}] ${content}` : content;
          if (
            isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id) &&
            interruptAndSteerAgentRun(
              [session.claudeSessionId, session.codexThreadId, session.id],
              attributed
            )
          ) {
            broadcastToSession(sessionId, {
              type: "notice",
              message: `${user || "Someone"} interrupted — redirecting Michael now.`,
            });
            break;
          }
          // Not interruptible (external run, codex, or just finished): treat
          // like a normal send so the message is never lost.
          if (isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id)) {
            const queue = promptQueues.get(sessionId) || [];
            queue.push({ content, user });
            promptQueues.set(sessionId, queue);
            broadcastQueue(sessionId);
            watchExternalRunAndDrain(sessionId);
            break;
          }
          await runSessionPromptAndDrain(sessionId, content, user);
          break;
        }

        case "cancel": {
          const data = ws.data;
          if (data.watchingSessionId) {
            const session = findSession(data.watchingSessionId);
            if (session) {
              cancelAgentRun(session.claudeSessionId, session.codexThreadId, session.id);
            }
            const dropped = promptQueues.get(data.watchingSessionId)?.length || 0;
            if (dropped > 0) {
              promptQueues.delete(data.watchingSessionId);
              broadcastQueue(data.watchingSessionId);
              broadcastToSession(data.watchingSessionId, {
                type: "notice",
                message: `Cancelled — ${dropped} queued message${dropped === 1 ? "" : "s"} dropped.`,
              });
            }
          }
          break;
        }

        case "answer_question": {
          const { sessionId, questionId, answers } = msg;
          const pending = pendingAsks.get(sessionId);
          if (pending && pending.questionId === questionId) {
            pending.resolve(answers && typeof answers === "object" ? answers : null);
          }
          break;
        }

        case "create_session": {
          const { branch, prompt, user, mode } = msg;
          const images = parseImageDataUrls(msg.images);

          // Fork: branch a new session off an existing one, keeping the REAL
          // engine conversation (via SDK forkSession), optionally from a chosen
          // message. Inherits the source's mode/model/cwd. Claude-only.
          const forkFrom = msg.forkFrom as { sourceId?: string; messageId?: string } | undefined;
          const forkSource = forkFrom?.sourceId ? findSession(forkFrom.sourceId) : undefined;
          if (forkFrom?.sourceId && !forkSource) {
            ws.send(JSON.stringify({ type: "error", message: "Fork source session not found" }));
            return;
          }
          const canFork =
            !!forkSource &&
            providerFor(forkSource.model) === "claude" &&
            !!forkSource.claudeSessionId;
          if (forkSource && !canFork) {
            ws.send(JSON.stringify({ type: "error", message: "Fork is only supported for Claude sessions" }));
            return;
          }

          const isAsk = forkSource ? forkSource.mode !== "code" : mode === "ask";
          // Optional model pick from the UI; invalid input falls back to default.
          // A fork inherits the source's model.
          const model = forkSource
            ? forkSource.model
            : msg.model
              ? resolveModel(String(msg.model))?.id
              : undefined;
          const isCodex = providerFor(model) === "codex";
          try {
            let wtPath: string;
            if (forkSource) {
              // Share the source's cwd so the fork sees the same code state.
              wtPath = forkSource.worktreeDir || `${HOME}/projects/tella-fusion`;
            } else if (isAsk) {
              // Ask sessions run read-only on the main checkout — no worktree
              wtPath = `${HOME}/projects/tella-fusion`;
            } else {
              // Check if worktree exists, create if needed
              const worktrees = await listWorktrees();
              wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
              if (!wtPath) {
                wtPath = await createWorktree(branch);
              }
            }

            const bksId = `bks-${randomUUIDv7()}`;
            const title = prompt.trim().split("\n")[0].slice(0, 80);

            ws.send(JSON.stringify({ type: "stream_start", sessionId: bksId }));

            let engineSessionId = "";
            let persisted = false;
            const persist = () => {
              const sessionData: BackstageSessionFile = {
                id: bksId,
                claudeSessionId: isCodex ? "" : engineSessionId,
                ...(isCodex && engineSessionId ? { codexThreadId: engineSessionId } : {}),
                ...(model ? { model } : {}),
                branch: forkSource ? forkSource.branch || "" : isAsk ? "" : branch,
                worktreeDir: wtPath,
                createdBy: user || "Anonymous",
                createdAt: new Date().toISOString(),
                lastActivity: new Date().toISOString(),
                title,
                mode: isAsk ? "ask" : "code",
              };
              writeFileSync(
                `${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
                JSON.stringify(sessionData, null, 2)
              );
              sessionsCache = null;
              persisted = true;
            };

            for await (const event of runAgent({
              prompt,
              cwd: wtPath,
              mode: isAsk ? "ask" : "code",
              model,
              images,
              // Fork: resume the source engine session into a new branch,
              // optionally from a specific past message.
              ...(canFork
                ? {
                    sessionId: forkSource!.claudeSessionId!,
                    forkSession: true,
                    resumeSessionAt: forkFrom?.messageId,
                  }
                : {}),
              inProcessMcp: interactiveMcpServers(user),
              confirmTools: STRIPE_CONFIRM_TOOLS,
              aws: true, // interactive sessions keep AWS read access (via injected creds)
              journal: { bksSessionId: bksId, kind: "create" },
              onAskUser: makeAskHandler(bksId),
            })) {
              if (event.type === "init") {
                engineSessionId = event.sessionId || "";
                // Persist immediately so the session is visible/shareable while running
                persist();
                ws.send(JSON.stringify({ type: "session_created", id: bksId }));
              }
              if (event.type === "text_chunk") {
                // Direct send for the creator (not in the room until they watch),
                // room broadcast for everyone else — never both to the same socket
                ws.send(JSON.stringify({ type: "stream_text", text: event.text }));
                broadcastToSession(bksId, { type: "stream_text", text: event.text }, ws);
              }
              if (event.type === "tool_use") {
                const entry = {
                  id: event.toolUseId || crypto.randomUUID(),
                  type: "tool_use" as const,
                  content: `Using ${event.toolName}`,
                  timestamp: new Date().toISOString(),
                  toolName: event.toolName,
                  toolInput: event.toolInput,
                  toolUseId: event.toolUseId,
                };
                ws.send(JSON.stringify({ type: "stream_tool_use", entry }));
                broadcastToSession(bksId, { type: "stream_tool_use", entry }, ws);
              }
              if (event.type === "tool_result") {
                const entry = {
                  id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
                  type: "tool_result" as const,
                  content: event.content || "",
                  timestamp: new Date().toISOString(),
                  toolUseId: event.toolUseId,
                  ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
                };
                ws.send(JSON.stringify({ type: "stream_tool_result", entry }));
                broadcastToSession(bksId, { type: "stream_tool_result", entry }, ws);
              }
              if (event.type === "done") {
                engineSessionId = event.sessionId || engineSessionId;
              }
              if (event.type === "error") {
                ws.send(JSON.stringify({ type: "error", message: event.content }));
              }
            }

            if (!persisted) persist();
            else
              touchBackstageSession(
                bksId,
                isCodex ? { codexThreadId: engineSessionId } : { claudeSessionId: engineSessionId }
              );

            ws.send(JSON.stringify({ type: "stream_done" }));
            broadcastToSession(bksId, { type: "stream_done" }, ws);
            broadcastToSession(bksId, { type: "session_status", isRunning: false });
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: e.message || String(e) }));
          }
          break;
        }
      }
    },

    close(ws) {
      stopAllWatchesForClient(ws);
      leaveSession(ws);
      console.log("WebSocket client disconnected");
    },
  },

  // Dev mode (HMR + error overlay + browser-console streaming) only when
  // explicitly asked for — the systemd service is production, and the overlay
  // pops "Script error." boxes on iOS with no diagnostics behind them.
  development:
    process.env.BACKSTAGE_DEV === "1"
      ? {
          hmr: true,
          console: true,
        }
      : false,
}));

console.log(`Backstage running at http://${HOST}:${PORT}/backstage/`);

// --- Session control surface (powers the michael-sessions MCP) ---
// Wires the MCP's tools into the same in-process state and helpers the
// WebSocket handlers use, so a management session steers/answers/creates the
// exact same way a human does in the web UI. See src/server/session-control.ts.
registerSessionControl({
  listSessions: () => getCachedSessions().map(buildSummary),

  getSession: (id) => {
    const s = findSession(id);
    return s ? buildSummary(s) : undefined;
  },

  transcriptTail: (id, n) => {
    const s = findSession(id);
    if (!s?.transcriptPath) return [];
    return parseTranscript(s.transcriptPath).slice(-Math.max(0, n));
  },

  answerQuestion: (id, answers) => {
    const pending = pendingAsks.get(id);
    if (!pending) return false;
    // resolve() clears the timeout, deletes the entry and unblocks makeAskHandler,
    // which broadcasts ask_resolved and lets the run continue with these answers.
    pending.resolve(answers && typeof answers === "object" ? answers : null);
    return true;
  },

  deliverToSession: async (id, content, user) => {
    const session = findSession(id);
    if (!session) return { status: "error" as const, message: "No session with that id." };
    const attributed = user ? `[${user}] ${content}` : content;

    if (isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id)) {
      // Busy + owned here → fold into the running turn (delivered at the next
      // stopping point). Otherwise queue and drain when the external run ends.
      if (steerAgentRun([session.claudeSessionId, session.codexThreadId, session.id], attributed)) {
        broadcastToSession(id, {
          type: "notice",
          message: `Message from ${user || "Michael"} folded into the run — picked up at the next stopping point.`,
        });
        return { status: "steered" as const, message: "Folded into the running turn." };
      }
      const queue = promptQueues.get(id) || [];
      queue.push({ content, user });
      promptQueues.set(id, queue);
      broadcastQueue(id);
      watchExternalRunAndDrain(id);
      return { status: "queued" as const, message: "Queued behind the current run." };
    }

    if (providerFor(session.model) === "claude" && !session.claudeSessionId) {
      return { status: "error" as const, message: "Session has no Claude session to resume yet." };
    }

    // Idle → start a fresh turn in the background; don't block the tool call on
    // the whole run finishing.
    void runSessionPromptAndDrain(id, content, user).catch((e) =>
      console.error(`[sessions-mcp] deliver to ${id} failed:`, e)
    );
    return { status: "started" as const, message: "Started a new turn on the session." };
  },

  cancelSession: (id) => {
    const session = findSession(id);
    if (!session) return false;
    const cancelled = cancelAgentRun(session.claudeSessionId, session.codexThreadId, session.id);
    const dropped = promptQueues.get(id)?.length || 0;
    if (dropped > 0) {
      promptQueues.delete(id);
      broadcastQueue(id);
    }
    return cancelled;
  },

  createSession: async ({ prompt, branch, mode, model: modelInput, user }) => {
    const isAsk = mode !== "code";
    const model = modelInput ? resolveModel(String(modelInput))?.id : undefined;
    const isCodex = providerFor(model) === "codex";

    let wtPath: string;
    if (isAsk) {
      wtPath = `${HOME}/projects/tella-fusion`;
    } else {
      const worktrees = await listWorktrees();
      wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
      if (!wtPath) wtPath = await createWorktree(branch!);
    }

    const bksId = `bks-${randomUUIDv7()}`;
    const title = prompt.trim().split("\n")[0].slice(0, 80);

    let engineSessionId = "";
    let persisted = false;
    const persist = () => {
      const sessionData: BackstageSessionFile = {
        id: bksId,
        claudeSessionId: isCodex ? "" : engineSessionId,
        ...(isCodex && engineSessionId ? { codexThreadId: engineSessionId } : {}),
        ...(model ? { model } : {}),
        branch: isAsk ? "" : branch || "",
        worktreeDir: wtPath,
        createdBy: user || "Michael",
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        title,
        mode: isAsk ? "ask" : "code",
      };
      writeFileSync(
        `${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
        JSON.stringify(sessionData, null, 2)
      );
      sessionsCache = null;
      persisted = true;
    };

    // Run in the background; watchers (web UI) see the live stream, the same as
    // a UI-created session. The tool returns the id immediately.
    void (async () => {
      try {
        for await (const event of runAgent({
          prompt,
          cwd: wtPath,
          mode: isAsk ? "ask" : "code",
          model,
          inProcessMcp: interactiveMcpServers(user),
          confirmTools: STRIPE_CONFIRM_TOOLS,
          aws: true,
          journal: { bksSessionId: bksId, kind: "create" },
          onAskUser: makeAskHandler(bksId),
        })) {
          if (event.type === "init") {
            engineSessionId = event.sessionId || "";
            persist();
          }
          if (event.type === "text_chunk") {
            broadcastToSession(bksId, { type: "stream_text", text: event.text });
          }
          if (event.type === "tool_use") {
            broadcastToSession(bksId, {
              type: "stream_tool_use",
              entry: {
                id: event.toolUseId || crypto.randomUUID(),
                type: "tool_use",
                content: `Using ${event.toolName}`,
                timestamp: new Date().toISOString(),
                toolName: event.toolName,
                toolInput: event.toolInput,
                toolUseId: event.toolUseId,
              },
            });
          }
          if (event.type === "tool_result") {
            broadcastToSession(bksId, {
              type: "stream_tool_result",
              entry: {
                id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
                type: "tool_result",
                content: event.content || "",
                timestamp: new Date().toISOString(),
                toolUseId: event.toolUseId,
                ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
              },
            });
          }
          if (event.type === "done") {
            engineSessionId = event.sessionId || engineSessionId;
          }
          if (event.type === "error") {
            broadcastToSession(bksId, { type: "error", message: event.content });
          }
        }
        if (!persisted) persist();
        else
          touchBackstageSession(
            bksId,
            isCodex ? { codexThreadId: engineSessionId } : { claudeSessionId: engineSessionId }
          );
        broadcastToSession(bksId, { type: "stream_done" });
        broadcastToSession(bksId, { type: "session_status", isRunning: false });
      } catch (e) {
        console.error(`[sessions-mcp] create session ${bksId} failed:`, e);
      }
    })();

    return { id: bksId };
  },
});

// --- Agent loading and webhook server ---

async function loadAgents(): Promise<AgentModule[]> {
  const agents: AgentModule[] = [];

  if (process.env.ENABLE_PLAIN_AGENT !== "false") {
    try {
      const { PlainAgent } = await import("./src/agents/plain/index");
      agents.push(new PlainAgent());
      console.log("[agents] Plain agent loaded");
    } catch (e) {
      console.error("[agents] Failed to load plain agent:", e);
    }
  }

  if (process.env.ENABLE_LINEAR_AGENT !== "false") {
    try {
      const { LinearAgent } = await import("./src/agents/linear/index");
      agents.push(new LinearAgent());
      console.log("[agents] Linear agent loaded");
    } catch (e) {
      console.error("[agents] Failed to load linear agent:", e);
    }
  }

  if (process.env.ENABLE_SLACK_AGENT !== "false") {
    try {
      const { SlackAgent } = await import("./src/agents/slack/index");
      agents.push(new SlackAgent());
      console.log("[agents] Slack agent loaded");
    } catch (e) {
      console.error("[agents] Failed to load slack agent:", e);
    }
  }

  // Gated on the signing secret: without it every webhook fails verification, so
  // there's no point exposing the route. Set STRIPE_WEBHOOK_SECRET to activate.
  if (process.env.ENABLE_STRIPE_AGENT !== "false" && process.env.STRIPE_WEBHOOK_SECRET) {
    try {
      const { StripeAgent } = await import("./src/agents/stripe/index");
      agents.push(new StripeAgent());
      console.log("[agents] Stripe agent loaded");
    } catch (e) {
      console.error("[agents] Failed to load stripe agent:", e);
    }
  }

  // Generic Grafana poller: drives every automation that carries a `grafanaPoll`
  // config (export failures, upload-processing failures, and any future signal
  // added as data). Gated on Grafana creds (the agent no-ops without them).
  if (process.env.ENABLE_GRAFANA_POLLER !== "false") {
    try {
      const { GrafanaPollerAgent } = await import("./src/agents/grafana-poller/index");
      agents.push(new GrafanaPollerAgent({ onSessionInvalidate: () => { sessionsCache = null; } }));
      console.log("[agents] Grafana poller loaded");
    } catch (e) {
      console.error("[agents] Failed to load grafana poller:", e);
    }
  }

  // GitHub PR agent: review / auto-fix / simplify on tella-fusion PRs. Receives
  // PR events forwarded from the Slack agent's /github/webhook; owns lifecycle
  // (seeds the disabled review automation, recovers interrupted fix loops).
  if (process.env.ENABLE_GITHUB_AGENT !== "false") {
    try {
      const { GithubAgent } = await import("./src/agents/github/index");
      agents.push(new GithubAgent({ onSessionInvalidate: () => { sessionsCache = null; } }));
      console.log("[agents] GitHub agent loaded");
    } catch (e) {
      console.error("[agents] Failed to load github agent:", e);
    }
  }

  return agents;
}

// One-time startup: agents, schedulers, recurring timers, and signal handlers.
// Guarded behind __backstageBooted so a `bun --hot` reload never double-starts
// any of it — the already-running agents/timers keep going untouched (only a
// real restart reloads their code, and that restart is now graceful, below).
if (!g.__backstageBooted) {
  // Start webhook server with enabled agents + automation webhook triggers
  agents = await loadAgents();
  g.__agents = agents;
  const webhookServer = startWebhookServer(
    agents,
    getWebhookRoutes(() => {
      sessionsCache = null;
    })
  );
  void webhookServer;

  // Seed cron-scheduled "sweep" loops (Production Error Sweep, …) as automations
  // before the scheduler starts. Create-if-absent, so UI edits are preserved.
  try {
    const { ensureSweepLoops } = await import("./src/agents/loops/sweep");
    ensureSweepLoops();
    const { ensureMonitors } = await import("./src/agents/loops/monitor");
    ensureMonitors();
    const { ensureSeoLoops } = await import("./src/agents/loops/seo");
    ensureSeoLoops();
    const { ensureStalePrMonitor } = await import("./src/agents/loops/stale-prs");
    ensureStalePrMonitor();
    const { ensureCronJobs } = await import("./src/agents/loops/cron-jobs");
    ensureCronJobs();
  } catch (e) {
    console.error("[loops] Failed to seed sweep/monitor/seo/stale-pr/cron loops:", e);
  }

  // Cron-scheduled automations + internal event bus (agents → automations)
  startScheduler(() => {
    sessionsCache = null;
  });
  setEventSessionCallback(() => {
    sessionsCache = null;
  });

  // Archive triage sessions when their Plain ticket is done
  startPlainArchiveSweep(() => {
    sessionsCache = null;
  });

  // Poll per-account Claude usage (drives account picking + the Connections UI)
  startUsagePoller();

  // Resume Claude runs a previous process left in-flight (restart/crash)
  setTimeout(() => {
    const resumed = resumeInterruptedRuns(() => {
      sessionsCache = null;
    });
    if (resumed > 0) {
      console.log(`[runner] Resumed ${resumed} interrupted run(s) from before restart`);
      sessionsCache = null;
    }
  }, 3000);

  // Ongoing hygiene (every 6h): archive sessions idle for more than a week,
  // then remove worktrees of archived sessions idle >14 days with no WIP.
  setInterval(
    async () => {
      const count = archiveOlderThan(getAllSessions(), 7);
      if (count > 0) {
        console.log(`[archive] Auto-archived ${count} session(s) idle >7 days`);
        sessionsCache = null;
      }
      try {
        const removed = await sweepArchivedWorktrees(getAllSessions(), 14);
        if (removed.length > 0) {
          console.log(
            `[worktree-sweep] Removed ${removed.length} clean worktree(s): ${removed.join(", ")}`
          );
          sessionsCache = null;
        }
      } catch (e) {
        console.error("[worktree-sweep] Sweep failed:", e);
      }
    },
    6 * 60 * 60 * 1000
  );

  // Run agent startup hooks
  for (const agent of agents) {
    try {
      await agent.startup();
      console.log(`[agents] ${agent.name} agent started`);
    } catch (e) {
      console.error(`[agents] ${agent.name} agent startup failed:`, e);
    }
  }

  // Graceful shutdown: stop taking new work, let in-flight runs reach a natural
  // stopping point (bounded), then exit — instead of killing every run mid-turn.
  // Anything still running after the drain window is picked up by the run
  // journal on the next boot (resumeInterruptedRuns), so nothing is lost.
  const DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS || "25000");
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} — stopping intake and draining in-flight runs…`);
    // Stop agents from accepting new work (Slack socket, webhook intake, …).
    for (const agent of agents) {
      try {
        await agent.shutdown();
      } catch (e) {
        console.error(`[shutdown] ${agent.name} shutdown error:`, e);
      }
    }
    // Stop accepting new HTTP/WS connections; existing ones can finish.
    try {
      server.stop();
    } catch {}
    // Wait for runner-driven runs (web UI / automations / loops) to settle.
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    let n = activeAgentRunCount();
    while (n > 0 && Date.now() < deadline) {
      console.log(`[shutdown] waiting on ${n} in-flight run(s)…`);
      await new Promise((r) => setTimeout(r, 500));
      n = activeAgentRunCount();
    }
    if (n > 0) {
      console.log(
        `[shutdown] ${n} run(s) still active after ${DRAIN_TIMEOUT_MS}ms — the journal will resume them on restart`
      );
    } else {
      console.log("[shutdown] all in-flight runs drained cleanly");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

  g.__backstageBooted = true;
}
