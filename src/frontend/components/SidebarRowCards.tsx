import React, { useState } from "react";
import type { OsReview, SupportThread, UnifiedSession } from "../lib/types";
import type { ReviewQueueItem } from "../lib/review-queue";
import { relativeTime, type OpenPr } from "../lib/api";
import { providerFromUrl } from "../lib/provider";
import { plainThreadUrl } from "./PlainThreadPanel";
import { IconGitMerge } from "./icons";

/**
 * Hover cards for the sidebar's non-workspace rows.
 *
 * Workspace rows have had a dwell card for a while (WsHoverCard in
 * Sidebar.tsx); this gives the Pull requests and Support bands the same
 * affordance, so every sidebar row can answer "what is this, and what does it
 * need?" without a click. The typography reuses the legacy `hovercard-*`
 * classes so all three cards read as one family — but the panel chrome,
 * positioning and lifecycle come from ui/popover.tsx instead of the older
 * card's hand-rolled portal, viewport clamping and dwell timers.
 */

/** Matches .sidebar-hovercard's width, padding, radius and shadow. */
export const ROW_CARD_CLASS =
	"w-[min(300px,calc(100vw-24px))] rounded-[16px] border border-line-strong bg-panel px-[13px] pt-[11px] pb-3 text-fg shadow-[0_8px_30px_rgba(0,0,0,0.45)] max-[720px]:hidden";

/**
 * Hover-only card wiring for a sidebar row.
 *
 * A row's click already does something (select the PR / open the ticket), so
 * the card may only be raised by hovering: a press that toggled it open would
 * put a card over the view the same tap just opened — which is exactly what
 * touch does, where every tap is a press. Blocking non-hover opens keeps
 * mobile behaving as it did before the card existed.
 */
export function useRowHoverCard() {
	const [open, setOpen] = useState(false);
	return {
		rootProps: {
			open,
			onOpenChange: (next: boolean, details: { reason?: string }) => {
				if (next && details.reason !== "trigger-hover") return;
				setOpen(next);
			},
		},
		/** Spread onto Popover.Trigger. Dwell is longer than a tooltip's: rows
		 *  are dense, and the card shouldn't chase a pointer crossing the list. */
		triggerProps: { openOnHover: true as const, delay: 320, closeDelay: 90 },
		close: () => setOpen(false),
	};
}

function CardRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
	if (rows.length === 0) return null;
	return (
		<div className="hovercard-rows mt-[9px] flex flex-col gap-[3px]">
			{rows.map(([label, value], i) => (
				<div className="hovercard-row flex gap-2 text-label leading-[1.35]" key={i}>
					<span className="hovercard-label w-[74px] shrink-0 text-faint">{label}</span>
					<span className="hovercard-value min-w-0 truncate text-dim">{value}</span>
				</div>
			))}
		</div>
	);
}

function CardFooter({
	link,
	time,
	timeTitle,
}: {
	link?: React.ReactNode;
	time: string;
	timeTitle?: string;
}) {
	return (
		<div className="mt-2.5 flex min-w-0 items-center gap-2 border-t border-line pt-2">
			{link}
			<span className="ml-auto shrink-0 text-label text-faint" title={timeTitle}>
				{time}
			</span>
		</div>
	);
}

// ── Pull request ────────────────────────────────────────────────────────────

function prettyReview(d: string): string {
	if (d === "APPROVED") return "approved";
	if (d === "CHANGES_REQUESTED") return "changes requested";
	if (d === "REVIEW_REQUIRED") return "review required";
	return d.toLowerCase().replace(/_/g, " ");
}

/**
 * The automated review's verdict, worded exactly as its PR comment words it
 * ("approve · 4/5"), so the card and the comment can't be read as two different
 * judgements. Tone follows the verdict; a review the branch has moved past goes
 * faint and says so rather than lending a stale score the same weight.
 */
