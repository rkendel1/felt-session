import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { InlineAlert, LoadingState } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	SettingsSection,
	settingsInputClass,
} from "../ui/settings";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import { ReposSection } from "./SetupRepos";
import { TeamSection } from "./SetupTeam";
import {
	Code,
	CopyableCode,
	LinkChips,
	StateChip,
	repoLifecycleState,
	setupRequest,
	type ChipTone,
	type SetupEngine,
	type SetupGithub,
	type SetupIntegration,
	type SetupStatus,
} from "./setup-shared";

// Settings → Setup: per-integration onboarding state with real configuration
// forms. On a fresh install nothing else in the UI says how to wire up Linear,
// Plain, Slack, Stripe, Grafana or GitHub — this page turns the integration
// registry (GET /api/setup/status) into a checklist plus a form per
// integration: paste the credentials, flip the enable switch, Save, and
// restart from the banner. Repos and the team roster are managed here too.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function integrationState(i: SetupIntegration): { tone: ChipTone; label: string } {
	if (i.enabled && i.missingRequired.length === 0) return { tone: "on", label: "On" };
	if (i.enabled) return { tone: "warn", label: "Enabled — missing credentials" };
	return { tone: "off", label: "Off" };
}

function githubAuthState(g: SetupGithub): { tone: ChipTone; label: string } {
	if (g.userPrAuth && g.clientIdConfigured)
		return {
			tone: "on",
			label: g.redirectFlowAvailable ? "Active" : "Active — device flow only",
		};
	if (g.userPrAuth) return { tone: "warn", label: "Missing client id" };
	return { tone: "off", label: "Off" };
}

/** One row of the Getting-started checklist: title, one-liner, state chip. */
function ChecklistRow({
	title,
	description,
	tone,
	label,
	action,
}: {
	title: React.ReactNode;
	description: React.ReactNode;
	tone: ChipTone;
	label: string;
	/** Optional inline fix — only for problems this page can actually solve. */
	action?: React.ReactNode;
}) {
	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>{title}</SettingRowTitle>
				<SettingRowDescription>{description}</SettingRowDescription>
			</SettingRowText>
			{action}
			<StateChip tone={tone} label={label} />
		</SettingRow>
	);
}

/** Getting-started row for model capacity. Everything else on this page is
 *  optional; without this, no session runs a single turn. */
function EngineRow({
	engine,
	onChanged,
}: {
	engine: SetupEngine;
	onChanged: () => void | Promise<void>;
}) {
	const [enabling, setEnabling] = useState(false);

	async function enable() {
		setEnabling(true);
		try {
			await setupRequest("/api/settings/opencode-engine", {
				method: "PUT",
				json: { enabled: true },
			});
			await onChanged();
			toast("Engine enabled");
		} catch (e: any) {
			toast(e?.message || "Couldn't enable the engine");
		} finally {
			setEnabling(false);
		}
	}

	const pool =
		engine.claudeAccounts + engine.codexAccounts === 0
			? "no accounts"
			: [
					engine.claudeAccounts && `${engine.claudeAccounts} Claude`,
					engine.codexAccounts && `${engine.codexAccounts} ChatGPT`,
				]
					.filter(Boolean)
					.join(", ");

	return (
		<ChecklistRow
			title="Engine"
			description={
				engine.ready
					? `Ready to run turns on ${engine.defaultModel} (${pool}).`
					: `${engine.blocker} ${engine.fix}`
			}
			tone={engine.ready ? "on" : "warn"}
			label={engine.ready ? "Ready" : "Can't run turns"}
			action={
				!engine.ready && engine.fixableInApp ? (
					<Button size="sm" onClick={enable} disabled={enabling}>
						{enabling ? "Enabling…" : "Enable"}
					</Button>
				) : undefined
			}
		/>
	);
}

/** One env var of an integration: name + badges + description over a
 * password input. The input never echoes a stored value — "set" is the badge
 * and the placeholder; an empty input means "keep what's there", and the
 * Clear affordance is the only way to unset. */
