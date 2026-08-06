import React, { useState, useEffect, useRef } from "react";
import { fetchWorktrees, fetchModels, fetchFileMentions, fetchSkillMentions, fetchConnections, fetchSandboxStatus, requestSandboxPrewarm, suggestBranch, fetchProviderAccounts, fetchRepos, type ProviderAccountOption, type ModelOption, type SandboxStatusInfo } from "../lib/api";
import { getCurrentUser, useAuthStatus } from "./UserPicker";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { getDefaultModelPref } from "../lib/default-model-pref";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import { insideOpenFence, isSendCombo, MOD_ENTER_GLYPH } from "../lib/send-key";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";
import { peopleMentionMatches } from "../lib/people";
import {
  IconPaperclip,
  IconChevronDown,
  IconCheck,
  IconSliders,
  IconConnections,
  IconReturn,
  IconBox,
  IconFile,
  IconFolderPlus,
  IconMap,
  IconStack,
} from "./icons";
import type { WSServerMessage } from "../lib/types";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";
import { PaletteSelect } from "./PaletteSelect";
import { RepoTile } from "./RepoTile";
import { ModelEffortSelect } from "./ModelEffortSelect";
import { Menu } from "../ui/menu";
import { IconTile, displayName } from "./BrandTile";
import { AddRepoDialog } from "./AddRepoDialog";
import { Tooltip } from "../ui/tooltip";
import { Modal, useEnterOnMount } from "../ui/modal";

interface Props {
  /** Close the palette (Esc, backdrop click, or after a create without "Create more"). */
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
  /** Prefill the prompt (e.g. from the Home "New session" box). */
  prefillPrompt?: string;
  forceMode?: "ask" | "code" | "scratch";
  /** When starting a session inside a workspace, the session joins that workspace… */
  workspaceId?: string;
  /** …and defaults to the workspace's shared repo + worktree (a sibling's branch). */
  forceRepo?: string;
  forceBranch?: string;
  /** Lets App render the pending session shell before the created session appears
      in the polled session list. */
  onCreateStarted?: (draft: {
    prompt: string;
    mode: "ask" | "code" | "scratch";
    repo: string;
    branch: string | null;
    workspaceId?: string;
    model?: string;
    images?: string[];
  }) => void;
}

interface Worktree {
  branch: string;
  path: string;
}

interface RepoOption {
  id: string;
  label: string;
  default?: boolean;
}

// Light mode paints the Create split-button ink-on-paper instead of accent.
// global.css scopes that override under `.palette-card`, which the shared Modal
// shell no longer carries, so the two buttons opt in explicitly.
const LIGHT_CREATE =
  "[html[data-theme=light]_&]:bg-fg [html[data-theme=light]_&]:text-bg";

const LAST_REPO_KEY = "opensession-new-session-repo";
const ADD_REPO_VALUE = "__add_repo__";
const SCRATCH_REPO_VALUE = "__scratch__";

function lastSelectedRepo(): string | null {
  try {
    return localStorage.getItem(LAST_REPO_KEY) || null;
  } catch {
    return null;
  }
}

function rememberSelectedRepo(repo: string) {
  try {
    localStorage.setItem(LAST_REPO_KEY, repo);
  } catch {}
}

// The repo the sidebar is currently filtered to (persisted by Sidebar.tsx under
// this key). When set to a real repo, a new session should default to it so
// creating from a repo-filtered view lands on that repo.
function filteredRepo(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem("opensession-sidebar-filter") || "{}");
    return typeof v.repo === "string" ? v.repo : null;
  } catch {
    return null;
  }
}

/** Deep-link prefill: <base>/new?mode=ask|code&prompt=…&branch=…&repo= */
function readPrefill() {
  const params = new URLSearchParams(location.search);
  // An explicit ?repo= wins (legacy ?project= still honored); otherwise keep
  // the user's last picker choice across closes/reloads, then use the sidebar
  // filter. The configured default is applied once `/repos` resolves.
  const repoParam = params.get("repo") ?? params.get("project");
  const repo = repoParam || lastSelectedRepo() || filteredRepo() || "";
  return {
    mode: params.get("mode") === "ask" ? ("ask" as const) : ("code" as const),
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
    repo,
  };
}

/** Fallback branch name from the prompt when Haiku's auto-suggest hasn't landed. */
function slugifyBranch(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug || "new-session";
}