export function osReviewLabel(review: OsReview): React.ReactNode {
	const tone =
		review.verdict === "approve"
			? "text-green"
			: review.verdict === "request_changes"
				? "text-red"
				: "text-dim";
	const parts = [
		review.verdict ? review.verdict.replace(/_/g, " ") : "reviewed",
		typeof review.confidence === "number" ? `${review.confidence}/5` : "",
		review.blocking > 0 ? `${review.blocking} blocking` : "",
		review.stale ? "stale" : "",
	].filter(Boolean);
	return (
		<span
			className={review.stale ? "text-faint" : tone}
			title={
				review.stale
					? `Reviewed ${relativeTime(review.at)}, on a commit this branch has moved past`
					: `Reviewed ${relativeTime(review.at)}`
			}
		>
			{parts.join(" · ")}
		</span>
	);
}

function checksLabel(checks: OpenPr["checks"]): React.ReactNode {
	if (!checks || checks.total === 0) return null;
	if (checks.failed > 0)
		return <span className="text-red">{checks.failed} failing</span>;
	if (checks.pending > 0)
		return <span className="text-yellow">{checks.pending} running</span>;
	return <span className="text-green">all {checks.total} passing</span>;
}

/** A status worth calling out in the card's callout strip rather than a row. */
function prProblem(item: ReviewQueueItem): string | null {
	const s = item.status;
	if (!s) return null;
	if (
		s.includes("failing") ||
		s === "Merge conflict" ||
		s === "Changes requested"
	)
		return s;
	return null;
}

/** The queue's own status, said out loud. The ready bucket's raw statuses are
 *  internal shorthand ("Green"), so they get spelled out here. */
function prState(item: ReviewQueueItem): { label: string; tone: string } | null {
	if (item.bucket === "ready")
		return {
			label:
				item.status === "Approved"
					? "Approved — ready to merge"
					: "Ready to merge",
			tone: "green",
		};
	if (!item.status) return null;
	return {
		label: item.status,
		tone: item.bucket === "attention" ? "yellow" : "dim",
	};
}

/** The card body for a Pull requests row. Everything comes off the already
 *  loaded queue item — like SessionHoverCard, the card fetches nothing. */
export function PrRowCard({ item }: { item: ReviewQueueItem }) {
	const pr = item.pr;
	const problem = prProblem(item);
	const state = prState(item);
	const rows: Array<[string, React.ReactNode]> = [
		["Author", pr.author],
		["Repo", pr.repo],
	];
	if (pr.reviewDecision)
		rows.push(["Review", prettyReview(pr.reviewDecision)]);
	if (pr.osReview) rows.push(["OS review", osReviewLabel(pr.osReview)]);
	const checks = checksLabel(pr.checks);
	if (checks) rows.push(["Checks", checks]);
	if (pr.reviewRequested?.length)
		rows.push(["Requested", pr.reviewRequested.join(", ")]);
	rows.push(["Opened", relativeTime(pr.createdAt)]);

	return (
		<>
			<div className="hovercard-head flex min-w-0 items-center gap-[7px]">
				<span className="hovercard-branch min-w-0 flex-1 truncate text-label text-dim">{pr.branch}</span>
				{pr.isDraft && (
					<span className="shrink-0 text-label text-faint">draft</span>
				)}
				<span className="flex shrink-0 items-center">
					{item.bucket === "ready" ? (
						<IconGitMerge className="text-green" size={20} />
					) : (
						<span
							className={`size-[7px] rounded-full ${
								item.bucket === "attention" ? "bg-yellow" : "bg-faint"
							}`}
						/>
					)}
				</span>
			</div>

			<div className="hovercard-title mt-[5px] text-control-label font-semibold leading-[1.3]">{pr.title}</div>

			{problem ? (
				<div className="hovercard-callout mt-[7px] rounded-sm bg-accent-soft px-2 py-[5px] text-label text-dim">{problem}</div>
			) : (
				state && (
					<div className={`hovercard-state mt-[3px] text-label font-medium hovercard-state-${state.tone}`}>
						{state.label}
					</div>
				)
			)}

			{pr.reviewActive && (
				<div className="hovercard-callout mt-[7px] rounded-sm bg-accent-soft px-2 py-[5px] text-label text-dim">
					An automated review is still running.
				</div>
			)}

			<CardRows rows={rows} />

			<CardFooter
				link={
					<a
						href={pr.url}
						target="_blank"
						rel="noopener noreferrer"
						title={`Open on ${providerFromUrl(pr.url).name}`}
						className="hovercard-mono shrink-0 text-meta text-dim hover:underline"
					>
						#{pr.number} ↗
					</a>
				}
				time={`Updated ${relativeTime(pr.updatedAt)}`}
				timeTitle={new Date(pr.updatedAt).toLocaleString()}
			/>
		</>
	);
}

