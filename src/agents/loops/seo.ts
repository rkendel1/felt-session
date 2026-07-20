/**
 * SEO loop — a self-improving pair of automations for Tella's marketing site:
 *
 *   1. SEO Sweep (daily): reads what's worked before, measures with Ahrefs, and
 *      ships ONE small, safe SEO improvement to the marketing pages as a PR
 *      (labelled `seo-sweep`, assigned + review-requested to johnnylinsf). Humans
 *      still merge — PRs are never auto-merged.
 *   2. SEO Validation (daily): when a `seo-sweep` PR is merged (detected via the
 *      GitHub webhook → recordMergedSeoPr), it's queued; ~3 weeks later — once SEO
 *      impact has had time to show in Ahrefs — the validator measures the actual
 *      ranking/traffic change since merge, classifies it, and writes the takeaway
 *      to the learnings file. The sweep reads that file each run, so the loop gets
 *      better over time.
 *
 * Tracking: every seo-sweep PR is announced in #proj-seo when it opens and ✅'d
 * there when it merges (github/seo-notify.ts, wired from the PR webhook), so the
 * channel is a running log of proposed vs landed SEO work. The validation loop
 * posts its measured outcomes to the same channel.
 *
 * Feedback state lives on the box (decoupled from repo PR churn):
 *   ~/.opensession-seo/pending.jsonl  — merged seo-sweep PRs awaiting validation
 *   ~/.opensession-seo/learnings.md   — measured outcomes; the sweep's memory
 */
import { personaName } from "../../server/config";
import { stateDir } from "../../server/rename-compat";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { listAutomations, createAutomation } from "../../server/automations";
import { defaultRepo } from "../../server/config";

const REPO = defaultRepo().ghRepo;
export const SEO_LABEL = "seo-sweep";
export const SEO_DIR = stateDir("seo");
const PENDING_FILE = `${SEO_DIR}/pending.jsonl`;
const LEARNINGS_FILE = `${SEO_DIR}/learnings.md`;
/** SEO impact lags merge by weeks; wait before measuring so the signal is real. */
const VALIDATE_AFTER_DAYS = 21;

/** Record a merged seo-sweep PR for later Ahrefs validation. Called from the webhook. */
export function recordMergedSeoPr(prNumber: number, mergedAt: string): void {
  try {
    mkdirSync(SEO_DIR, { recursive: true });
    const merged = new Date(mergedAt);
    const validateAfter = new Date(merged.getTime() + VALIDATE_AFTER_DAYS * 86_400_000);
    const rec = {
      prNumber,
      mergedAt: merged.toISOString(),
      validateAfter: validateAfter.toISOString(),
    };
    appendFileSync(PENDING_FILE, JSON.stringify(rec) + "\n");
    console.log(`[seo] queued merged PR #${prNumber} for validation after ${rec.validateAfter.slice(0, 10)}`);
  } catch (e) {
    console.error(`[seo] failed to queue merged PR #${prNumber}:`, e);
  }
}

