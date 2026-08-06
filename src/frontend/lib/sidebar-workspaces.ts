import type { UnifiedSession } from "./types";

export function isScratchWorkspace(
	sessions: readonly Pick<UnifiedSession, "mode">[],
): boolean {
	return sessions.length > 0 && sessions.every((session) => session.mode === "scratch");
}