function EnvVarField({
	envVar,
	value,
	cleared,
	onChange,
	onToggleClear,
}: {
	envVar: SetupIntegration["env"][number];
	value: string;
	cleared: boolean;
	onChange: (value: string) => void;
	onToggleClear: () => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<Code>{envVar.name}</Code>
				{envVar.required && (
					<span className="text-meta font-medium text-yellow">required</span>
				)}
				{envVar.present && !cleared && <span className="text-meta text-green">set</span>}
				{cleared && <span className="text-meta font-medium text-red">cleared on save</span>}
				<span className="min-w-0 flex-1 text-meta text-faint">{envVar.description}</span>
				{envVar.present && (
					<button
						type="button"
						className="focus-ring shrink-0 rounded-sm text-meta font-medium text-faint underline underline-offset-2 transition-colors hover:text-fg"
						onClick={onToggleClear}
					>
						{cleared ? "Keep" : "Clear"}
					</button>
				)}
			</div>
			<input
				type="password"
				className={cn(settingsInputClass, "font-mono")}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={
					cleared ? "will be unset" : envVar.present ? "••• set" : "not set"
				}
				aria-label={envVar.name}
				autoComplete="new-password"
				autoCapitalize="none"
				spellCheck={false}
			/>
		</div>
	);
}

