/**
 * Analytics: what happened on/because of Open Session, aggregated for the
 * Analytics view (sidebar → Analytics). Three sources, all read-only:
 *
 * - The audit log (~/.opensession-audit/audit-YYYY-MM-DD.jsonl) for per-turn
 *   facts: turns, tokens, models, run kinds, errors, cancellations. Day files
 *   are 10-20MB, so each day is parsed once into a compact rollup and disk-
 *   cached (keyed by source size — today's growing file recomputes, past days
 *   never do).
 * - The session store (~/.opensession-sessions) for who created what: person,
 *   automation, mode, branch, repo.
 * - `gh pr list` for PRs opened/merged in the range, attributed to Open Session
 *   by head-branch ∈ {branches of code-mode sessions} (review sessions are
 *   ask-mode and don't own their branch, so reviewed-only PRs don't count).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { $ } from "bun";
import { stateDir , isNativeSessionId} from "./paths";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { configuredRepos, defaultRepo, githubBotLogins } from "./config";
import { ghRateLimited, isGhRateLimitMsg, noteGhRateLimited } from "./github-limit";
import { readFeedback } from "../agents/github/feedback";
import type { FeedbackRecord } from "../agents/github/feedback-gates";

const AUDIT_DIR = stateDir("audit");
const CACHE_DIR = stateDir("analytics-cache");
// Bump when the rollup shape changes — stale disk caches recompute.
const ROLLUP_VERSION = 5;

interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface ModelAgg extends TokenTotals {
	turns: number;
}

interface SessionAgg {
	kind: string;
	turns: number;
	output: number;
	errors: number;
}

/** Per-day PR-review telemetry from `review_*` audit events. `completed`
 *  (verdict/confidence/findings) only exists from 2026-07-28 on — earlier
 *  days legitimately roll up to zeros. */
interface ReviewDayAgg {
	completed: number;
	updates: number;
	verdicts: Record<string, number>;
	confidenceSum: number;
	confidenceN: number;
	findings: number;
	blocking: number;
	withheld: number;
	missedBugs: number;
	repliesPositive: number;
	repliesDismissive: number;
}

function emptyReviewAgg(): ReviewDayAgg {
	return {
		completed: 0,
		updates: 0,
		verdicts: {},
		confidenceSum: 0,
		confidenceN: 0,
		findings: 0,
		blocking: 0,
		withheld: 0,
		missedBugs: 0,
		repliesPositive: 0,
		repliesDismissive: 0,
	};
}

interface DayRollup {
	date: string;
	turns: number;
	errors: number;
	cancelled: number;
	durationMs: number;
	oneshots: number;
	tokens: TokenTotals;
	byModel: Record<string, ModelAgg>;
	/** Turns whose audit events carried no model (pre-2026-07-09 SDK-runner
	 *  days), keyed by session id — resolved against the session store's
	 *  `model` at compose time. */
	unknownModel: Record<string, ModelAgg>;
	bySession: Record<string, SessionAgg>;
	review: ReviewDayAgg;
}

