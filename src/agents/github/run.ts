/**
 * Shared headless-run helper for the github agent. Composes `runAgent` like
 * automations.ts does, but persists its own visible NativeSessionFile so each
 * PR review/fix/simplify shows up as a session in the web UI, and resumes
 * the engine conversation across rounds via the deterministic per-PR session file.
 */
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../../server/paths";
import { recordRunOutcome, updateSessionFile } from "../../server/session-cache";
import { runAgent } from "../../server/agent-runner";
import { listAutomations } from "../../server/automations";
import { providerFor, DEFAULT_FALLBACK_MODEL, modelLabel } from "../../server/models";
import { engineSessionPatch } from "../../server/sessions";
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import { gitIdentityFor, type GitIdentity } from "../../server/shared/user-mappings";
import { resolvePrWorkspace } from "../../server/workspace-resolve";
import { repoForPath } from "../../server/worktree";
import { PR_EVENT_KEY, prKey } from "./constants";
import type { NativeSessionFile } from "../../server/types";
import { configuredServer } from "../../server/config";
import { shouldPersistModelSwitch } from "../../server/run-events";

const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

/**
 * Default external MCP servers for a PR flow, used when the review automation
 * doesn't pin its own list (see githubFlowMcpServers). Everything else in
 * mcp-config is withheld: these runs read a diff, the repo, and CI, and
 * mounting the full connector set put ~430 external tool schemas in front of
 * every one of them.
 *
 * Measured over the retained audit window (1,410 github-* sessions): only ~20
 * sessions (1.4%) ever called an external MCP tool at all, and the calls
 * concentrate in grafana (149 calls / 7 sessions — checking Loki + Prometheus
 * for a change under review) and linear (13 / 8 — pulling the issue a PR
 * references). The tail this drops by default is stripe (16 / 3),
 * TellaInternalSupportMCP (11 / 3) and plain (3 / 2); a run that needs one of
 * those reports it can't reach it instead of silently costing every other run
 * the schemas.
 */
export const DEFAULT_GITHUB_FLOW_MCP_SERVERS = ["grafana", "linear"];

/**
 * Which MCP servers this PR flow mounts — configurable, not baked in. The
 * review automation (eventKey `github:pull_request`) is already the config
 * surface for these runs' prompt, model and on/off switch (resolveReviewConfig
 * in webhook.ts); its `mcpServers` field now steers their connectors too, so
 * the list is editable in Settings → Automations (the form has an MCP picker)
 * and through opensession-admin, with no deploy.
 *
 * Unset on the automation → the lean default above. Explicitly set to `[]` →
 * no external servers at all, which is a legitimate choice here (built-ins,
 * the repo and gh cover the job). Note this is NOT the same as the runner's
 * `undefined`, which means "every server" — that distinction is why the
 * default is applied here rather than by passing the automation's value
 * straight through.
 */
export function githubFlowMcpServers(): string[] {
  const automation = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  return automation?.mcpServers ?? DEFAULT_GITHUB_FLOW_MCP_SERVERS;
}

/**
 * All sessions for one PR (its review/autofix/simplify/adversarial/mention runs,
 * plus whatever session originally opened the PR) belong in one Project folder.
 * Delegates to the shared adopt-don't-duplicate resolver (workspace-resolve.ts)
 * so the sidebar's PR clicks and these headless runs can never mint diverging
 * workspaces for the same PR. Best-effort: never block a run on this.
 */