function IntegrationCard({
	integration,
	onSaved,
}: {
	integration: SetupIntegration;
	onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
}) {
	const state = integrationState(integration);
	const configured = state.tone === "on";
	const [enabled, setEnabled] = useState(integration.enabled);
	const [typed, setTyped] = useState<Record<string, string>>({});
	const [cleared, setCleared] = useState<Record<string, boolean>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Track the server truth when a refetch lands (post-restart, other tab).
	useEffect(() => {
		setEnabled(integration.enabled);
	}, [integration.enabled]);

	const typedKeys = integration.env
		.map((e) => e.name)
		.filter((name) => (typed[name] ?? "").trim() !== "");
	const clearedKeys = integration.env
		.filter((e) => e.present && cleared[e.name] && !(typed[e.name] ?? "").trim())
		.map((e) => e.name);
	const dirty =
		enabled !== integration.enabled || typedKeys.length > 0 || clearedKeys.length > 0;

	async function handleSave() {
		if (!dirty || saving) return;
		setSaving(true);
		setError(null);
		try {
			const env: Record<string, string> = {};
			// Only the keys the user touched ride: typed values (whitespace
			// stripped — pasted keys often carry newlines) and explicit clears.
			for (const name of typedKeys) env[name] = (typed[name] ?? "").replace(/\s+/g, "");
			for (const name of clearedKeys) env[name] = "";
			const body = await setupRequest<{
				integration: SetupIntegration;
				restartRequired: boolean;
			}>(`/api/setup/integrations/${encodeURIComponent(integration.id)}`, {
				method: "PUT",
				json: {
					...(enabled !== integration.enabled ? { enabled } : {}),
					...(Object.keys(env).length > 0 ? { env } : {}),
				},
			});
			setTyped({});
			setCleared({});
			toast(`${integration.label} saved`);
			onSaved(body.integration, body.restartRequired !== false);
		} catch (e: any) {
			setError(e.message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<SettingsSection className="mb-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<div className="min-w-0 flex-1 text-item-title font-medium text-fg">
					{integration.label}
				</div>
				<StateChip tone={state.tone} label={state.label} />
				<Switch
					checked={enabled}
					onCheckedChange={setEnabled}
					disabled={saving}
					aria-label={`Enable ${integration.label}`}
				/>
			</div>
			{integration.missingRequired.length > 0 && (
				<div className="mt-1 text-supporting text-dim">
					Missing:{" "}
					{integration.missingRequired.map((name, i) => (
						<React.Fragment key={name}>
							{i > 0 && ", "}
							<Code>{name}</Code>
						</React.Fragment>
					))}
				</div>
			)}
			<div className="mt-1 text-supporting leading-relaxed text-dim">
				{configured ? (
					<>
						Connected and running. Full guide: <Code>{integration.doc}</Code> in the
						checkout.
					</>
				) : (
					<>
						Get the {integration.label} credentials — <Code>{integration.doc}</Code>{" "}
						in the checkout is the full walkthrough — paste them below, flip the
						switch on, and Save.
					</>
				)}
			</div>
			{!configured && <LinkChips links={integration.links ?? []} />}
			<div className="mt-3 flex flex-col gap-2.5">
				{integration.env.map((e) => (
					<EnvVarField
						key={e.name}
						envVar={e}
						value={typed[e.name] ?? ""}
						cleared={Boolean(
							e.present && cleared[e.name] && !(typed[e.name] ?? "").trim(),
						)}
						onChange={(v) => {
							setTyped((prev) => ({ ...prev, [e.name]: v }));
							if (v.trim() && cleared[e.name])
								setCleared((prev) => ({ ...prev, [e.name]: false }));
						}}
						onToggleClear={() => {
							setCleared((prev) => ({ ...prev, [e.name]: !prev[e.name] }));
							setTyped((prev) => ({ ...prev, [e.name]: "" }));
						}}
					/>
				))}
			</div>
			{error && <InlineAlert className="mt-3">{error}</InlineAlert>}
			<div className="mt-3 flex items-center justify-end gap-3">
				{dirty && !saving && (
					<span className="text-meta text-faint">Applies after a restart</span>
				)}
				<Button variant="primary" size="sm" disabled={!dirty || saving} onClick={handleSave}>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>
		</SettingsSection>
	);
}

function GithubAuthCard({
	github,
	onSaved,
}: {
	github: SetupGithub;
	onSaved: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
	const state = githubAuthState(github);
	const active = github.userPrAuth && github.clientIdConfigured;
	// The secret is never echoed; the status exposes presence only.
	const secretConfigured = github.clientSecretConfigured;
	const [userPrAuth, setUserPrAuth] = useState(github.userPrAuth);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [clearId, setClearId] = useState(false);
	const [clearSecret, setClearSecret] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setUserPrAuth(github.userPrAuth);
	}, [github.userPrAuth]);

	const idCleared = github.clientIdConfigured && clearId && !clientId.trim();
	const secretCleared = secretConfigured && clearSecret && !clientSecret.trim();
	const dirty =
		userPrAuth !== github.userPrAuth ||
		clientId.trim() !== "" ||
		clientSecret.trim() !== "" ||
		idCleared ||
		secretCleared;

	async function handleSave() {
		if (!dirty || saving) return;
		setSaving(true);
		setError(null);
		try {
			const body = await setupRequest<{
				github: SetupGithub;
				restartRequired: boolean;
			}>("/api/setup/github", {
				method: "PUT",
				json: {
					...(userPrAuth !== github.userPrAuth ? { userPrAuth } : {}),
					...(clientId.trim()
						? { oauthClientId: clientId.trim() }
						: idCleared
							? { oauthClientId: "" }
							: {}),
					...(clientSecret.trim()
						? { oauthClientSecret: clientSecret.replace(/\s+/g, "") }
						: secretCleared
							? { oauthClientSecret: "" }
							: {}),
				},
			});
			setClientId("");
			setClientSecret("");
			setClearId(false);
			setClearSecret(false);
			toast("GitHub sign-in settings saved");
			onSaved(body.github, body.restartRequired === true);
		} catch (e: any) {
			setError(e.message);
		} finally {
			setSaving(false);
		}
	}

	const fieldLabelClass = "flex min-w-0 flex-col gap-1.5 text-label font-medium text-dim";
	const clearButtonClass =
		"focus-ring self-start rounded-sm text-meta font-medium text-faint underline underline-offset-2 transition-colors hover:text-fg";

	return (
		<SettingsSection>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<div className="min-w-0 flex-1 text-item-title font-medium text-fg">
					GitHub sign-in &amp; PRs as yourself
				</div>
				<StateChip tone={state.tone} label={state.label} />
				<Switch
					checked={userPrAuth}
					onCheckedChange={setUserPrAuth}
					disabled={saving}
					aria-label="Enable GitHub sign-in"
				/>
			</div>
			<div className="mt-1 text-supporting leading-relaxed text-dim">
				Opting in replaces the name picker with a real GitHub sign-in, and
				interactive sessions of a connected teammate open PRs as their own
				account instead of the bot.
			</div>
			{active && (
				<div className="mt-2 text-supporting leading-relaxed text-dim">
					{github.redirectFlowAvailable
						? "Browser redirect sign-in and device codes both work."
						: "Device-code sign-in only — add the client secret below to enable the browser redirect flow."}{" "}
					Teammates connect their accounts under Workspace → Connections. Full
					guide: <Code>docs/setup/github.md</Code>.
				</div>
			)}
			{!github.clientIdConfigured && (
				<div className="mt-3">
					<ol className="m-0 flex list-none flex-col gap-2.5 p-0">
						<RecipeStep n={1}>
							Create an org-owned GitHub App —{" "}
							<a
								href={github.appCreateUrl}
								target="_blank"
								rel="noreferrer"
								className="text-fg underline decoration-line underline-offset-2 transition-colors hover:decoration-fg"
							>
								open the New GitHub App form ↗
							</a>
							. Full guide: <Code>docs/setup/github.md</Code> in the checkout.
						</RecipeStep>
						<RecipeStep n={2}>On the app, check “Enable Device Flow”.</RecipeStep>
						<RecipeStep n={3}>
							Set the app&rsquo;s callback URL to exactly:
							<span className="mt-1.5 block">
								<CopyableCode value={github.callbackUrl} />
							</span>
						</RecipeStep>
						<RecipeStep n={4}>
							Install the app on your org → All repositories (and make it
							installable only on that account).
						</RecipeStep>
						<RecipeStep n={5}>
							Paste the app&rsquo;s client id below (and its client secret for the
							browser redirect flow), flip the switch on, and Save.
						</RecipeStep>
					</ol>
				</div>
			)}
			<div className="mt-3 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<label className={fieldLabelClass}>
					<span className="flex items-baseline justify-between gap-2">
						Client id
						{github.clientIdConfigured && (
							<button
								type="button"
								className={clearButtonClass}
								onClick={() => {
									setClearId((c) => !c);
									setClientId("");
								}}
							>
								{idCleared ? "Keep" : "Clear"}
							</button>
						)}
					</span>
					<input
						className={cn(settingsInputClass, "font-mono")}
						value={clientId}
						onChange={(e) => {
							setClientId(e.target.value);
							if (e.target.value.trim()) setClearId(false);
						}}
						placeholder={
							idCleared
								? "will be unset"
								: github.clientIdConfigured
									? "set — leave blank to keep"
									: "Iv23li…"
						}
						autoCapitalize="none"
						spellCheck={false}
					/>
				</label>
				<label className={fieldLabelClass}>
					<span className="flex items-baseline justify-between gap-2">
						Client secret
						{secretConfigured && (
							<button
								type="button"
								className={clearButtonClass}
								onClick={() => {
									setClearSecret((c) => !c);
									setClientSecret("");
								}}
							>
								{secretCleared ? "Keep" : "Clear"}
							</button>
						)}
					</span>
					<input
						type="password"
						className={cn(settingsInputClass, "font-mono")}
						value={clientSecret}
						onChange={(e) => {
							setClientSecret(e.target.value);
							if (e.target.value.trim()) setClearSecret(false);
						}}
						placeholder={
							secretCleared
								? "will be unset"
								: secretConfigured
									? "••• set"
									: "optional — enables browser redirect"
						}
						autoComplete="new-password"
						autoCapitalize="none"
						spellCheck={false}
					/>
				</label>
			</div>
			{error && <InlineAlert className="mt-3">{error}</InlineAlert>}
			<div className="mt-3 flex items-center justify-end gap-3">
				{dirty && !saving && (
					<span className="text-meta text-faint">Applies after a restart</span>
				)}
				<Button variant="primary" size="sm" disabled={!dirty || saving} onClick={handleSave}>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>
		</SettingsSection>
	);
}

function RecipeStep({ n, children }: { n: number; children: React.ReactNode }) {
	return (
		<li className="flex items-start gap-2.5 text-supporting leading-relaxed text-dim">
			<span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface text-[10px] font-semibold tabular-nums text-faint">
				{n}
			</span>
			<span className="min-w-0 flex-1">{children}</span>
		</li>
	);
}

type RestartState = "idle" | "working" | "failed";

export function SetupPanel() {
	const [status, setStatus] = useState<SetupStatus | null>(null);
	const [failed, setFailed] = useState(false);
	const [restartNeeded, setRestartNeeded] = useState(false);
	const [restartState, setRestartState] = useState<RestartState>("idle");
	const statusRef = useRef<SetupStatus | null>(null);
	statusRef.current = status;

	const refetch = useCallback(async () => {
		try {
			const body = await setupRequest<SetupStatus>("/api/setup/status");
			setStatus(body);
			setFailed(false);
		} catch {
			if (!statusRef.current) setFailed(true);
		}
	}, []);

	useEffect(() => {
		document.title = docTitle("Setup");
		refetch();
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, [refetch]);

	function handleIntegrationSaved(updated: SetupIntegration, restartRequired: boolean) {
		setStatus((s) =>
			s
				? {
						...s,
						integrations: s.integrations.map((i) =>
							i.id === updated.id ? updated : i,
						),
					}
				: s,
		);
		if (restartRequired) setRestartNeeded(true);
	}

	function handleGithubSaved(updated: SetupGithub, restartRequired: boolean) {
		setStatus((s) => (s ? { ...s, github: updated } : s));
		if (restartRequired) setRestartNeeded(true);
	}

	/** POST the restart, then poll /api/health (1s cadence, 30s budget) until
	 * the server is back; on success refetch status and drop the banner. Pass
	 * `post: false` to only poll — the "Check again" path after a timeout. */
	async function restartServer(post = true) {
		setRestartState("working");
		if (post) {
			try {
				const res = await fetch(`${BASE_PATH}/api/setup/restart`, {
					method: "POST",
				});
				// 409 = nothing would revive this process, so it refused. Say so
				// rather than polling a server that was never going to go down.
				if (res.status === 409) {
					const body = await res.json().catch(() => null);
					setRestartState("idle");
					toast(body?.error || "This server can't restart itself.");
					return;
				}
			} catch {
				// The connection can drop as the server goes down — that's fine,
				// the health poll below is the real signal.
			}
		}
		const deadline = Date.now() + 30_000;
		await sleep(1000);
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${BASE_PATH}/api/health`, { cache: "no-store" });
				if (res.ok) {
					await refetch();
					setRestartNeeded(false);
					setRestartState("idle");
					toast("Server restarted — changes applied");
					return;
				}
			} catch {}
			await sleep(1000);
		}
		setRestartState("failed");
	}

	const githubState = status ? githubAuthState(status.github) : null;

	return (
		<SettingsPanel className="relative">
			<SettingsHeader
				title="Setup"
				description="What's wired up on this instance — connect and configure the rest right here."
			/>
			{!status ? (
				<LoadingState>{failed ? "Couldn't load setup status." : "Loading…"}</LoadingState>
			) : (
				<>
					<SettingsGroupLabel className="mt-0">Getting started</SettingsGroupLabel>
					<SettingCard>
						<EngineRow engine={status.engine} onChanged={refetch} />
						<ChecklistRow
							title="Repositories"
							description={
								status.repos.length > 0
									? status.repos.map((r) => r.label).join(", ")
									: "Register the repos sessions work in — add one under Repositories below."
							}
							tone={status.repos.length > 0 ? "on" : "warn"}
							label={
								status.repos.length > 0
									? `${status.repos.length} registered`
									: "None registered"
							}
						/>
						{status.repos.length > 0 &&
							(() => {
								const bootable = status.repos.filter(
									(r) => repoLifecycleState(r).tone === "on",
								);
								const missing = status.repos.filter(
									(r) => repoLifecycleState(r).tone !== "on",
								);
								const named = missing
									.slice(0, 3)
									.map((r) => r.label)
									.join(", ");
								const rest = missing.length - 3;
								return (
									<ChecklistRow
										title="Local dev setup"
										description={
											missing.length === 0
												? "Every repo commits lifecycle scripts — sessions provision themselves, previews boot, and agents can check their own UI changes in a browser."
												: `No boot script in ${named}${rest > 0 ? ` and ${rest} more` : ""} — the Preview button stays disabled there. Add .opensession/start.sh to the repo (docs/repo-lifecycle.md).`
										}
										tone={
											bootable.length === status.repos.length
												? "on"
												: bootable.length > 0
													? "warn"
													: "off"
										}
										label={`${bootable.length}/${status.repos.length} bootable`}
									/>
								);
							})()}
						<ChecklistRow
							title="Team roster"
							description={
								status.team.count > 0
									? status.team.names.join(", ")
									: "Add teammates under Team below so commits and sessions attribute to real people."
							}
							tone={status.team.count > 0 ? "on" : "warn"}
							label={
								status.team.count > 0
									? `${status.team.count} ${status.team.count === 1 ? "member" : "members"}`
									: "Empty"
							}
						/>
						{githubState && (
							<ChecklistRow
								title="GitHub sign-in"
								description={
									status.github.userPrAuth && status.github.clientIdConfigured
										? "Teammates sign in with GitHub and open PRs as themselves."
										: "Off — the UI uses the name picker and PRs come from the bot account."
								}
								tone={githubState.tone}
								label={githubState.label}
							/>
						)}
						{status.integrations.map((i) => {
							const s = integrationState(i);
							return (
								<ChecklistRow
									key={i.id}
									title={i.label}
									description={
										s.tone === "on"
											? "Connected and running."
											: s.tone === "warn"
												? `Enabled, but missing ${i.missingRequired.join(", ")}.`
												: "Not enabled — see the card below to connect it."
									}
									tone={s.tone}
									label={s.label}
								/>
							);
						})}
					</SettingCard>

					<ReposSection repos={status.repos} onChanged={refetch} />

					<TeamSection onChanged={refetch} />

					<SettingsGroupLabel>Integrations</SettingsGroupLabel>
					{status.integrations.map((i) => (
						<IntegrationCard
							key={i.id}
							integration={i}
							onSaved={handleIntegrationSaved}
						/>
					))}
					<SettingsHint>
						Values save into the server&rsquo;s env (<Code>~/.opensession.env</Code>)
						and are never shown back — a <Code>set</Code> badge is all the UI keeps.
						Saved changes apply on the next restart; the banner below handles it.
					</SettingsHint>

					<SettingsGroupLabel>GitHub sign-in</SettingsGroupLabel>
					<GithubAuthCard github={status.github} onSaved={handleGithubSaved} />

					{restartNeeded && restartState !== "working" && (
						<div className="sticky bottom-3 z-20 mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-panel px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.18),0_1px_3px_rgba(0,0,0,0.08)]">
							<div className="min-w-0 flex-1">
								<div className="text-control-label font-medium text-fg">
									Changes saved — restart to apply
								</div>
								<div className="mt-0.5 text-supporting text-dim">
									{restartState === "failed" ? (
										<>
											Still not back — check <Code>opensession logs</Code>.
										</>
									) : (
										"The server reads credentials and enable flags on boot. Restarts take a few seconds; running engine turns keep going."
									)}
								</div>
							</div>
							{restartState === "failed" ? (
								<Button onClick={() => restartServer(false)}>Check again</Button>
							) : (
								<Button variant="primary" onClick={() => restartServer()}>
									Restart server
								</Button>
							)}
						</div>
					)}
				</>
			)}
			{restartState === "working" && (
				<div className="absolute inset-0 z-30 rounded-lg bg-bg/75 backdrop-blur-[2px]">
					<div className="sticky top-[30vh] pb-8">
						<LoadingState>Restarting…</LoadingState>
					</div>
				</div>
			)}
		</SettingsPanel>
	);
}
