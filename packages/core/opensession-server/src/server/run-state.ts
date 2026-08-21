/**
 * Authoritative per-session run-state machine.
 *
 * The transition table remains pure and exhaustively tested. Runtime state is
 * committed by SessionKernel, which gives prompt admission, recovery, asks,
 * cancellation and executor events one durable answer to whether the session
 * is owned. Detached run hosts keep only a private ephemeral view: they report
 * events to the server and never write the session kernel database.
 */

import { audit } from "./audit";
import { clearSessionKernel, sessionKernel, sessionKernelStore } from "./session-kernel";

export {
	RUN_STATE_TRANSITIONS,
	nextRunState,
	type RunEvent,
	type RunState,
} from "./session-kernel/run-state-machine";
import {
	nextRunState,
	type RunEvent,
	type RunState,
} from "./session-kernel/run-state-machine";

export type RunStateEntry = {
	state: RunState;
	since: string;
	lastEvent?: RunEvent;
};

/** States that still own the session and must settle before a new turn starts. */
export function isRunStateUnsettled(state: RunState): boolean {
	return (
		state === "preparing" ||
		state === "starting" ||
		state === "running" ||
		state === "ask_blocked" ||
		state === "interrupted" ||
		state === "reattaching"
	);
}

const detachedHostStates = new Map<string, RunStateEntry>();
const detachedRunHost = () => !!process.env.OPENSESSION_RUN_JOURNAL;

export const runStates = {
	get(sessionId: string): RunStateEntry | undefined {
		if (detachedRunHost()) return detachedHostStates.get(sessionId);
		const current = sessionKernelStore().runState(sessionId);
		if (current.changeSeq === 0) return undefined;
		return {
			state: current.state as RunState,
			since: current.since,
			lastEvent: current.lastEvent as RunEvent | undefined,
		};
	},
};

export function getRunState(sessionId: string): RunState {
	if (detachedRunHost()) return detachedHostStates.get(sessionId)?.state ?? "idle";
	return sessionKernelStore().runState(sessionId).state as RunState;
}

type AuditEmit = (event: Record<string, unknown>) => void;

/**
 * Apply an event through the owning SessionKernel. A defined edge moves the
 * durable state and emits `run_state_transition`; an undefined one leaves the
 * state untouched and emits `run_state_rejected`.
 */
export function transitionRunState(
	sessionId: string,
	event: RunEvent,
	detail?: Record<string, unknown>,
	emit: AuditEmit = audit,
): RunState {
	if (detachedRunHost()) {
		const from = getRunState(sessionId);
		const to = nextRunState(from, event);
		if (!to) {
			console.warn(`[run-state] rejected: ${event} while ${from} (session ${sessionId})`);
			emit({ msg: "run_state_rejected", session_id: sessionId, state: from, event, ...detail });
			return from;
		}
		detachedHostStates.set(sessionId, {
			state: to,
			since: new Date().toISOString(),
			lastEvent: event,
		});
		emit({ msg: "run_state_transition", session_id: sessionId, from, to, event, ...detail });
		return to;
	}

	const runKey = typeof detail?.run_key === "string" ? detail.run_key : undefined;
	const decision = sessionKernel(sessionId).applyRunEvent({
		event,
		detail,
		runKey,
	});
	if (!decision.accepted) {
		if (decision.reason === "stale_run") {
			emit({
				msg: "stale_run_registration_rejected",
				session_id: sessionId,
				current_run_id: decision.currentRunId,
				rejected_run_id: decision.rejectedRunId,
				state: decision.from,
			});
		} else {
			console.warn(
				`[run-state] rejected: ${event} while ${decision.from} (session ${sessionId})`,
			);
			emit({
				msg: "run_state_rejected",
				session_id: sessionId,
				state: decision.from,
				event,
				...detail,
			});
		}
		return decision.from;
	}
	emit({
		msg: "run_state_transition",
		session_id: sessionId,
		from: decision.from,
		to: decision.to,
		event,
		...detail,
	});
	return decision.to;
}

/** Drop tracking for a deleted session. */
export function clearRunState(sessionId: string): void {
	if (detachedRunHost()) detachedHostStates.delete(sessionId);
	else clearSessionKernel(sessionId);
}