const SWEEP_PROMPT = `You are Michael's daily SEO sweep for Tella's marketing site (tella.com), working in the \`tella-fusion\` monorepo (Next.js + ReScript + Bun webapp at \`packages/core/webapp\`).

Marketing / SEO surface you may edit (ONLY these — never the product/app UI):
- \`packages/core/webapp/src/app/(marketing)/**\` — page.tsx routes (/, /features, /recorder, /chrome, /windows, /alternatives, /record/*, …)
- \`packages/core/webapp/content/**\` — .mdx content (features, record, …)
- \`packages/core/webapp/src/frontend/marketing/**\` — marketing components + metadata

Goal: every day, ship ONE small, safe, high-leverage SEO improvement to the marketing pages as a PR. Small and consistent beats big swings. Improve organic rankings/traffic and how often AI assistants recommend Tella. Follow the repo's AGENTS.md (root AND packages/core/webapp) EXACTLY for commands, ReScript rules, and the git/PR workflow.

## 1. Learn from what's already worked (do this FIRST)
Read \`${LEARNINGS_FILE}\` (\`cat ${LEARNINGS_FILE}\` — it may not exist yet on early runs, that's fine). It holds the MEASURED outcome of past merged SEO changes. Prefer kinds of change that have validated as effective; deprioritize kinds that moved nothing.

## 2. Measure with the Ahrefs MCP (tella.com; Rank Tracker project_id 1751241; country US)
Monetary values are USD cents → divide by 100. When any response includes \`render_with\`, you MUST call that render tool. This MCP has NO Brand Radar / AI-visibility tools — skip those.
- \`rank-tracker-overview\` (date = today, date_compared = 7 days ago, device desktop; select keyword,position,position_diff,volume,url) across the WHOLE tracked set — not one fixed cluster. Note movers up and down.
- For the 2-3 highest-opportunity terms (decent volume AND ranking ~#5-30 = winnable), run \`serp-overview\` + \`site-explorer-organic-keywords\` for tella.com to find the ranking URL and the specific gap.
- Consider \`site-explorer-pages-by-traffic\` / \`best-by-internal-links\` to spot a strong page that could lift a sibling via internal links.

## 3. Pick ONE small, safe, reviewable improvement
Across ANY marketing page/cluster. Prefer, in order: (a) on-page metadata/title/H1/description + JSON-LD (FAQPage / SoftwareApplication) on a high-opportunity page; (b) descriptive-anchor internal links from a strong page to a winnable target; (c) refresh/expand ONE existing supporting page to better match a winnable term. ONE topic, ONE page→keyword mapping. Keep the diff reviewable in a few minutes.
NEVER make unverifiable claims ("no watermark", "no time limit", "we tested X") unless verifiably true for Tella. Do NOT create big new roundup pages or change robots.txt AI signals without explicit human sign-off — propose those in the PR body instead of shipping them.

## 4. Avoid duplicate PRs (BEFORE implementing)
\`gh pr list --repo ${REPO} --label ${SEO_LABEL} --state open --json number,title,body\` — if an open SEO Sweep PR already covers your idea, pick a different opportunity. If nothing safe AND new remains, STOP and open no PR.

## 5. Implement + verify on a fresh branch off main: \`${SEO_LABEL}-YYYY-MM-DD-<slug>\`
- \`git fetch origin main --quiet && git checkout -B ${SEO_LABEL}-<date>-<slug> origin/main\`, then make the page.tsx / .mdx / schema edits.
- If you edited any content .mdx: run \`cd packages/core/webapp && bun scripts/generate-marketing-content-data.ts\` and commit the regenerated \`src/frontend/marketing/generated/contentData.gen.ts\`.
- If you touched any .res: run \`bun rescript-check\` in packages/core/webapp and resolve ALL errors; then \`just format\`.
- Run the \`/security-review\` skill on the changes before committing. Keep commits atomic and focused.

## 6. Open ONE PR (never push to main, never \`gh pr merge\`)
\`gh pr create --repo ${REPO} --base main --label ${SEO_LABEL} --head <branch> --title "SEO Sweep: <short summary>" --body "<body>"\`
Then assign AND request review from Johnny: \`gh pr edit <n> --repo ${REPO} --add-assignee johnnylinsf --add-reviewer johnnylinsf\`.
The PR body MUST contain this machine-readable block so the post-merge validator can measure impact later:

\`\`\`
## SEO impact tracking
- Pages: <comma-separated live URLs affected, e.g. https://www.tella.com/recorder>
- Target keywords: <comma-separated keywords this change targets>
- Hypothesis: <one line: what you expect to improve and why, citing the Ahrefs positions/volumes>
\`\`\`

Then a human summary: what changed, the Ahrefs rationale (positions/volumes), and the next candidate move.

You do NOT need to post to Slack yourself — backstage auto-announces every \`${SEO_LABEL}\` PR in #proj-seo when it opens and adds a ✅ there when it merges, so the channel tracks proposed vs landed SEO work automatically.

## 7. If there's nothing safe to ship
Post your measurement + recommendation as the session summary and open NO PR. Consistency beats forcing a change.`;

