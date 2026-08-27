import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession } from "../lib/types";
import {
	fetchRecentCommits,
	fetchRecentPrs,
	type RecentCommit,
	type RecentPr,
} from "../lib/api";
import {
	buildWorktreeRows,
	compactAge,
	compactDiff,
	dateGroup,
	personLabel,
} from "../lib/pr-rows";
import { buildFeedRows, type FeedOwner, type FeedRow } from "../lib/feed-rows";
import {
	PR_FEED_GROUP_LABEL,
	PR_FEED_ROW,
	PR_LIST,
} from "../lib/pr-list-classes";
import { RepoTile, repoLabel } from "./RepoTile";
import { useCurrentUser } from "./UserPicker";
import { usePeople } from "../lib/people";
import { UserAvatar } from "./UserAvatar";
import { personLensFilter, setFilter } from "../lib/sidebar-filter";
import { presenceState, StatusDot, useTeamPresence } from "./TeamPresence";
import { EmptyState, ListSkeleton } from "../ui/state";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import {
	cn,
	mergeStylexProps,
	mergeStylexOverrideClassName,
	utilityClassName,
} from "../ui/cn";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	size24px: { width: "24px", height: "24px" },
	roundedAvatar: {
			borderRadius: "calc(32% * var(--rp))",
		cornerShape: "var(--cs)"
	},
	shadowVarAvatarEdge: { boxShadow: "var(--avatar-edge)" },
	maxW28: { maxWidth: "112px" },
	maxW150px: { maxWidth: "150px" },
	maxW920px: { maxWidth: "920px" },
	minW200px: { minWidth: "200px" },
	minH30px: { minHeight: "30px" },
	pb15: { paddingBottom: "60px" },
	pt6: { paddingTop: "24px" },
	itemsBaseline: { alignItems: "baseline" },
	leading13: { lineHeight: "1.3" },
	justifySelfEnd: { justifySelf: "flex-end" },
	ml2: { marginLeft: "8px" },
	/** A phone floats its header over the scroll, so the column opens below it. */
	phonePtHeader: {
		"@media (max-width: 720px)": {
			"paddingTop": "calc(var(--header-h) + 18px)"
		}
	},
});
import { IconFeed, IconPeople, IconRepo, IconRobot } from "./icons";
import {
	PEOPLE_CHIP,
	PEOPLE_CHIP_GLYPH,
	PEOPLE_CHIP_GLYPH_SELECTED,
	PEOPLE_CHIP_ROW,
	PEOPLE_CHIP_SELECTED,
	PEOPLE_SECTION_LABEL,
} from "../lib/people-classes";

/**
 * What the team has been shipping.
 *
 * The page is the feed. The team is the row at its top, because who shipped it
 * is how you narrow the feed, not a destination of its own. There is no
 * per-person page to open, since everything you would put on one already
 * exists as their sidebar. Once the row scrolls away, its compact face picker
 * moves into the app bar so the scope stays available.
 *
 * So picking a teammate does two things at once, which is the point: it
 * narrows the feed to their merges, and it hands you their sidebar.
 *
 * The row is people, and only people. GitHub review teams used to sit at the
 * end of it, but a team is a routing rule for reviews rather than a group
 * whose work you would go and read. The sidebar's lens holds one person
 * anyway, so picking a team could not leave the sidebar anywhere sensible.
 */

interface Props {
	sessions: UnifiedSession[];
	/** Who's viewing what right now (global presence), for the face dots. */
	teamViewing?: Array<{ user: string; sessionId: string }>;
	/** The app-level title bar's actions slot. */
	headerActionsEl?: HTMLElement | null;
	/** By id, not by row: most of what the feed can open is archived, and an
	 *  archived session is not in `sessions`. */
	onSelect: (sessionId: string) => void;
}