/** "opencode/anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6". */
function shortModel(model: string): string {
	return model.replace(/^opencode\/[^/]+\//, "") || "unknown";
}

function emptyTokens(): TokenTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function rollupAuditDay(date: string): DayRollup {
	const rollup: DayRollup = {
		date,
		turns: 0,
		errors: 0,
		cancelled: 0,
		durationMs: 0,
		oneshots: 0,
		tokens: emptyTokens(),
		byModel: {},
		unknownModel: {},
		bySession: {},
		review: emptyReviewAgg(),
	};
	const path = `${AUDIT_DIR}/audit-${date}.jsonl`;
	if (!existsSync(path)) return rollup;

	const promptModel = new Map<string, string>();
	const sessionOf = (e: Record<string, unknown>): SessionAgg | null => {
		const id = String(e.session_id || e.bks_session_id || "");
		if (!id) return null;
		return (rollup.bySession[id] ||= {
			// A restart-reattached turn is still its base kind for analytics.
			kind: String(e.run_kind || "?").replace(/-reattach$/, ""),
			turns: 0,
			output: 0,
			errors: 0,
		});
	};

	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line) continue;
		// Cheap pre-filter: the firehose kinds (tool_use/result/thinking/text)
		// are ~95% of lines and irrelevant here — skip them without parsing.
		const isResult = line.includes('"kind":"result"');
		const isPrompt = line.includes('"kind":"user_prompt"');
		const isError = line.includes('"kind":"error"');
		const isCancelled = line.includes('"kind":"cancelled"');
		const isOneshot = line.includes('"msg":"opencode_oneshot"');
		// Engine-run end events carry the turn's wall-clock duration (the
		// per-turn "result" events don't on the opencode engine).
		const isRunEnd =
			line.includes('"phase":"end"') &&
			(line.includes('"msg":"opencode_meridian_run"') || line.includes('"msg":"opencode_openai_run"'));
		const isReviewEvt = line.includes('"msg":"review_');
		if (!isResult && !isPrompt && !isError && !isCancelled && !isOneshot && !isRunEnd && !isReviewEvt) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (isReviewEvt) {
			const rv = rollup.review;
			switch (String(e.msg || "")) {
				case "review_completed": {
					rv.completed++;
					if (e.is_update) rv.updates++;
					const verdict = String(e.verdict || "");
					if (verdict) rv.verdicts[verdict] = (rv.verdicts[verdict] || 0) + 1;
					if (typeof e.confidence === "number") {
						rv.confidenceSum += e.confidence;
						rv.confidenceN++;
					}
					rv.findings += Number(e.findings) || 0;
					rv.blocking += Number(e.blocking) || 0;
					break;
				}
				case "review_findings_withheld":
					rv.withheld += Number(e.withheld) || 0;
					break;
				case "review_missed_bug":
					rv.missedBugs++;
					break;
				case "review_reply_signal":
					rv.repliesPositive += Number(e.positive) || 0;
					rv.repliesDismissive += Number(e.dismissive) || 0;
					break;
			}
			continue;
		}
		if (e.msg === "opencode_oneshot") {
			rollup.oneshots++;
			continue;
		}
		if (e.msg === "opencode_meridian_run" || e.msg === "opencode_openai_run") {
			rollup.durationMs += Number(e.duration_ms) || 0;
			continue;
		}
		const s = sessionOf(e);
		switch (String(e.kind || "")) {
			// Some engines' result events carry no model — remember the turn's
			// model from its user_prompt so those turns don't land in "unknown".
			case "user_prompt":
				if (e.model && (e.session_id || e.bks_session_id)) {
					promptModel.set(String(e.session_id || e.bks_session_id), shortModel(String(e.model)));
				}
				break;
			case "result": {
				rollup.turns++;
				const input = Number(e.input_tokens) || 0;
				const output = Number(e.output_tokens) || 0;
				const cacheRead = Number(e.cache_read_input_tokens) || 0;
				const cacheWrite = Number(e.cache_creation_input_tokens) || 0;
				rollup.tokens.input += input;
				rollup.tokens.output += output;
				rollup.tokens.cacheRead += cacheRead;
				rollup.tokens.cacheWrite += cacheWrite;
				const model = e.model
					? shortModel(String(e.model))
					: promptModel.get(String(e.session_id || e.bks_session_id || "")) || "";
				const m = model
					? (rollup.byModel[model] ||= { turns: 0, ...emptyTokens() })
					: (rollup.unknownModel[String(e.session_id || e.bks_session_id || "")] ||= { turns: 0, ...emptyTokens() });
				m.turns++;
				m.input += input;
				m.output += output;
				m.cacheRead += cacheRead;
				m.cacheWrite += cacheWrite;
				if (s) {
					s.turns++;
					s.output += output;
				}
				break;
			}
			case "error":
				rollup.errors++;
				if (s) s.errors++;
				break;
			case "cancelled":
				rollup.cancelled++;
				break;
		}
	}
	return rollup;
}

/** Rollup with a per-day disk cache keyed on the source file's size. */
function cachedRollup(date: string): DayRollup {
	const src = `${AUDIT_DIR}/audit-${date}.jsonl`;
	const size = existsSync(src) ? statSync(src).size : 0;
	const cachePath = `${CACHE_DIR}/day-${date}.json`;
	try {
		if (existsSync(cachePath)) {
			const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
			if (cached.v === ROLLUP_VERSION && cached.size === size) return cached.rollup;
		}
	} catch {}
	const rollup = rollupAuditDay(date);
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(cachePath, JSON.stringify({ v: ROLLUP_VERSION, size, rollup }));
	} catch (e) {
		console.error("[analytics] rollup cache write failed:", e);
	}
	return rollup;
}

// ── Session store scan ──

interface SessionMeta {
	id: string;
	createdAt: string;
	createdBy: string;
	mode: string;
	model: string;
	branch: string;
	repo: string | null;
	/** Set (to the automation's display name) for automation-created sessions. */
	automationName: string | null;
	isReview: boolean;
}

function repoOfWorktree(worktreeDir: string): string | null {
	if (!worktreeDir) return null;
	const base = worktreeDir.split("/").pop() || "";
	for (const repo of Object.values(configuredRepos())) {
		if (worktreeDir === repo.repo || worktreeDir.startsWith(`${repo.repo}/`)) return repo.id;
		if (base.startsWith(`${repo.wtPrefix}-`)) return repo.id;
	}
	return null;
}

