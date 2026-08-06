import React from "react";
import type { UnifiedSession } from "../lib/types";
import { usePeople, type Person } from "../lib/people";
import { shortTime } from "../lib/time";
import { cn } from "../ui/cn";
import { Popover } from "../ui/popover";
import { UserAvatar } from "./UserAvatar";

/**
 * The team, as a face row. One derivation (`useTeamPresence`) feeds two
 * surfaces: the pile on the sidebar's Home entry — who's around, click to see
 * what they're on — and the pile in the Home header, where a face is the
 * person filter.
 *
 * The pile itself carries no status: it's just the team, and your own
 * connection state already lives on the account row. Status appears where
 * there's room to say it in words — the popover's rows, where a face is dimmed
 * when the person has OS¹ closed, gets a hollow green dot when they're in the
 * app, and a filled pulsing one while a session of theirs has a turn in flight.
 * That pulsing green dot is the same "working" language as the viewer's
 * Working pill.
 */

export interface TeamMember {
	/** Lowercased first name — the key every person filter in the app uses. */
	key: string;
	person: Person;
	/** Has OS¹ open right now (global presence). */
	online: boolean;
	/** One of their sessions has a turn in flight. */
	working: boolean;
	/** True for the signed-in person. */
	isYou: boolean;
	/**
	 * What answers "what are they on": the running session, else the one they're
	 * looking at, else their most recent.
	 */
	session?: UnifiedSession;
	/** Their wall clock, when the directory knows their timezone. */
	localTime?: string;
}

export type PresenceState = "working" | "online" | "away";

export function presenceState(m: TeamMember): PresenceState {
	return m.working ? "working" : m.online ? "online" : "away";
}

/** First token, lowercased — the shape of picker names, `startedBy` and
 *  presence viewers alike (chat integrations send full names). */
