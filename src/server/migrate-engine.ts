/**
 * Migrate a opensession session onto the OpenCode engine — the "flip the model,
 * let the next turn hand off" affordance behind the opensession-sessions
 * `migrate_session_engine` tool and scripts/migrate-sessions-to-opencode.ts.
 *
 * Deliberately does NOT start a run: it only sets `session.model` to an
 * opencode/* id (recording the switch in modelHistory, exactly like a /model
 * command). The session's NEXT prompt takes the normal cross-provider path in
 * runSessionPromptInner: lastEngineProvider ≠ "opencode" ⇒ the prior engine's
 * transcript (claude jsonl / codex rollout) becomes an engine-switch handoff
 * note, a fresh OpenCode session starts carrying it, and the new id is
 * persisted in `opencodeSessionId`. The session keeps its file, workspace,
 * branch, title and UI history — only the engine changes.
 *
 * Hard gates (fail closed):
 *  - automation-owned sessions: the opencode runner deny-by-default gate
 *    refuses automation runs, so flipping their model would just brick them.
 *  - sessions with an in-flight run (per the shared run journal): flipping the
 *    model mid-turn races the run's own end-of-turn session patch.
 *  - targets that don't resolve to the opencode provider.
 */
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { resolveModel } from "./models";
import type { ActiveRunRecord } from "./run-journal";
import type { NativeSessionFile } from "./types";

export type MigrateEngineResult =
  | { ok: true; sessionId: string; from?: string; to: string }
  | { ok: false; error: string };

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : null;
  } catch {
    return null;
  }
}

/** Journal read (file-level, not via claude-runner's in-memory maps) so this
 *  module stays import-light and usable from standalone scripts. */
function journaledRuns(): ActiveRunRecord[] {
  const path =
    process.env.OPENSESSION_RUN_JOURNAL ||
    `${OPENSESSION_SESSIONS_DIR}/active-runs.json`;
  const journal = readJson<Record<string, ActiveRunRecord>>(path);
  return journal ? Object.values(journal) : [];
}

export function isAutomationOwnedSession(
  data: Pick<NativeSessionFile, "automation" | "createdBy">
): boolean {
  return !!data.automation || !!data.createdBy?.endsWith(" (automation)");
}

/** Whether the shared run journal shows an in-flight run for this session. */
export function sessionHasJournaledRun(
  sessionId: string,
  data?: Pick<
    NativeSessionFile,
    "claudeSessionId" | "codexThreadId" | "opencodeSessionId" | "piSessionId"
  >
): boolean {
  const engineIds = new Set(
    [
      sessionId,
      data?.claudeSessionId,
      data?.codexThreadId,
      data?.opencodeSessionId,
      data?.piSessionId,
    ].filter(Boolean) as string[]
  );
  return journaledRuns().some(
    (r) =>
      (r.osSessionId && engineIds.has(r.osSessionId)) ||
      (r.claudeSessionId && engineIds.has(r.claudeSessionId)) ||
      engineIds.has(r.runKey)
  );
}

/**
 * Flip a opensession session's model to an opencode/* id so its next turn
 * migrates onto the OpenCode engine via the transcript handoff. Pure
 * session-file operation — see module doc for what it deliberately doesn't do.
 */
export function migrateSessionEngine(
  sessionId: string,
  targetModel: string,
  by = "engine-migration"
): MigrateEngineResult {
  const path = `${OPENSESSION_SESSIONS_DIR}/${sessionId}.json`;
  const data = readJson<NativeSessionFile>(path);
  if (!data?.id) {
    return { ok: false, error: `No opensession session file for "${sessionId}".` };
  }

  const resolved = resolveModel(targetModel);
  if (!resolved || resolved.provider !== "opencode") {
    return {
      ok: false,
      error:
        `"${targetModel}" is not an opencode engine model — expected ` +
        "opencode/<provider>/<model>, e.g. opencode/anthropic/claude-sonnet-5.",
    };
  }

  if (isAutomationOwnedSession(data)) {
    return {
      ok: false,
      error:
        `Session ${sessionId} is automation-owned ("${data.automation || data.createdBy}") — ` +
        "the opencode engine hard-gates automation runs off, so migrating it would only break its runs.",
    };
  }

  if (sessionHasJournaledRun(sessionId, data)) {
    return {
      ok: false,
      error: `Session ${sessionId} has an in-flight run — let it finish (or cancel it) before migrating.`,
    };
  }

  if (data.model === resolved.id) {
    return { ok: true, sessionId, from: data.model, to: resolved.id };
  }

  const from = data.model;
  writeJsonAtomic(path, {
    ...data,
    model: resolved.id,
    modelHistory: [
      ...(data.modelHistory || []),
      { model: resolved.id, from, at: new Date().toISOString(), by },
    ],
    lastActivity: new Date().toISOString(),
  });
  return { ok: true, sessionId, from, to: resolved.id };
}