let sessionMetaCache: { at: number; map: Map<string, SessionMeta> } | null = null;

function loadSessionMeta(): Map<string, SessionMeta> {
	if (sessionMetaCache && Date.now() - sessionMetaCache.at < 60_000) return sessionMetaCache.map;
	const map = new Map<string, SessionMeta>();
	try {
		for (const file of readdirSync(OPENSESSION_SESSIONS_DIR)) {
			if (!isNativeSessionId(file) || !file.endsWith(".json")) continue;
			try {
				const s = JSON.parse(readFileSync(`${OPENSESSION_SESSIONS_DIR}/${file}`, "utf-8"));
				const id = String(s.id || file.slice(0, -5));
				const createdBy = String(s.createdBy || "");
				const autoMatch = createdBy.match(/^(.*) \(automation\)$/);
				map.set(id, {
					id,
					createdAt: String(s.createdAt || ""),
					createdBy,
					mode: String(s.mode || ""),
					model: String(s.model || ""),
					branch: String(s.branch || ""),
					repo: repoOfWorktree(String(s.worktreeDir || "")),
					automationName: autoMatch ? autoMatch[1] : null,
					isReview: id.startsWith("bks-ghpr-") || createdBy === "GitHub (automation)",
				});
			} catch {}
		}
	} catch (e) {
		console.error("[analytics] session scan failed:", e);
	}
	sessionMetaCache = { at: Date.now(), map };
	return map;
}

// ── PRs via gh ──

export interface AnalyticsPr {
	repo: string;
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	createdAt: string;
	mergedAt: string | null;
	headRefName: string;
	byOpensession: boolean;
}

const PR_CACHE_TTL_MS = 10 * 60 * 1000;
const prCache = new Map<string, { at: number; prs: AnalyticsPr[] }>();

async function fetchRepoPrs(repoId: string, ghRepo: string, fromDate: string): Promise<AnalyticsPr[]> {
	const key = `${ghRepo}:${fromDate}`;
	const cached = prCache.get(key);
	if (cached && Date.now() - cached.at < PR_CACHE_TTL_MS) return cached.prs;
	if (ghRateLimited() && cached) return cached.prs; // serve stale during a backoff window

	const fields = "number,title,url,state,createdAt,mergedAt,headRefName";
	const seen = new Map<number, AnalyticsPr>();
	// Two searches: PRs created in range (any state) + PRs merged in range
	// (which may have been created before it). Capped at 1000 (the GitHub
	// search ceiling) — tella-fusion alone opens 400+ PRs in a 30-day window.
	for (const search of [`created:>=${fromDate}`, `merged:>=${fromDate}`]) {
		try {
			const raw = await $`gh pr list --repo ${ghRepo} --state all --limit 1000 --search ${search} --json ${fields}`
				.quiet()
				.text();
			for (const pr of JSON.parse(raw)) {
				seen.set(pr.number, {
					repo: repoId,
					number: pr.number,
					title: String(pr.title || ""),
					url: String(pr.url || ""),
					state: pr.state,
					createdAt: String(pr.createdAt || ""),
					mergedAt: pr.mergedAt ? String(pr.mergedAt) : null,
					headRefName: String(pr.headRefName || ""),
					byOpensession: false,
				});
			}
		} catch (e) {
			console.error(`[analytics] gh pr list failed for ${ghRepo}:`, e);
			if (isGhRateLimitMsg(String((e as any)?.stderr || e))) noteGhRateLimited("analytics");
		}
	}
	const prs = [...seen.values()];
	prCache.set(key, { at: Date.now(), prs });
	return prs;
}

// ── Factory health: review depth on merged PRs ──
//
// The lights-off failure mode is invisible in open/merge counts: PRs merging
// with zero human eyes, growing rework, reverts creeping up. This measures it
// with a second, merged-only gh query that pulls the heavy per-PR fields
// (reviews, comments, commits) the cheap list query deliberately skips.

export interface FactoryCohort {
	merged: number;
	/** Merged PRs with ≥1 review or comment from a human other than the author. */
	humanReviewed: number;
	/** Merged PRs whose title is a revert. */
	reverts: number;
	/** Avg commits pushed after the first human review, over reviewed PRs. */
	avgReworkCommits: number;
	medianHoursToMerge: number;
	/** Avg additions+deletions per merged PR. */
	avgLinesChanged: number;
}

interface FactoryPr {
	repo: string;
	number: number;
	headRefName: string;
	title: string;
	createdAt: string;
	mergedAt: string;
	linesChanged: number;
	humanReviews: number;
	reworkCommits: number;
}

