import { describe, expect, test } from "bun:test";
import { makeSubagentStallGuard } from "./opencode-runner";

// Regression tests for the 2026-08-03 bks-019fc798 wedge: a task child whose
// provider request hung emitted only housekeeping events (session.status
// retry ticks, session.updated bumps — the SSE envelope carries a top-level
// sessionID), each of which reset the family silence clock, so the guard sat
// armed for 25 minutes and never fired. Only CONTENT flow may reset the clock.

const PARENT = "ses_parent";
const CHILD = "ses_child";

function makeGuard() {
	return makeSubagentStallGuard(PARENT, () => {});
}

function partEvent(sessionID: string, part: Record<string, unknown>) {
	return {
		type: "message.part.updated",
		properties: { sessionID, part: { sessionID, ...part } },
	};
}

describe("makeSubagentStallGuard.noteEvent", () => {
	test("content events reset the silence clock; housekeeping does not", () => {
		const guard = makeGuard();
		const t0 = Date.now();

		guard.noteEvent(partEvent(PARENT, { id: "prt1", type: "tool", tool: "task" }));
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);

		// session.status / session.updated for the parent carry a top-level
		// sessionID but are NOT progress — the clock must keep running.
		guard.noteEvent({ type: "session.status", properties: { sessionID: PARENT, status: { type: "retry" } } });
		guard.noteEvent({ type: "session.updated", properties: { sessionID: PARENT, info: { id: PARENT } } });
		guard.noteEvent({ type: "permission.asked", properties: { sessionID: PARENT } });
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);

		// Real content resets it.
		guard.noteEvent(partEvent(PARENT, { id: "prt2", type: "text", text: "hi" }));
		expect(guard.quietFor(Date.now())).toBeLessThan(1_000);
	});

	test("retry parts do not reset the clock, even for family sessions", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteEvent(partEvent(PARENT, { id: "prt-retry", type: "retry", attempt: 3 }));
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);
	});

	test("tracks task children transitively and answers isFamily", () => {
		const guard = makeGuard();
		guard.noteEvent({
			type: "session.created",
			properties: { sessionID: CHILD, info: { id: CHILD, parentID: PARENT } },
		});
		expect(guard.isFamily(PARENT)).toBe(true);
		expect(guard.isFamily(CHILD)).toBe(true);
		expect(guard.isFamily("ses_other")).toBe(false);

		// A grandchild registers through the child.
		guard.noteEvent({
			type: "session.updated",
			properties: { sessionID: "ses_gc", info: { id: "ses_gc", parentID: CHILD } },
		});
		expect(guard.isFamily("ses_gc")).toBe(true);

		// Child content resets the clock.
		const before = guard.quietFor(Date.now() + 60_000);
		guard.noteEvent(partEvent(CHILD, { id: "prt3", type: "reasoning", text: "…" }));
		expect(guard.quietFor(Date.now())).toBeLessThan(before);
	});

	test("non-family content does not reset the clock", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteEvent(partEvent("ses_unrelated", { id: "prt4", type: "text", text: "x" }));
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);
	});
});

describe("makeSubagentStallGuard.noteTool", () => {
	test("open task tools are tracked until completed or errored", () => {
		const guard = makeGuard();
		guard.noteTool({ id: "task1", tool: "task", state: { status: "running" } });
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "running" } });
		guard.noteTool({ id: "task1", tool: "task", state: { status: "completed" } });
		// No public accessor for openTasks; this at least exercises the state
		// transitions without throwing. The firing behavior is covered by the
		// evaluate() tests below.
		expect(guard.isFamily(PARENT)).toBe(true);
	});
});

// Regression tests for the 2026-08-06 os-019fd67b wedge: a bash call that
// launched a detached Chrome never resolved (the child inherited the tool's
// stdout/stderr pipe), no task child and no retries were involved, and the
// turn sat silent for 2h52m until the wall-clock deadline. Any open non-task
// tool with family-wide silence past the tool window must end the turn.
describe("makeSubagentStallGuard.evaluate (tool stalls)", () => {
	const TASK_WINDOW = 600_000; // SUBAGENT_STALL_MS default
	const TOOL_WINDOW = 1_200_000; // TOOL_STALL_MS default

	test("an open non-task tool fires kind=tool after the tool window", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteTool({
			id: "bash1",
			tool: "bash",
			state: { status: "running", input: { command: "setsid -f google-chrome --remote-debugging-port=9346" } },
		});
		expect(guard.evaluate(t0 + TOOL_WINDOW - 60_000)).toBeNull();
		const verdict = guard.evaluate(t0 + TOOL_WINDOW + 60_000);
		expect(verdict?.kind).toBe("tool");
		expect(verdict?.openToolLabels.join("")).toContain("bash: setsid -f google-chrome");
	});

	test("a completed tool no longer fires", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "running" } });
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "completed" } });
		expect(guard.evaluate(t0 + TOOL_WINDOW * 2)).toBeNull();
	});

	test("an open task fires the task lane first, ahead of the tool lane", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteTool({ id: "task1", tool: "task", state: { status: "running" } });
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "running" } });
		const verdict = guard.evaluate(t0 + TOOL_WINDOW + 60_000);
		expect(verdict?.kind).toBe("task");
		expect(verdict?.openTaskIds).toEqual(["task1"]);
	});

	test("the task lane still fires at its own (shorter) window", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteTool({ id: "task1", tool: "task", state: { status: "running" } });
		expect(guard.evaluate(t0 + TASK_WINDOW + 60_000)?.kind).toBe("task");
	});

	test("a pending permission ask pauses the clock; resolution restarts it", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "running" } });
		guard.noteAskPending(1);
		expect(guard.evaluate(t0 + TOOL_WINDOW * 3)).toBeNull();
		guard.noteAskPending(-1);
		// The human's wait must not count toward silence: clock restarted at
		// resolution, so the verdict stays null until a fresh window elapses.
		expect(guard.evaluate(Date.now() + TOOL_WINDOW - 60_000)).toBeNull();
		expect(guard.evaluate(Date.now() + TOOL_WINDOW + 60_000)?.kind).toBe("tool");
	});

	test("family content resets the tool-stall clock too", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "running" } });
		guard.noteEvent(partEvent(PARENT, { id: "prt-x", type: "text", text: "still going" }));
		expect(guard.evaluate(t0 + TOOL_WINDOW - 60_000)).toBeNull();
	});
});