async function workspaceIdForPr(prNumber: number, branch: string, title: string, cwd: string, ghRepo?: string): Promise<string | null> {
  try {
    const repo = repoForPath(cwd).id;
    // opts.title is per-kind ("Review · PR #123 <PR title>"). The folder groups
    // ALL kinds for the PR, so name it PR-level: strip the kind + "PR #n" prefix
    // down to the bare PR title (fall back to the full title if it doesn't match).
    const prTitle = title.replace(/^.*?PR #\d+[:\s-]*/i, "").trim() || title;
    const resolved = await resolvePrWorkspace({
      repoId: repo,
      number: prNumber,
      branch,
      title: prTitle,
      createdBy: "GitHub (automation)",
    });
    return resolved?.workspace.id ?? null;
  } catch {
    return null;
  }
}

export type GithubRunKind =
  | "review"
  | "autofix"
  | "simplify"
  | "mention"
  | "adversarial"
  | "followup";

/** Stable, deterministic opensession session id per PR + behavior (one resumable session each). */
export function bksIdFor(prNumber: number, kind: GithubRunKind, ghRepo?: string): string {
  return `bks-ghpr-${prKey(prNumber, ghRepo)}-${kind}`;
}

const UI_BASE =
  process.env.OPENSESSION_UI_BASE ||
  configuredServer().publicBaseUrl;

/** Open Session UI link to any session id (also used for handoff "open session" links). */
export function uiSessionUrl(sessionId: string): string {
  return `${UI_BASE}/session/${sessionId}`;
}

/** Open Session UI link to a run's session, for "open to monitor" links in PR comments. */
export function sessionUrl(prNumber: number, kind: GithubRunKind, ghRepo?: string): string {
  return uiSessionUrl(bksIdFor(prNumber, kind, ghRepo));
}

/** Map a GitHub login to a git identity for commit attribution (fix/simplify). */
export function authorForLogin(login?: string): GitIdentity | null {
  return gitIdentityFor(login || null);
}

/**
 * Marker the code-mode behaviors emit right before their final summary. We post
 * only the text after it, so the agent's working narration ("let me run the
 * subagents…") never lands on the PR.
 */
export const SUMMARY_SENTINEL = "===OPENSESSION-SUMMARY===";
// Pre-rename sentinel — runs prompted before a deploy (or resumed across one)
// still emit it, so extraction accepts both.
const LEGACY_SUMMARY_SENTINEL = "===MICHAEL-SUMMARY===";

/** Text after the last summary sentinel; falls back to the full trimmed text. */
export function finalSummary(text: string): string {
  if (!text) return "";
  for (const sentinel of [SUMMARY_SENTINEL, LEGACY_SUMMARY_SENTINEL]) {
    const idx = text.lastIndexOf(sentinel);
    if (idx !== -1) return text.slice(idx + sentinel.length).trim();
  }
  return text.trim();
}

function readSessionFile(bksId: string): NativeSessionFile | null {
  const path = `${SESSIONS_DIR}/${bksId}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
  } catch {}
  return null;
}

function readEngineSessionId(
  file: NativeSessionFile | null,
  model?: string
): string {
  if (!file) return "";
  const provider = providerFor(model || file.model);
  if (provider === "codex") return file.codexThreadId || "";
  return file.claudeSessionId || "";
}

export interface GithubRunOpts {
  prNumber: number;
  /** owner/name when the PR lives outside the default repo (multi-repo). */
  ghRepo?: string;
  kind: GithubRunKind;
  prompt: string;
  cwd: string;
  mode: "ask" | "code";
  model?: string;
  branch: string;
  title: string;
  /** Resume the prior engine conversation for this PR+behavior if one exists. */
  resume?: boolean;
  /** Commit attribution for code-mode runs (the human who asked). */
  author?: GitIdentity | null;
  onSessionCreated?: (bksId: string) => void;
}

export interface GithubRunResult {
  bksId: string;
  text: string;
  error?: string;
  /** Model that actually drove the run (after any fallback switches). */
  model?: string;
}

/** Run one headless turn for a PR behavior; returns the agent's accumulated text. */
export async function runGithubAgent(opts: GithubRunOpts): Promise<GithubRunResult> {
  const bksId = bksIdFor(opts.prNumber, opts.kind, opts.ghRepo);
  const startedAt = new Date();

  // Group this and the PR's other sessions under one Project folder.
  const workspaceId = await workspaceIdForPr(opts.prNumber, opts.branch, opts.title, opts.cwd, opts.ghRepo);

  const existingSessionFile = readSessionFile(bksId);
  // Engine sessions are scoped to their directory; a session started under a
  // different cwd (e.g. a review from before reviews got per-PR worktrees)
  // won't resolve there — start fresh rather than resuming across cwds.
  const cwdMatches =
    !existingSessionFile?.worktreeDir || existingSessionFile.worktreeDir === opts.cwd;
  const resumeFrom = opts.resume && cwdMatches
    ? readEngineSessionId(existingSessionFile, opts.model)
    : "";

  let effectiveModel = opts.model || existingSessionFile?.model;
  let selectedModel = effectiveModel;
  let effectiveProvider = providerFor(effectiveModel);
  const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [
    ...(existingSessionFile?.modelHistory || []),
  ];
  // Field-scoped write via the session-file mutex (transcript-v2 §6, same
  // shape as the six W3 conversions): creation fields are create-if-absent
  // defaults (an existing file wins), and each call overlays only the fields
  // this run owns — engine ids, effective model + history, and the per-round
  // PR shape (branch/cwd/title/mode/workspaceId). Prior engine ids (e.g. a
  // codexThreadId from an earlier round) and any concurrent writer's fields
  // survive via the fresh-read spread instead of being rebuilt from closures.
  const persist = (engineSessionId: string) =>
    updateSessionFile(bksId, (data) => {
      // Widen to Partial: the file may not exist yet (create-if-absent).
      const existing: Partial<NativeSessionFile> = data;
      return {
        id: bksId,
        claudeSessionId: "",
        createdAt: startedAt.toISOString(),
        ...existing,
        ...(engineSessionId
          ? engineSessionPatch(effectiveProvider, engineSessionId)
          : {}),
        ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
        ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(modelHistory.length ? { modelHistory } : {}),
        branch: opts.branch,
        worktreeDir: opts.cwd,
        createdBy: "GitHub (automation)",
        lastActivity: new Date().toISOString(),
        title: opts.title,
        mode: opts.mode,
        automation: "github-pr-review",
        ...(workspaceId ? { workspaceId } : {}),
      };
    }).catch((e) => {
      console.error(`[github-run] failed to persist session ${bksId}:`, e);
    });

  let text = "";
  let engineSessionId = resumeFrom;
  let errorMsg = "";

  try {
    for await (const event of runAgent({
      prompt: opts.prompt,
      sessionId: resumeFrom || undefined,
      cwd: opts.cwd,
      mode: opts.mode,
      model: effectiveModel,
      confirmTools: STRIPE_CONFIRM_TOOLS,
      aws: true,
      author: opts.author,
      fallbackModel: DEFAULT_FALLBACK_MODEL,
      mcpServers: githubFlowMcpServers(),
      journal: { osSessionId: bksId, kind: `github-${opts.kind}` },
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) {
          effectiveModel = event.model;
          if (!selectedModel) selectedModel = event.model;
        }
        persist(engineSessionId);
        opts.onSessionCreated?.(bksId);
      } else if (event.type === "text_chunk") {
        text += event.text;
      } else if (event.type === "model_switch") {
        const to = event.toModel || "";
        if (to) {
          effectiveModel = to;
          effectiveProvider = providerFor(to);
          if (shouldPersistModelSwitch(event)) {
            selectedModel = to;
            modelHistory.push({
              model: to,
              at: new Date().toISOString(),
              by: `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`,
            });
          }
        }
      } else if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      } else if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }
  } catch (e: any) {
    errorMsg = e.message || String(e);
  }

  await persist(engineSessionId);
  // GitHub behaviors drive runAgent directly instead of flowing through
  // runSessionPrompt, so they must settle the visible session themselves.
  // Without this, journalSet leaves the FSM in `running` after the engine exits.
  recordRunOutcome(bksId, errorMsg || null);
  return { bksId, text, error: errorMsg || undefined, model: effectiveModel };
}