/** Review activity by the bot credential (or any app bot) isn't human review. */
const BOT_LOGINS = new Set(githubBotLogins());
function isHumanReviewer(login: unknown, prAuthor: string): boolean {
	const l = String(login || "");
	return !!l && l !== prAuthor && !BOT_LOGINS.has(l) && !l.endsWith("[bot]") && !l.startsWith("app/");
}

const FACTORY_CACHE_TTL_MS = 30 * 60 * 1000;
const factoryCache = new Map<string, { at: number; prs: FactoryPr[] }>();
const FACTORY_PR_CAP = 400;

// Custom query instead of `gh pr list --json reviews,commits,comments`: gh's
// canned query nests commits(100)×authors(100) = ~1M possible nodes per page,
// over GitHub's 500k cap. We only need dates and logins (~20k nodes per page).
const FACTORY_QUERY = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title createdAt mergedAt additions deletions headRefName
        author { login }
        reviews(first: 50) { nodes { author { login } submittedAt } }
        comments(first: 50) { nodes { author { login } createdAt } }
        commits(last: 100) { nodes { commit { committedDate } } }
      }
    }
  }
}`;

async function fetchRepoFactoryPrs(repoId: string, ghRepo: string, fromDate: string): Promise<FactoryPr[]> {
	const key = `${ghRepo}:${fromDate}`;
	const cached = factoryCache.get(key);
	if (cached && Date.now() - cached.at < FACTORY_CACHE_TTL_MS) return cached.prs;
	if (ghRateLimited() && cached) return cached.prs;

	const prs: FactoryPr[] = [];
	const q = `repo:${ghRepo} is:pr is:merged merged:>=${fromDate}`;
	let cursor = "";
	try {
		while (prs.length < FACTORY_PR_CAP) {
			const args = ["api", "graphql", "-f", `query=${FACTORY_QUERY}`, "-f", `q=${q}`];
			if (cursor) args.push("-f", `cursor=${cursor}`);
			const raw = await $`gh ${args}`.quiet().text();
			const search = JSON.parse(raw)?.data?.search;
			for (const pr of search?.nodes || []) {
				if (!pr?.number) continue;
				const author = String(pr.author?.login || "");
				const humanEvents: string[] = [];
				for (const r of pr.reviews?.nodes || []) {
					if (isHumanReviewer(r?.author?.login, author) && r?.submittedAt) humanEvents.push(String(r.submittedAt));
				}
				for (const c of pr.comments?.nodes || []) {
					if (isHumanReviewer(c?.author?.login, author) && c?.createdAt) humanEvents.push(String(c.createdAt));
				}
				const firstReviewAt = humanEvents.sort()[0] || null;
				const reworkCommits = firstReviewAt
					? (pr.commits?.nodes || []).filter((c: any) => String(c?.commit?.committedDate || "") > firstReviewAt).length
					: 0;
				prs.push({
					repo: repoId,
					number: pr.number,
					headRefName: String(pr.headRefName || ""),
					title: String(pr.title || ""),
					createdAt: String(pr.createdAt || ""),
					mergedAt: String(pr.mergedAt || ""),
					linesChanged: (Number(pr.additions) || 0) + (Number(pr.deletions) || 0),
					humanReviews: humanEvents.length,
					reworkCommits,
				});
			}
			if (!search?.pageInfo?.hasNextPage || !search.pageInfo.endCursor) break;
			cursor = String(search.pageInfo.endCursor);
		}
	} catch (e) {
		console.error(`[analytics] factory pr fetch failed for ${ghRepo}:`, e);
		if (isGhRateLimitMsg(String((e as any)?.stderr || e))) noteGhRateLimited("analytics");
		return cached?.prs ?? [];
	}
	factoryCache.set(key, { at: Date.now(), prs });
	return prs;
}

function factoryCohort(prs: FactoryPr[]): FactoryCohort {
	const reviewed = prs.filter((p) => p.humanReviews > 0);
	const hours = prs
		.map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000)
		.filter((h) => Number.isFinite(h) && h >= 0)
		.sort((a, b) => a - b);
	const round1 = (n: number) => Math.round(n * 10) / 10;
	return {
		merged: prs.length,
		humanReviewed: reviewed.length,
		reverts: prs.filter((p) => /^revert\b/i.test(p.title)).length,
		avgReworkCommits: reviewed.length
			? round1(reviewed.reduce((sum, p) => sum + p.reworkCommits, 0) / reviewed.length)
			: 0,
		medianHoursToMerge: hours.length ? round1(hours[Math.floor(hours.length / 2)]) : 0,
		avgLinesChanged: prs.length ? Math.round(prs.reduce((sum, p) => sum + p.linesChanged, 0) / prs.length) : 0,
	};
}

// ── Review quality: is the PR reviewer getting better or worse? ──
//
// Two sources. The feedback store (~/.opensession-github/feedback-*.json) is a
// COHORT view: every inline finding by the day it was POSTED, with the outcome
// readers eventually gave it (addressed / ignored / explicit pushback) — recent
// days naturally show "pending" until their PRs settle. The audit rollup adds
// per-day review-run facts (verdicts, confidence, findings, withheld); the
// `review_completed` event only exists from 2026-07-28, so those columns are
// honest zeros before that.

export interface ReviewQualityDay {
	date: string;
	posted: number;
	addressed: number;
	ignored: number;
	dismissed: number;
	pending: number;
	missedBugs: number;
	reviews: number;
	findings: number;
	withheld: number;
	confidenceSum: number;
	confidenceN: number;
}

export interface ReviewQualityCohort {
	posted: number;
	addressed: number;
	ignored: number;
	dismissed: number;
	pending: number;
	missedBugs: number;
	/** addressed / settled, 0-100; null with nothing settled yet. */
	addressedRate: number | null;
	reviews: number;
	avgConfidence: number | null;
	avgFindingsPerReview: number | null;
	withheld: number;
}

/** One finding record → its settled bucket. Explicit words win over silence. */
function outcomeBucket(r: FeedbackRecord): "addressed" | "ignored" | "dismissed" | "pending" {
	if (r.replySignal === "dismissive") return "dismissed";
	if (r.outcome === "addressed") return "addressed";
	if (r.outcome === "ignored") return "ignored";
	return "pending";
}

/** Feedback records across every configured repo (default first). */
function loadAllFeedbackRecords(): FeedbackRecord[] {
	const targets: Array<string | undefined> = [undefined];
	for (const repo of Object.values(configuredRepos())) {
		if (repo.ghRepo && repo.ghRepo.toLowerCase() !== defaultRepo().ghRepo.toLowerCase()) {
			targets.push(repo.ghRepo);
		}
	}
	const out: FeedbackRecord[] = [];
	for (const t of targets) {
		try {
			out.push(...readFeedback(t));
		} catch {}
	}
	return out;
}

function reviewQualityCohort(days: ReviewQualityDay[]): ReviewQualityCohort {
	const sum = (f: (d: ReviewQualityDay) => number) => days.reduce((acc, d) => acc + f(d), 0);
	const posted = sum((d) => d.posted);
	const addressed = sum((d) => d.addressed);
	const ignored = sum((d) => d.ignored);
	const dismissed = sum((d) => d.dismissed);
	const settled = addressed + ignored + dismissed;
	const reviews = sum((d) => d.reviews);
	const confidenceN = sum((d) => d.confidenceN);
	const round1 = (n: number) => Math.round(n * 10) / 10;
	return {
		posted,
		addressed,
		ignored,
		dismissed,
		pending: sum((d) => d.pending),
		missedBugs: sum((d) => d.missedBugs),
		addressedRate: settled ? Math.round((100 * addressed) / settled) : null,
		reviews,
		avgConfidence: confidenceN ? round1(sum((d) => d.confidenceSum) / confidenceN) : null,
		avgFindingsPerReview: reviews ? round1(sum((d) => d.findings) / reviews) : null,
		withheld: sum((d) => d.withheld),
	};
}

// ── The composed summary ──

export interface AnalyticsSummary {
	from: string;
	to: string;
	days: Array<{
		date: string;
		sessions: number;
		sessionsByKind: Record<string, number>;
		turns: number;
		errors: number;
		cancelled: number;
		outputTokens: number;
		inputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		outputByModel: Record<string, number>;
		prsOpened: number;
		prsMerged: number;
		durationMs: number;
	}>;
	totals: {
		sessions: number;
		sessionsCreated: number;
		turns: number;
		errors: number;
		cancelled: number;
		oneshots: number;
		durationMs: number;
		outputTokens: number;
		inputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		prsOpened: number;
		prsMerged: number;
		allPrsOpened: number;
		allPrsMerged: number;
		activePeople: number;
	};
	models: Array<{ model: string; turns: number } & { [K in keyof TokenTotals as `${K}Tokens`]: number }>;
	people: Array<{
		name: string;
		sessionsCreated: number;
		sessionsActive: number;
		turns: number;
		outputTokens: number;
	}>;
	automations: Array<{
		name: string;
		runs: number;
		sessionsActive: number;
		turns: number;
		outputTokens: number;
		errors: number;
	}>;
	repos: Array<{
		repo: string;
		prsOpened: number;
		prsMerged: number;
		allOpened: number;
		allMerged: number;
	}>;
	prs: AnalyticsPr[];
	factory: {
		days: Array<{ date: string; reviewed: number; unreviewed: number }>;
		/** Merged PRs whose head branch belongs to an Open Session code session. */
		agent: FactoryCohort;
		/** Every other merged PR in range (humans + external bots). */
		other: FactoryCohort;
	};
	reviewQuality: {
		days: ReviewQualityDay[];
		/** First half of the range vs the second — the better-or-worse split. */
		earlier: ReviewQualityCohort;
		recent: ReviewQualityCohort;
	};
}

function utcDatesBetween(from: string, to: string): string[] {
	const dates: string[] = [];
	const end = new Date(`${to}T00:00:00Z`).getTime();
	for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
		dates.push(new Date(t).toISOString().slice(0, 10));
	}
	return dates;
}

/** Friendly owner label for run kinds whose sessions live outside our store. */
function kindOwner(kind: string): string {
	if (kind === "slack") return "Slack";
	if (kind === "linear") return "Linear";
	return "Other";
}

export async function buildAnalytics(from: string, to: string): Promise<AnalyticsSummary> {
	const dates = utcDatesBetween(from, to);
	const meta = loadSessionMeta();

	// PRs: query every repo that has ever hosted a code-mode session, and
	// attribute by head branch against those sessions' branches.
	const codeBranches = new Set<string>();
	const codeRepos = new Set<string>();
	for (const s of meta.values()) {
		if (s.mode !== "code" || !s.branch) continue;
		codeBranches.add(s.branch);
		if (s.repo) codeRepos.add(s.repo);
	}
	const repos = configuredRepos();
	const allPrs: AnalyticsPr[] = [];
	const allFactoryPrs: FactoryPr[] = [];
	await Promise.all(
		[...codeRepos].map(async (repoId) => {
			const repo = repos[repoId];
			if (!repo?.ghRepo) return;
			const [prs, factoryPrs] = await Promise.all([
				fetchRepoPrs(repoId, repo.ghRepo, from),
				fetchRepoFactoryPrs(repoId, repo.ghRepo, from),
			]);
			allPrs.push(...prs);
			allFactoryPrs.push(...factoryPrs);
		}),
	);
	for (const pr of allPrs) pr.byOpensession = codeBranches.has(pr.headRefName);
	const inRange = (iso: string | null) => {
		const d = (iso || "").slice(0, 10);
		return d >= from && d <= to;
	};

	const days: AnalyticsSummary["days"] = [];
	const totals: AnalyticsSummary["totals"] = {
		sessions: 0,
		sessionsCreated: 0,
		turns: 0,
		errors: 0,
		cancelled: 0,
		oneshots: 0,
		durationMs: 0,
		outputTokens: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		prsOpened: 0,
		prsMerged: 0,
		allPrsOpened: 0,
		allPrsMerged: 0,
		activePeople: 0,
	};
	const modelAgg = new Map<string, ModelAgg>();
	interface OwnerAgg {
		sessionsCreated: number;
		sessionsActive: Set<string>;
		turns: number;
		outputTokens: number;
		errors: number;
	}
	const peopleAgg = new Map<string, OwnerAgg>();
	const automationAgg = new Map<string, OwnerAgg>();
	const ownerAgg = (m: Map<string, OwnerAgg>, name: string): OwnerAgg => {
		let a = m.get(name);
		if (!a) m.set(name, (a = { sessionsCreated: 0, sessionsActive: new Set(), turns: 0, outputTokens: 0, errors: 0 }));
		return a;
	};
	const allSessions = new Set<string>();

	// People arrive as free-text createdBy strings with inconsistent casing —
	// merge case variants, preferring a variant that carries real capitals.
	const personDisplay = new Map<string, string>();
	const personKey = (name: string): string => {
		const lower = name.toLowerCase();
		const stored = personDisplay.get(lower);
		if (!stored || (stored === stored.toLowerCase() && name !== lower)) {
			personDisplay.set(lower, name === lower ? name.charAt(0).toUpperCase() + name.slice(1) : name);
		}
		return personDisplay.get(lower)!;
	};

	// Sessions *created* in range, from the store (owner attribution).
	for (const s of meta.values()) {
		if (!inRange(s.createdAt)) continue;
		totals.sessionsCreated++;
		const agg = s.isReview
			? ownerAgg(automationAgg, "GitHub review")
			: s.automationName
				? ownerAgg(automationAgg, s.automationName)
				: ownerAgg(peopleAgg, personKey(s.createdBy || "Unknown"));
		agg.sessionsCreated++;
	}

	const reviewByDate = new Map<string, ReviewDayAgg>();
	for (const date of dates) {
		const r = cachedRollup(date);
		reviewByDate.set(date, r.review || emptyReviewAgg());
		const sessionsByKind: Record<string, number> = {};
		for (const [id, s] of Object.entries(r.bySession)) {
			allSessions.add(id);
			const m = meta.get(id);
			// Review sessions run with run_kind "prompt"; give them their own
			// stack slice — they're volume-dominant and qualitatively different.
			// (Id-prefix fallback: review sessions get pruned from the store.)
			const isReview = m?.isReview || id.startsWith("bks-ghpr-");
			const isUnattendedKind =
				["automation", "plain", "action", "security-scan"].includes(s.kind) || s.kind.startsWith("github");
			const kind = isReview ? "review" : m?.automationName || (!m && isUnattendedKind) ? "automation" : s.kind;
			sessionsByKind[kind] = (sessionsByKind[kind] || 0) + 1;
			const agg = isReview
				? ownerAgg(automationAgg, "GitHub review")
				: m?.automationName
					? ownerAgg(automationAgg, m.automationName)
					: m
						? ownerAgg(peopleAgg, personKey(m.createdBy || "Unknown"))
						: isUnattendedKind
							? ownerAgg(automationAgg, "Removed automation sessions")
							: ownerAgg(peopleAgg, kindOwner(s.kind));
			agg.sessionsActive.add(id);
			agg.turns += s.turns;
			agg.outputTokens += s.output;
			agg.errors += s.errors;
		}
		const outputByModel: Record<string, number> = {};
		const addModel = (model: string, m: ModelAgg) => {
			outputByModel[model] = (outputByModel[model] || 0) + m.output;
			const agg = modelAgg.get(model) || { turns: 0, ...emptyTokens() };
			agg.turns += m.turns;
			agg.input += m.input;
			agg.output += m.output;
			agg.cacheRead += m.cacheRead;
			agg.cacheWrite += m.cacheWrite;
			modelAgg.set(model, agg);
		};
		for (const [model, m] of Object.entries(r.byModel)) addModel(model, m);
		for (const [sid, m] of Object.entries(r.unknownModel)) {
			const storeModel = meta.get(sid)?.model;
			addModel(storeModel ? shortModel(storeModel) : "unknown", m);
		}
		const dayPrs = allPrs.filter((pr) => pr.byOpensession);
		const prsOpened = dayPrs.filter((pr) => pr.createdAt.slice(0, 10) === date).length;
		const prsMerged = dayPrs.filter((pr) => pr.mergedAt?.slice(0, 10) === date).length;
		days.push({
			date,
			sessions: Object.keys(r.bySession).length,
			sessionsByKind,
			turns: r.turns,
			errors: r.errors,
			cancelled: r.cancelled,
			outputTokens: r.tokens.output,
			inputTokens: r.tokens.input,
			cacheReadTokens: r.tokens.cacheRead,
			cacheWriteTokens: r.tokens.cacheWrite,
			outputByModel,
			prsOpened,
			prsMerged,
			durationMs: r.durationMs,
		});
		totals.turns += r.turns;
		totals.errors += r.errors;
		totals.cancelled += r.cancelled;
		totals.oneshots += r.oneshots;
		totals.durationMs += r.durationMs;
		totals.outputTokens += r.tokens.output;
		totals.inputTokens += r.tokens.input;
		totals.cacheReadTokens += r.tokens.cacheRead;
		totals.cacheWriteTokens += r.tokens.cacheWrite;
	}
	totals.sessions = allSessions.size;

	const repoAgg = new Map<string, AnalyticsSummary["repos"][number]>();
	for (const pr of allPrs) {
		const r = repoAgg.get(pr.repo) || { repo: pr.repo, prsOpened: 0, prsMerged: 0, allOpened: 0, allMerged: 0 };
		if (inRange(pr.createdAt)) {
			r.allOpened++;
			if (pr.byOpensession) r.prsOpened++;
		}
		if (pr.mergedAt && inRange(pr.mergedAt)) {
			r.allMerged++;
			if (pr.byOpensession) r.prsMerged++;
		}
		repoAgg.set(pr.repo, r);
	}
	for (const r of repoAgg.values()) {
		totals.prsOpened += r.prsOpened;
		totals.prsMerged += r.prsMerged;
		totals.allPrsOpened += r.allOpened;
		totals.allPrsMerged += r.allMerged;
	}

	const models = [...modelAgg.entries()]
		.map(([model, m]) => ({
			model,
			turns: m.turns,
			inputTokens: m.input,
			outputTokens: m.output,
			cacheReadTokens: m.cacheRead,
			cacheWriteTokens: m.cacheWrite,
		}))
		.sort((a, b) => b.outputTokens - a.outputTokens);
	const people = [...peopleAgg.entries()]
		.map(([name, a]) => ({
			name,
			sessionsCreated: a.sessionsCreated,
			sessionsActive: a.sessionsActive.size,
			turns: a.turns,
			outputTokens: a.outputTokens,
		}))
		.filter((p) => p.sessionsCreated > 0 || p.sessionsActive > 0)
		.sort((a, b) => b.sessionsActive - a.sessionsActive || b.sessionsCreated - a.sessionsCreated);
	totals.activePeople = people.filter((p) => !["Slack", "Linear", "Other", "Unknown"].includes(p.name)).length;
	const automations = [...automationAgg.entries()]
		.map(([name, a]) => ({
			name,
			runs: a.sessionsCreated,
			sessionsActive: a.sessionsActive.size,
			turns: a.turns,
			outputTokens: a.outputTokens,
			errors: a.errors,
		}))
		.sort((a, b) => b.sessionsActive - a.sessionsActive || b.runs - a.runs);

	const prs = allPrs
		.filter((pr) => pr.byOpensession && (inRange(pr.createdAt) || inRange(pr.mergedAt)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, 400);

	const factoryInRange = allFactoryPrs.filter((pr) => inRange(pr.mergedAt));
	const factoryDays = dates.map((date) => {
		const merged = factoryInRange.filter((pr) => pr.mergedAt.slice(0, 10) === date);
		const reviewed = merged.filter((pr) => pr.humanReviews > 0).length;
		return { date, reviewed, unreviewed: merged.length - reviewed };
	});
	const factory = {
		days: factoryDays,
		agent: factoryCohort(factoryInRange.filter((pr) => codeBranches.has(pr.headRefName))),
		other: factoryCohort(factoryInRange.filter((pr) => !codeBranches.has(pr.headRefName))),
	};

	// Review quality: audit-rollup run facts per day + the feedback store's
	// finding cohorts folded in by posted date.
	const reviewQualityDays: ReviewQualityDay[] = dates.map((date) => {
		const rv = reviewByDate.get(date) || emptyReviewAgg();
		return {
			date,
			posted: 0,
			addressed: 0,
			ignored: 0,
			dismissed: 0,
			pending: 0,
			missedBugs: 0,
			reviews: rv.completed,
			findings: rv.findings,
			withheld: rv.withheld,
			confidenceSum: rv.confidenceSum,
			confidenceN: rv.confidenceN,
		};
	});
	const reviewDayIndex = new Map(reviewQualityDays.map((d) => [d.date, d]));
	for (const rec of loadAllFeedbackRecords()) {
		const d = reviewDayIndex.get((rec.postedAt || "").slice(0, 10));
		if (!d) continue;
		if (rec.falseNegative) {
			d.missedBugs++;
			continue;
		}
		d.posted++;
		d[outcomeBucket(rec)]++;
	}
	const half = Math.floor(dates.length / 2);
	const reviewQuality = {
		days: reviewQualityDays,
		earlier: reviewQualityCohort(reviewQualityDays.slice(0, half)),
		recent: reviewQualityCohort(reviewQualityDays.slice(half)),
	};

	return {
		from,
		to,
		days,
		totals,
		models,
		people,
		automations,
		repos: [...repoAgg.values()].sort((a, b) => b.allOpened - a.allOpened),
		prs,
		factory,
		reviewQuality,
	};
}

// ── Home overview strip ──

export interface HomeStatsBucket {
	/** Sessions that had at least one turn in the window. */
	sessions: number;
	turns: number;
	errors: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Cheap numbers for the Home overview strip: audit-rollup reads only — no
 *  session-store scan and no gh calls. Past days come straight from the disk
 *  cache; today's rollup recomputes only when its audit file has grown. */
export function buildHomeStats(): { today: HomeStatsBucket; week: HomeStatsBucket } {
	const empty = (): HomeStatsBucket => ({
		sessions: 0,
		turns: 0,
		errors: 0,
		durationMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});
	let today = empty();
	const week = empty();
	const weekSessions = new Set<string>();
	for (let i = 6; i >= 0; i--) {
		const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
		const r = cachedRollup(date);
		const bucket: HomeStatsBucket = {
			sessions: Object.keys(r.bySession).length,
			turns: r.turns,
			errors: r.errors,
			durationMs: r.durationMs,
			inputTokens: r.tokens.input,
			outputTokens: r.tokens.output,
			cacheReadTokens: r.tokens.cacheRead,
			cacheWriteTokens: r.tokens.cacheWrite,
		};
		for (const id of Object.keys(r.bySession)) weekSessions.add(id);
		week.turns += bucket.turns;
		week.errors += bucket.errors;
		week.durationMs += bucket.durationMs;
		week.inputTokens += bucket.inputTokens;
		week.outputTokens += bucket.outputTokens;
		week.cacheReadTokens += bucket.cacheReadTokens;
		week.cacheWriteTokens += bucket.cacheWriteTokens;
		if (i === 0) today = bucket;
	}
	week.sessions = weekSessions.size;
	return { today, week };
}
