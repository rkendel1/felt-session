import React, { useEffect, useMemo, useRef, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";

interface Props {
	sessions: UnifiedSession[];
	/** Open a session by id (also closes the palette). */
	onSelect: (id: string) => void;
	onClose: () => void;
}

const DEFAULT_PROJECT = "tella-fusion";

function sessionRepo(s: UnifiedSession): string {
	return s.project || DEFAULT_PROJECT;
}

// The status buckets a session can fall into, mirroring the sidebar's triage
// order: a blocked question first, then live activity, then PR lifecycle.
type Status = "needsinput" | "running" | "review" | "merged" | "done";

const STATUS_META: Record<Status, { label: string; dotClass: string }> = {
	needsinput: { label: "Needs input", dotClass: "ss-dot-accent" },
	running: { label: "Running", dotClass: "ss-dot-green" },
	review: { label: "In review", dotClass: "ss-dot-yellow" },
	merged: { label: "Merged", dotClass: "ss-dot-purple" },
	done: { label: "Done", dotClass: "ss-dot-dim" },
};

const STATUS_ORDER: Status[] = [
	"needsinput",
	"running",
	"review",
	"merged",
	"done",
];

function sessionStatus(s: UnifiedSession): Status {
	if (s.waitingForInput) return "needsinput";
	if (s.isRunning) return "running";
	if (s.prState === "OPEN") return "review";
	if (s.prState === "MERGED") return "merged";
	return "done";
}

// The searchable haystack for a session — title plus every field a person might
// recall it by (branch, owner, automation, repo, Linear id).
function haystack(s: UnifiedSession): string {
	return [
		s.title,
		s.branch,
		s.startedBy,
		s.automation,
		sessionRepo(s),
		s.linearIssue?.identifier,
		s.linearIssue?.title,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

// A compact styled dropdown built on a native <select> (an invisible select is
// stacked over the pill so we get a real OS menu for free — same trick as the
// new-session palette).
function FilterPill({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (v: string) => void;
}) {
	const active = value !== "all";
	const current = options.find((o) => o.value === value);
	return (
		<div className={`ss-pill${active ? " ss-pill-active" : ""}`}>
			<span className="ss-pill-key">{label}</span>
			<span className="ss-pill-val">{current?.label ?? value}</span>
			<span className="ss-pill-caret">▾</span>
			<select
				className="ss-pill-select"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-label={label}
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</div>
	);
}

export function SessionSearch({ sessions, onSelect, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [person, setPerson] = useState("all");
	const [repo, setRepo] = useState("all");
	const [status, setStatus] = useState<Status | "all">("all");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Only live (non-archived) sessions are searchable here.
	const pool = useMemo(
		() => sessions.filter((s) => !s.archived),
		[sessions],
	);

	// Filter option lists are built off the full pool (not the filtered set) so
	// they don't churn as you narrow things down.
	const personOptions = useMemo(() => {
		const seen = new Map<string, string>(); // lowercased → first-seen spelling
		for (const s of pool) {
			if (s.automation || !s.startedBy) continue;
			const k = s.startedBy.toLowerCase();
			if (!seen.has(k)) seen.set(k, s.startedBy);
		}
		return [
			{ value: "all", label: "Anyone" },
			...Array.from(seen.entries())
				.sort((a, b) => a[1].localeCompare(b[1]))
				.map(([k, label]) => ({ value: k, label })),
		];
	}, [pool]);

	const repoOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const s of pool) {
			const p = sessionRepo(s);
			counts.set(p, (counts.get(p) || 0) + 1);
		}
		return [
			{ value: "all", label: "Any repo" },
			...Array.from(counts.entries())
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([p]) => ({ value: p, label: p })),
		];
	}, [pool]);

	const statusOptions = useMemo(
		() => [
			{ value: "all", label: "Any status" },
			...STATUS_ORDER.map((k) => ({ value: k, label: STATUS_META[k].label })),
		],
		[],
	);

	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		const terms = q.split(/\s+/).filter(Boolean);
		let out = pool.filter((s) => {
			if (person !== "all" && (s.startedBy || "").toLowerCase() !== person)
				return false;
			if (repo !== "all" && sessionRepo(s) !== repo) return false;
			if (status !== "all" && sessionStatus(s) !== status) return false;
			if (terms.length === 0) return true;
			const hay = haystack(s);
			return terms.every((t) => hay.includes(t));
		});
		// Most-recently-active first — the same order the sidebar defaults to.
		out = out.sort(
			(a, b) =>
				new Date(b.lastActivity).getTime() -
				new Date(a.lastActivity).getTime(),
		);
		return out.slice(0, 100);
	}, [pool, query, person, repo, status]);

	// Clamp the active row whenever the result set changes.
	useEffect(() => {
		setActive((i) => Math.min(i, Math.max(0, results.length - 1)));
	}, [results.length]);

	// Keep the highlighted row scrolled into view during keyboard nav.
	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-idx="${active}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [active]);

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, results.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const s = results[active];
			if (s) onSelect(s.id);
		} else if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		}
	}

	const hasFilter =
		person !== "all" || repo !== "all" || status !== "all";

	return (
		<div
			className="palette-backdrop"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="palette-card ss-card"
				role="dialog"
				aria-label="Search sessions"
				onKeyDown={onKeyDown}
			>
				<div className="ss-search-row">
					<svg
						className="ss-search-icon"
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						aria-hidden="true"
					>
						<circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
						<path
							d="M14 14L10.7 10.7"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
					<input
						ref={inputRef}
						className="ss-search-input"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search all sessions…"
						spellCheck={false}
					/>
					<kbd className="ss-kbd">esc</kbd>
				</div>

				<div className="ss-filters">
					<FilterPill
						label="Person"
						value={person}
						options={personOptions}
						onChange={setPerson}
					/>
					<FilterPill
						label="Repo"
						value={repo}
						options={repoOptions}
						onChange={setRepo}
					/>
					<FilterPill
						label="Status"
						value={status}
						options={statusOptions}
						onChange={(v) => setStatus(v as Status | "all")}
					/>
					{hasFilter && (
						<button
							className="ss-clear"
							onClick={() => {
								setPerson("all");
								setRepo("all");
								setStatus("all");
							}}
						>
							Clear
						</button>
					)}
				</div>

				<div className="ss-results" ref={listRef}>
					{results.length === 0 && (
						<div className="ss-empty">No matching sessions</div>
					)}
					{results.map((s, i) => {
						const st = sessionStatus(s);
						const meta = STATUS_META[st];
						return (
							<button
								key={s.id}
								data-idx={i}
								className={`ss-item${i === active ? " ss-item-active" : ""}`}
								onMouseMove={() => setActive(i)}
								onClick={() => onSelect(s.id)}
							>
								<span className={`ss-item-dot ${meta.dotClass}`} />
								<span className="ss-item-main">
									<span className="ss-item-title">{s.title}</span>
									<span className="ss-item-meta">
										{s.automation ? (
											<span className="ss-tag ss-tag-auto">{s.automation}</span>
										) : (
											s.startedBy && <span>{s.startedBy}</span>
										)}
										<span className="ss-item-repo">{sessionRepo(s)}</span>
										{s.branch && (
											<span className="ss-item-branch">{s.branch}</span>
										)}
										<span className="ss-item-time">
											{relativeTime(s.lastActivity)}
										</span>
									</span>
								</span>
								<span className="ss-item-status">{meta.label}</span>
							</button>
						);
					})}
				</div>

				<div className="ss-hint">
					<span>
						<kbd className="ss-kbd">↑</kbd>
						<kbd className="ss-kbd">↓</kbd> navigate
					</span>
					<span>
						<kbd className="ss-kbd">↵</kbd> open
					</span>
					<span className="ss-hint-count">
						{results.length} session{results.length === 1 ? "" : "s"}
					</span>
				</div>
			</div>
		</div>
	);
}
