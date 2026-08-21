import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { duration, ease } from "../../ui/motion";
import { TranscriptSkeleton } from "../../ui/state";
import { PageLoader } from "../../ui/page-loader";
import { PulseDot } from "../../ui/status";
import { cn } from "../../ui/cn";
import { msgRow } from "../../lib/msg-classes";

export function WorkspaceWaiting({ detail }: { detail: string }) {
	return (
		<div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
			<PageLoader className="mb-2 text-dim" />
			<div className="text-item-title font-semibold text-fg">
				Setting up your workspace
			</div>
			<div className="max-w-[340px] text-label font-medium leading-relaxed text-dim">
				{detail}
			</div>
		</div>
	);
}

export function ConversationLoading() {
	// Held back for a beat: most transcripts arrive fast enough that a
	// placeholder would flash and go, which is more distracting than the empty
	// canvas it replaced. Only a load slow enough to notice gets stood in for.
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => setVisible(true), 180);
		return () => clearTimeout(t);
	}, []);
	if (!visible) return <div className="min-h-full" />;
	// The fade sits on the wrapper, not on the skeleton: Motion writes inline
	// opacity, which the ghosts' own breathing animation would overwrite.
	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ type: "tween", duration: duration.base, ease }}
		>
			<TranscriptSkeleton />
		</motion.div>
	);
}

// Ticking elapsed-time label for the busy dot row. Self-ticking
// so the 10Hz re-render stays inside this tiny span, not the whole viewer.
function BusyElapsed({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(t);
	}, []);
	const s = Math.max(0, now - since) / 1000;
	let label: string;
	if (s < 60) label = `${s.toFixed(1)}s`;
	else if (s < 3600)
		label = `${Math.floor(s / 60)}m, ${(s % 60).toFixed(1)}s`;
	else label = `${Math.floor(s / 3600)}h, ${Math.floor((s % 3600) / 60)}m`;
	// Tabular figures so a 10Hz counter doesn't jitter its own width.
	return <span className="text-meta text-faint tabular-nums">{label}</span>;
}

// How long a steer may wait before the chip starts showing how long it has
// waited. Under this, the counter would be noise on a fold-in that is about to
// land anyway; over it, the silence is what reads as a hang.
const STEER_SLOW_MS = 5000;

/**
 * A steer the run has accepted but not yet read. pi's agent loop drains its
 * steering queue only between turns, after the current assistant message AND
 * its whole tool batch finish, so this wait is the remainder of whatever the
 * agent is doing right now: usually seconds, but a `bun test` or a subagent
 * holds it for minutes (measured p90 85s, max 385s over two days).
 *
 * The counter appears only once the wait is long enough to worry about, and it
 * counts up rather than predicting a landing time, because nothing here knows
 * how long the running tool will take. A still chip saying "Steered" was the
 * bug: it claimed delivery during the only window in which delivery had not
 * happened, since the receipt is reconciled away as soon as it has.
 */
export function SteerWaiting({ since }: { since?: number }) {
	const [waited, setWaited] = useState(() =>
		since ? Date.now() - since : 0,
	);
	useEffect(() => {
		if (!since) return;
		setWaited(Date.now() - since);
		const t = setInterval(() => setWaited(Date.now() - since), 1000);
		return () => clearInterval(t);
	}, [since]);
	// An old receipt restored across a restart has no stamp; showing nothing is
	// better than showing a made-up zero.
	if (!since || waited < STEER_SLOW_MS) return null;
	const s = Math.floor(waited / 1000);
	const label =
		s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
	return <span className="font-normal tabular-nums opacity-70">{label}</span>;
}

// How long a stop may sit there before the label stops sounding confident.
const STOP_SLOW_MS = 5000;

/**
 * The stop has been asked for, the turn has not settled yet. This deliberately
 * counts nothing: freezing the work timer at click time would be a small lie
 * (the engine really is still unwinding its current tool call), and letting it
 * run is the complaint we are fixing. After STOP_SLOW_MS the wording admits
 * the abort has not landed rather than sitting on a hopeful "Stopping…"
 * forever — the one thing this row must never do is claim the agent has
 * stopped while it is still editing files.
 */
function BusyStopping({ since }: { since: number }) {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const waited = Date.now() - since;
		setSlow(waited >= STOP_SLOW_MS);
		if (waited >= STOP_SLOW_MS) return;
		const t = setTimeout(() => setSlow(true), STOP_SLOW_MS - waited);
		return () => clearTimeout(t);
	}, [since]);
	return (
		<span className="text-meta text-faint">
			{slow ? "Still stopping…" : "Stopping…"}
		</span>
	);
}

export function BusyInline({
	since,
	stoppingSince,
}: {
	since: number | null;
	stoppingSince: number | null;
}) {
	return (
		<div
			className={cn(
				msgRow,
				"mt-0.5 flex-row items-center gap-2 px-1 py-1.25 text-dim",
			)}
		>
			{/* The 8px pull hangs off the DOT, not off the row: msgRow centres
			    itself in the reading column with `mx-auto`, and a `-ml-2` on the
			    row overrides that auto (Tailwind emits `margin-left` after
			    `margin-inline`), leaving `margin-right: auto` to shove the whole
			    row against the scroller's left gutter. Here it lands the dot's
			    centre on the work fold's chevron, which hangs out by the same
			    8px from a box that stays centred. */}
			<span className="-ml-2 grid size-5 shrink-0 place-items-center">
				<PulseDot size={7} />
			</span>
			{stoppingSince != null ? (
				<BusyStopping since={stoppingSince} />
			) : (
				since != null && <BusyElapsed since={since} />
			)}
		</div>
	);
}