function firstName(name?: string | null): string {
	return (name || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
}

/** What a row says the person is doing. */
export function presenceLabel(m: TeamMember): string {
	const title = m.session?.title?.trim();
	if (m.working) return title ? `Working on ${title}` : "Working";
	if (m.online) return title ? `Viewing ${title}` : "In OS¹";
	if (title) return `Last: ${title}`;
	return m.localTime ? `${m.localTime} their time` : "Away";
}

export function useTeamPresence({
	sessions,
	teamViewing,
	currentUser,
}: {
	sessions: UnifiedSession[];
	teamViewing?: Array<{ user: string; sessionId: string }>;
	currentUser?: string;
}): TeamMember[] {
	const roster = usePeople();

	// Who's looking at what right now (global presence), by first name.
	const viewingBy = new Map<string, string>();
	for (const v of teamViewing || []) viewingBy.set(firstName(v.user), v.sessionId);

	// Per person: the newest session, and any session of theirs with a run in flight.
	// Automations and sub-agent sessions are machine work, not "what Kent is on".
	const latest = new Map<string, UnifiedSession>();
	const runningBy = new Map<string, UnifiedSession>();
	const byId = new Map<string, UnifiedSession>();
	for (const s of sessions) {
		byId.set(s.id, s);
		if (s.archived || s.automation) continue;
		const key = firstName(s.startedBy);
		if (!key) continue;
		const prev = latest.get(key);
		if (!prev || (s.lastActivity || "") > (prev.lastActivity || "")) latest.set(key, s);
		if (s.isRunning) {
			const run = runningBy.get(key);
			if (!run || (s.lastActivity || "") > (run.lastActivity || "")) runningBy.set(key, s);
		}
	}

	const me = firstName(currentUser);
	const members = roster.map((person): TeamMember => {
		const key = person.name.toLowerCase();
		const liveId = viewingBy.get(key);
		const running = runningBy.get(key);
		const live = liveId ? byId.get(liveId) : undefined;
		return {
			key,
			person,
			online: !!liveId,
			working: !!running,
			isYou: key === me,
			session: running || live || latest.get(key),
			localTime: person.timezone
				? new Intl.DateTimeFormat([], {
						hour: "2-digit",
						minute: "2-digit",
						timeZone: person.timezone,
					}).format(new Date())
				: undefined,
		};
	});

	// Working first, then online, then whoever moved most recently. You sort
	// last within your own bucket so a teammate never loses a slot in a capped
	// pile to your own face.
	const rank = (m: TeamMember) => (m.working ? 0 : m.online ? 1 : 2);
	return members.sort((a, b) => {
		if (rank(a) !== rank(b)) return rank(a) - rank(b);
		if (a.isYou !== b.isYou) return a.isYou ? 1 : -1;
		return (b.session?.lastActivity || "").localeCompare(a.session?.lastActivity || "");
	});
}

/**
 * The dot sits inside the face's own box (bottom-right corner), ringed in the
 * popup's own surface so it separates from the picture under it.
 */
function StatusDot({ state }: { state: PresenceState }) {
	if (state === "away") return null;
	return (
		<span
			className="absolute bottom-0 right-0 size-[7px] rounded-full shadow-[0_0_0_1.5px_var(--bg-panel)]"
			aria-hidden="true"
		>
			<span
				className={cn(
					"block size-full rounded-full bg-panel",
					state === "working"
						? "bg-green motion-safe:animate-pulse"
						: "border-[1.5px] border-green",
				)}
			/>
		</span>
	);
}

/** A face. `status` is for the popover's rows, which have room to say what the
 *  dimming and the dot mean; the piles show the person and nothing else. */
function Face({
	member,
	size,
	status,
	selected,
	ring,
}: {
	member: TeamMember;
	size: number;
	status?: boolean;
	selected?: boolean;
	/** Colour of the gap a piled face cuts into the one behind it. */
	ring?: string;
}) {
	const state = presenceState(member);
	return (
		// `flex`, not `inline-flex`: an inline box sits on its parent's baseline
		// and carries the descender space below it, which makes the face ride
		// high against anything centred beside it (the pile's "+N").
		<span className="relative flex">
			<UserAvatar
				name={member.person.name}
				size={size}
				className={cn(status && state === "away" && "opacity-45 grayscale")}
				style={{
					// The ring paints the row's own colour just outside the picture,
					// so the face in front cuts a clean gap into the one behind it
					// instead of the two running together. It layers on top of the
					// avatar's own hairline (--avatar-edge) rather than replacing it:
					// without that edge a light photo dissolves into a light gap.
					...(ring ? { boxShadow: `var(--avatar-edge), 0 0 0 2px ${ring}` } : null),
					// An outline follows the squircle radius and paints outside the
					// box, so the picked face reads as ringed rather than boxed.
					...(selected
						? { outline: "2px solid var(--accent)", outlineOffset: "1px" }
						: null),
				}}
			/>
			{status && <StatusDot state={state} />}
		</span>
	);
}

/**
 * Overlapping face row. Without `onSelect` it's decoration (safe to nest in a
 * trigger); with it, every face is its own toggle — the Home filter.
 */
export function TeamFacepile({
	members,
	size = 22,
	max = 6,
	ring = "var(--bg)",
	selectedKey,
	onSelect,
	className,
}: {
	members: TeamMember[];
	size?: number;
	max?: number;
	/** What the pile is painted on: each face rings itself in it to separate. */
	ring?: string;
	selectedKey?: string | null;
	onSelect?: (member: TeamMember) => void;
	className?: string;
}) {
	// A selected face must stay in the pile even when it would fall off the end.
	const shown = members.slice(0, max);
	if (selectedKey && !shown.some((m) => m.key === selectedKey)) {
		const picked = members.find((m) => m.key === selectedKey);
		if (picked) shown.splice(max - 1, 1, picked);
	}
	const overflow = members.length - shown.length;
	// A shoulder's worth of overlap: enough to read as one group, shallow
	// enough that every face stays a face rather than a sliver. Two of those
	// pixels go to the ring, so the tuck reads as a gap, not a collision.
	const overlap = Math.round(size * 0.26);
	const selectedIndex = selectedKey ? shown.findIndex((m) => m.key === selectedKey) : -1;
	const selectedTuck = Math.max(2, Math.round(size * 0.08));
	return (
		<div className={cn("flex items-center", className)}>
			{shown.map((m, i) => {
				const selected = !!selectedKey && m.key === selectedKey;
				const label = `${m.person.fullName} · ${presenceLabel(m)}`;
				const besideSelected = i === selectedIndex || i === selectedIndex + 1;
				const style: React.CSSProperties = {
					// Tighten both gaps around the picked face. Its higher z-index keeps
					// the larger face and accent ring above the neighbours tucked behind it.
					marginLeft: i === 0 ? 0 : -(overlap + (besideSelected ? selectedTuck : 0)),
					// The pile runs front-to-back, left to right: each face tucks
					// behind the one before it, so nothing later covers what's read
					// first. The picked face clears them all.
					zIndex: selected ? shown.length + 1 : shown.length - i,
				};
				if (!onSelect)
					return (
						<span key={m.key} className="relative" style={style} title={label}>
							<Face member={m} size={size} ring={ring} />
						</span>
					);
				return (
					<button
						key={m.key}
						type="button"
						className={cn(
							"relative cursor-pointer rounded-full border-0 bg-transparent p-0 transition-transform duration-100 hover:z-20 hover:-translate-y-px focus-visible:z-20 focus-visible:outline-none",
							selected && "scale-[1.1]",
						)}
						style={style}
						title={label}
						aria-pressed={selected}
						aria-label={label}
						onClick={() => onSelect(m)}
					>
						<Face member={m} size={size} ring={ring} selected={selected} />
					</button>
				);
			})}
			{overflow > 0 && (
				<span
					// The rest of the team is a count, not another face: no tile, no
					// border, just the number sitting on the row's centre line.
					className="ml-1.5 flex items-center text-meta font-semibold tabular-nums text-dim"
					style={{ height: size }}
					title={members
						.slice(shown.length)
						.map((m) => m.person.fullName)
						.join(", ")}
				>
					+{overflow}
				</span>
			)}
		</div>
	);
}

/**
 * The sidebar's pile: a face row that opens the team, each row saying what
 * that person is on. Clicking a row opens their session.
 */
export function TeamPresencePopover({
	members,
	size = 20,
	max = 4,
	ring,
	onOpenSession,
	className,
}: {
	members: TeamMember[];
	size?: number;
	max?: number;
	/** Colour of the row the pile sits on — the faces ring themselves in it. */
	ring?: string;
	onOpenSession?: (session: UnifiedSession) => void;
	className?: string;
}) {
	if (members.length === 0) return null;
	const active = members.filter((m) => m.online || m.working).length;
	return (
		<Popover.Root>
			<Popover.Trigger
				className={cn(
					"inline-flex cursor-pointer items-center rounded-full border-0 bg-transparent p-0",
					className,
				)}
				aria-label={
					active > 0 ? `Team — ${active} here now` : "Team — nobody here now"
				}
			>
				<TeamFacepile members={members} size={size} max={max} ring={ring} />
			</Popover.Trigger>
			<Popover.Popup align="end" side="bottom" sideOffset={8} initialFocus className="w-[290px] p-1.5">
				<div className="flex items-baseline justify-between px-2 pb-1 pt-1.5">
					<span className="text-label font-semibold text-faint">Team</span>
					<span className="text-label text-faint">
						{active > 0 ? `${active} here now` : "Nobody here now"}
					</span>
				</div>
				{members.map((m) => {
					const session = m.session;
					const state = presenceState(m);
					const row = (
						<>
							<Face member={m} size={26} status />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex min-w-0 items-baseline gap-1.5">
									<span className="truncate text-body font-medium text-fg">
										{m.person.name}
										{m.isYou && <span className="ml-1 text-faint">you</span>}
									</span>
									{session?.lastActivity && state === "away" && (
										<span className="ml-auto shrink-0 text-meta text-faint">
											{shortTime(session.lastActivity)}
										</span>
									)}
								</span>
								<span
									className={cn(
										"truncate text-meta",
										state === "working" ? "text-green" : "text-faint",
									)}
								>
									{presenceLabel(m)}
								</span>
							</span>
						</>
					);
					const cls =
						"flex w-full min-w-0 items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left";
					return session && onOpenSession ? (
						<button
							key={m.key}
							type="button"
							className={cn(cls, "cursor-pointer hover:bg-hover")}
							onClick={() => onOpenSession(session)}
							title={`Open “${session.title || session.id}”`}
						>
							{row}
						</button>
					) : (
						<div key={m.key} className={cls}>
							{row}
						</div>
					);
				})}
			</Popover.Popup>
		</Popover.Root>
	);
}
