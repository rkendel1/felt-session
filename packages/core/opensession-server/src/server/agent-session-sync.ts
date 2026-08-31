/**
 * Engine-session sync for agent-owned Slack and Linear session stores.
 *
 * Those stores belong to the Slack/Linear loops and the server treats them as
 * read-only — with this one deliberate exception. When an interactive run on a
 * slack/linear-source session mints a NEW engine session id (first run, engine
 * rotation, or a cross-provider usage/infra fallback), the id previously lived
 * only in the runner's journal: the session file kept pointing at the dead
 * engine session, so the UI transcript froze there, queued prompts forked the
 * stale thread, and the owning loop's next turn resumed it too (2026-07-16,
 * slack-can-you-try: a mid-turn Opus→Sol fallback minted ses_09528e… while
 * both slack files still said ses_099d38…). The owning loops persist ids only
 * for runs THEY drive, so runs driven from the web UI must sync the store
 * themselves.
 *
 * Writes are surgical: only existing managed records are patched and only
 * the engine-session fields are touched. Pi engine ids get their own
 * `piSessionId` slot — pi uuids are
 * shape-indistinguishable from claude ids, so the claude slot alone can't
 * say which engine owns the id (the run-start arm in run-session resolved
 * undefined and minted a fresh pi session every web-UI turn) — while a
 * claude-slot mirror still rides along, because the owning loops' own resume
 * paths read that slot (slack handlers pass session.claudeSessionId). The
 * slack loop's in-memory session is updated too so a thread reply arriving
 * before its next disk load doesn't resurrect the stale id.
 */

import {
	activeSessions as slackActiveSessions,
	getSessionKey as slackSessionKey,
	loadSession as loadSlackSession,
	saveSession as saveSlackSession,
} from "../agents/slack/state";
import {
	loadSessionInfo as loadLinearSession,
	saveSessionInfo as saveLinearSession,
} from "../agents/linear/session";
import type { UnifiedSession } from "./types";

export interface EngineSessionPatch {
	engineSessionId?: string;
	/** Pi engine session id — lands in the file's own piSessionId slot AND
	 *  mirrors into the claude slot (see module doc). Callers pick this field
	 *  over engineSessionId when the run's provider is "pi". */
	piSessionId?: string;
	model?: string;
}

/**
 * Persist a new engine session id (and/or model) for a slack/linear-source
 * session. No-op for other sources and for empty patches. Returns true when
 * anything was actually written.
 */
export async function syncAgentSessionEngine(
	session: Pick<UnifiedSession, "id" | "source" | "branch" | "slackThread">,
	patch: EngineSessionPatch,
): Promise<boolean> {
	if (!patch.engineSessionId && !patch.piSessionId && !patch.model) return false;

	if (session.source === "slack") {
		const key = session.slackThread?.channel
			? slackSessionKey(session.slackThread.channel, session.slackThread.threadTs || undefined)
			: session.id.replace(/^slack-/, "");
		const stored = await loadSlackSession(key);
		if (!stored) return false;
		const nextEngineId = patch.piSessionId || patch.engineSessionId;
		const changed =
			(!!nextEngineId && stored.claudeSessionId !== nextEngineId) ||
			(!!patch.piSessionId && stored.piSessionId !== patch.piSessionId) ||
			(!!patch.model && stored.model !== patch.model);
		if (!changed) return false;
		if (patch.engineSessionId) stored.claudeSessionId = patch.engineSessionId;
		if (patch.piSessionId) {
			stored.piSessionId = patch.piSessionId;
			stored.claudeSessionId = patch.piSessionId;
		}
		if (patch.model) stored.model = patch.model;
		await saveSlackSession(stored);

		// The loop's live copy, so an in-flight thread doesn't fork the old id.
		if (session.slackThread?.channel) {
			const live = slackActiveSessions.get(
				slackSessionKey(session.slackThread.channel, session.slackThread.threadTs || undefined),
			);
			if (live) {
				if (patch.engineSessionId) live.claudeSessionId = patch.engineSessionId;
				// The loop's resume path reads claudeSessionId — the mirror is what
				// keeps its next thread-driven turn on the fresh pi session.
				if (patch.piSessionId) live.claudeSessionId = patch.piSessionId;
				if (patch.model) live.model = patch.model;
			}
		}
		return true;
	}

	if (session.source === "linear") {
		if (!session.branch) return false;
		const stored = await loadLinearSession(session.branch);
		if (!stored) return false;
		const nextEngineId = patch.piSessionId || patch.engineSessionId;
		const changed =
			(!!nextEngineId && stored.claudeSessionId !== nextEngineId) ||
			(!!patch.model && stored.model !== patch.model);
		if (!changed) return false;
		await saveLinearSession(session.branch, {
			...(nextEngineId ? { claudeSessionId: nextEngineId } : {}),
			...(patch.piSessionId ? { piSessionId: patch.piSessionId } : {}),
			...(patch.model ? { model: patch.model } : {}),
		});
		return true;
	}

	return false;
}
