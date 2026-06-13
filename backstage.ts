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
} from "./src/server/agent-runner";
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

function findSession(sessionId: string): UnifiedSession | undefined {
  return getCachedSessions().find((s) => s.id === sessionId);
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
const sessionWatchers = new Map<string, Set<any>>();

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
const pendingAsks = new Map<string, PendingAsk>();

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
const promptQueues = new Map<string, Array<{ content: string; user?: string }>>();

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
  user?: string
): Promise<void> {
  await runSessionPrompt(sessionId, content, user);
  await drainQueue(sessionId);
}

// Messages queued while a run we didn't start is in flight (Slack runs, CLI
// sessions in tmux, automations) have no drain loop of their own — watch the
// busy state and deliver the queue once the external run finishes.
const drainWatchers = new Set<string>();
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
async function runSessionPrompt(sessionId: string, content: string, user?: string): Promise<void> {
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
    mcpServers,
    deniedTools,
    confirmTools: STRIPE_CONFIRM_TOOLS,
    aws: true, // sessions keep AWS read access (via injected creds)
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

// Loop ticker: fire due session loops (skips busy/archived sessions)
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

console.log(`Starting Backstage server on ${HOST}:${PORT}...`);

const server = Bun.serve<WSClientData>({
  port: PORT,
  hostname: HOST,
  // The plain-triage route waits for worktree+session boot (~15-60s);
  // Bun's default 10s idleTimeout would drop the connection mid-wait
  idleTimeout: 240,

  routes: {
    "/backstage": homepage,
    "/backstage/": homepage,
    "/backstage/index.html": homepage,
    // Client-side routes must go through the bundled HTML import, not the raw file
    "/backstage/new": homepage,
    "/backstage/session/*": homepage,
    "/backstage/automations": homepage,
    "/backstage/wiki": homepage,
    "/backstage/wiki/*": homepage,
    "/backstage/connections": homepage,
    "/backstage/archived": homepage,
  },

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

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

          await runSessionPromptAndDrain(sessionId, content, user);
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
          const isAsk = mode === "ask";
          // Optional model pick from the UI; invalid input falls back to default
          const model = msg.model ? resolveModel(String(msg.model))?.id : undefined;
          const isCodex = providerFor(model) === "codex";
          try {
            let wtPath: string;
            if (isAsk) {
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
                branch: isAsk ? "" : branch,
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
});

console.log(`Backstage running at http://${HOST}:${PORT}/backstage/`);

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

  return agents;
}

// Start webhook server with enabled agents + automation webhook triggers
const agents = await loadAgents();
const webhookServer = startWebhookServer(
  agents,
  getWebhookRoutes(() => {
    sessionsCache = null;
  })
);

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
setInterval(async () => {
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
}, 6 * 60 * 60 * 1000);

// Run agent startup hooks
for (const agent of agents) {
  try {
    await agent.startup();
    console.log(`[agents] ${agent.name} agent started`);
  } catch (e) {
    console.error(`[agents] ${agent.name} agent startup failed:`, e);
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, shutting down agents...");
  for (const agent of agents) {
    try {
      await agent.shutdown();
    } catch (e) {
      console.error(`[shutdown] ${agent.name} shutdown error:`, e);
    }
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[shutdown] SIGINT received, shutting down agents...");
  for (const agent of agents) {
    try {
      await agent.shutdown();
    } catch (e) {
      console.error(`[shutdown] ${agent.name} shutdown error:`, e);
    }
  }
  process.exit(0);
});