export function NewSession({ onBack, send, addHandler, connected, prefillPrompt, forceMode, workspaceId, forceRepo, forceBranch, onCreateStarted }: Props) {
  const auth = useAuthStatus();
  const desktopShell =
    (window as { os1?: { desktop?: boolean } }).os1?.desktop === true ||
    navigator.userAgent.includes("Electron/");
  const [prefill] = useState(readPrefill);
  const [mode, setMode] = useState<"ask" | "code" | "scratch">(forceMode || prefill.mode);
  // Plan-first gate (code mode): design doc + ask_user approval before any
  // code, then vertical slices with per-slice evidence. See buildPlanFirstNote.
  const [planFirst, setPlanFirst] = useState(false);
  // The desktop app's local bridge merges local and hosted sessions. Hosted is
  // deliberately the default; local execution is still experimental and must
  // be selected explicitly for each palette lifetime.
  const [createTarget, setCreateTarget] = useState<"cloud" | "local">(
    auth?.local || desktopShell ? "cloud" : "local",
  );
  useEffect(() => {
    if (auth?.local || desktopShell) setCreateTarget("cloud");
  }, [auth?.local, desktopShell]);
  const cloudTarget = auth?.local === true && createTarget === "cloud";
  // In a workspace, default to its shared repo; else the prefill/filter repo.
  const [repo, setRepo] = useState(forceRepo || prefill.repo);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [configuredDefaultRepo, setConfiguredDefaultRepo] = useState("");
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const locallyAddedRepos = useRef(new Map<string, { id: string; label: string }>());
  const localReposLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    fetchRepos(cloudTarget).then((items) => {
      if (!live) return;
      const options: RepoOption[] = items.map((item) => ({
        id: item.id,
        label: item.label || item.id,
        default: item.default,
      }));
      if (!cloudTarget) {
        for (const added of locallyAddedRepos.current.values()) {
          if (!options.some((item) => item.id === added.id)) options.push(added);
        }
      }
      localReposLoaded.current = true;
      setRepos(options);
      setConfiguredDefaultRepo(
        options.find((item) => item.default)?.id || options[0]?.id || "",
      );
    }).catch(() => {
      if (!live) return;
      localReposLoaded.current = true;
      setRepos(cloudTarget ? [] : [...locallyAddedRepos.current.values()]);
    });
    return () => {
      live = false;
    };
  }, [cloudTarget]);
  useEffect(() => {
    setRepo((current) => {
      if (forceRepo && repos.some((item) => item.id === forceRepo)) return forceRepo;
      if (repos.some((item) => item.id === current)) return current;
      return configuredDefaultRepo;
    });
  }, [configuredDefaultRepo, forceRepo, repos]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // In a workspace, default to a sibling's branch so the new session reuses its
  // worktree; the user can still switch to "New branch" to fork a fresh one.
  const [selectedWorktree, setSelectedWorktree] = useState(forceBranch || "__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  // An explicit prefill (Home hand-off, deep link) wins; otherwise restore the
  // stored draft so closing the palette / navigating away doesn't lose a
  // half-written task. Mirrored back below; cleared on session_created.
  const [prompt, setPrompt] = useState(
    prefillPrompt || prefill.prompt || loadDraft("new-session").text,
  );
  // Whether the user has hand-edited the branch field. Once true we stop
  // auto-suggesting so we never clobber what they typed. A prefilled branch
  // (deep link) counts as already-owned.
  const [branchEdited, setBranchEdited] = useState(!!prefill.branch);
  const [suggestingBranch, setSuggestingBranch] = useState(false);
  const [images, setImages] = useState<string[]>(() => loadDraft("new-session").images);
  const [files, setFiles] = useState<FileAttachment[]>(() => loadDraft("new-session").files);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  // Footer controls from the palette design. effort is persisted on the new
  // session and enforced per run (Claude effort / Codex modelReasoningEffort).
  const [effort, setEffort] = useState("high");
  // Pinned provider account for the new session ("" = auto pool pick).
  // Soft pin: the runner prefers it and falls back on exhaustion. Only
  // meaningful for Anthropic/OpenAI subscription-backed models.
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    fetchProviderAccounts(cloudTarget).then(setAccounts).catch(() => {});
  }, [cloudTarget]);
  const effectiveNewModel = model || defaultModel;
  const accountProvider = models.find((item) => item.id === effectiveNewModel)?.accountProvider;
  // A pin belongs to one provider pool. Drop it when the selected model moves
  // to another family so an opaque id is never reinterpreted.
  useEffect(() => {
    const account = accounts.find((item) => item.id === accountId);
    if (accountId && account?.provider !== accountProvider) setAccountId("");
  }, [accountProvider, accountId, accounts]);
  // Keep the palette open after a create to fire off another task. Chosen from
  // the Create split-button's dropdown; the primary button reflects the mode.
  const [createMore, setCreateMore] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createSplitRef = useRef<HTMLDivElement>(null);
  // Phones open on just the prompt — repo/base/model/effort have sensible
  // defaults and hide behind the sliders toggle until you actually need them.
  const isPhone = useIsPhone();
  // "Send messages with" (Settings → Composer). The session composer honors it,
  // so this field has to as well — otherwise Enter silently does nothing here
  // while the Create button advertises ↩.
  const [sendKey, setSendKey] = useState(getSendKeyPref);
  useEffect(() => onSendKeyChanged(() => setSendKey(getSendKeyPref())), []);
  const [showOptions, setShowOptions] = useState(false);
  const optionsVisible = !isPhone || showOptions;

  // Sandbox provider picker (the sandbox rollout plan): isolate this session's
  // workspace in the selected environment. Remote/MicroVM OpenCode sessions
  // keep the model engine on Host and expose only explicit workspace methods.
  // "" = Host (no sandbox, the default); otherwise an explicit provider id
  // sent as the create's `sandbox` string. Options come from
  // /api/sandbox/status (fetched once when the palette opens) — only
  // configured providers are offered, and the whole control hides when the
  // server has no sandbox config or the kill switch is on.
  const [sandboxProvider, setSandboxProvider] = useState("");
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusInfo | null>(null);
  useEffect(() => {
    fetchSandboxStatus().then(setSandboxStatus).catch(() => {});
  }, []);
  const sandboxChoices = (sandboxStatus?.providers || []).filter((p) => p.configured);
  const showSandboxPicker =
    !!sandboxStatus?.enabled && !sandboxStatus.killSwitch && sandboxChoices.length > 0;
  const sandboxLabel = (id: string) =>
    id === "" ? "Host" : id === "docker" ? "Docker" : id === "daytona" ? "Daytona" : id === "e2b" ? "E2B" : id === "box" ? "Box" : id === "modal" ? "Modal" : id === "microvm" ? "Local Firecracker MicroVM" : id === "lambda-microvm" ? "AWS Lambda MicroVM" : id;

  // Model × environment capability check, driven entirely by the server's
  // matrix (status.modelFamilies — the same source resolveRequestedSandbox
  // enforces at create, so this warning is a preview of the server's answer,
  // never a second opinion). First matching family rule wins, mirroring
  // sandboxModelFamilyFor (sandbox/config.ts).
  const effectiveModelId = model || defaultModel;
  const effectiveModelProvider =
    models.find((m) => m.id === effectiveModelId)?.provider ?? "claude";
  const modelFamily = (sandboxStatus?.modelFamilies || []).find(
    (f) =>
      f.match.provider === effectiveModelProvider &&
      (!f.match.idPrefix || effectiveModelId.startsWith(f.match.idPrefix)),
  );
  // Engine switcher (advanced): flips the selected model between execution
  // engines while keeping the same underlying model when both serve it
  // (opencode/anthropic/claude-opus-5 ⇄ pi/anthropic/claude-opus-5). Only
  // rendered when a second engine is actually configured (pi models present
  // in /api/models); legacy native ids dispatch on opencode, so they count
  // as that engine here. The model menu still lists every engine's models —
  // this is a quick toggle, not a filter.
  const engineChoices = models.some((m) => m.provider === "pi")
    ? (["opencode", "pi"] as const)
    : null;
  const currentEngine = effectiveModelProvider === "pi" ? "pi" : "opencode";
  const engineLabel = (e: string) => (e === "pi" ? "Pi" : "OpenCode");
  const switchEngine = (target: "opencode" | "pi") => {
    if (target === currentEngine) return;
    const tail = effectiveModelId.split("/").pop();
    const candidates = models.filter((m) => m.provider === target);
    const match =
      candidates.find((m) => m.id.split("/").pop() === tail) ||
      (target === "opencode" && candidates.some((m) => m.id === defaultModel)
        ? candidates.find((m) => m.id === defaultModel)
        : undefined) ||
      candidates[0];
    if (match) setModel(match.id);
  };

  const sandboxModelWarning = (() => {
    if (!sandboxProvider || !modelFamily) return null;
    if (modelFamily.environments[sandboxProvider as "docker" | "daytona" | "e2b" | "box" | "modal" | "microvm" | "lambda-microvm"]) return null;
    const supported = (Object.keys(modelFamily.environments) as Array<
      "local" | "docker" | "daytona" | "e2b" | "box" | "modal" | "microvm" | "lambda-microvm"
    >)
      .filter(
        (e) =>
          modelFamily.environments[e] &&
          // Only steer toward environments that exist here: Host always, a
          // sandbox provider only when it's configured.
          (e === "local" || sandboxChoices.some((p) => p.id === e)),
      )
      .map((e) => (e === "local" ? "Host" : sandboxLabel(e)));
    const pick =
      supported.length > 1
        ? `${supported.slice(0, -1).join(", ")} or ${supported[supported.length - 1]}`
        : supported[0] || "Host";
    return (
      `${modelFamily.label} models can't run in ${sandboxLabel(sandboxProvider)} yet — pick ${pick}` +
      (modelFamily.hint ? ` (${modelFamily.hint})` : "") +
      "."
    );
  })();

  // Remote sandbox-engine models adopt a full-runner prewarm. MicroVM OpenCode
  // sessions adopt a workspace-only prewarm (restore + repo clone); other
  // host-engine providers deliberately skip the full-runner pool. Strictly
  // fire-and-forget: a failure must never surface or block typing.
  const isRemoteSandbox = sandboxProvider === "daytona" || sandboxProvider === "e2b" || sandboxProvider === "box" || sandboxProvider === "modal" || sandboxProvider === "lambda-microvm";
  const usesRemoteHostEngine =
    isRemoteSandbox && modelFamily?.match.provider === "opencode";
  const usesMicrovmWorkspacePrewarm =
    sandboxProvider === "microvm" && modelFamily?.match.provider === "opencode";
  const shouldPrewarm =
    (isRemoteSandbox && !usesRemoteHostEngine) || usesMicrovmWorkspacePrewarm;
  const [sandboxWarmed, setSandboxWarmed] = useState(false);
  const lastPrewarmAtRef = useRef(0);
  useEffect(() => {
    // Provider/repo switch: allow an immediate re-fire for the new key.
    lastPrewarmAtRef.current = 0;
    setSandboxWarmed(false);
  }, [sandboxProvider, repo]);
  useEffect(() => {
    if (!shouldPrewarm || !prompt.trim() || creating) return;
    if (Date.now() - lastPrewarmAtRef.current < 60_000) return;
    lastPrewarmAtRef.current = Date.now();
    requestSandboxPrewarm(sandboxProvider, repo, getCurrentUser())
      .then((r) => setSandboxWarmed(r.state === "ready"))
      .catch(() => {});
  }, [prompt, shouldPrewarm, sandboxProvider, repo, creating]);

  // MCP servers: empty by default (minimal context), users can opt in for
  // specific ones. The list comes from mcp-config.json via the connections
  // API so it never drifts from what's actually installed.
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<string[]>([]);
  useEffect(() => {
    fetchConnections()
      .then((c) => setAvailableMcpServers((c.mcpServers || []).map((s) => s.name)))
      .catch(() => {});
  }, []);
  function toggleMcpServer(name: string, on: boolean) {
    setSelectedMcpServers((prev) =>
      on ? [...prev, name] : prev.filter((m) => m !== name),
    );
  }

  // Phone-only sheet state (desktop uses a Menu popup instead).
  const [mcpPickerOpen, setMcpPickerOpen] = useState(false);
  const mcpPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mcpPickerOpen) return;
    function onDown(e: MouseEvent) {
      if (mcpPickerRef.current && !mcpPickerRef.current.contains(e.target as Node)) {
        setMcpPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [mcpPickerOpen]);

  // "@"-mention file autocomplete against the selected repo's repo (no
  // session exists yet, so search by repo).
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Hidden <input type="file"> driven by the "Add file" button — the mobile
  // path, since there's no clipboard paste there.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentions = useFileMentions({
    value: prompt,
    onChange: setPrompt,
    textareaRef: promptRef,
    mentionFetch: async (q) => [
      ...peopleMentionMatches(q),
      ...(await fetchFileMentions(q, undefined, repo)),
    ],
    skillsFetch: (q) => fetchSkillMentions(q, undefined, repo),
  });

  // (The prompt is focused on open by Modal.Content's initialFocus — a mount
  // effect here would run a frame before the dialog's popup exists.)

  // Auto-grow the prompt so a long draft isn't crammed into the resting height.
  // CSS min-height/max-height clamp the field, so it rests tall, grows with the
  // text, and only starts scrolling once it hits the cap.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  // Keep the draft store in sync so a dismissed palette can restore the work.
  useEffect(() => {
    saveDraft("new-session", { text: prompt, images, files });
  }, [prompt, images, files]);

  // Close the Create dropdown on an outside click.
  useEffect(() => {
    if (!createMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (createSplitRef.current && !createSplitRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [createMenuOpen]);

  useEffect(() => {
    fetchModels(cloudTarget)
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
        setModel((current) => {
          if (current) {
            return m.models.some((item) => item.id === current) ? current : "";
          }
          // Untouched picker: preselect the user's own default-model pref
          // (Settings → Composer) when it's set and still selectable; "" (no
          // preference) keeps the workspace default.
          const pref = getDefaultModelPref();
          return pref && m.models.some((item) => item.id === pref) ? pref : "";
        });
      })
      .catch(() => {});
  }, [cloudTarget]);

  // Worktrees are per-repo; refetch and reset the selection when it changes.
  // Inside a workspace, snap back to the shared sibling branch, not "New branch".
  useEffect(() => {
    setSelectedWorktree(forceBranch || "__new__");
    if (!repo) {
      setWorktrees([]);
      return;
    }
    fetchWorktrees(repo)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [repo, forceBranch]);

  // Auto-suggest a branch name from the prompt (debounced Haiku call), but only
  // while the field is "ours" — once the user types in it (branchEdited) we back
  // off. The latest-request guard drops a stale response if the user starts
  // editing the branch while a suggestion is in flight.
  const branchEditedRef = useRef(branchEdited);
  branchEditedRef.current = branchEdited;
  const suggestSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== "code" || selectedWorktree !== "__new__" || branchEdited) return;
    if (prompt.trim().length < 10) return;
    const seq = ++suggestSeqRef.current;
    const t = setTimeout(async () => {
      setSuggestingBranch(true);
      const branch = await suggestBranch(prompt.trim());
      setSuggestingBranch(false);
      // Drop if superseded by a newer prompt or the user grabbed the field.
      if (seq !== suggestSeqRef.current || branchEditedRef.current) return;
      if (branch) setNewBranch(branch);
    }, 700);
    return () => clearTimeout(t);
  }, [prompt, mode, selectedWorktree, branchEdited]);

  // Registered from mount and gated on a ref set synchronously in handleCreate:
  // session_created is announced before the worktree even boots, so it can
  // arrive before a `creating`-gated effect would have registered this handler
  // — the palette would miss it (stuck on "creating", draft never cleared).
  const creatingRef = useRef(false);
  useEffect(() => {
    return addHandler((msg) => {
      if (!creatingRef.current) return;
      if (msg.type === "error") {
        creatingRef.current = false;
        setError(msg.message);
        setCreating(false);
      } else if (msg.type === "session_created") {
        creatingRef.current = false;
        // The prompt was consumed — drop the stored draft either way.
        clearDraft("new-session");
        // With "Create more" on, stay in the palette and reset for the next task
        // (App still navigates into the created session behind the overlay). Off,
        // close and let App drop us into the new session.
        if (createMore) {
          setCreating(false);
          setPrompt("");
          setImages([]);
          setFiles([]);
          setNewBranch("");
          setBranchEdited(false);
          setError(null);
          promptRef.current?.focus();
        } else {
          // Close the palette; App's global session_created handler drops us
          // into the newly created session behind it.
          onBack();
        }
      }
    });
  }, [addHandler, createMore]);

  async function addAttachments(picked: FileList | File[]) {
    const { images: imgs, files: fls, rejected } = await splitAttachments(picked);
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
    if (fls.length) setFiles((prev) => [...prev, ...fls]);
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
  }

  function handlePaste(e: React.ClipboardEvent) {
    const imgs = imageFilesFromPaste(e);
    if (imgs.length) {
      e.preventDefault();
      void addAttachments(imgs);
    }
  }

  function handleCreate() {
    if (!canCreate) return;
    const branch =
      selectedWorktree === "__new__"
        ? newBranch.trim() || slugifyBranch(prompt)
        : selectedWorktree;

    setError(null);
    // With "Create more" off, App tears down the palette when the
    // session_created event arrives (and drops us into the new session).
    setCreating(true);
    creatingRef.current = true;
    // Workspace linkage: scoped to an existing workspace (the tab/sidebar +),
    // the session joins it — sharing its worktree when reusing the sibling branch,
    // stacking a fresh worktree off it for a new branch. Unscoped, the default
    // is a brand-new Workspace + first Session created together.
    const worktreeMode =
      mode === "ask" ? "ask" : mode === "code" && selectedWorktree === "__new__" ? "stack" : "share";
    onCreateStarted?.({
      prompt: prompt.trim(),
      mode,
      repo,
      branch: mode === "code" ? branch : null,
      ...(workspaceId ? { workspaceId } : {}),
      ...(model ? { model } : {}),
      ...(images.length ? { images } : {}),
    });
    send({
      type: "create_session",
      ...(auth?.local && createTarget === "cloud" ? { cloud: true } : {}),
      mode,
      repo,
      ...(workspaceId
        ? { workspaceId: workspaceId, worktreeMode }
        : { createWorkspace: {} }),
      branch: mode === "code" ? branch : "",
      prompt: prompt.trim(),
      user: getCurrentUser(),
      ...(mode === "code" && planFirst ? { planFirst: true } : {}),
      ...(model ? { model } : {}),
      effort,
      ...(accountProvider && accountId ? { accountId } : {}),
      // Explicit provider id; omitted entirely for Host (= no sandbox).
      ...(sandboxProvider ? { sandbox: sandboxProvider } : {}),
      ...(selectedMcpServers.length ? { mcpServers: selectedMcpServers } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length
        ? {
            files: files.map((f) =>
              f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
            ),
          }
        : {}),
    });
  }

  const canCreate =
    !creating &&
    connected &&
		(!!repo || mode === "scratch") &&
    // Unsupported model × environment combo: the server would reject the
    // create with the same message (resolveRequestedSandbox) — block here so
    // the wall is discovered before submit, not after.
    !sandboxModelWarning &&
    (prompt.trim() || images.length > 0 || files.length > 0) &&
    (mode === "ask" || mode === "scratch" || selectedWorktree !== "");

  // "Create from…" combines the repo-backed mode + base into one control.
  const createFromValue = mode === "ask" ? "__ask__" : selectedWorktree;
  function onCreateFromChange(v: string) {
    if (v === "__ask__") {
      setMode("ask");
    } else {
      setMode("code");
      setSelectedWorktree(v);
    }
  }
  const createFromLabel =
    mode === "ask"
      ? "Ask · read-only"
      : selectedWorktree === "__new__"
        ? "New branch"
        : selectedWorktree;
  const createFromOptions = [
    {
      value: "__new__",
      label: workspaceId && forceBranch
        ? `New stacked branch (off ${forceBranch})`
        : "New branch",
    },
    // Ask stays above the branch list — as the last option it drowned below
    // the scroll fold once the worktree list grew, reading as "Ask is gone".
    { value: "__ask__", label: "Ask — read-only on main", menuLabel: "Ask · read-only on main" },
    ...worktrees.map((wt) => ({ value: wt.branch, label: wt.branch })),
  ];

  // One frame closed so the palette animates in; App mounts us already-open.
  const open = useEnterOnMount();
  // Plan mode tints the writing surface and hatches it. Applied here rather
  // than through a `.palette-card.is-plan-mode` descendant rule now that the
  // shell is the shared Modal and no longer carries `.palette-card`.
  const planSurface: React.CSSProperties | undefined = planFirst
    ? { background: "color-mix(in srgb, var(--bg-panel) 96%, var(--accent))" }
    : undefined;
  const planBody: React.CSSProperties | undefined = planFirst
    ? {
        backgroundColor: "color-mix(in srgb, var(--bg-panel) 96%, var(--accent))",
        // The hatch fades out downwards, same as the composer's ask mode: the
        // flat tint is layered back over the stripes so the writing surface
        // settles into the footer instead of hatching all the way to the edge.
        backgroundImage:
          "linear-gradient(to bottom, transparent 15%, color-mix(in srgb, var(--bg-panel) 96%, var(--accent)) 72%), repeating-linear-gradient(45deg, color-mix(in srgb, var(--accent) 5%, transparent) 0, color-mix(in srgb, var(--accent) 5%, transparent) 12px, transparent 12px, transparent 24px)",
      }
    : undefined;

  return (
    <Modal.Root
      open={open}
      // Escape and outside presses both land here. App's global Esc-closes-a-
      // palette shortcut can't double-fire: Base UI stops the keydown before it
      // reaches window, so this is the only close (which matters — closePalette
      // also pops a /new deep link off history).
      onOpenChange={(next) => {
        if (!next) onBack();
      }}
      // Focus is trapped, but the page is neither inerted nor scroll-locked: the
      // "@"-mention popup portals to <body>, and inerting would leave it dead.
      modal="trap-focus"
      // Mid-create the palette isn't dismissable. An open mention popup also
      // owns the next click — it lives outside the dialog, so pressing it would
      // otherwise read as an outside press and close the whole palette.
      disablePointerDismissal={creating || mentions.open}
    >
      <Modal.Content
        variant="palette"
        aria-label="New session"
        // The prompt, not the repo picker Base UI would otherwise land on as the
        // first tabbable.
        initialFocus={promptRef}
      >
        {/* Header: repo (left) · create-from (right). The repo picker is
            always visible — on phones the create-from picker hides until the
            options toggle in the footer opens it. */}
        <div className="palette-header">
          <PaletteSelect
            className="palette-trigger palette-trigger-strong"
            title="Repository"
            value={mode === "scratch" ? SCRATCH_REPO_VALUE : repo}
            options={[
              ...repos.map((p) => ({
                value: p.id,
                label: p.label,
                icon: <RepoTile name={p.id} />,
              })),
              {
                value: SCRATCH_REPO_VALUE,
                label: "Scratch · no repo",
                icon: <IconFile size={20} />,
              },
              ...(auth?.local && createTarget === "local"
                ? [
                    {
                      value: ADD_REPO_VALUE,
                      label: "Add repo…",
                      icon: <IconFolderPlus size={20} />,
                    },
                  ]
                : []),
            ]}
            onChange={(nextRepo) => {
              if (nextRepo === SCRATCH_REPO_VALUE) {
                setMode("scratch");
                return;
              }
              if (nextRepo === ADD_REPO_VALUE) {
                setAddRepoOpen(true);
                return;
              }
              if (mode === "scratch") setMode("code");
              setRepo(nextRepo);
              rememberSelectedRepo(nextRepo);
            }}
            disabled={creating}
            ariaLabel="Repository"
            isPhone={isPhone}
          >
            {mode === "scratch" ? (
              <IconFile className="shrink-0" size={20} />
            ) : (
              <RepoTile name={repo} />
            )}
            <span className="palette-trigger-label">
              {mode === "scratch"
                ? "Scratch · no repo"
                : repos.find((p) => p.id === repo)?.label || repo || "No repositories"}
            </span>
            <IconChevronDown className="palette-chevron" size={22} />
          </PaletteSelect>

          {optionsVisible && mode !== "scratch" && (
          <PaletteSelect
            className="palette-trigger"
            title="What to create from"
            value={createFromValue}
            options={createFromOptions}
            onChange={onCreateFromChange}
            disabled={creating}
            ariaLabel="Create from"
            isPhone={isPhone}
            align="end"
          >
            <svg width="19" height="19" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="4" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="4" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4 5.7v4.6M4 8h4a4 4 0 004-4" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span className="palette-trigger-label">{createFromLabel}</span>
            <IconChevronDown className="palette-chevron" size={22} />
          </PaletteSelect>
          )}
        </div>

        {auth?.local && (
          <AddRepoDialog
            open={addRepoOpen}
            onOpenChange={setAddRepoOpen}
            onAdded={(added) => {
              const next = { id: added.id, label: added.id };
              locallyAddedRepos.current.set(added.id, next);
              setRepos((current) => [
                ...(localReposLoaded.current ? current : []).filter((item) => item.id !== added.id),
                next,
              ]);
              setRepo(added.id);
              rememberSelectedRepo(added.id);
            }}
          />
        )}

        {/* Prompt */}
        <div
          className="palette-body"
          style={planBody}
          onDrop={(e) => {
            if (e.dataTransfer?.files?.length) {
              e.preventDefault();
              void addAttachments(e.dataTransfer.files);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          ref={mentions.inputWrapRef}
        >
          {mentions.popup}
          <textarea
            ref={promptRef}
            className="palette-textarea"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              queueMicrotask(mentions.sync);
            }}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter creates whatever the send-key preference is.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleCreate();
                return;
              }
              // The @/slash popup claims plain Enter to accept a suggestion.
              if (mentions.handleKeyDown(e)) return;
              // Otherwise the send key creates, exactly as it sends in the session
              // composer — including the unclosed-``` fence exception, so a
              // multi-line code block can still be typed into the first prompt.
              // Nothing to create yet? Let the newline land rather than eating
              // the keystroke.
              if (!isSendCombo(e, sendKey) || !canCreate) return;
              const caret = promptRef.current?.selectionStart ?? prompt.length;
              if (insideOpenFence(prompt, caret)) return;
              e.preventDefault();
              handleCreate();
            }}
            onKeyUp={mentions.sync}
            onClick={mentions.sync}
            onBlur={() => setTimeout(mentions.close, 120)}
            onPaste={handlePaste}
            placeholder="What do you want to work on?"
            disabled={creating}
          />
          <ImageThumbs images={images} onRemove={(i) => setImages((p) => p.filter((_, idx) => idx !== i))} disabled={creating} />
          <FileChips files={files} onRemove={(i) => setFiles((p) => p.filter((_, idx) => idx !== i))} disabled={creating} />
        </div>

        {error && <div className="palette-error">{error}</div>}
        {sandboxModelWarning && (
          <div className="palette-error" role="alert">
            {sandboxModelWarning}
          </div>
        )}

        {/* Footer toolbar */}
        <div className="palette-footer" style={planSurface}>
          <div className="palette-footer-left">
            {isPhone && (
              <button
                type="button"
                className={`palette-icon-btn palette-options-btn ${showOptions ? "is-on" : ""}`}
                onClick={() => setShowOptions((v) => !v)}
                disabled={creating}
                aria-label="Advanced options — base branch, plan first, run environment"
                aria-expanded={showOptions}
              >
                <IconSliders size={20} />
              </button>
            )}
            <Tooltip label="Attach a file">
              <button
                type="button"
                className="palette-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={creating}
                aria-label="Attach a file"
              >
                <IconPaperclip size={20} />
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addAttachments(e.target.files);
                e.target.value = "";
              }}
            />
            {/* Connected services: a Menu popup on desktop, a full-width sheet
                on phones (a positioned popup is too cramped there). */}
            {!isPhone ? (
              <Menu.Root>
                <Tooltip
                  label={`Connected services${selectedMcpServers.length ? ` (${selectedMcpServers.length})` : ""}`}
                >
                  <Menu.Trigger
                    type="button"
                    className={`palette-icon-btn palette-mcp-picker-btn ${selectedMcpServers.length ? "is-on" : ""}`}
                    disabled={creating}
                    aria-label="Choose connected services"
                  >
                    <IconConnections size={20} />
                    {selectedMcpServers.length > 0 && (
                      <span className="palette-mcp-picker-badge">{selectedMcpServers.length}</span>
                    )}
                  </Menu.Trigger>
                </Tooltip>
                <Menu.Popup align="start" sideOffset={6} className="max-w-[min(360px,calc(100vw-1rem))]">
                  <Menu.Group>
                    <Menu.GroupLabel className="pt-1.5">Connected services</Menu.GroupLabel>
                    {availableMcpServers.map((mcp) => {
                      const checked = selectedMcpServers.includes(mcp);
                      return (
                        <Menu.CheckboxItem
                          key={mcp}
                          checked={checked}
                          closeOnClick={false}
                          onCheckedChange={(on) => toggleMcpServer(mcp, on)}
                          className={`justify-between gap-3 ${checked ? "bg-hover" : ""}`}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <IconTile name={mcp} size={20} />
                            <span className="min-w-0 truncate">{displayName(mcp)}</span>
                          </span>
                          {checked && <IconCheck className="shrink-0 text-dim" size={17} />}
                        </Menu.CheckboxItem>
                      );
                    })}
                  </Menu.Group>
                </Menu.Popup>
              </Menu.Root>
            ) : (
            <div className="palette-mcp-picker-container" ref={mcpPickerRef}>
              <button
                type="button"
                className={`palette-icon-btn palette-mcp-picker-btn ${selectedMcpServers.length ? "is-on" : ""}`}
                onClick={() => setMcpPickerOpen((v) => !v)}
                disabled={creating}
                title={`Connected services${selectedMcpServers.length ? ` (${selectedMcpServers.length})` : ""}`}
                aria-label="Choose connected services"
                aria-expanded={mcpPickerOpen}
              >
                <IconConnections size={20} />
                {selectedMcpServers.length > 0 && (
                  <span className="palette-mcp-picker-badge">{selectedMcpServers.length}</span>
                )}
              </button>
              {mcpPickerOpen && (
                <div className="palette-mcp-picker-popover">
                  <div className="palette-mcp-picker-header">Connected services</div>
                  <div className="palette-mcp-picker-grid">
                    {availableMcpServers.map((mcp) => (
                      <label key={mcp} className="palette-mcp-checkbox-compact">
                        <input
                          type="checkbox"
                          checked={selectedMcpServers.includes(mcp)}
                          onChange={(e) => toggleMcpServer(mcp, e.target.checked)}
                          disabled={creating}
                        />
                        <IconTile name={mcp} size={20} />
                        <span>{displayName(mcp)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            )}
            {/* Plan mode is an advanced switch, so on phones it rides behind
                the options toggle with the other advanced controls. */}
            {mode === "code" && optionsVisible && (
              <Tooltip label={planFirst ? "Exit plan mode" : "Enter plan mode"}>
                <button
                  type="button"
                  className={`palette-icon-btn ${planFirst ? "is-on" : ""}`}
                  onClick={() => setPlanFirst((v) => !v)}
                  disabled={creating}
                  aria-label={planFirst ? "Exit plan mode" : "Enter plan mode"}
                  aria-pressed={planFirst}
                >
                  <IconMap size={20} />
                </button>
              </Tooltip>
            )}
            {/* On phones the run-environment picker hides behind the options
                toggle with the other advanced controls. */}
            {showSandboxPicker && optionsVisible && (
              <Menu.Root>
                <Tooltip
                  label={`Run environment — ${sandboxLabel(sandboxProvider)}${
                    sandboxWarmed && shouldPrewarm ? " (warmed)" : ""
                  }`}
                >
                  <Menu.Trigger
                    type="button"
                    className={`palette-icon-btn ${sandboxProvider ? "is-on" : ""}`}
                    disabled={creating}
                    aria-label="Run environment"
                  >
                    <IconBox size={20} />
                  </Menu.Trigger>
                </Tooltip>
                <Menu.Popup align="start" sideOffset={6} className="max-w-[min(340px,calc(100vw-1rem))]">
                  <Menu.Group>
                    <Menu.GroupLabel className="pt-1.5">Run environment</Menu.GroupLabel>
                    {[{ id: "", note: undefined as string | undefined }, ...sandboxChoices].map(
                      (opt) => {
                        const selected = sandboxProvider === opt.id;
                        const hostEngineWorkspace =
                          !!opt.id &&
                          opt.id !== "docker" &&
                          modelFamily?.match.provider === "opencode";
                        return (
                          <Menu.Item
                            key={opt.id || "host"}
                            onClick={() => setSandboxProvider(opt.id)}
                            className="items-start"
                          >
                            <IconCheck
                              size={17}
                              className={`mt-0.5 shrink-0 text-dim ${selected ? "" : "invisible"}`}
                            />
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span>
                                {sandboxLabel(opt.id)}
                                {opt.id === "" && (
                                  <span className="text-faint"> — no sandbox</span>
                                )}
                              </span>
                              {opt.note && (
                                <span className="whitespace-normal text-[11px] font-medium leading-snug text-faint">
                                  {opt.note}
                                </span>
                              )}
                              {hostEngineWorkspace && (
                                <span className="whitespace-normal text-[11px] font-medium leading-snug text-faint">
                                  Model on Host · workspace isolated here
                                </span>
                              )}
                            </span>
                          </Menu.Item>
                        );
                      },
                    )}
                  </Menu.Group>
                </Menu.Popup>
              </Menu.Root>
            )}
            {/* Engine switcher rides with the other advanced controls; hidden
                entirely unless a second engine is configured. */}
            {engineChoices && optionsVisible && (
              <Menu.Root>
                <Tooltip label={`Engine — ${engineLabel(currentEngine)}`}>
                  <Menu.Trigger
                    type="button"
                    className={`palette-icon-btn ${currentEngine === "pi" ? "is-on" : ""}`}
                    disabled={creating}
                    aria-label="Engine"
                  >
                    <IconStack size={20} />
                  </Menu.Trigger>
                </Tooltip>
                <Menu.Popup align="start" sideOffset={6} className="max-w-[min(300px,calc(100vw-1rem))]">
                  <Menu.Group>
                    <Menu.GroupLabel className="pt-1.5">Engine</Menu.GroupLabel>
                    {engineChoices.map((e) => {
                      const selected = currentEngine === e;
                      return (
                        <Menu.Item key={e} onClick={() => switchEngine(e)} className="items-start">
                          <IconCheck
                            size={17}
                            className={`mt-0.5 shrink-0 text-dim ${selected ? "" : "invisible"}`}
                          />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span>{engineLabel(e)}</span>
                            <span className="whitespace-normal text-[11px] font-medium leading-snug text-faint">
                              {e === "pi"
                                ? "pi.dev harness, in-process — native mid-turn steering"
                                : "Default engine — server pools, sandboxes, detached runs"}
                            </span>
                          </span>
                        </Menu.Item>
                      );
                    })}
                  </Menu.Group>
                </Menu.Popup>
              </Menu.Root>
            )}
          </div>

          <div className="palette-footer-right">
            {/* Always visible — on phones too, so a non-default (dumber) model
                is never silently in effect behind the options toggle. */}
            <ModelEffortSelect
              className="palette-pill"
              title="Model and reasoning effort"
              models={models}
              defaultModel={defaultModel}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              // Account pinning is shown for models backed by a configured
              // Claude or Codex account pool.
              accounts={accountProvider && accounts.length > 0 ? accounts : undefined}
              accountId={accountId}
              onAccountChange={setAccountId}
              disabled={creating}
            />
            <VoiceInput
              disabled={creating}
              onText={(t) => {
                setPrompt((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${t}` : t));
                promptRef.current?.focus();
              }}
            />

            <div className="palette-create-split" ref={createSplitRef}>
              <button
                // In light mode the Create button is ink-on-paper rather than
                // accent — carried here since the shell no longer supplies the
                // `.palette-card` that scoped that override.
                className={`palette-create palette-create-main ${LIGHT_CREATE}`}
                onClick={handleCreate}
                disabled={!canCreate}
              >
                {creating
                  ? "Creating…"
                  : (auth?.local || desktopShell) && createTarget === "local"
                    ? createMore
                      ? "Create more locally"
                      : "Create locally"
                    : createMore
                      ? "Create more"
                      : "Create"}
                {/* The hint has to match the preference — a bare ↩ next to a
                    field that only creates on ⌘↩ is what made Enter look
                    broken in the first place. */}
                {sendKey === "mod-enter" ? (
                  <span className="palette-create-kbd mx-0 text-xs">
                    {MOD_ENTER_GLYPH}
                  </span>
                ) : (
                  <IconReturn className="palette-create-kbd" size={20} />
                )}
              </button>
              <button
                type="button"
                className={`palette-create palette-create-caret ${LIGHT_CREATE} ${createMenuOpen ? "is-open" : ""}`}
                onClick={() => setCreateMenuOpen((v) => !v)}
                disabled={creating}
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                aria-label="Create options"
              >
                <IconChevronDown size={22} />
              </button>
              {createMenuOpen && (
                <div className="palette-create-menu" role="menu">
                  {auth?.local && (
                    <>
                      {[
                        { target: "cloud" as const, title: "Create", desc: "Run on the hosted instance" },
                        { target: "local" as const, title: "Create locally", desc: "Experimental - run on this Mac" },
                      ].map((opt) => (
                        <button
                          key={opt.target}
                          type="button"
                          role="menuitemradio"
                          aria-checked={createTarget === opt.target}
                          className={`palette-create-menu-item ${createTarget === opt.target ? "is-active" : ""}`}
                          onClick={() => {
                            setCreateTarget(opt.target);
                            setCreateMenuOpen(false);
                          }}
                        >
                          <IconCheck
                            className="palette-create-menu-check"
                            size={22}
                            style={{ visibility: createTarget === opt.target ? "visible" : "hidden" }}
                          />
                          <span className="palette-create-menu-text">
                            <span className="palette-create-menu-title">{opt.title}</span>
                            <span className="palette-create-menu-desc">{opt.desc}</span>
                          </span>
                        </button>
                      ))}
                      <div className="my-1 border-t border-line" />
                    </>
                  )}
                  {[
                    { more: false, title: "Create", desc: "Open the new session" },
                    { more: true, title: "Create more", desc: "Stay here to start another" },
                  ].map((opt) => (
                    <button
                      key={opt.title}
                      type="button"
                      role="menuitemradio"
                      aria-checked={createMore === opt.more}
                      className={`palette-create-menu-item ${createMore === opt.more ? "is-active" : ""}`}
                      onClick={() => {
                        setCreateMore(opt.more);
                        setCreateMenuOpen(false);
                      }}
                    >
                      <IconCheck
                        className="palette-create-menu-check"
                        size={22}
                        style={{ visibility: createMore === opt.more ? "visible" : "hidden" }}
                      />
                      <span className="palette-create-menu-text">
                        <span className="palette-create-menu-title">{opt.title}</span>
                        <span className="palette-create-menu-desc">{opt.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
