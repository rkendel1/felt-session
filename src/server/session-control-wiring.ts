/**
 * Wires the SessionControl registry (src/server/session-control.ts) — the
 * surface behind the opensession-sessions MCP — into the same in-process state and
 * helpers the WebSocket handlers use, so a management session lists/steers/
 * answers/creates exactly like a human in the web UI. Also keeps the linked
 * Slack-channel index + inbound-message bridge fresh. Module-scope side
 * effects: re-run on every hot reload (cheap, and keeps closures current).
 */

import { personaName } from "./config";
import { type StreamEvent, cancelAgentRun, isAgentSessionBusy, runAgent, steerAgentRun } from "./agent-runner";
import { makeAskHandler, pendingAsks } from "./asks";
import { ensureGeneratedTitle } from "./generated-titles";
import { onSessionIdle as onHumanAsksSessionIdle, relinkAskThreads } from "./human-asks";
import { interactiveMcpServers } from "./interactive-mcp";
import { SESSION_EFFORTS, type SessionEffort, interactiveDefaultModel, interactiveFallbackModel, modelLabel, providerFor, resolveModel } from "./models";
import { promptQueues, recordSteer, requeueSteerReceipts, stoppedSessions } from "./queue-state";
import { attachSessionWatchersToEngineTranscript, attachSessionWatchersToTranscript, enqueuePrompt, foldSessionUsage, maybeLaunchSandboxedRun, maybeQueueAutoContinue, runSessionPrompt, runSessionPromptAndDrain, sessionMentionsNote, watchExternalRunAndDrain } from "./run-session";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { parseImageDataUrls } from "./uploads";
import { type Sandbox } from "./sandbox";
import { isRemoteSandboxProvider, resolveRequestedSandbox } from "./sandbox/config";
import { findSession, getCachedSessions, invalidateSessionsCache, recordRunOutcome, touchNativeSession, updateSessionFile } from "./session-cache";
import { type SessionState, type SessionSummary, registerSessionControl } from "./session-control";
import { buildBranchNote, memoryNoteFor, resolveSessionRepoContext, workspaceOwningWorktree } from "./session-repos";
import { engineSessionPatch, engineUserTexts, getAllSessions, mergedSessionTranscript } from "./sessions";
import { isLocalSessionUpgradeInProgress } from "./session-transfer-state";
import { rebuildIndex } from "./slack-links";
import { handleSlashCommand } from "./slash-commands";
import { type NativeSessionFile, type SessionUsage, type UnifiedSession } from "./types";
import { type Workspace, createWorkspace, getWorkspace, updateWorkspace } from "./workspaces";
import { ownedWorktree } from "./session-workspace";
import { createWorktree, ensureAskCheckout, ensureScratchDir, getRepo, listWorktrees, repoForPath, resolveUniqueBranch, worktreeHeadBranch } from "./worktree";
import { broadcastToAll, broadcastToSession } from "./ws-hub";
import { randomUUIDv7 } from "bun";
import { existsSync, watch } from "fs";
import { shouldPersistModelSwitch } from "./run-events";
import { newSessionId } from "./paths";
import { branchNameFromPrompt } from "./suggest-branch";

/** Derive the at-a-glance state + control surface for a session (for the MCP). */
function buildSummary(s: UnifiedSession): SessionSummary {
	const busyHere = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
	// External runs (CLI in tmux, another process) show as running via PID but
	// aren't in our activeRuns — observe-only, can't steer/cancel them.
	const runningExternal = !!s.isRunning && !busyHere;
	const pending = pendingAsks.get(s.id);
	const queuedCount = promptQueues.get(s.id)?.length || 0;

	let state: SessionState;
	if (s.archived) state = "archived";
	else if (pending) state = "waiting_question";
	else if (busyHere || s.isRunning) state = "running";
	else if (queuedCount > 0) state = "queued";
	else state = "idle";

	return {
		...s,
		state,
		queuedCount,
		controllable: !runningExternal,
		...(pending
			? {
					pendingQuestion: {
						questionId: pending.questionId,
						questions: pending.questions,
					},
				}
			: {}),
	};
}

