import { AGENT_NAME, GITHUB_BOT_NAME } from "../lib/brand";
import { BASE_PATH } from "../lib/base";
import { commitPrompt } from "../lib/commit-prompt";
import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useResolvedTheme } from "./CodeHighlight";
import {
	fetchDiff,
	fetchPr,
	fetchGitStatus,
	gitPushApi,
	gitPullApi,
	mergePrApi,
	setSessionReviewerApi,
	acceptReviewApi,
	triggerPrActionApi,
	type PrAgentAction,
	type WorkspaceMediaItem,
	type WorkspaceOverview,
	type SessionAssetFile,
} from "../lib/api";
import {
	pollWhileVisible,
	PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import { getCurrentUser, TEAM, useCurrentUser } from "./UserPicker";
import { useReviewTeams } from "../lib/people";
import { UserAvatar } from "./UserAvatar";
import { Menu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import type {
	DiffFile,
	GitStatusInfo,
	PrDetails,
	UnifiedSession,
} from "../lib/types";
import { formatPrCommentPrompt } from "./PrPanel";
import { renderMarkdown } from "../lib/markdown";
import { isOutdatedReviewComment } from "../lib/pr-comments";
import {
	personKey,
	reviewRequestTargetsPerson,
} from "../lib/review-queue";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import {
	loadOverview,
	overviewCache,
	type OverviewSessionRef,
} from "../lib/workspace-overview";
import { summarizeChecks } from "./PrStatusBar";
import {
	type CheckVisual,
	checkStatusMeta,
	checkToneClass,
} from "../lib/pr-checks";
import {
	GIT_ACTION,
	GIT_DOT,
	GIT_DOT_BG,
	GIT_LABEL,
	GIT_NOTE,
	GIT_ROW,
} from "../lib/pr-tone-classes";
import { CheckStatusIcon } from "./CheckStatusIcon";
import { openLightbox } from "./MediaLightbox";
import { repoLabel } from "./RepoTile";
import { SandboxBadge } from "./SandboxBadge";
import {
	IconBell,
	IconCheck,
	IconChevronDown,
	IconClock,
	IconFile,
	IconPlay,
	IconPullRequest,
	IconSparkle,
	IconStack,
	IconX,
} from "./icons";

/**
 * Workspace info block at the top of the right side panel (the "Info" tab): a
 * dense, at-a-glance catch-all - title + meta, workspace actions, local git
 * state, PR comments, changed files, and a compact filmstrip of every screenshot
 * / video from the workspace's sessions. PR state and local git deltas share one
 * compact Git status section; the transcript remains the opening-prompt source.
 *
 * Loading/caching for the overview lives in lib/workspace-overview (shared with
 * the sidebar's workspace hover card), including the pre-restart transcript
 * fallbacks. The PR is fetched here and refreshed on a slow interval.
 */

type PanelTab = "changes" | "pr" | "staging" | "assets";

type ReviewRequestInfo = {
	to: string;
	recipients?: string[];
	by: string;
	at: string;
	accepted?: { by: string; at: string };
};

interface Props {
	/** The open session's session id — anchors the PR + Slack fetches. */
	sessionId: string;
	/** The session's workspace (workspaceId); null = workspace-less (fallback only). */
	workspaceId: string | null;
	workspaceName?: string;
	/** Sibling sessions, oldest first (the tab strip's list). */
	sessions: Array<OverviewSessionRef & { startedBy?: string | null }>;
	/** Primary repo the workspace's sessions work in. */
	repo?: string;
	/** PR lane state, when the session has a PR — gates the PR fetch. */
	prState?: string | null;
	/** Bumped when a GitHub webhook reports activity for this workspace's PR. */
	refreshTick?: number;
	/** The open session's sandbox opt-in — renders a provider/mode badge in the
	    status row (from session fields only; no container polling). */
	sandbox?: {
		provider: string;
		sandboxId?: string;
		workspace?: "bind" | "volume";
	};
	/** Pending review request for this workspace — the open session's, or a sibling
	    session's (the request is per-session but the band groups by workspace). */
	reviewRequest?: ReviewRequestInfo | null;
	/** The session that owns `reviewRequest` (may be a sibling, not the open one). */
	reviewRequestSessionId?: string;
	/** The request is complete because its reviewer submitted a GitHub review. */
	reviewAcceptedFromPr?: boolean;
	/** Optimistically push a reviewer pick / sign-off into the app-level session
	    list, so the sidebar's review bands + the other chip instance flip at once
	    instead of waiting up to a poll (~5s) for the change to round-trip. */
	onReviewChange?: (sessionId: string, req: ReviewRequestInfo | null) => void;
	/** Jump to a sibling tab when a status chip / reply row is clicked. */
	onOpenTab?: (tab: PanelTab) => void;
	/** Open the current PR directly on its Checks tab. */
	onOpenChecks?: () => void;
	/** The session's scratch assets — listed in the Info panel; clicking one
	    opens the full-width Assets view-tab focused on that file. */
	assets?: SessionAssetFile[];
	/** Open the Assets view-tab focused on a specific asset (a list-row click). */
	onOpenAsset?: (path: string) => void;
	/** Prefill the composer (the per-comment "Add to session" hover action). */
	onAddToInput?: (text: string) => void;
	/** Navigate to a session — used by Auto-fix, which spins up a new session in this
	    workspace and jumps into it. `created` is the server's copy of a session this
	    panel just made, so the caller can open it without a loading placeholder. */
	onOpenSession?: (id: string, created?: UnifiedSession | null) => void;
	/** Prompt the session (the Status section's Commit action) — the WS `prompt`
	    message. Absent in read-only mounts, where Commit is simply hidden. */
	send?: (msg: any) => void;
	/** Media items currently in the open session's live entries — bumps refresh
	    the panel as new screenshots land during a run. */
	liveMediaCount: number;
	/** Images visible in the session UI before the transcript-backed overview catches up. */
	liveMedia?: WorkspaceMediaItem[];
}

const INFO_LABEL_CLASS = "px-1 text-label font-semibold tracking-[-0.01em] text-faint";
const INFO_SECTION_CLASS = "grid gap-[5px]";
const INFO_LIST_CLASS =
	"grid gap-px overflow-hidden rounded-lg bg-panel p-1";
const INFO_MORE_BUTTON_CLASS =
	"cursor-pointer bg-panel px-[9px] py-[7px] text-left text-label font-semibold text-faint transition-colors hover:bg-hover hover:text-fg";

function statusBadgeClass(status: DiffFile["status"]): string {
	switch (statusClass(status)) {
		case "added":
			return "bg-green-soft text-green";
		case "modified":
			return "bg-[rgba(210,153,34,0.15)] text-yellow";
		case "deleted":
			return "bg-red-soft text-red";
		case "renamed":
			return "bg-accent-soft text-accent";
		default:
			return "bg-surface text-dim";
	}
}

const ACTION_BUTTON_CLASS =
	"flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-supporting font-semibold text-fg outline-none transition-colors hover:bg-hover focus-visible:bg-hover disabled:cursor-default disabled:opacity-50";
const ACTION_ICON_CLASS =
	"inline-flex size-5 shrink-0 items-center justify-center text-faint [&_svg]:block";

function initial(name: string): string {
	return (name.trim()[0] || "?").toUpperCase();
}
function hueFor(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
	return Math.abs(h) % 360;
}
/** Flatten a GitHub markdown/HTML comment body into a clean one-glance
		preview: drop HTML comments/tags, collapse markdown emphasis + headings,
		turn links into their label, squash whitespace. */
function plainComment(body: string): string {
	return body
		.replace(/<!--[\s\S]*?-->/g, "") // HTML comments (bot markers)
		.replace(/<[^>]+>/g, "") // HTML tags
		.replace(/```[\s\S]*?```/g, " ") // fenced code blocks
		.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link-ref defs (Vercel [vc]: #…)
		.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "") // markdown table separator rows
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
		.replace(/^#{1,6}\s+/gm, "") // heading markers
		.replace(/\s*\|\s*/g, " · ") // table cells → separators
		.replace(/[*_`>]/g, "") // emphasis / code / quote marks
		.replace(/(?:\s·\s)+/g, " · ") // collapse repeated separators
		.replace(/^[\s·]+|[\s·]+$/g, "") // trim leading/trailing separators
		.replace(/\s+/g, " ")
		.trim();
}

/** Clean a GitHub comment body for markdown rendering: drop bot markers and
		link-ref noise, and downgrade raw HTML to equivalent markdown (our renderer
		escapes raw tags for safety, so <h3>/<br>/etc. would otherwise show as
		literal text) — while KEEPING real markdown structure (headings, lists,
		tables, code fences, line breaks). */
function cleanCommentMarkdown(body: string): string {
	return body
		.replace(/<!--[\s\S]*?-->/g, "") // HTML comments (bot markers)
		.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link-ref defs (Vercel [vc]: #…)
		.replace(
			/<h([1-6])[^>]*>\s*([\s\S]*?)<\/h\1>/gi,
			(_m, _n, t) => `\n### ${t.trim()}\n`,
		)
		.replace(/<br\s*\/?>/gi, "\n") // explicit line breaks
		.replace(/<\/(p|div|li|tr|table|ul|ol|details)>/gi, "\n") // block ends → break
		.replace(/<[^>]+>/g, "") // remaining tags → keep inner text
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_CHAR: Record<DiffFile["status"], string> = {
	added: "A",
	untracked: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
};
/** untracked shares the "added" tint. */
function statusClass(status: DiffFile["status"]): string {
	return status === "untracked" ? "added" : status;
}

function relTime(iso?: string): string {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return "";
	const s = Math.round((Date.now() - t) / 1000);
	if (s < 60) return "now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

// How many file rows / comments the compact preview shows before deferring to
// the drill-down tab.
const FILE_PREVIEW = 6;
const COMMENT_PREVIEW = 3;

/** The author's real GitHub avatar (Greptile, Tella Butler, Vercel, a human…),
		served at github.com/<login>.png. Falls back to a lettered brand tile if the
		image 404s or the author isn't a plausible login (e.g. a display name). */
function CommentAvatar({ author }: { author: string }) {
	const login = (author || "").trim();
	// GitHub usernames/app slugs: alphanumerics with single interior hyphens,
	// ≤39 chars — skips display names with spaces so we don't 404 on those.
	const canAvatar = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login);
	const [failed, setFailed] = useState(false);
	if (canAvatar && !failed) {
		return (
			<img
				className="size-6 shrink-0 rounded-full border border-line object-cover bg-active"
				src={`https://github.com/${login}.png?size=48`}
				alt=""
				aria-hidden
				loading="lazy"
				onError={() => setFailed(true)}
			/>
		);
	}
	return (
		<span
			className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-active text-[11px] font-semibold text-white"
			style={{ background: `hsl(${hueFor(login || "?")} 52% 42%)` }}
			aria-hidden
		>
			{initial(login || "?")}
		</span>
	);
}

/** One PR comment as a single dense row: avatar · one-line title · time. The
		title is the flattened first slice of the body, ellipsised. Hovering floats
		the full markdown comment in a popover on top (never shifting the list); a
		hover "Add to session" drops it into the composer; clicking opens the PR tab. */
function CommentCard({
	comment,
	pr,
	onOpenTab,
	onAddToInput,
}: {
	comment: { author: string; body: string; url?: string; createdAt?: string };
	pr: PrDetails;
	onOpenTab?: (tab: PanelTab) => void;
	onAddToInput?: (text: string) => void;
}) {
	const repo = useMarkdownRepo();
	const html = useMemo(
		() => renderMarkdown(cleanCommentMarkdown(comment.body), { repo }),
		[comment.body, repo],
	);
	// The one-line label: lead with the comment's title/first words, flattened.
	const title = useMemo(() => plainComment(comment.body), [comment.body]);

	const addBtn = onAddToInput && (
		<button
			type="button"
			className="absolute right-1.5 top-1/2 z-[1] -translate-y-1/2 rounded-control border border-line-strong bg-panel px-2 py-0.5 text-[11px] font-semibold text-dim opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:border-faint hover:bg-hover hover:text-fg"
			onClick={(e) => {
				e.stopPropagation();
				onAddToInput(formatPrCommentPrompt(comment, pr));
			}}
			aria-label="Add this comment to the session composer"
		>
			Add to session
		</button>
	);
	const avatar = <CommentAvatar author={comment.author} />;

	return (
		<Popover.Root>
			<Popover.Trigger
				render={<div />}
				nativeButton={false}
				openOnHover
				delay={200}
				closeDelay={90}
				className="group relative flex min-w-0 items-center gap-2 rounded-md px-[7px] py-[5px] text-left transition-colors hover:bg-hover"
				role="button"
				tabIndex={0}
				onClick={() => onOpenTab?.("pr")}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") onOpenTab?.("pr");
				}}
				aria-label={`Comment by ${comment.author}`}
			>
				{avatar}
				<span className="min-w-0 flex-1 truncate text-supporting font-medium leading-[1.35] text-fg">
					{title}
				</span>
				<span className="shrink-0 text-meta text-faint">
					{relTime(comment.createdAt)}
				</span>
				{addBtn}
			</Popover.Trigger>
			<Popover.Popup
				side="left"
				align="start"
				sideOffset={10}
				elevation="lg"
				className="flex max-h-[min(560px,70vh,var(--available-height))] w-[min(440px,calc(100vw-24px))] cursor-pointer gap-[9px] overflow-hidden bg-panel px-3 py-[11px]"
			>
				<div className="contents" onClick={() => onOpenTab?.("pr")}>
					{avatar}
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="mb-1.5 flex min-w-0 items-baseline justify-between gap-2">
							<span className="min-w-0 truncate text-meta font-semibold text-faint">
								{comment.author}
							</span>
							{comment.createdAt && (
								<span className="shrink-0 text-meta text-faint">
									{relTime(comment.createdAt)}
								</span>
							)}
						</div>
					<div className="mb-[5px] min-h-0 flex-1 overflow-y-auto">
							<MarkdownBody html={html} className="markdown" />
						</div>
					</div>
				</div>
			</Popover.Popup>
		</Popover.Root>
	);
}

/** Read-only render options for the hover diff — no line selection, our own
		header owns the file name, unified view themed to the app appearance. */
const PREVIEW_DIFF_OPTIONS = {
	diffStyle: "unified" as const,
	disableFileHeader: true,
	overflow: "scroll" as const,
	enableLineSelection: false,
};

/**
* One "file changed" row. Hovering reveals a floated card with the file's actual
* diff (parsed from the primary repo's patch), mirroring the PR-comment hover in
* the same panel; clicking still jumps to the full Changes tab. Rows whose file
* isn't in the parsed patch (binary, or a not-yet-loaded/truncated patch) simply
* don't open a popover.
*/
function FileRow({
	file,
	meta,
	theme,
	onOpenTab,
}: {
	file: DiffFile;
	meta: FileDiffMetadata | undefined;
	theme: "light" | "dark";
	onOpenTab?: (tab: PanelTab) => void;
}) {
	const slash = file.path.lastIndexOf("/");
	const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
	const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
	const options = useMemo(
		() => ({
			...PREVIEW_DIFF_OPTIONS,
			theme: theme === "light" ? "pierre-light" : "pierre-dark",
			themeType: theme,
		}),
		[theme],
	);
	const stats = (
		<span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums">
			{file.additions > 0 && (
				<span className="text-green">+{file.additions}</span>
			)}
			{file.deletions > 0 && (
				<span className="text-red">−{file.deletions}</span>
			)}
		</span>
	);
	const path = (
		<span className="min-w-0 flex-1 truncate text-left text-label">
			{dir && <span className="text-dim">{dir}</span>}
			<span className="text-fg">{base}</span>
		</span>
	);

	return (
		<Popover.Root>
			<Popover.Trigger
				openOnHover={Boolean(meta)}
				delay={200}
				closeDelay={90}
				type="button"
				className="flex min-w-0 items-center gap-2 rounded-md px-[7px] py-[5px] text-left transition-colors hover:bg-hover"
				onClick={() => onOpenTab?.("changes")}
				aria-label={`${file.path} — open in Changes`}
			>
				<span
					className={cn(
						"inline-flex size-[18px] shrink-0 items-center justify-center rounded-xs text-[11px] font-bold",
						statusBadgeClass(file.status),
					)}
				>
					{STATUS_CHAR[file.status]}
				</span>
				{path}
				{stats}
			</Popover.Trigger>
			{meta && (
				<Popover.Popup
					side="left"
					align="start"
					sideOffset={10}
					elevation="lg"
					className="flex max-h-[min(720px,82vh,var(--available-height))] w-[min(720px,calc(100vw-24px))] cursor-pointer flex-col overflow-hidden bg-panel px-3 py-2.5"
				>
					<div
						className="flex min-h-0 flex-1 flex-col overflow-hidden"
						onClick={() => onOpenTab?.("changes")}
					>
						<div className="mb-2 flex min-w-0 items-baseline justify-between gap-2">
							{path}
							{stats}
						</div>
						<div className="min-h-0 flex-1 overflow-auto text-label">
							<FileDiff fileDiff={meta} options={options} disableWorkerPool />
						</div>
					</div>
				</Popover.Popup>
			)}
		</Popover.Root>
	);
}

/** Keep the aggregate state visible in Info while the hover card preserves the
 * useful detail that the one-line PR strip cannot show. */
function ChecksChip({
	pr,
	onOpenChecks,
}: {
	pr: PrDetails;
	onOpenChecks?: () => void;
}) {
	const order: Record<CheckVisual, number> = {
		failure: 0,
		pending: 1,
		success: 2,
		skipped: 3,
		neutral: 3,
	};
	const checks = [...(pr.checks || [])].sort(
		(a, b) => order[checkStatusMeta(a).kind] - order[checkStatusMeta(b).kind],
	);
	const sum = summarizeChecks(pr);
	if (checks.length === 0) return null;

	const aggregate =
		sum.failed > 0
			? {
					label: `${sum.failed} check${sum.failed === 1 ? "" : "s"} failing`,
					icon: <IconX size={18} />,
					className: "border-transparent bg-red-soft text-red",
				}
			: sum.pending > 0
				? {
						label: `${sum.pending} check${sum.pending === 1 ? "" : "s"} pending`,
						icon: <IconClock size={18} />,
						className:
							"border-transparent bg-[rgba(210,153,34,0.14)] text-yellow",
					}
				: {
						label: "Checks passing",
						icon: <IconCheck size={18} />,
						className: "border-transparent bg-green-soft text-green",
					};

	return (
		<Popover.Root>
			<Popover.Trigger
				openOnHover
				delay={200}
				closeDelay={120}
				type="button"
				className={cn(
					"mt-1.5 inline-flex w-fit cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control border px-2.5 py-1 text-label font-semibold leading-[1.35] transition-colors hover:brightness-110",
					aggregate.className,
				)}
				onClick={onOpenChecks}
			>
				<span className="inline-flex items-center opacity-70">{aggregate.icon}</span>
				{aggregate.label}
			</Popover.Trigger>
			<Popover.Popup
				side="left"
				align="start"
				sideOffset={10}
				className="flex max-h-[min(560px,70vh,var(--available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden p-0"
			>
				<div className="flex items-baseline justify-between gap-2.5 border-b border-line bg-surface px-3 py-[9px]">
					<span className="text-label font-semibold text-fg">
						{checks.length} check{checks.length === 1 ? "" : "s"}
					</span>
					<span className="inline-flex gap-2 text-meta font-semibold">
						{sum.passed > 0 && <span className="text-green">{sum.passed} passed</span>}
						{sum.failed > 0 && <span className="text-red">{sum.failed} failed</span>}
						{sum.pending > 0 && (
							<span className="text-yellow">{sum.pending} running</span>
						)}
					</span>
				</div>
				<div className="overflow-y-auto p-1">
					{checks.map((check, i) => {
						const status = checkStatusMeta(check);
						const content = (
							<>
								<span
									className={cn(
										"inline-flex size-4 shrink-0",
										checkToneClass(status.kind),
									)}
								>
									<CheckStatusIcon kind={status.kind} />
								</span>
								<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
									{check.name}
								</span>
								<span className="shrink-0 text-label font-medium text-dim">
									{status.label}
								</span>
							</>
						);
						return check.url ? (
							<a
								key={`${check.name}:${i}`}
								className="flex items-center gap-[9px] rounded-md px-2 py-1.5 text-fg no-underline hover:bg-surface"
								href={check.url}
								target="_blank"
								rel="noopener"
							>
								{content}
							</a>
						) : (
							<div
								key={`${check.name}:${i}`}
								className="flex items-center gap-[9px] rounded-md px-2 py-1.5 text-fg"
							>
								{content}
							</div>
						);
					})}
				</div>
			</Popover.Popup>
		</Popover.Root>
	);
}

/** The GitHub PR agent behaviors behind the score card. Each maps to an os-*
		PR label, but runs directly from the panel without a GitHub round trip. */
const PR_AGENT_ACTIONS: Array<{
	kind: PrAgentAction;
	label: string;
	hint: string;
}> = [
	{
		kind: "review",
		label: "Review",
		hint: "Full review pass (os-review). Findings are posted on the PR.",
	},
	{
		kind: "autofix",
		label: "Auto-fix",
		hint: "Opens a new session in this workspace that fixes every finding + failing CI and pushes. Watch and steer it live.",
	},
	{
		kind: "simplify",
		label: "Simplify",
		hint: "Quality cleanup pass: reuse, simpler shapes, dead code (os-simplify)",
	},
	{
		kind: "adversarial",
		label: "Adversarial",
		hint: "Deeper two-pass adversarial review (os-adversarial)",
	},
];

function AgentReviewCard({
	sessionId,
	repo,
	pr,
	onOpenSession,
}: {
	sessionId: string;
	repo?: string;
	pr: PrDetails;
	onOpenSession?: (id: string, created?: UnifiedSession | null) => void;
}) {
	const [busy, setBusy] = useState<PrAgentAction | null>(null);
	const [done, setDone] = useState<{ label: string; bksId?: string } | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	const [reviewQueued, setReviewQueued] = useState<{ at?: string } | null>(null);
	const review = pr.osReview;
	const score = review?.confidence;
	const stale = !!review?.stale;
	const actionable = pr.state === "OPEN";
	const active = !!pr.reviewActive || busy === "review" || !!reviewQueued;
	const canFix = actionable && !!review && !stale && review.findings > 0;
	const scoreTone = stale
		? "text-faint"
		: score && score >= 4
			? "text-green"
			: score === 3
				? "text-yellow"
				: score
					? "text-red"
					: "text-dim";
	const meterTone = stale
		? "bg-faint"
		: score && score >= 4
			? "bg-green"
			: score === 3
				? "bg-yellow"
				: score
					? "bg-red"
					: "bg-dim";
	let verdict = "Not scored yet";
	if (pr.state === "MERGED") verdict = "Merged with this score";
	else if (pr.state === "CLOSED") verdict = "Pull request closed";
	else if (active) verdict = "Review in progress";
	else if (stale) verdict = "New commits since review";
	else if (score === 5) verdict = "Safe to merge";
	else if (score === 4) verdict = "Looks mergeable";
	else if (score === 3) verdict = "Worth another pass";
	else if (score) verdict = "Needs work";
	const reviewedAgo = review ? relTime(review.at) : "";
	const detail = review
		? [
				review.findings
					? `${review.findings} finding${review.findings === 1 ? "" : "s"}`
					: "No findings",
				review.blocking
					? `${review.blocking} blocking`
					: null,
				reviewedAgo ? `reviewed ${reviewedAgo} ago` : "reviewed recently",
			].filter(Boolean).join(" · ")
		: `Run ${AGENT_NAME}'s merge-safety review`;
	// The score is intentionally compact; the matching GitHub summary comment
	// retains the reviewer's complete reasoning and is available on hover/focus.
	const reviewComment = review
		? [...(pr.comments || [])]
				.reverse()
				.find((comment) => comment.body.trim().startsWith("<!-- os-review -->"))
		: undefined;
	const reviewMessage = reviewComment?.body.replace(/^<!-- os-review -->\s*/, "");
	const reviewHtml = useMemo(
		() =>
			reviewMessage
				? renderMarkdown(cleanCommentMarkdown(reviewMessage), { repo })
				: "",
		[reviewMessage, repo],
	);

	// Keep the just-started state latched until a later PR refresh observes the
	// run or its new result; otherwise the button flashes idle after the POST.
	useEffect(() => {
		if (
			reviewQueued &&
			(pr.reviewActive || pr.osReview?.at !== reviewQueued.at)
		) {
			setReviewQueued(null);
		}
	}, [pr.reviewActive, pr.osReview?.at, reviewQueued]);

	async function run(action: (typeof PR_AGENT_ACTIONS)[number]) {
		if (busy) return;
		setBusy(action.kind);
		setError(null);
		setDone(null);
		try {
			const res = await triggerPrActionApi(
				sessionId,
				action.kind,
				getCurrentUser(),
				repo,
			);
			if (res.ok) {
				if (action.kind === "review") setReviewQueued({ at: review?.at });
				// Auto-fix opens a live session in this workspace — jump straight into it
				// instead of leaving a "posted on the PR" note behind. The response
				// carries the persisted session, so it opens as a real tab right away.
				if (res.openSession && res.bksId && onOpenSession) {
					onOpenSession(res.bksId, res.session ?? null);
					return;
				}
				setDone({ label: action.label, bksId: res.bksId });
			} else setError(res.error || res.message || "Couldn't start");
		} catch (e: any) {
			setError(e?.message || "Couldn't start");
		} finally {
			setBusy(null);
		}
	}

	const reviewAction = PR_AGENT_ACTIONS[0];
	const fixAction = PR_AGENT_ACTIONS[1];
	const moreActions = PR_AGENT_ACTIONS.slice(2);

	return (
		<div data-agent-score className={INFO_SECTION_CLASS}>
			<div className="flex items-center gap-2 px-1">
				<div className={INFO_LABEL_CLASS}>{AGENT_NAME} score</div>
				<div className="ml-auto flex items-center gap-2">
					{active ? (
						<span className="inline-flex items-center gap-1 text-meta font-semibold text-accent">
							<span className="size-1.5 animate-pulse rounded-full bg-accent" />
							Reviewing
						</span>
					) : stale ? (
						<span className="text-meta font-semibold text-faint">Stale</span>
					) : null}
					{actionable && (
						<Button
							variant="ghost"
							size="xs"
							className="shrink-0 text-meta"
							disabled={busy !== null || active}
							onClick={() => run(reviewAction)}
							title={reviewAction.hint}
						>
							{busy === "review" ? "Starting..." : review ? "Review again" : "Run review"}
						</Button>
					)}
					{actionable && (
						<Menu.Root>
							<Menu.Trigger
								className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-faint transition-[color,background-color] hover:bg-hover hover:text-fg disabled:opacity-50"
								disabled={busy !== null}
								aria-label={`More ${AGENT_NAME} actions`}
							>
								<IconChevronDown size={14} />
							</Menu.Trigger>
							<Menu.Popup align="end" sideOffset={6} className="min-w-[280px]">
								<Menu.Group>
									<Menu.GroupLabel>More {AGENT_NAME} actions</Menu.GroupLabel>
									{moreActions.map((action) => (
										<Menu.Item
											key={action.kind}
											disabled={busy !== null}
											onClick={() => run(action)}
											className="items-start py-2"
										>
											<div className="min-w-0">
												<div className="font-semibold text-fg">{action.label}</div>
												<div className="mt-0.5 text-meta leading-[1.35] text-faint">
													{action.hint}
												</div>
											</div>
										</Menu.Item>
									))}
								</Menu.Group>
							</Menu.Popup>
						</Menu.Root>
					)}
				</div>
			</div>
			<div className="flex items-center gap-1 rounded-lg bg-panel p-1">
				<Popover.Root>
					<Popover.Trigger
						render={<div />}
						nativeButton={false}
						openOnHover={Boolean(reviewMessage)}
						delay={200}
						closeDelay={120}
						className={cn(
							"flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2",
							reviewMessage && "cursor-help",
						)}
						tabIndex={reviewMessage ? 0 : undefined}
					>
						{/* The meter sits under the score itself, so the reading and its
						    scale stay one glance and the row's right edge is free for the
						    action. */}
						<div className="grid shrink-0 gap-1.5">
							<div className={cn("leading-none", scoreTone)}>
								<span className="text-section-title font-[750] tracking-[-0.06em]">{score ?? "–"}</span>
								<span className="ml-0.5 text-meta font-semibold tracking-normal text-faint">/5</span>
							</div>
							<div
								className="flex gap-0.5"
								role={score ? "meter" : "status"}
								aria-label={`${AGENT_NAME} merge-safety score`}
								aria-valuemin={score ? 1 : undefined}
								aria-valuemax={score ? 5 : undefined}
								aria-valuenow={score}
							>
								{[1, 2, 3, 4, 5].map((step) => (
									<span
										key={step}
										className={cn(
											"h-1 flex-1 rounded-full",
											score && step <= score ? meterTone : "bg-active",
										)}
									/>
								))}
							</div>
						</div>
						<div className="min-w-0 flex-1">
							<div className="truncate text-label font-semibold text-fg">{verdict}</div>
							<div className="mt-0.5 truncate text-meta text-faint">{detail}</div>
						</div>
					</Popover.Trigger>
					{reviewMessage && (
						<Popover.Popup
							side="left"
							align="start"
							sideOffset={12}
							className="flex max-h-[min(680px,calc(100vh-24px),var(--available-height))] w-[min(680px,calc(100vw-24px),var(--available-width))] min-h-0 overflow-hidden"
						>
							<div className="flex min-h-0 w-full flex-col">
								<div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
									<CommentAvatar author={reviewComment?.author || GITHUB_BOT_NAME || AGENT_NAME} />
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-semibold text-fg">
											{reviewComment?.author || GITHUB_BOT_NAME || AGENT_NAME}
										</div>
										<div className="text-meta text-faint">
											Automated review{reviewedAgo ? ` · reviewed ${reviewedAgo} ago` : ""}
										</div>
									</div>
									<span className={cn("shrink-0 text-[13px] font-semibold", scoreTone)}>
										{score ?? "–"}/5
									</span>
								</div>
								<div className="min-h-0 overflow-auto px-4 py-3">
									<MarkdownBody html={reviewHtml} className="markdown review-preview-markdown" />
								</div>
							</div>
						</Popover.Popup>
					)}
				</Popover.Root>
				{canFix && (
					<button
						type="button"
						className={cn(ACTION_BUTTON_CLASS, "shrink-0 gap-1.5 px-2 text-meta")}
						disabled={busy !== null}
						onClick={() => run(fixAction)}
						title={fixAction.hint}
					>
						<IconSparkle size={14} className="shrink-0 text-faint" />
						{busy === "autofix" ? "Starting..." : "Fix findings"}
					</button>
				)}
			</div>
			{done && (
				<div className="px-1 text-[11px] font-medium text-dim">
					Started {done.label.toLowerCase()} — {AGENT_NAME} will post results on{" "}
					{pr.url ? (
						<a
							href={pr.url}
							target="_blank"
							rel="noopener"
							className="text-fg underline decoration-line-strong underline-offset-2"
						>
							the PR
						</a>
					) : (
						"the PR"
					)}
					{done.bksId && (
						<>
							{" · "}
							<a
								href={`${BASE_PATH}/session/${encodeURIComponent(done.bksId)}`}
								className="text-fg underline decoration-line-strong underline-offset-2"
							>
								open run
							</a>
						</>
					)}
				</div>
			)}
			{error && (
				<div className="px-1 text-[11px] font-medium text-red">
					{error}
				</div>
			)}
		</div>
	);
}

/** The reviewer action: pick a teammate to flag this
		session as "needs review" — it jumps into a Needs-review band at the top of
		their sidebar and buzzes their registered devices. Re-pick to hand off,
		"Clear review request" to withdraw. Optimistic; the polled session list
		confirms (or reverts) on the next refresh. */
function ReviewerChip({
	sessionId,
	reviewRequest,
	requestSessionId,
	acceptedFromPr,
	onReviewPr,
	onReviewChange,
}: {
	sessionId: string;
	reviewRequest?: ReviewRequestInfo | null;
	/** The session that actually holds the request — a workspace's request may live
	    on a sibling session, not the open one. Clear/re-assign target this so the
	    chip stays consistent with the sidebar's workspace-level band; a brand-new
	    request (none exists) targets the open `sessionId`. */
	requestSessionId?: string;
	acceptedFromPr?: boolean;
	/** Open the PR review canvas — offered when a review is waiting on you. */
	onReviewPr?: () => void;
	/** Optimistically mirror a pick / sign-off into the app-level session list so
	    every other surface (sidebar bands, the sibling chip) updates immediately. */
	onReviewChange?: (sessionId: string, req: ReviewRequestInfo | null) => void;
}) {
	const currentUser = useCurrentUser();
	const reviewTeams = useReviewTeams();
	const [req, setReq] = useState(reviewRequest ?? null);
	// Why the last pick/sign-off was rejected. Without this the chip just snaps
	// back to its old state, which reads as the button doing nothing at all —
	// the server's reason (an expired GitHub connection, say) is worth showing.
	const [error, setError] = useState<string | null>(null);
	// Follow the polled session as it refreshes (another viewer may re-assign or
	// sign off). Track accepted's timestamp too so the sign-off lands live.
	useEffect(() => {
		setReq(reviewRequest ?? null);
		setError(null);
	}, [reviewRequest?.to, reviewRequest?.at, reviewRequest?.accepted?.at]);

	// The session that owns an existing request; a brand-new one anchors to the open session.
	const owner = (req && requestSessionId) || sessionId;
	const accepted = req?.accepted ?? null;
	// This chip controls Open Session's sidebar state. GitHub's automatic
	// requested-reviewer list stays separate; only a group picked here expands
	// into explicit sidebar requests for its configured members.
	const me = personKey(currentUser);
	const needsMyReview =
		!!req && !accepted && reviewRequestTargetsPerson(req, me);
	const selectedTeam = req
		? reviewTeams.find((team) => team.github === req.to)
		: undefined;
	const targetLabel = selectedTeam?.name || req?.to;

	function pick(name: string | null, recipients?: string[]) {
		const prev = req;
		const me = getCurrentUser();
		// Re-assigning drops any prior sign-off (a fresh reviewer, fresh review).
		const next = name
			? {
					to: name,
					...(recipients ? { recipients } : {}),
					by: me,
					at: new Date().toISOString(),
				}
			: null;
		setReq(next);
		setError(null);
		onReviewChange?.(owner, next);
		setSessionReviewerApi(owner, name, me).catch((e: any) => {
			setReq(prev);
			onReviewChange?.(owner, prev);
			setError(e?.message || "Failed to set reviewer");
		});
	}

	function accept(value: boolean) {
		if (!req) return;
		const prev = req;
		const me = getCurrentUser();
		const next: ReviewRequestInfo = {
			...req,
			accepted: value ? { by: me, at: new Date().toISOString() } : undefined,
		};
		setReq(next);
		setError(null);
		onReviewChange?.(owner, next);
		acceptReviewApi(owner, value, me).catch((e: any) => {
			setReq(prev);
			onReviewChange?.(owner, prev);
			setError(e?.message || "Failed to update review");
		});
	}

	return (
		<div className="mt-1.5 grid w-fit min-w-0 gap-1">
			<Menu.Root>
				<Menu.Trigger
					className={cn(
						"inline-flex w-fit min-w-0 items-center gap-1 rounded-control border border-line bg-control py-1 pl-2 pr-2.5 text-left text-supporting font-medium whitespace-nowrap text-dim outline-none transition-[color,background-color,border-color,scale] hover:border-line-strong hover:text-fg active:scale-[0.96] data-[popup-open]:border-line-strong data-[popup-open]:bg-hover",
						needsMyReview
							? "border-red/30 bg-red-soft text-red hover:border-red/50 hover:text-red"
							: accepted
								? "text-green"
								: req
									? "text-yellow"
									: "",
					)}
					title={
						needsMyReview
							? `Review requested by ${req?.by || "a teammate"}`
							: accepted
								? `Reviewed by ${accepted.by}`
								: req
									? `Review requested by ${req.by}`
									: "Ask a teammate to review this session"
					}
				>
					{needsMyReview ? (
						<span className={cn(ACTION_ICON_CLASS, "text-red opacity-80")}>
							<IconBell size={20} />
						</span>
					) : accepted ? (
						<UserAvatar name={accepted.by} size={20}>
							<span className="absolute -bottom-px -right-px grid size-4 place-items-center rounded-full border border-panel bg-green text-white shadow-[0_0_0_1px_var(--bg-panel)] [&_svg]:size-3">
								<IconCheck size={12} />
							</span>
						</UserAvatar>
					) : selectedTeam ? (
						<span className={ACTION_ICON_CLASS}>
							<IconStack size={20} />
						</span>
					) : req ? (
						<UserAvatar name={req.to} size={20} />
					) : (
						<span className={ACTION_ICON_CLASS}>
							<IconBell size={20} />
						</span>
					)}
					<span className="min-w-0 truncate">
						{needsMyReview
							? "Needs your review"
							: accepted
								? `Reviewed by ${accepted.by}`
								: req
									? `Review: ${targetLabel}`
									: "Request review"}
					</span>
					{/* Inherit the chip's own tone at low strength — a fixed grey caret
					    reads as a dead spot next to a red/green/yellow label. */}
					<IconChevronDown size={14} className="shrink-0 opacity-55" />
				</Menu.Trigger>
				<Menu.Popup align="start" sideOffset={6} className="min-w-[200px]">
					{needsMyReview && onReviewPr && (
						<>
							<Menu.Item onClick={onReviewPr}>
								<IconPullRequest size={20} className="text-dim" />
								<span className="min-w-0 flex-1 truncate">Review PR</span>
							</Menu.Item>
							<Menu.Separator />
						</>
					)}
					{req &&
						(accepted ? (
							<Menu.Item
								onClick={() =>
									acceptedFromPr && req
										? pick(req.to, req.recipients)
										: accept(false)
								}
							>
								<IconBell size={20} className="text-dim" />
								<span className="min-w-0 flex-1 truncate">Reopen review</span>
							</Menu.Item>
						) : (
							<Menu.Item onClick={() => accept(true)}>
								<IconCheck size={20} className="text-dim" />
								<span className="min-w-0 flex-1 truncate">Mark as reviewed</span>
							</Menu.Item>
						))}
					{req && <Menu.Separator />}
					{TEAM.map((name) => (
						<Menu.Item key={name} onClick={() => pick(name)}>
							<UserAvatar name={name} size={22} />
							<span className="min-w-0 flex-1 truncate">{name}</span>
							{req?.to === name && <IconCheck size={20} className="text-dim" />}
						</Menu.Item>
					))}
					{reviewTeams.length > 0 && <Menu.Separator />}
					{reviewTeams.map((team) => (
						<Menu.Item
							key={team.github}
							onClick={() => pick(team.github, team.members)}
						>
							<span className="grid size-[22px] place-items-center text-dim">
								<IconStack size={20} />
							</span>
							<span className="min-w-0 flex-1 truncate">{team.name}</span>
							{req?.to === team.github && (
								<IconCheck size={20} className="text-dim" />
							)}
						</Menu.Item>
					))}
					{req && (
						<>
							<Menu.Separator />
							<Menu.Item className="text-dim" onClick={() => pick(null)}>
								Clear review request
							</Menu.Item>
						</>
					)}
				</Menu.Popup>
			</Menu.Root>
			{error && <p className="text-supporting text-red">{error}</p>}
		</div>
	);
}

/**
 * The Git status section of the info panel: PR state first, then one row per
 * outstanding local git fact. Direct git actions stay local; judgment calls
 * prompt the session so commits and conflict resolutions remain agent-authored.
*/
function GitStatusRows({
	sessionId,
	repo,
	git,
	pr,
	prState,
	send,
	onReload,
}: {
	sessionId: string;
	repo?: string;
	git: GitStatusInfo | null;
	pr: PrDetails | null;
	prState?: string | null;
	send?: (msg: any) => void;
	onReload: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmMerge, setConfirmMerge] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [prompted, setPrompted] = useState<string | null>(null);

	const ahead = git?.ahead ?? 0;
	const behind = git?.behind ?? 0;
	const behindBase = git?.behindBase ?? 0;
	// On a shared checkout the server scopes this to the files this session
	// wrote, so it means the same thing either way: your uncommitted work.
	const dirty = git?.uncommittedFiles ?? 0;

	// Behind counts fold together — a stale upstream reads "behind remote", a
	// fresh branch behind its base reads "behind <base>". A merged branch is
	// terminal, so stale checkout drift must not offer an Update action.
	const behindCount =
		prState === "MERGED" ? 0 : behind > 0 ? behind : behindBase;
	const behindWhat = behind > 0 ? "remote" : git?.baseBranch || "main";

	const hasRows = !!pr || ahead > 0 || behindCount > 0 || dirty > 0;
	if (!hasRows) return null;

	async function run(name: string, fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(name);
		setError(null);
		try {
			await fn();
			onReload();
		} catch (e: any) {
			setError(e?.message || `${name} failed`);
		} finally {
			setBusy(null);
		}
	}

	function commit() {
		if (!send) return;
		send({
			type: "prompt",
			sessionId,
			user: getCurrentUser(),
			content: commitPrompt(dirty, git?.sharedCheckout, git?.uncommittedPaths),
		});
		setPrompted("commit the changes");
		setTimeout(() => setPrompted(null), 6000);
	}

	async function merge() {
		if (busy) return;
		if (!confirmMerge) {
			setConfirmMerge(true);
			setError(null);
			setTimeout(() => setConfirmMerge(false), 4000);
			return;
		}
		setConfirmMerge(false);
		await run("merge", () => mergePrApi(sessionId, "squash", repo));
	}

	function resolveConflicts() {
		if (!send) return;
		send({
			type: "prompt",
			sessionId,
			user: getCurrentUser(),
			content: `The PR has merge conflicts with ${pr?.baseRefName || git?.baseBranch || "main"}. Rebase this branch on the latest origin/${pr?.baseRefName || git?.baseBranch || "main"}, resolve the conflicts, and push.`,
		});
		setPrompted("resolve the conflicts");
		setTimeout(() => setPrompted(null), 6000);
	}

	const checks = summarizeChecks(pr);
	const prStatus = !pr
		? null
		: pr.state === "MERGED"
			? "Merged"
			: pr.state === "CLOSED"
				? "Closed"
				: pr.isDraft
					? "Draft"
					: pr.mergeable === "CONFLICTING"
						? "Merge conflicts"
						: checks.failed > 0
							? "Checks failed"
							: checks.pending > 0
								? "Checks running"
								: pr.reviewDecision === "CHANGES_REQUESTED"
									? "Changes requested"
									: pr.reviewDecision === "REVIEW_REQUIRED"
										? "Review required"
										: "Ready to merge";

	// The dot carries the state, so it has to agree with the headline above.
	const prTone =
		prStatus === "Ready to merge"
			? "green"
			: prStatus === "Merged"
				? "purple"
				: prStatus === "Checks running" || prStatus === "Review required"
					? "yellow"
					: prStatus === "Closed" || prStatus === "Draft"
						? "muted"
						: "red";

	return (
		<div className={INFO_SECTION_CLASS}>
			<div className={INFO_LABEL_CLASS}>Git status</div>
			<div className={INFO_LIST_CLASS}>
				{prStatus && (
					<div className={`${GIT_ROW} py-2`}>
						<span className={`${GIT_DOT} ${GIT_DOT_BG[prTone]}`} aria-hidden />
						<span className={GIT_LABEL}>{prStatus}</span>
						{pr?.mergeable === "CONFLICTING" && send ? (
							<button type="button" className={GIT_ACTION} onClick={resolveConflicts}>
								Resolve
							</button>
						) : pr?.state === "OPEN" && !pr.isDraft ? (
							<button
								type="button"
								className={GIT_ACTION}
								disabled={!!busy}
								onClick={() => void merge()}
								title="Squash and merge this pull request"
							>
								{busy === "merge"
									? "Merging…"
									: confirmMerge
										? "Confirm merge"
										: "Merge"}
							</button>
						) : null}
					</div>
				)}
				{ahead > 0 && (
					<div className={`${GIT_ROW} py-2`}>
						<span className={`${GIT_DOT} ${GIT_DOT_BG.blue}`} aria-hidden />
						<span className={GIT_LABEL}>
							{ahead} commit{ahead === 1 ? "" : "s"} ahead of remote
						</span>
						<button
							type="button"
							className={GIT_ACTION}
							disabled={!!busy}
							onClick={() => run("push", () => gitPushApi(sessionId, repo))}
						>
							{busy === "push" ? "Pushing…" : "Push"}
						</button>
					</div>
				)}
				{behindCount > 0 && (
					<div className={`${GIT_ROW} py-2`}>
						<span className={`${GIT_DOT} ${GIT_DOT_BG.yellow}`} aria-hidden />
						<span className={GIT_LABEL}>
							{behindCount} commit{behindCount === 1 ? "" : "s"} behind{" "}
							{behindWhat}
						</span>
						<button
							type="button"
							className={GIT_ACTION}
							disabled={!!busy}
							title={
								behindWhat === "remote"
									? `Fast-forward to ${git?.branch || "the upstream"}`
									: `Merge the latest origin/${behindWhat}`
							}
							onClick={() =>
								run("pull", () => gitPullApi(sessionId, repo, behind === 0))
							}
						>
							{busy === "pull" ? "Pulling…" : "Pull"}
						</button>
					</div>
				)}
				{dirty > 0 && (
					<div className={`${GIT_ROW} py-2`}>
						<span className={`${GIT_DOT} ${GIT_DOT_BG.yellow}`} aria-hidden />
						<span className={GIT_LABEL}>
							{dirty} uncommitted file{dirty === 1 ? "" : "s"}
						</span>
						{send && (
							<button
								type="button"
								className={GIT_ACTION}
								onClick={commit}
								title={`Ask ${AGENT_NAME} to commit the uncommitted changes and push`}
							>
								Commit
							</button>
						)}
					</div>
				)}
			</div>
			{prompted && <div className={`${GIT_NOTE} text-faint`}>Asked {AGENT_NAME} to {prompted} ✓</div>}
			{error && <div className={`${GIT_NOTE} text-red`}>{error}</div>}
		</div>
	);
}

export function WorkspaceInfo({
	sessionId,
	workspaceId,
	workspaceName,
	sessions,
	repo,
	prState,
	refreshTick,
	sandbox,
	reviewRequest,
	reviewRequestSessionId,
	reviewAcceptedFromPr,
	onReviewChange,
	onOpenTab,
	onOpenChecks,
	onAddToInput,
	onOpenSession,
	send,
	liveMediaCount,
	liveMedia = [],
	assets = [],
	onOpenAsset,
}: Props) {
	const sessionsKey = sessions.map((c) => c.id).join(",");
	const cacheKey = workspaceId || `sessions:${sessionsKey}`;
	const [data, setData] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	const [commentsExpanded, setCommentsExpanded] = useState(false);
	const [pr, setPr] = useState<PrDetails | null>(null);
	const [files, setFiles] = useState<DiffFile[] | null>(null);
	// The primary repo's raw patch, kept so the file rows can hover-reveal the
	// actual diff for that file (parsed lazily below).
	const [rawPatch, setRawPatch] = useState<string>("");
	// Local git state (ahead/behind, dirty tree) for the Git status section.
	const [git, setGit] = useState<GitStatusInfo | null>(null);

	// The sessions array is re-created every App render — read it through a ref so
	// the fetch effect keys on the stable sessionsKey instead.
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	useEffect(() => {
		let alive = true;
		const cached = overviewCache.get(cacheKey);
		setData(cached?.data ?? null);
		setCommentsExpanded(false);
		// Fresh cache → refresh quietly in the background after a beat (also
		// debounces the liveMediaCount bumps during a streaming run).
		const t = setTimeout(
			() => {
				loadOverview(cacheKey, workspaceId, sessionsRef.current)
					.then((ov) => {
						if (alive) setData(ov);
					})
					.catch(() => {
						// Keep whatever we had — the block just doesn't refresh.
					});
			},
			cached ? 1200 : 0,
		);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [cacheKey, sessionsKey, workspaceId, liveMediaCount]);

	// PR (for the status chips) — webhooks trigger refreshTick; the slow poll only
	// recovers a missed delivery or a deployment with no matching webhook.
	useEffect(() => {
		if (!prState) {
			setPr(null);
			return;
		}
		let alive = true;
		const load = () =>
			fetchPr(sessionId, repo)
				.then((p) => alive && setPr(p))
				.catch(() => {});
		load();
		const stop = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
		return () => {
			alive = false;
			stop();
		};
	}, [sessionId, repo, prState, refreshTick]);

	// Files changed — the primary repo's diff (Changes tab has the full view
	// + repo switcher; here we show a capped preview).
	useEffect(() => {
		if (!repo) {
			setFiles(null);
			setRawPatch("");
			return;
		}
		let alive = true;
		const load = () =>
			fetchDiff(sessionId)
				.then((res) => {
					if (!alive) return;
					const primary =
						res.repos.find((r) => r.primary) || res.repos[0] || null;
					setFiles(primary?.diff.files ?? []);
					setRawPatch(primary?.diff.rawPatch ?? "");
				})
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, repo, liveMediaCount]);

	// Local git status (ahead/behind, uncommitted) for the Git status section — same
	// slow poll, refetched as live media bumps (a proxy for run activity) so the
	// counts settle after a turn's auto-commit/push. Only when the session has a repo.
	useEffect(() => {
		if (!repo) {
			setGit(null);
			return;
		}
		let alive = true;
		const load = () =>
			fetchGitStatus(sessionId, repo)
				.then((g) => alive && setGit(g))
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, repo, liveMediaCount]);

	// Refetch git status right after a Push/Update lands, so the row clears
	// without waiting on the 45s poll.
	const reloadStatus = () => {
		if (repo)
			fetchGitStatus(sessionId, repo)
				.then(setGit)
				.catch(() => {});
		if (prState)
			fetchPr(sessionId, repo)
				.then(setPr)
				.catch(() => {});
	};

	const oldest = sessions[0];
	const started = oldest?.createdAt
		? new Date(oldest.createdAt).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})
		: null;
	const meta = [
		repo ? repoLabel(repo) : null,
		`${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
		oldest?.startedBy ? `by ${oldest.startedBy}` : null,
		started,
	]
		.filter(Boolean)
		.join(" · ");

	// Clean each body up front and drop the noise: Vercel deploy bots and
	// anything that reduces to nothing (link-ref markers, pure HTML-comment
	// bot pings) so no blank/useless cards show.
	const comments = (pr?.comments ?? [])
		.filter((c) => !/vercel/i.test(c.author || ""))
		.filter((c) => !isOutdatedReviewComment(c.body))
		.map((c) => ({ ...c, preview: plainComment(c.body) }))
		.filter((c) => c.preview.length > 0);
	const changed = files ?? [];
	const totalAdd = changed.reduce((n, f) => n + (f.additions || 0), 0);
	const totalDel = changed.reduce((n, f) => n + (f.deletions || 0), 0);
	// Parse the raw patch once into a path→file-diff map so each file row can
	// hover-reveal its own hunks (same @pierre/diffs parse the Changes tab uses).
	const diffTheme = useResolvedTheme();
	const diffByPath = useMemo(() => {
		const m = new Map<string, FileDiffMetadata>();
		if (!rawPatch.trim()) return m;
		try {
			for (const p of parsePatchFiles(rawPatch))
				for (const f of p.files) m.set(f.name, f);
		} catch {
			/* malformed patch — rows just fall back to a plain click. */
		}
		return m;
	}, [rawPatch]);
	const title = workspaceName || oldest?.title || "Untitled session";
	const media = [...liveMedia, ...(data?.media || [])].filter(
		(m, i, all) =>
			all.findIndex(
				(x) =>
					x.kind === m.kind && x.src === m.src && x.sessionId === m.sessionId,
			) === i,
	);

	// PR status belongs in the Info sidebar even when the local tree is clean;
	// local deltas add rows beneath it.
	const showGit = Boolean(
		pr ||
			(git &&
				(git.ahead > 0 ||
					(prState !== "MERGED" && (git.behind > 0 || git.behindBase > 0)) ||
					git.uncommittedFiles > 0)),
	);
	const hasBody = Boolean(
		comments.length > 0 ||
		changed.length > 0 ||
		media.length > 0 ||
		assets.length > 0,
	);

	// `workspace-info-panel` / `workspace-info-title` are DOM hooks, not
	// styling: the phone session-info page reaches both from an ancestor —
	// `[&_.workspace-info-panel]:pt-0` / `[&_.workspace-info-title]:hidden` in
	// INFO_OVERVIEW (lib/session-viewer-classes).
	return (
		<div className="workspace-info-panel flex flex-col gap-4 px-2 pb-[22px] pt-3">
			<div className="grid gap-1 px-1">
				<div className="workspace-info-title selectable text-item-title font-semibold leading-[1.2] text-fg [overflow-wrap:anywhere]">
					{title}
				</div>
				{meta && <div className="text-label leading-[1.35] text-faint">{meta}</div>}
				<ReviewerChip
					sessionId={sessionId}
					reviewRequest={reviewRequest}
					requestSessionId={reviewRequestSessionId}
					acceptedFromPr={reviewAcceptedFromPr}
					onReviewPr={onOpenTab ? () => onOpenTab("pr") : undefined}
					onReviewChange={onReviewChange}
				/>
				{sandbox && (
					<div className="mt-1 flex flex-wrap items-center gap-1.5">
						<SandboxBadge sessionId={sessionId} sandbox={sandbox} />
					</div>
				)}
				{pr && <ChecksChip pr={pr} onOpenChecks={onOpenChecks} />}
			</div>
			{pr?.number && (
				<AgentReviewCard
					sessionId={sessionId}
					repo={repo}
					pr={pr}
					onOpenSession={onOpenSession}
				/>
			)}
			{showGit && (
				<GitStatusRows
					sessionId={sessionId}
					repo={repo}
					git={git}
					pr={pr}
					prState={prState}
					send={send}
					onReload={reloadStatus}
				/>
			)}
			{hasBody ? (
				<div className="grid gap-4">
					{comments.length > 0 && (
						<div className={INFO_SECTION_CLASS}>
							<div className="flex items-center justify-between gap-2 px-1 text-label font-semibold tracking-[-0.01em] text-faint">
								<span>
									{comments.length} PR comment{comments.length === 1 ? "" : "s"}
								</span>
								{onAddToInput && (
									<button
										type="button"
										className="rounded-control border border-line bg-surface px-2 py-0.5 text-[11px] font-semibold text-dim transition-colors hover:border-line-strong hover:bg-hover hover:text-fg"
										onClick={() =>
											onAddToInput(formatFixCommentsPrompt(comments, pr!))
										}
										title="Add every comment to the composer as a fix task"
									>
										Fix
									</button>
								)}
							</div>
							<div className={INFO_LIST_CLASS}>
								{(commentsExpanded
									? comments.slice().reverse()
									: comments.slice(-COMMENT_PREVIEW).reverse()
								).map((c, i) => (
									<CommentCard
										key={c.url || `${c.author}:${i}`}
										comment={c}
										pr={pr!}
										onOpenTab={onOpenTab}
										onAddToInput={onAddToInput}
									/>
								))}
								{comments.length > COMMENT_PREVIEW && (
									<button
										type="button"
										className={INFO_MORE_BUTTON_CLASS}
										onClick={() => setCommentsExpanded((v) => !v)}
									>
										{commentsExpanded
											? "Show fewer comments"
											: `View all ${comments.length} comments`}
									</button>
								)}
							</div>
						</div>
					)}
					{changed.length > 0 && (
						<div className={INFO_SECTION_CLASS}>
							<div className="flex items-center justify-between gap-2 px-1 text-label font-semibold tracking-[-0.01em] text-faint">
								<span>
									{changed.length} file{changed.length === 1 ? "" : "s"} changed
								</span>
								<span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums">
									{totalAdd > 0 && (
										<span className="text-green">+{totalAdd}</span>
									)}
									{totalDel > 0 && (
										<span className="text-red">−{totalDel}</span>
									)}
								</span>
							</div>
							<div className={INFO_LIST_CLASS}>
								{changed.slice(0, FILE_PREVIEW).map((f) => (
									<FileRow
										key={f.path}
										file={f}
										meta={diffByPath.get(f.path)}
										theme={diffTheme}
										onOpenTab={onOpenTab}
									/>
								))}
								{changed.length > FILE_PREVIEW && (
									<button
										type="button"
										className={INFO_MORE_BUTTON_CLASS}
										onClick={() => onOpenTab?.("changes")}
									>
										View all {changed.length} files in Changes →
									</button>
								)}
							</div>
						</div>
					)}
					{media.length > 0 && (
						<div className={INFO_SECTION_CLASS}>
							<div className={INFO_LABEL_CLASS}>
								{media.length} screenshot{media.length === 1 ? "" : "s"}
							</div>
							{/* Not a card like the lists above it: the strip runs the
							    full width of the panel, so tiles leave the screen at
							    its edge instead of ending inside a rounded box.
							    Frames leaving the screen is what reads as "scrolls";
							    the same frames tucked inside a container read as a
							    complete set that happens to be clipped.
							    The negative margins cancel the panel's own `px-2`,
							    plus (on desktop) the `px-1` wrapper the session
							    viewer puts around this panel — hence the extra 4px. */}
							<div
								className="-mx-2 flex snap-x snap-mandatory gap-2 overflow-x-auto overflow-y-hidden desktop:-mx-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
							>
								{media.map((m, i) => (
									<button
										key={`${m.sessionId}:${m.at}:${i}`}
										type="button"
										onClick={(event) =>
											openLightbox(media, i, event.currentTarget)
										}
										className={cn(
											"relative aspect-video shrink-0 snap-start overflow-hidden rounded-control border border-line bg-surface transition-colors hover:border-line-strong hover:bg-hover",
											media.length === 1
												? "w-full"
												: media.length === 2
													? "w-[calc((100%-8px)/2)]"
													: // Two full tiles + the 8px gap + a 22px sliver
														// of the third, which then keeps going past
														// the panel edge.
														"w-[calc((100%-30px)/2)]",
										)}
										title={[m.sessionTitle, new Date(m.at).toLocaleString()]
											.filter(Boolean)
											.join(" · ")}
									>
										{m.kind === "image" ? (
											<img
												src={m.src}
												alt=""
												loading="lazy"
												// contain, not cover: a screenshot is only worth
												// showing if the whole frame is there.
												className="h-full w-full object-contain"
											/>
										) : (
											<>
												<video
													// #t=0.1 makes the browser seek to the first
													// frame and paint it as a poster — without it
													// preload="metadata" leaves the tile blank.
													src={`${m.src}#t=0.1`}
													muted
													playsInline
													preload="metadata"
													className="h-full w-full object-contain"
												/>
												{/* Dark translucent disc so the wedge reads on any
												    frame (a bare white glyph vanishes on light
												    footage). */}
												<span className="pointer-events-none absolute inset-0 grid place-items-center">
													<span className="grid size-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
														<IconPlay size={18} />
													</span>
												</span>
											</>
										)}
									</button>
								))}
							</div>
						</div>
					)}
					{assets.length > 0 && (
						<div className={INFO_SECTION_CLASS}>
							<div className={INFO_LABEL_CLASS}>
								{assets.length} asset{assets.length === 1 ? "" : "s"}
							</div>
							<div className={INFO_LIST_CLASS}>
								{assets.map((a) => (
									<button
										key={a.path}
										type="button"
										onClick={() => onOpenAsset?.(a.path)}
										title={`Open ${a.path}`}
										className="flex w-full min-w-0 items-start gap-2 rounded-control px-[7px] py-[5px] text-left text-label text-fg transition-colors hover:bg-hover"
									>
										<IconFile size={14} className="mt-0.5 shrink-0 text-faint" />
										<span className="min-w-0 flex-1">
											<span className="block truncate">{a.path}</span>
											{a.description && (
												<span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-dim">
													{a.description}
												</span>
											)}
										</span>
										<span className="shrink-0 text-[11px] text-faint">
											{fmtBytes(a.size)}
										</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}

/** Bundle every surfaced PR comment into one "please fix these" composer prompt
		— the Fix button next to the comments heading. Bodies are cleaned to plain
		text and trimmed so the prompt stays readable. */
function formatFixCommentsPrompt(
	comments: Array<{ author: string; body: string; url?: string }>,
	pr: PrDetails,
): string {
	const items = comments
		.map((c, i) => {
			const by = c.author ? ` (${c.author})` : "";
			const link = c.url ? `\n   ${c.url}` : "";
			const body = plainComment(c.body).slice(0, 600);
			return `${i + 1}.${by} ${body}${link}`;
		})
		.join("\n\n");
	return `Please fix the issues raised in these ${comments.length} review comment${
		comments.length === 1 ? "" : "s"
	} on PR #${pr.number} (${pr.title}).\n\n${items}`;
}
