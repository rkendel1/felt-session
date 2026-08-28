import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingsHint } from "../ui/settings";
import { duration } from "../ui/motion";
import { InlineAlert } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import { IconTile } from "./BrandTile";
import { IconCheckCircleFilled, IconQuestionCircle } from "./icons";
import githubCreateAppGuide from "../assets/github-create-app.svg";
import {
	githubAppCreateOwner,
	githubAppInstallUrlForSlug,
	githubAppSettingsUrlForSlug,
	githubAppSetupOwner,
	githubManifestAction,
	type GithubAppOwnerType,
} from "../lib/github-app-setup";
import {
	StateChip,
	setupRequest,
	type ChipTone,
	type SetupGithub,
} from "./setup-shared";

type GuidedStage = "create" | "device" | "install" | "done";

function GithubSetupStep({
	label,
	guide,
	caption,
	complete = false,
	href,
	disabled,
	onClick,
}: {
	label: string;
	guide: string;
	caption: ReactNode;
	complete?: boolean;
	href?: string | null;
	disabled?: boolean;
	onClick?: () => void;
}) {
	const actionDisabled = disabled || (!href && !onClick);

	return (
		<div className="group relative min-h-11">
			<Button
				size="lg"
				className={cn(
					"absolute inset-0 min-h-11 w-full",
					complete && "disabled:opacity-100",
				)}
				disabled={actionDisabled}
				onClick={onClick}
				{...(href
					? { render: <a href={href} target="_blank" rel="noreferrer" /> }
					: {})}
			>
				<span className="sr-only">{label}</span>
			</Button>
			<div className="pointer-events-none relative z-10 flex min-h-11 items-center px-3.5 text-base font-medium text-dim">
				<span
					aria-hidden="true"
					className={cn(
						"flex items-center gap-2 transition-colors duration-[var(--dur-micro)] group-hover:text-fg",
						actionDisabled && !complete && "opacity-40 group-hover:text-dim",
					)}
				>
					<IconCheckCircleFilled
						size={20}
						className={complete ? "text-green" : "text-faint"}
					/>
					<span className="[text-box:trim-both_cap_alphabetic]">{label}</span>
				</span>
				<Tooltip
					side="top"
					align="center"
					offset={6}
					multiline
					popupClassName="max-w-[424px]! p-2!"
					label={
						<span className="block w-[400px] max-w-[calc(100vw-32px)] whitespace-normal">
							<img
								src={guide}
								alt=""
								className="block h-auto w-full rounded-md border border-[var(--tooltip-ring)]"
							/>
							<span className="block px-1 pt-2 pb-1 text-left text-supporting leading-snug font-normal text-tooltip-fg/75">
								{caption}
							</span>
						</span>
					}
				>
					<button
						type="button"
						aria-label={`Show help for ${label.toLowerCase()}`}
						className="focus-ring pointer-events-auto ml-auto flex size-6 items-center justify-center rounded-control text-faint transition-colors duration-[var(--dur-micro)] hover:text-fg phone:size-8"
					>
						<IconQuestionCircle size={18} />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}

export function GithubManifestSetup({
	github,
	returnTo,
	connectionStatus,
	onContentSizeChange,
	onComplete,
}: {
	github: SetupGithub;
	returnTo: "welcome" | "settings";
	connectionStatus?: { tone: ChipTone; label: string };
	onContentSizeChange?: () => void;
	onComplete?: () => void;
}) {
	const initialOwner = githubAppCreateOwner(github.appCreateUrl);
	const [owner, setOwner] = useState<GithubAppOwnerType>(
		githubAppSetupOwner(github),
	);
	// Keep the owner-specific form in place while the segmented knob travels.
	// Once the click has visibly settled, the form can change the modal height
	// without competing with that direct feedback.
	const [formOwner, setFormOwner] = useState(owner);
	const reducedMotion = useReducedMotion();
	const [ownerDrafts, setOwnerDrafts] = useState<Record<GithubAppOwnerType, string>>({
		personal: initialOwner.type === "personal" ? github.installationOwner ?? "" : "",
		organization:
			github.appOrg ??
			(initialOwner.type === "organization"
				? github.installationOwner ?? initialOwner.login
				: ""),
	});
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const storageKey = `opensession:github-guide:${github.appSlug ?? "new"}`;
	const [stage, setStage] = useState<GuidedStage>(() => {
		if (!github.clientIdConfigured) return "create";
		if (typeof window === "undefined") return "device";
		const saved = window.sessionStorage.getItem(storageKey);
		return saved === "install" || saved === "done" ? saved : "device";
	});
	const installationOwner = ownerDrafts[owner];
	const formInstallationOwner = ownerDrafts[formOwner];
	const ownerSwitching = owner !== formOwner;
	const ownerReady = owner === "personal" || Boolean(installationOwner.trim());

	useEffect(() => {
		if (!ownerSwitching) return;
		const reveal = window.setTimeout(() => {
			onContentSizeChange?.();
			setFormOwner(owner);
		}, (reducedMotion ? 0 : duration.base) * 1000);
		return () => window.clearTimeout(reveal);
	}, [owner, ownerSwitching, reducedMotion, onContentSizeChange]);
	const settingsUrl = githubAppSettingsUrlForSlug(
		github.appSlug,
		github.appOrg,
	);
	const installUrl = githubAppInstallUrlForSlug(github.appSlug ?? "");
	const result =
		typeof window === "undefined"
			? null
			: new URLSearchParams(window.location.search).get("github_manifest");

	useEffect(() => {
		if (stage === "done") onComplete?.();
	}, [stage, onComplete]);

	function advance(next: GuidedStage) {
		setStage(next);
		if (github.appSlug) window.sessionStorage.setItem(storageKey, next);
		onContentSizeChange?.();
	}

	async function createApp() {
		if (starting || !ownerReady) return;
		setStarting(true);
		setError(null);
		try {
			const body = await setupRequest<{
				action: string;
				manifest: string;
				launchUrl: string;
			}>(
				"/api/setup/github/manifest",
				{
					method: "POST",
					json: {
						owner,
						returnTo,
						desktop: window.os1?.desktop === true,
						...(owner === "organization"
							? { organization: installationOwner.trim() }
							: {}),
					},
				},
			);
			const action = githubManifestAction(body.action);
			if (!action) {
				setError("GitHub returned an invalid App registration address");
				setStarting(false);
				return;
			}
			if (returnTo === "welcome") {
				window.sessionStorage.setItem("opensession:first-mile-step", "github");
			}
			const external = window.os1?.external as
				| { open?: (url: string) => Promise<boolean> }
				| undefined;
			if (external?.open) {
				const opened = await external.open(body.launchUrl);
				if (!opened) {
					setError("Could not open GitHub in your browser");
					setStarting(false);
				}
				return;
			}
			const launchWindow = window.open(body.launchUrl, "_blank", "noopener,noreferrer");
			if (!launchWindow) {
				setError("Allow pop-ups to continue in GitHub");
				setStarting(false);
			}
			return;
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not start GitHub App setup",
			);
			setStarting(false);
		}
	}

	return (
		<>
			{connectionStatus ? (
				<>
					<div className="flex items-center justify-center gap-2 pb-5">
						<IconTile name="github" size={48} />
						<span aria-hidden="true" className="flex gap-1">
							<span className="size-1 bg-line-strong" />
							<span className="size-1 bg-line-strong" />
							<span className="size-1 bg-line-strong" />
							<span className="size-1 bg-line-strong" />
						</span>
						<img
							src={`${BASE_PATH}/mac-app-icon.png`}
							alt=""
							className="size-12 shrink-0"
						/>
					</div>
					<div className="flex items-center justify-between gap-4 phone:items-start">
						<div className="min-w-0 text-dialog-title font-semibold text-fg">
							Connect GitHub
						</div>
						<StateChip
							tone={stage === "done" ? connectionStatus.tone : "warn"}
							label={
								stage === "done"
									? connectionStatus.label
									: stage === "create"
										? "Setup required"
										: "Finish setup"
							}
						/>
					</div>
				</>
			) : (
				<div className="text-dialog-title font-semibold text-fg">
					Connect GitHub
				</div>
			)}
			<p className="m-0 text-supporting leading-relaxed text-dim">
				Open Session will create a private GitHub App owned by you. Its
				credentials stay on this Mac.
			</p>
			<ol
				className="m-0 grid list-none grid-cols-3 gap-2 p-0"
				aria-label="GitHub setup progress"
			>
				{(["Create", "Device Flow", "Repositories"] as const).map(
					(label, index) => {
						const current =
							stage === "create"
								? 0
								: stage === "device"
									? 1
									: stage === "install"
										? 2
										: 3;
						return (
							<li
								key={label}
								className={cn(
									"flex min-w-0 items-center gap-2 rounded-control bg-button px-3 py-2 text-meta text-faint phone:min-h-11 phone:px-2",
									index === current && "text-fg",
									index < current && "text-dim",
								)}
								aria-current={index === current ? "step" : undefined}
							>
								<IconCheckCircleFilled
									size={18}
									className={index < current ? "text-green" : "text-faint"}
								/>
								<span className="truncate">{label}</span>
							</li>
						);
					},
				)}
			</ol>
			{stage === "create" && (
				<div
					className={cn(
						"flex flex-col rounded-xl bg-panel p-5 phone:p-4",
						formOwner === "organization" ? "gap-5" : "gap-2",
					)}
				>
				<div className="mb-2">
					<div className="text-body font-semibold text-fg">1. Choose the App owner</div>
					<p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
						GitHub shows the permissions before creation. Open Session fills in
						the configuration and saves the credentials automatically.
					</p>
				</div>
				<Segmented
					label="GitHub App owner"
					value={owner}
					onValueChange={(value) => setOwner(value as GithubAppOwnerType)}
					className="w-full"
				>
					<SegmentedOption
						value="personal"
						className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
					>
						Personal account
					</SegmentedOption>
					<SegmentedOption
						value="organization"
						className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
					>
						Organization
					</SegmentedOption>
				</Segmented>
				{formOwner === "organization" && (
					<label className="flex flex-col gap-1">
						<span className="text-label font-medium text-dim">Organization ID</span>
						<Input
							value={formInstallationOwner}
							onChange={(event) =>
								setOwnerDrafts((current) => ({
									...current,
									organization: event.target.value,
								}))
							}
							placeholder="my-organization"
							className="phone:min-h-11 phone:text-input-phone"
							disabled={starting}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
				)}
				<GithubSetupStep
					label={starting ? "Opening GitHub…" : "Create App in GitHub"}
					guide={githubCreateAppGuide}
					caption="Review the suggested settings, then create the App. GitHub returns you here automatically."
					disabled={!ownerReady || ownerSwitching || starting}
					onClick={() => void createApp()}
				/>
				</div>
			)}
			{stage === "device" && (
				<div className="flex flex-col gap-3 rounded-xl bg-panel p-5 phone:p-4">
				<div className="text-body font-semibold text-fg">2. Enable Device Flow</div>
				<p className="m-0 text-supporting leading-relaxed text-dim">
					In GitHub, turn on Enable Device Flow and save the change. This lets
					people sign in without sharing passwords or tokens.
				</p>
				<Button
					variant="primary"
					size="lg"
					className="w-full phone:min-h-11"
					disabled={!settingsUrl}
					{...(settingsUrl
						? { render: <a href={settingsUrl} target="_blank" rel="noreferrer" /> }
						: {})}
				>
					Open GitHub settings
				</Button>
				<Button size="lg" onClick={() => advance("install")} className="w-full phone:min-h-11">Device Flow is enabled</Button>
				</div>
			)}
			{stage === "install" && (
				<div className="flex flex-col gap-3 rounded-xl bg-panel p-5 phone:p-4">
				<div className="text-body font-semibold text-fg">3. Choose repositories</div>
				<p className="m-0 text-supporting leading-relaxed text-dim">
					Install your App and choose which repositories Open Session may access.
					You can change this selection later in GitHub.
				</p>
				<Button
					variant="primary"
					size="lg"
					className="w-full phone:min-h-11"
					disabled={!installUrl}
					{...(installUrl
						? { render: <a href={installUrl} target="_blank" rel="noreferrer" /> }
						: {})}
				>
					Choose repositories in GitHub
				</Button>
				<Button size="lg" onClick={() => advance("done")} className="w-full phone:min-h-11">I installed the App</Button>
				</div>
			)}
			{stage === "done" && (
				<div className="flex items-start gap-3 rounded-xl bg-panel p-5 phone:p-4" role="status">
				<IconCheckCircleFilled size={22} className="mt-0.5 shrink-0 text-green" />
				<div>
					<div className="text-body font-semibold text-fg">GitHub App installed</div>
					<p className="m-0 mt-1 text-supporting leading-relaxed text-dim">Open Session can now connect to the repositories you selected.</p>
				</div>
				</div>
			)}
			{result === "created" && (
				<SettingsHint className="m-0">
					GitHub created the App and returned its credentials to this Mac.
				</SettingsHint>
			)}
			{result === "error" && (
				<InlineAlert>GitHub App setup could not be completed. Try again.</InlineAlert>
			)}
			{error && <InlineAlert>{error}</InlineAlert>}
		</>
	);
}