// ── Support ticket ──────────────────────────────────────────────────────────

// Mirrors SUPPORT_PRIORITY_GROUPS in Sidebar.tsx (Plain priorities are ints
// 0..3, unset buckets as Normal); kept local so the card file doesn't import
// the sidebar that renders it.
const PRIORITY_META: Record<number, { label: string; cls: string }> = {
	0: { label: "Urgent", cls: "text-red" },
	1: { label: "High", cls: "text-yellow" },
	2: { label: "Normal", cls: "text-blue" },
	3: { label: "Low", cls: "text-faint" },
};

/** The card body for a Support row. `previewText` is the ticket's equivalent
 *  of the workspace card's latest-message line — the "where things stand"
 *  snippet that makes the queue skimmable without opening each thread. */
export function SupportRowCard({
	thread: t,
	session,
}: {
	thread: SupportThread;
	session: UnifiedSession | null;
}) {
	const customer = t.customer.name || t.customer.email || "Unknown";
	const priority = PRIORITY_META[t.priority ?? 2] || PRIORITY_META[2];
	const preview = (t.previewText || "").replace(/\s+/g, " ").trim();
	const labels = t.labels || [];
	const stamp = t.statusChangedAt || t.createdAt;

	const rows: Array<[string, React.ReactNode]> = [];
	// Plain often stores the address as the name too, so only spell the email
	// out when the head isn't already showing it.
	if (t.customer.email && t.customer.email !== customer)
		rows.push(["Email", t.customer.email]);
	rows.push([
		"Assignee",
		t.assignee ? t.assignee.name : <span className="text-faint">unassigned</span>,
	]);
	if (session) rows.push(["Session", session.title]);
	if (t.createdAt) rows.push(["Opened", relativeTime(t.createdAt)]);

	return (
		<>
			<div className="hovercard-head flex min-w-0 items-center gap-[7px]">
				<span className="hovercard-branch min-w-0 flex-1 truncate text-label text-dim">{customer}</span>
				<span className={`shrink-0 text-label ${priority.cls}`}>
					{priority.label}
				</span>
			</div>

			<div className="hovercard-title mt-[5px] text-control-label font-semibold leading-[1.3]">{t.title || customer}</div>

			{preview && (
				<div className="selectable mt-1 text-meta leading-snug text-dim line-clamp-3">
					{preview}
				</div>
			)}

			{labels.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1">
					{labels.map((l) => (
						<span
							key={l.id}
							className="rounded-sm border border-line bg-surface px-1.5 py-0.5 text-meta text-dim"
						>
							{l.icon ? `${l.icon} ` : ""}
							{l.name}
						</span>
					))}
				</div>
			)}

			<CardRows rows={rows} />

			<CardFooter
				link={
					<a
						href={plainThreadUrl(t.id)}
						target="_blank"
						rel="noopener noreferrer"
						className="shrink-0 text-meta text-dim hover:underline"
					>
						Open in Plain ↗
					</a>
				}
				time={stamp ? relativeTime(stamp) : ""}
				timeTitle={stamp ? new Date(stamp).toLocaleString() : undefined}
			/>
		</>
	);
}