const VALIDATE_PROMPT = `You are Michael's SEO validation loop. You measure whether merged "SEO Sweep" changes actually improved rankings/traffic in Ahrefs, and write the learnings so the daily SEO sweep gets better over time.

Permissions note: this is read-only with respect to the tella-fusion codebase/git (don't modify or commit anything there). BUT you MUST read/append the box-local files under \`${SEO_DIR}\` (via Bash) and post to Slack via the MCP — that's the entire purpose of this run; do not refuse on "read-only" grounds.

## 1. Find merged SEO PRs that are now due for validation
\`cat ${PENDING_FILE}\` (one JSON object per line: {prNumber, mergedAt, validateAfter}). It lists merged \`${SEO_LABEL}\` PRs awaiting measurement. A PR is DUE when today >= its \`validateAfter\` (SEO impact takes weeks to show, so recently-merged PRs are intentionally NOT due yet). If the file is missing/empty or NOTHING is due, STOP — do nothing, post nothing.

## 2. For each DUE PR, measure impact with the Ahrefs MCP (tella.com; Rank Tracker project_id 1751241; US)
- Read the PR: \`gh pr view <n> --repo ${REPO} --json title,body,mergedAt,files\`. Parse its "SEO impact tracking" block for the affected Pages + Target keywords. If absent, infer the affected URLs from the changed files.
- Compare BEFORE vs AFTER the merge date:
  - \`rank-tracker-overview\` with date = today and date_compared = the PR's merge date, for the target keywords → position change since merge.
  - \`site-explorer-metrics-history\` / \`pages-history\` / \`url-rating-history\` for the affected URLs spanning the merge date → organic traffic / keyword trend.
- Monetary values are cents ÷ 100; honor \`render_with\`.

## 3. Classify + record the learning (the sweep's memory)
Classify each PR: IMPROVED / FLAT / REGRESSED, with the actual numbers. Append a dated entry to \`${LEARNINGS_FILE}\` (create it if absent) with: the date, PR #, the KIND of change (metadata / internal-links / content refresh / schema …), the target keywords + pages, the measured before→after, the verdict, and a one-line ACTIONABLE takeaway for the daily sweep (e.g. "internal links from /recorder lifted 'screen recorder' #12→#7 — do more of this"; or "metadata-only tweak on /chrome moved nothing in 3wks — deprioritize"). Be concrete — this file steers future runs.

## 4. Report + clean up
- Post ONE concise summary to Slack channel \`C0BE3E5JGTH\` (#proj-seo — the SEO tracking channel) via the Slack MCP \`conversations_add_message\`: start with "📈 Michael SEO validation:" then, per PR: #<n> '<title>' — <verdict> (<key numbers>); takeaway: <…>. Cover all PRs validated this run in the one message.
- Remove each validated PR's line from \`${PENDING_FILE}\` (rewrite the file without those lines so it isn't re-validated).`;

interface SeoLoopSeed {
  eventKey: string;
  name: string;
  schedule: string;
  mode: "ask" | "code";
  mcpServers: string[];
  prompt: string;
}

const SEO_LOOPS: SeoLoopSeed[] = [
  {
    eventKey: "loop:seo-sweep",
    name: "SEO Sweep",
    schedule: "0 16 * * *", // daily, ~9am PT (server is UTC)
    mode: "code",
    mcpServers: ["ahrefs"],
    prompt: SWEEP_PROMPT,
  },
  {
    eventKey: "loop:seo-validate",
    name: "SEO Validation",
    schedule: "0 18 * * *", // daily, ~11am PT — after the sweep
    mode: "ask",
    mcpServers: ["ahrefs", "slack"],
    prompt: VALIDATE_PROMPT,
  },
];

/** Seed the SEO sweep + validation automations (create-if-absent; preserves UI edits). */
export function ensureSeoLoops(): void {
  try {
    mkdirSync(SEO_DIR, { recursive: true });
  } catch {}
  if (!existsSync(LEARNINGS_FILE)) {
    try {
      appendFileSync(
        LEARNINGS_FILE,
        "# SEO learnings\n\nMeasured outcomes of merged SEO Sweep PRs (written by the SEO Validation loop). The daily SEO Sweep reads this first.\n",
      );
    } catch {}
  }
  for (const loop of SEO_LOOPS) {
    if (listAutomations().some((a) => a.eventKey === loop.eventKey)) continue;
    const created = createAutomation({
      name: loop.name,
      prompt: loop.prompt,
      schedule: loop.schedule,
      mode: loop.mode,
      createdBy: `${personaName()} (loops)`,
      eventKey: loop.eventKey,
      mcpServers: loop.mcpServers,
    });
    if ("error" in created) {
      console.error(`[loops] Failed to seed SEO loop "${loop.name}":`, created.error);
    } else {
      console.log(`[loops] Seeded SEO loop "${loop.name}" (${created.id})`);
    }
  }
}