/** How far back the feed reaches, in days, and the steps "Show more" walks.
 *
 *  This used to be a flat row count, which read as "the feed only shows
 *  today" on a repo that ships a hundred times a day: the cap was spent
 *  before the first date group ended, so no amount of scrolling reached
 *  yesterday. A window is the honest unit — the list ends where the days do,
 *  and the button says how much further it can go. */
const DAY_STEPS = [3, 7, 14, 45];

/** A ceiling on rendered rows, so a very wide window can't stall the page.
 *  It sits far above a busy fortnight; the window is what normally binds. */
const RENDER_CEILING = 1500;

/** Everyone, or one person. */
type Scope = { kind: "everyone" } | { kind: "person"; key: string };

function ScopeChip({
	selected,
	onClick,
	mark,
	label,
}: {
	selected: boolean;
	onClick: () => void;
	mark: React.ReactNode;
	label: string;
}) {
	return (
		<button
			className={cn(PEOPLE_CHIP, selected && PEOPLE_CHIP_SELECTED)}
			onClick={onClick}
			aria-pressed={selected}
		>
			{mark}
			<span className={utilityClassName("min-w-0 truncate")}>{label}</span>
		</button>
	);
}

/**
 * The owner of a row, in the same 24px slot whoever they are. A teammate wears
 * their face; an automation wears a glyph in the avatar's own shape, so the
 * column reads as one column of owners rather than faces and something else.
 *
 * The repo is not here. It rode this corner for a while, which put a second
 * picture on the one mark the column exists to carry, and the repo already has
 * a place of its own beside its name on the line below.
 */
function FeedOwnerMark({ owner }: { owner: FeedOwner }) {
	if (owner.person) {
		return <UserAvatar name={owner.label} size={24} title={owner.label} />;
	}
	return (
		<span
			{...mergeStylexProps(
				utilityClassName("flex shrink-0 items-center justify-center bg-active text-dim"),
				sx.size24px,
				sx.roundedAvatar,
				sx.shadowVarAvatarEdge,
			)}
			title={owner.label}
		>
			<IconRobot size={14} />
		</span>
	);
}