// --- Session control surface (powers the opensession-sessions MCP) ---
// Wire the Slack thread index (thread replies → owning session). Re-run on
// every hot reload (cheap) so the index stays fresh.
rebuildIndex(getAllSessions());
// rebuildIndex() clears the index, so replay the links the session files don't
// hold: a human-ask DM thread belongs to the session that raised the ask.
relinkAskThreads();

// Wires the MCP's tools into the same in-process state and helpers the
// WebSocket handlers use, so a management session steers/answers/creates the
// exact same way a human does in the web UI. See src/server/session-control.ts.
registerSessionControl({
	listSessions: () =>
		getCachedSessions().map(buildSummary),

	getSession: (id) => {
		const s = findSession(id);
		return s ? buildSummary(s) : undefined;
	},

	transcriptTail: (id, n) => {
		const s = findSession(id);
		if (!s) return [];
		// Engine-spanning read (file + opencode store) — same as the transcript
		// route, so get_session works on opencode/migrated sessions too.
		return mergedSessionTranscript(s).slice(-Math.max(0, n));
	},

	answerQuestion: (id, answers) => {
		const pending = pendingAsks.get(id);
		if (!pending) return false;
		// resolve() clears the timeout, deletes the entry and unblocks makeAskHandler,
		// which broadcasts ask_resolved and lets the run continue with these answers.
		pending.resolve(answers && typeof answers === "object" ? answers : null);
		return true;
	},

	deliverToSession: async (id, content, user, opts) => {
		const session = findSession(id);
		if (!session)
			return { status: "error" as const, message: "No session with that id." };
		if (session.upgradedTo || isLocalSessionUpgradeInProgress(id)) {
			return {
				status: "error" as const,
				message: "This session is being upgraded to the cloud. Retry there after the upgrade completes.",
			};
		}

		// Slash commands (/loop, /goal, /model, /help) are handled by opensession
		// itself, exactly like the WebSocket prompt path — checked BEFORE the
		// busy branch so "/loop stop" configures the session instead of being
		// steered into its running turn as literal prompt text. This is what
		// lets a monitor session manage loops (its own and others') via the
		// opensession-sessions send_to_session tool.
		const notice = handleSlashCommand(session, String(content || "").trim(), user);
		if (notice !== null) {
			invalidateSessionsCache();
			return { status: "handled" as const, message: notice };
		}

		const attributed = user ? `[${user}] ${content}` : content;

		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		) {
			// Busy + owned here → fold into the running turn (delivered at the next
			// stopping point). Otherwise queue and drain when the external run ends.
			// busy: "queue" opts out of steering; Slack-thread replies always set it
			// (and never steer regardless): the in-thread answer mirror only fires
			// on a turn that carries the slackReplyTo, and a steered message can't
			// (it folds into a turn that's already running).
			if (
				opts?.busy !== "queue" &&
				!opts?.slackReplyTo &&
				steerAgentRun(
					[session.claudeSessionId, session.codexThreadId, session.id],
					attributed,
					opts?.images,
				)
			) {
				recordSteer(id, { content, user, images: opts?.imageUrls });
				return {
					status: "steered" as const,
					message: "Folded into the running turn.",
				};
			}
			enqueuePrompt(id, {
				content,
				user,
				images: opts?.imageUrls,
				slackReplyTo: opts?.slackReplyTo,
				...(opts?.hold ? { hold: true } : {}),
			});
			watchExternalRunAndDrain(id);
			return {
				status: "queued" as const,
				message: "Queued behind the current run.",
			};
		}
		// Open Session sessions with no engine id are fresh sessions — the first prompt
		// starts a new conversation (see runSessionPrompt).
		if (
			providerFor(session.model) === "claude" &&
			!session.claudeSessionId &&
			session.source !== "opensession"
		) {
			return {
				status: "error" as const,
				message: "Session has no Claude session to resume yet.",
			};
		}

		// Idle → start a fresh turn in the background; don't block the tool call on
		// the whole run finishing.
		void runSessionPromptAndDrain(
			id,
			content,
			user,
			opts?.images,
			undefined,
			undefined,
			opts?.slackReplyTo,
		).catch((e) => console.error(`[sessions-mcp] deliver to ${id} failed:`, e));
		return {
			status: "started" as const,
			message: "Started a new turn on the session.",
		};
	},

	cancelSession: (id) => {
		const session = findSession(id);
		if (!session) return false;
		// Same park as the UI Stop: without it the run-end guards (queue drain,
		// orphaned-steer redelivery in maybeQueueAutoContinue) would immediately
		// start a new turn on the session that was just deliberately cancelled.
		// Any later explicit prompt lifts it (runSessionPrompt deletes the mark).
		stoppedSessions.add(id);
		const cancelled = cancelAgentRun(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		);
		requeueSteerReceipts(id, engineUserTexts(session));
		return cancelled;
	},

	createSession: async ({
		prompt,
		branch,
		repo: repoInput,
		mode,
		model: modelInput,
		effort: effortInput,
		fastMode: fastModeInput,
		images: imageUrls,
		mcpServers,
		workspaceId,
		parentSessionId,
		reportBack,
		user,
		sandbox,
	}) => {
		// Scratch: repo-less sessions (feed-item workspaces — the feeds design).
		const isScratch = mode === "scratch";
		const isAsk = !isScratch && mode !== "code";
		const model =
			(modelInput ? resolveModel(String(modelInput))?.id : undefined) ||
			interactiveDefaultModel();
		// Same validation as the web palette's create_session: unknown efforts
		// are dropped rather than persisted; images arrive as data URLs.
		const createEffort =
			typeof effortInput === "string" &&
			(SESSION_EFFORTS as readonly string[]).includes(
				effortInput.trim().toLowerCase(),
			)
				? (effortInput.trim().toLowerCase() as SessionEffort)
				: undefined;
		const createFastMode = fastModeInput === true;
		const images = parseImageDataUrls(imageUrls);
		const parentSession = parentSessionId ? findSession(parentSessionId) : null;
		// Explicit workspace join (the native apps' "new session in this workspace" —
		// this path's equivalent of the web tab strip's "+"). An unknown id is a
		// hard error: falling back to a standalone create would silently mint the
		// duplicate sidebar row the caller asked to avoid.
		const joinedWorkspace = workspaceId ? getWorkspace(workspaceId) : null;
		if (workspaceId && !joinedWorkspace) {
			throw new Error(`No such workspace: ${workspaceId}`);
		}
		// A child defaults to the parent's primary repo, but an explicit repo —
		// or a prompt that names exactly one attached worktree — inherits that
		// exact repo context. This is load-bearing for reviewers of in-progress
		// attached-repo work: a fresh ask checkout cannot see those changes.
		const parentRepoContext = parentSession
			? resolveSessionRepoContext(parentSession, repoInput, prompt)
			: null;
		// A joined workspace's repo outranks the global default: a caller that
		// names only a workspace means "a session in there", and defaulting to the
		// configured default repo would mint a foreign worktree inside it.
		const repo = getRepo(
			repoInput ||
				joinedWorkspace?.repo ||
				parentRepoContext?.repo ||
				parentSession?.repo,
		);
		// Sandbox opt-in: true = config default provider, or an explicit
		// provider id validated against the config — an unconfigured pick fails
		// the create loudly instead of silently running on the host.
		const sandboxResolved = resolveRequestedSandbox(sandbox, repo.id, model);
		if (!sandboxResolved.ok) throw new Error(sandboxResolved.error);
		const sandboxProvider = sandboxResolved.provider;
		const remoteSandbox = isRemoteSandboxProvider(sandboxProvider);
		const parentWorkspace =
			parentSession?.workspaceId
				? getWorkspace(parentSession.workspaceId)
				: null;
		// The workspace this session lands in: the one it explicitly joins, else the
		// parent's. Everything a session inherits from its workspace — repo context,
		// worktree, feed refs and their MCP scoping — reads from this.
		const contextWorkspace = joinedWorkspace ?? parentWorkspace;
		// Least privilege: sessions in feed-item workspaces default their MCP
		// allowlist to the feed's declared servers, else inherit the parent's
		// scoping — never widen back to the full mcp-config.
		const { feedMcpServersForRefs } = await import("./feeds");
		const effectiveMcpServers = mcpServers?.length
			? mcpServers
			: contextWorkspace?.externalRefs?.length
				? ((await feedMcpServersForRefs(contextWorkspace.externalRefs)) ??
					parentSession?.mcpServers)
				: parentSession?.mcpServers;

		let wtPath: string;
		let sessionBranch = branch || "";
		const sharedParentContext =
			parentSession &&
			parentSession.mode !== "ask" &&
			parentSession.mode !== "scratch" &&
			parentRepoContext?.repo === repo.id &&
			existsSync(parentRepoContext.dir)
				? parentRepoContext
				: null;
		if (isScratch) {
			// Scratch children share the parent workspace's scratch dir (so a
			// child sees the parent's downloads); standalone scratch creates get
			// a fresh one. Never a repo checkout (the feeds design).
			wtPath = ensureScratchDir(
				joinedWorkspace?.id || parentSession?.workspaceId || randomUUIDv7(),
			);
			sessionBranch = "";
		} else if (isAsk) {
			// A child reviewer shares the selected parent worktree read-only so
			// it sees uncommitted/current-branch work. Standalone ask sessions
			// keep using the pinned default-branch checkout.
			if (sharedParentContext) {
				wtPath = sharedParentContext.dir;
				sessionBranch = sharedParentContext.branch || sessionBranch;
			} else {
				wtPath = await ensureAskCheckout(repo.id);
			}
		} else {
			// Same workspace ⇒ same worktree: a code session joining a workspace (its
			// parent's, or one it named) shares that worktree/branch instead of
			// creating a fresh one. Only when the repo matches — a session explicitly
			// targeting another repo still gets its own isolated worktree there.
			const shared =
				sharedParentContext
					? {
							dir: sharedParentContext.dir,
							branch: sharedParentContext.branch,
						}
					: contextWorkspace?.worktreeDir &&
				repoForPath(contextWorkspace.worktreeDir).id === repo.id &&
				existsSync(contextWorkspace.worktreeDir)
					? {
							dir: contextWorkspace.worktreeDir,
							branch: contextWorkspace.branch,
						}
					: parentSession?.worktreeDir &&
							parentSession.mode !== "ask" &&
							repoForPath(parentSession.worktreeDir).id === repo.id &&
							existsSync(parentSession.worktreeDir)
						? { dir: parentSession.worktreeDir, branch: parentSession.branch }
						: null;
			if (shared) {
				wtPath = shared.dir;
				sessionBranch = shared.branch || sessionBranch;
			} else {
				if (!sessionBranch.trim()) {
					sessionBranch = await branchNameFromPrompt(prompt);
					sessionBranch = await resolveUniqueBranch(sessionBranch, repo.id);
				}
				const worktrees = await listWorktrees(repo.id);
				wtPath = worktrees.find((w) => w.branch === sessionBranch)?.path || "";
				if (!wtPath) wtPath = await createWorktree(sessionBranch, repo.id);
			}
		}
		// The first code session in a joined workspace that owns no worktree yet (an
		// ask-style or ticket workspace) materializes it, so the next session joining
		// the workspace inherits THIS worktree instead of minting a second one and
		// silently splitting the tabs across two trees. Only an isolated worktree
		// is owned — never a shared main/ask checkout, which every other session in
		// the repo uses too.
		if (
			joinedWorkspace &&
			!joinedWorkspace.worktreeDir &&
			!isAsk &&
			!isScratch &&
			ownedWorktree(wtPath)
		) {
			updateWorkspace(joinedWorkspace.id, {
				worktreeDir: wtPath,
				...(sessionBranch ? { branch: sessionBranch } : {}),
			});
		}

		const bksId = newSessionId();
		const sessionCreatedBy = user || personaName();
		const sessionCreatedAt = new Date().toISOString();
		const title = prompt.trim().split("\n")[0].slice(0, 80);
		// A joined workspace is the session's workspace, which also skips the mint /
		// adopt block below — and with it the auto-naming: a session that merely
		// joins an existing workspace must never rename it.
		let resolvedWorkspaceId = joinedWorkspace?.id || parentSession?.workspaceId || null;
		// A workspace minted below from THIS session's provisional first line is
		// renamed once the generated summary lands, exactly like the web create
		// path — the sidebar rows (web and native) are titled by the workspace,
		// so without this a session started from the native apps wears its raw
		// 80-character prompt for life while its own title is a short summary.
		let autoNamedWorkspace: Workspace | null = null;
		if (!resolvedWorkspaceId) {
			// Adopt the workspace that already owns the (parent's or this child's)
			// worktree before minting a duplicate one over it. Failing that, mint —
			// every session lives in a workspace (session-workspace.ts), so a parentless
			// child, or one hanging off a workspace-less slack/linear session, gets
			// wrapped here instead of surfacing as an orphan for the read-side
			// sweep to adopt. The parent's identity seeds the name when there is
			// one: the pair is one piece of work.
			const owned =
				workspaceOwningWorktree(parentSession?.worktreeDir) ??
				workspaceOwningWorktree(wtPath);
			if (owned) resolvedWorkspaceId = owned.id;
			else {
				const branchForWs = parentSession?.branch || sessionBranch;
				// Only an isolated worktree is owned — never a shared main/ask
				// checkout, which every other session there uses too.
				const dir =
					ownedWorktree(parentSession?.worktreeDir) ?? ownedWorktree(wtPath);
				const wsName =
					parentSession?.title || parentSession?.branch || title || "Workspace";
				const ws = createWorkspace({
					name: wsName,
					...(isScratch ? {} : { repo: parentSession?.repo || repo.id }),
					createdBy: user || parentSession?.createdBy || parentSession?.startedBy || "Anonymous",
					...(branchForWs ? { branch: branchForWs } : {}),
					...(dir ? { worktreeDir: dir } : {}),
				});
				resolvedWorkspaceId = ws.id;
				// Only when the name was seeded from this session's own first line
				// (compared before createWorkspace trims it): a workspace named
				// after the parent's identity belongs to the parent's work, and
				// this child's summary must not rename it.
				if (wsName === title) autoNamedWorkspace = ws;
			}
			if (resolvedWorkspaceId && parentSession?.source === "opensession")
				touchNativeSession(parentSession.id, { workspaceId: resolvedWorkspaceId });
		}
		// Replace the raw first-line title with a short summary in the background;
		// the next sessions poll (≤5s) picks it up. A workspace minted for this
		// session is named ONCE from that same summary and keeps the name for life —
		// later sessions never rename it.
		void ensureGeneratedTitle(bksId, prompt, user, model).then((t) => {
			if (!t) return;
			invalidateSessionsCache();
			if (!autoNamedWorkspace) return;
			const cur = getWorkspace(autoNamedWorkspace.id);
			// Only while it still wears the provisional name — a manual rename in
			// the meantime wins.
			if (cur && cur.name === autoNamedWorkspace.name)
				updateWorkspace(autoNamedWorkspace.id, { name: t });
		});

		let engineSessionId = "";
		let effectiveModel = model;
		let selectedModel = model;
		let effectiveProvider = providerFor(effectiveModel);
		const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [];
		let persisted = false;
		let latestUsage: SessionUsage | undefined;
		// Terminal failure the opening run died on — recorded after the loop so
		// the fresh session surfaces as "Needs input".
		let runFailure: string | null = null;
		// The runner already wrote its own, friendlier transcript line.
		let failureNoticePersisted = false;
		// The opening turn's reply and tool count, for the shared
		// announce-then-stop guard (maybeQueueAutoContinue) below.
		let assistantText = "";
		let toolUseCount = 0;
		// Actual worktree HEAD when it drifted from the recorded branch (the
		// agent switched/renamed branches during the opening turn).
		const headBranchPatch = () => {
			const head =
				!isAsk && !isScratch && sessionBranch
					? worktreeHeadBranch(wtPath)
					: null;
			return head && head !== sessionBranch ? { branch: head } : {};
		};
		// Field-scoped write: creation fields are create-if-absent defaults (an
		// existing file — e.g. one a sandbox launch already stamped a sandboxId
		// onto — wins); this run only owns the engine-id/model/HEAD-sync fields
		// it actually changes. Serialized via updateSessionFile.
		const persist = () =>
			updateSessionFile(bksId, (data) => {
				// Widen to Partial: the file may not exist yet (create-if-absent).
				const existing: Partial<NativeSessionFile> = data;
				return {
					id: bksId,
					claudeSessionId: "",
					branch: isAsk || isScratch ? "" : sessionBranch,
					worktreeDir: wtPath,
					// Scratch sessions are repo-less (wtPath is a plain dir).
					...(isScratch ? {} : { repo: repo.id }),
					...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
					...(parentSessionId ? { parentSessionId } : {}),
					// Persisted so the failure beacon (handoff-evidence.ts) can tell
					// a worker that owes its parent a report from a child session
					// that was explicitly told not to report (e.g. the PR session).
					...(parentSessionId && reportBack ? { reportBack: true } : {}),
					// Feed-item linkage follows the session's workspace (Video tab +
					// sidebar feed-row join — the feeds design).
					...(contextWorkspace?.externalRefs?.length
						? { externalRefs: contextWorkspace.externalRefs }
						: {}),
					// A session in a support-ticket workspace is on that ticket too —
					// same rule as the web tab strip's "+".
					...(joinedWorkspace?.plainThreadId
						? { plainThreadId: joinedWorkspace.plainThreadId }
						: {}),
					// Persist the MCP scoping so follow-up prompts keep it.
					...(effectiveMcpServers?.length
						? { mcpServers: effectiveMcpServers }
						: {}),
					createdBy: sessionCreatedBy,
					createdAt: sessionCreatedAt,
					title,
					mode: (isScratch ? "scratch" : isAsk ? "ask" : "code") as
						| "ask"
						| "code"
						| "scratch",
					...(createEffort ? { effort: createEffort } : {}),
					...(createFastMode ? { fastMode: true } : {}),
					// Sandbox opt-in: the opening run below and every later prompt
					// route through maybeLaunchSandboxedRun for this provider.
					...(sandboxProvider
						? {
								sandbox: {
									provider: sandboxProvider,
									// Remote providers are always volume-style (no host mounts).
									...(remoteSandbox ? { workspace: "volume" as const } : {}),
								},
							}
						: {}),
					...existing,
					...(engineSessionId
						? engineSessionPatch(effectiveProvider, engineSessionId)
						: {}),
					...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
					...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
					...(selectedModel ? { model: selectedModel } : {}),
					...(modelHistory.length ? { modelHistory } : {}),
					...headBranchPatch(),
					lastActivity: new Date().toISOString(),
				};
			}).then(() => {
				persisted = true;
			});

		// @session:<id> mentions in a create_session prompt (e.g. a monitor
		// session spun up to watch others) get the same resolving footer as
		// prompts on existing sessions — this create path bypasses
		// runSessionPromptInner.
		const createMentionsNote = sessionMentionsNote(prompt);
		let openingPrompt = createMentionsNote
			? `${prompt}\n\n${createMentionsNote}`
			: prompt;
		// A session joining a workspace opens with the workspace's own context, the
		// same as the web create: the feed item it hangs off, and the support
		// ticket it belongs to. Without this a "new tab" in a ticket workspace is
		// an amnesiac session that has to be told what it's looking at.
		if (joinedWorkspace) {
			const { wrapContext } = await import("./prompt-context");
			if (joinedWorkspace.externalRefs?.length) {
				const { externalRefsOpeningContext } = await import("./feeds");
				const refsContext = await externalRefsOpeningContext(
					joinedWorkspace.externalRefs,
					{ scratch: isScratch, user },
				);
				if (refsContext) openingPrompt += `\n\n${wrapContext(refsContext)}`;
			}
			if (joinedWorkspace.plainThreadId) {
				const threadId = joinedWorkspace.plainThreadId;
				try {
					const { getThreadWithMessages, formatThreadContext } = await import(
						"../agents/plain/api"
					);
					const thread = await getThreadWithMessages(threadId);
					openingPrompt += `\n\n${wrapContext(
						`This session was opened from a Plain support ticket. Ticket context:\n\n${formatThreadContext(thread, true)}`,
					)}`;
				} catch (e) {
					console.error(
						`[create_session] Plain thread lookup failed for ${threadId}:`,
						e,
					);
					openingPrompt += `\n\n${wrapContext(
						`This session was opened from Plain support ticket ${threadId} (the context lookup failed — use the plain MCP tools to fetch the thread).`,
					)}`;
				}
			}
		}

		// Make the id resolvable before returning it. Callers can navigate to the
		// fresh session immediately, while engine startup continues in the background.
		await persist();

		// Run in the background; watchers (web UI) see the live stream, the same as
		// a UI-created session. The tool returns once the session file exists.
		void (async () => {
			try {
				// Sandbox session: the OPENING turn routes through the same launcher
				// the prompt path uses (persist first so the session file resolves;
				// the worktree already exists — created above — so bind mounts are
				// ready). Bind mode falls back to a host run on launch failure;
				// remote providers (always volume) have no host fallback — fail the
				// opening turn with a clear error instead.
				let sandboxOpeningRun: AsyncGenerator<StreamEvent> | null = null;
				if (sandboxProvider) {
					if (!persisted) await persist();
					const created = findSession(bksId);
					sandboxOpeningRun = created
						? await maybeLaunchSandboxedRun(created, {
								prompt: openingPrompt,
								cwd: wtPath,
								user,
								images,
								mcpServers: effectiveMcpServers ?? "all",
								isAutomationSession: false,
							})
						: null;
					if (!sandboxOpeningRun && remoteSandbox) {
						runFailure =
							"Sandbox unavailable for this remote-sandbox session — the opening prompt was not run. Check sandbox config/kill-switch and retry.";
						broadcastToSession(bksId, {
							type: "error",
							sessionId: bksId,
							message: runFailure,
						});
						recordRunOutcome(bksId, runFailure);
						broadcastToSession(bksId, { type: "stream_done", sessionId: bksId });
						broadcastToSession(bksId, {
							type: "session_status",
							sessionId: bksId,
							isRunning: false,
						});
						return;
					}
				}
				for await (const event of sandboxOpeningRun ?? runAgent({
					prompt: openingPrompt,
					cwd: wtPath,
					mode: isScratch ? ("scratch" as const) : isAsk ? ("ask" as const) : ("code" as const),
					model,
					effort: createEffort,
					fastMode: createFastMode || undefined,
					images,
					fallbackModel: interactiveFallbackModel(model),
					mcpServers: effectiveMcpServers ?? "all",
					reposNote:
						[
							buildBranchNote({
								mode: isScratch ? ("scratch" as const) : isAsk ? ("ask" as const) : ("code" as const),
								branch: sessionBranch,
								worktreeDir: wtPath,
							}),
							await memoryNoteFor(user, [repo.id]),
						]
							.filter(Boolean)
							.join("\n\n") || undefined,
					inProcessMcp: interactiveMcpServers(user, bksId),
					confirmTools: STRIPE_CONFIRM_TOOLS,
					aws: true,
					user, // gate per-user MCP servers (allowedUsers) to the creator
					journal: { osSessionId: bksId, kind: "create" },
					onAskUser: makeAskHandler(bksId),
				})) {
					if (event.type === "init") {
						engineSessionId = event.sessionId || "";
						if (event.provider) effectiveProvider = event.provider;
						if (event.model) effectiveModel = event.model;
						// A sandbox session was persisted before launch and its file has
						// since been touched with the materialized sandboxId — persist()
						// is field-scoped now, but the narrower touch stays the clearer
						// statement of what init actually changes.
						if (persisted)
							touchNativeSession(bksId, {
								...engineSessionPatch(effectiveProvider, engineSessionId),
								...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
							});
						else await persist();
						// Attach anyone already viewing this fresh session to its brand-new
						// transcript file so the first turn streams live (see
						// attachSessionWatchersToTranscript).
						if (engineSessionId) {
							attachSessionWatchersToEngineTranscript(
								bksId,
								effectiveProvider,
								wtPath,
								engineSessionId,
							);
						}
					}
					if (event.type === "model_switch") {
						const to = event.toModel || "";
						const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
						if (to) {
							effectiveModel = to;
							effectiveProvider = providerFor(to);
							if (shouldPersistModelSwitch(event)) {
								selectedModel = to;
								modelHistory.push({
									model: to,
									from: event.fromModel,
									at: new Date().toISOString(),
									by: reason,
								});
								touchNativeSession(bksId, {
									model: selectedModel,
									modelHistory,
								});
								broadcastToSession(bksId, {
									type: "model_changed",
									sessionId: bksId,
									model: to,
									from: event.fromModel,
									by: reason,
								});
							} else {
								broadcastToSession(bksId, {
									type: "notice",
									message: `${modelLabel(event.fromModel)} ${event.switchReason || "fell back"} — using ${modelLabel(to)} for this turn only.`,
								});
							}
						}
					}
					if (event.type === "text_chunk") {
						assistantText += event.text;
						broadcastToSession(bksId, {
							type: "stream_text",
							sessionId: bksId,
							text: event.text,
						});
					}
					if (event.type === "tool_use") {
						toolUseCount++;
						broadcastToSession(bksId, {
							type: "stream_tool_use",
							sessionId: bksId,
							entry: {
								id: event.toolUseId || crypto.randomUUID(),
								type: "tool_use",
								content: `Using ${event.toolName}`,
								timestamp: new Date().toISOString(),
								toolName: event.toolName,
								toolInput: event.toolInput,
								toolUseId: event.toolUseId,
							},
						});
					}
					if (event.type === "tool_result") {
						broadcastToSession(bksId, {
							type: "stream_tool_result",
							sessionId: bksId,
							entry: {
								id: event.toolUseId
									? `tr-${event.toolUseId}`
									: crypto.randomUUID(),
								type: "tool_result",
								content: event.content || "",
								timestamp: new Date().toISOString(),
								toolUseId: event.toolUseId,
								...(event.images && event.images.length > 0
									? { images: event.images }
									: {}),
								...(event.videos && event.videos.length > 0
									? { videos: event.videos }
									: {}),
							},
						});
					}
					if (event.type === "usage_snapshot" && event.usage) {
						// Live mid-run cost/context. Snapshots are run-cumulative and this
						// is the session's only run, so the fold base is empty — each
						// snapshot recomputes the total from scratch (folding onto
						// latestUsage would double-count).
						latestUsage = foldSessionUsage(
							undefined,
							event.usage,
							effectiveModel,
						);
						broadcastToSession(bksId, {
							type: "usage_update",
							sessionId: bksId,
							usage: latestUsage,
						});
					}
					if (event.type === "done") {
						engineSessionId = event.sessionId || engineSessionId;
						if (event.provider) effectiveProvider = event.provider;
						if (event.model) effectiveModel = event.model;
						if (event.usageLimitExhausted)
							runFailure =
								event.result || "Usage limit reached on every account";
						if (event.usage) {
							latestUsage = foldSessionUsage(
								undefined,
								event.usage,
								event.model || effectiveModel,
							);
							broadcastToSession(bksId, {
								type: "usage_update",
								sessionId: bksId,
								usage: latestUsage,
							});
						}
						if (event.cacheMissWarning) {
							broadcastToSession(bksId, {
								type: "cache_warning",
								sessionId: bksId,
							});
						}
					}
					if (event.type === "error") {
						runFailure = event.content || "Run failed";
						if (event.noticePersisted) failureNoticePersisted = true;
						broadcastToSession(bksId, {
							type: "error",
							message: event.content,
						});
					}
				}
				if (!persisted) await persist();
				else
					touchNativeSession(
						bksId,
						{
							...engineSessionPatch(effectiveProvider, engineSessionId),
							...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
							...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
							...(modelHistory.length ? { modelHistory } : {}),
							// Same run-end branch sync as runSessionPromptInner.
							...headBranchPatch(),
						},
					);
				if (latestUsage)
					touchNativeSession(bksId, { usage: latestUsage });
				recordRunOutcome(bksId, runFailure, {
					engineSessionId,
					noticePersisted: failureNoticePersisted,
				});
				broadcastToSession(bksId, { type: "stream_done", sessionId: bksId });
				broadcastToSession(bksId, {
					type: "session_status",
					sessionId: bksId,
					isRunning: false,
				});
				// An opening turn announce-then-stops exactly like a later one, and
				// this path bypasses runSessionPromptInner (see createMentionsNote
				// above) — so run the shared guard here too. Nothing wraps this run
				// in runSessionPromptAndDrain, so a queued nudge needs the drain
				// watcher to deliver it.
				if (
					maybeQueueAutoContinue({
						sessionId: bksId,
						assistantText,
						toolUseCount,
						endedWithError: !!runFailure,
						runFailure,
					})
				) {
					watchExternalRunAndDrain(bksId);
				}
				if (!promptQueues.get(bksId)?.length) {
					onHumanAsksSessionIdle(bksId);
				}
			} catch (e) {
				console.error(`[sessions-mcp] create session ${bksId} failed:`, e);
			}
		})();

		return { id: bksId, createdBy: sessionCreatedBy, createdAt: sessionCreatedAt };
	},
});