export function Feed({ sessions, teamViewing, headerActionsEl, onSelect }: Props) {
	const currentUser = useCurrentUser();
	const team = useTeamPresence({ sessions, teamViewing, currentUser });
	const people = usePeople();
	const [scope, setScope] = useState<Scope>({ kind: "everyone" });
	const [membersPinned, setMembersPinned] = useState(false);
	const memberRowRef = useRef<HTMLDivElement>(null);
	// The other axis: which repo shipped it. Unlike the person scope this is
	// the page's own filter and touches nothing else, because a repo is not
	// something the sidebar can be turned to.
	const [repo, setRepo] = useState("all");

	// You first, then the team in the order `useTeamPresence` already sorted
	// them: working, then online, then whoever moved most recently.
	const chips = [...team].sort((a, b) => Number(b.isYou) - Number(a.isYou));

	useEffect(() => {
		const row = memberRowRef.current;
		const scroller = row?.closest("[data-page-scroll]");
		if (!row || !(scroller instanceof HTMLElement)) {
			setMembersPinned(false);
			return;
		}
		const observer = new IntersectionObserver(
			([entry]) => {
				const rootTop = entry.rootBounds?.top ?? 0;
				setMembersPinned(
					!entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop,
				);
			},
			{ root: scroller, threshold: 0 },
		);
		observer.observe(row);
		return () => observer.disconnect();
	}, [team.length]);

	const [recentPrs, setRecentPrs] = useState<RecentPr[]>([]);
	const [recentPrsLoading, setRecentPrsLoading] = useState(true);
	const [personPrs, setPersonPrs] = useState<RecentPr[]>([]);
	const [personPrsLoading, setPersonPrsLoading] = useState(false);

	// Picking a person is also the sidebar you turn to. Mark their request in
	// flight before changing scope, rather than waiting for the next effect, so
	// the first filtered paint cannot make the same false empty-state claim.
	const pick = (next: Scope) => {
		setPersonPrs([]);
		setPersonPrsLoading(next.kind === "person");
		setScope(next);
		setFilter({
			person: personLensFilter(
				next.kind === "person" ? next.key : "everyone",
				currentUser,
			),
		});
	};
	// Repos that ship without pull requests — Open Session's own — say what
	// they shipped in commits instead, and land in the same list.
	const [commits, setCommits] = useState<RecentCommit[]>([]);
	// How far back the list currently reaches. "Show more" walks it out, and
	// the server answers with the window it could actually serve, so a step
	// that hits the end of the readable history stops offering another one.
	const [days, setDays] = useState(DAY_STEPS[0]);
	const [hasOlder, setHasOlder] = useState(true);
	// Start in flight. Effects run after the first paint, so initializing this
	// false briefly made a full feed claim it was empty before either request
	// had even started.
	const [widening, setWidening] = useState(true);
	useEffect(() => {
		let active = true;
		fetchRecentPrs(undefined, { days })
			.then((prs) => active && setRecentPrs(prs))
			.catch(() => {})
			.finally(() => active && setRecentPrsLoading(false));
		return () => {
			active = false;
		};
	}, [days]);
	useEffect(() => {
		let active = true;
		setWidening(true);
		fetchRecentCommits(days)
			.then((page) => {
				if (!active) return;
				setCommits(page.commits);
				setHasOlder(page.hasMore);
			})
			.catch(() => {})
			.finally(() => active && setWidening(false));
		return () => {
			active = false;
		};
	}, [days]);
	// One person's own merges, on top of the global list: that list is capped
	// across the whole team, so a quiet fortnight would drop someone out of
	// their own feed.
	const scopedPerson = scope.kind === "person" ? scope.key : null;
	useEffect(() => {
		if (!scopedPerson) {
			setPersonPrs([]);
			setPersonPrsLoading(false);
			return;
		}
		let active = true;
		setPersonPrs([]);
		setPersonPrsLoading(true);
		fetchRecentPrs(scopedPerson)
			.then((prs) => active && setPersonPrs(prs))
			.catch(() => {})
			.finally(() => active && setPersonPrsLoading(false));
		return () => {
			active = false;
		};
	}, [scopedPerson]);

	const inScope = (person: string | null) =>
		scope.kind === "everyone" || person === scope.key;
	const prs = new Map(recentPrs.map((pr) => [pr.url, pr]));
	for (const pr of personPrs) prs.set(pr.url, pr);
	const merged = buildWorktreeRows([...prs.values()], sessions).filter(
		(row) => row.state === "MERGED",
	);
	// The repo list comes from everything shipped, not from what the current
	// scopes leave: a repo has to stay pickable while you are looking at a
	// person who has not touched it, or the control drops the option you were
	// about to use.
	// A row's person is whoever owns the session behind it, which is an
	// automation as often as a teammate. The roster decides which, so an
	// automation is named rather than given a face.
	const teammates = new Set(people.map((p) => p.name.toLowerCase()));
	const allShipped = buildFeedRows(merged, commits, (key) => teammates.has(key));
	const repoOptions = [...new Set(allShipped.map((row) => row.repo).filter(Boolean))].sort();
	const scoped = allShipped.filter(
		(row) => inScope(row.person) && (repo === "all" || row.repo === repo),
	);
	// One horizon for the whole list. Commits arrive already windowed, but
	// merged PRs come from a cache that reaches much further back, so without
	// this the page runs a few days of commits and then a month of pull
	// requests under date headings that read as the team having stopped
	// committing. "Show more" moves the horizon, and both sides move with it.
	const cutoff = Date.now() - days * 86_400_000;
	const shipped = scoped.filter(
		(row) => new Date(row.shippedAt).getTime() >= cutoff,
	);
	const groups = new Map<string, FeedRow[]>();
	for (const row of shipped.slice(0, RENDER_CEILING)) {
		const label = dateGroup(row.shippedAt);
		groups.set(label, [...(groups.get(label) || []), row]);
	}
	const dayGroups = [...groups.entries()];

	// The next step out, offered while either side of the list still has
	// something older to show: commits the server is holding back, or merged
	// PRs the horizon is currently cutting off.
	const nextStep = DAY_STEPS.find((step) => step > days);
	const canWiden = !!nextStep && (hasOlder || scoped.length > shipped.length);

	const scopeName = scope.kind === "person" ? personLabel(scope.key) : null;
	const compactMembers =
		scope.kind === "person"
			? [...chips].sort((a, b) => Number(b.key === scope.key) - Number(a.key === scope.key))
			: chips;
	const visibleCompactMembers = compactMembers.slice(0, 5);
	const hiddenCompactMembers = compactMembers.length - visibleCompactMembers.length;
	const compactPicker = (
		<div className={utilityClassName("flex items-center gap-0.5")} aria-label="Filter feed by person">
			{visibleCompactMembers.map((member) => {
				const selected = scope.kind === "person" && scope.key === member.key;
				return (
					<button
						key={member.key}
						type="button"
						className={cn(
							utilityClassName("focus-ring flex min-h-10 items-center gap-1.5 rounded-control p-1 text-label font-medium text-fg hover:bg-hover"),
							selected && utilityClassName("bg-accent-soft pr-2 text-accent"),
						)}
						onClick={() =>
							pick(
								selected
									? { kind: "everyone" }
									: { kind: "person", key: member.key },
							)
						}
						aria-pressed={selected}
						aria-label={selected ? "Show everyone" : `Show ${member.person.name}`}
					>
						<UserAvatar name={member.person.name} size={30} edge={false} />
						{selected && (
							<span {...mergeStylexProps(utilityClassName("truncate pr-0.5"), sx.maxW28)}>
								{member.isYou ? "You" : personLabel(member.key)}
							</span>
						)}
					</button>
				);
			})}
			{hiddenCompactMembers > 0 && (
				<button
					type="button"
					className={utilityClassName("focus-ring flex size-10 min-h-10 items-center justify-center rounded-control bg-active text-label font-semibold text-dim hover:bg-hover")}
					onClick={() => memberRowRef.current?.scrollIntoView({ block: "start" })}
					aria-label={`Show ${hiddenCompactMembers} more people`}
				>
					+{hiddenCompactMembers}
				</button>
			)}
		</div>
	);
	const feedLoading =
		recentPrs.length === 0 &&
		commits.length === 0 &&
		(recentPrsLoading || widening);
	const filteredFeedLoading =
		dayGroups.length === 0 && (widening || personPrsLoading);

	return (
		<div className={utilityClassName("flex min-h-0 w-full flex-1 flex-col bg-surface")}>
			{membersPinned &&
				headerActionsEl &&
				createPortal(<div className={utilityClassName("phone:hidden")}>{compactPicker}</div>, headerActionsEl)}
			<div data-page-scroll className={utilityClassName("min-h-0 flex-1 overflow-y-auto")}>
				<div {...mergeStylexProps(utilityClassName("mx-auto w-full px-6 phone:px-4 phone:pb-12"), sx.maxW920px, sx.pb15, sx.pt6, sx.phonePtHeader)}>
					{team.length > 0 && (
						<div ref={memberRowRef} className={PEOPLE_CHIP_ROW}>
							<ScopeChip
								selected={scope.kind === "everyone"}
								onClick={() => pick({ kind: "everyone" })}
								mark={
									<span
										className={cn(
											PEOPLE_CHIP_GLYPH,
											scope.kind === "everyone" && PEOPLE_CHIP_GLYPH_SELECTED,
										)}
									>
										<IconPeople size={17} />
									</span>
								}
								label="Everyone"
							/>
							{chips.map((member) => (
								<ScopeChip
									key={member.key}
									selected={scope.kind === "person" && scope.key === member.key}
									onClick={() => pick({ kind: "person", key: member.key })}
									mark={
										<span className={utilityClassName("relative flex")}>
											<UserAvatar name={member.person.name} size={26} />
											<StatusDot
												state={presenceState(member)}
												ring={
													scope.kind === "person" && scope.key === member.key
														? "var(--accent)"
														: "var(--bg-panel)"
												}
												size={8}
											/>
										</span>
									}
									label={member.isYou ? "You" : member.person.name}
								/>
							))}
						</div>
					)}
					{feedLoading ? (
					<>
						<div {...mergeStylexProps(utilityClassName("mb-2 flex items-center"), sx.minH30px)}>
							<h3 className={cn(PEOPLE_SECTION_LABEL, utilityClassName("mb-0"))}>Shipped</h3>
						</div>
						<ListSkeleton
							variant="bare"
							rows={6}
							label="Loading feed"
							className={PR_LIST}
							rowClassName="py-[18px]"
						/>
					</>
				) : recentPrs.length === 0 && commits.length === 0 ? (
					<EmptyState icon={<IconFeed size={22} />} title="Nothing yet">
						Work shows up here as the team ships it.
					</EmptyState>
				) : (
					<>
						{/* The list's own header: what it is on the left, the second
						    axis on the right. The repo filter belongs here rather than
						    among the faces because it narrows the list rather than
						    changing whose sidebar you are in, and it has to stay on
						    screen when a pick empties the list, or the only way back
						    is gone. */}
						<div {...mergeStylexProps(utilityClassName("mb-2 flex items-center justify-between gap-3"), sx.minH30px)}>
							<h3 className={cn(PEOPLE_SECTION_LABEL, utilityClassName("mb-0"))}>
								{scopeName ? `${scopeName} shipped` : "Shipped"}
							</h3>
							{repoOptions.length > 1 && (
								<Menu.Root>
									<Menu.Trigger
										render={
											<Button variant="ghost" size="sm" icon={<IconRepo size={18} />} caret>
												<span {...mergeStylexProps(utilityClassName("truncate"), sx.maxW150px)}>
													{repo === "all" ? "In all repos" : `In ${repoLabel(repo)}`}
												</span>
											</Button>
										}
									/>
									<Menu.Popup align="end" className={mergeStylexOverrideClassName("", sx.minW200px)}>
										<Menu.RadioGroup
											value={repo}
											onValueChange={(value) => setRepo(String(value))}
										>
											<Menu.RadioItem value="all" closeOnClick>
												{/* Sized to the tiles below so every label shares one edge. */}
												<span className={utilityClassName("size-[18px] shrink-0")} />
												<span className={utilityClassName("min-w-0 flex-1 truncate")}>All repos</span>
												<Menu.Check on={repo === "all"} />
											</Menu.RadioItem>
											{repoOptions.map((name) => (
												<Menu.RadioItem key={name} value={name} closeOnClick>
													<RepoTile name={name} size={18} />
													<span className={utilityClassName("min-w-0 flex-1 truncate")}>
														{repoLabel(name)}
													</span>
													<Menu.Check on={repo === name} />
												</Menu.RadioItem>
											))}
										</Menu.RadioGroup>
									</Menu.Popup>
								</Menu.Root>
							)}
						</div>
						{filteredFeedLoading ? (
							<ListSkeleton
								variant="bare"
								rows={6}
								label="Loading feed"
								className={PR_LIST}
								rowClassName="py-[18px]"
							/>
						) : dayGroups.length === 0 ? (
							// A picked teammate or repo with nothing shipped is an answer,
							// so the header stays and the sentence names the filter that
							// emptied it. Both are on screen, so a sentence that names
							// neither reads as "there is nothing", which is the one thing
							// it does not mean.
							<EmptyState title="Nothing shipped yet">
								{scopeName && repo !== "all"
									? `${scopeName} hasn't shipped anything in ${repoLabel(repo)} recently.`
									: scopeName
										? `${scopeName} hasn't shipped anything recently.`
										: repo !== "all"
											? `Nothing has shipped in ${repoLabel(repo)} recently.`
											: "Merged pull requests and commits show up here."}
							</EmptyState>
						) : null}
						<div className={PR_LIST}>
							{dayGroups.map(([label, rows]) => (
								<div key={label} className={utilityClassName("mb-5")}>
									<h4 className={PR_FEED_GROUP_LABEL}>
										{label}
										<span className={utilityClassName("font-medium")}>{rows.length}</span>
									</h4>
									<div>
										{rows.map((row) => (
											<button
												key={row.key}
												className={PR_FEED_ROW}
												onClick={() =>
													row.sessionId
														? onSelect(row.sessionId)
														: row.url && window.open(row.url, "_blank", "noopener")
												}
												title={[
													repoLabel(row.repo),
													row.ref,
													row.owner && !row.owner.person ? row.owner.label : "",
												]
													.filter(Boolean)
													.join(" · ")}
											>
												{/* Who shipped it. An automation is an owner too, so
												    it gets the column rather than the repo standing in
												    for a name. The bare tile is left for the older work
												    that recorded no author at all. */}
												{row.owner ? (
													<FeedOwnerMark owner={row.owner} />
												) : (
													<RepoTile name={row.repo} size={24} />
												)}
												{/* One line. The repo rides in front of the title as
												    its mark alone: it used to be a tile and its own name
												    on a second line, which spent a whole row restating
												    what the picture already said and made the feed twice
												    as tall as it needed to be. The name is in the row's
												    tooltip and in the repo filter above. */}
												<span {...mergeStylexProps(utilityClassName("flex min-w-0 gap-2"), sx.itemsBaseline)}>
													<RepoTile name={row.repo} size={16} className={utilityClassName("self-center")} />
													<span {...mergeStylexProps(utilityClassName("truncate text-item-title font-medium text-fg"), sx.leading13)}>
														{row.title}
													</span>
													{row.ref && (
														<span {...mergeStylexProps(utilityClassName("shrink-0 tabular-nums text-faint"), typography.meta)}>
															{row.ref}
														</span>
													)}
													{/* Which automation shipped it is on the mark's own
													    tooltip and on the row's. It used to sit here, but
													    an owner name is as long as someone made it, and a
													    third run of text truncating mid-word between the
													    title and the diff read as damage rather than as a
													    field. The glyph still says "not a person". */}
												</span>
												{/* A side that moved no lines is left off rather than
												    written as a zero: every commit carries both counts. */}
												<span {...mergeStylexProps(utilityClassName("tabular-nums phone:hidden"), sx.justifySelfEnd, typography.meta)}>
													{!!row.additions && (
														<span className={utilityClassName("text-green")}>+{compactDiff(row.additions)}</span>
													)}
													{!!row.deletions && (
														<span {...mergeStylexProps(utilityClassName("text-red"), sx.ml2)}>−{compactDiff(row.deletions)}</span>
													)}
												</span>
												<span {...mergeStylexProps(utilityClassName("tabular-nums text-faint"), sx.justifySelfEnd, typography.meta)}>
													{compactAge(row.shippedAt)}
												</span>
											</button>
										))}
									</div>
								</div>
							))}
						</div>
						{/* The end of the window, not the end of the work: the feed
						    reaches back a few days by default so the first page stays
						    cheap, and this walks it out. It goes when the server says
						    it holds nothing older, so the last page ends in the list
						    rather than in a button that would do nothing. */}
						{canWiden && (
							<div className={utilityClassName("mt-1 flex justify-center")}>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => nextStep && setDays(nextStep)}
									disabled={widening}
								>
									{widening ? "Loading…" : "Show more"}
								</Button>
							</div>
						)}
					</>
					)}
				</div>
			</div>
		</div>
	);
}
