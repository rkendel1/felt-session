import { mergeStylexOverrideClassName, mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import githubDeviceFlowGuide from "../assets/github-enable-device-flow.svg";
import githubInstallAppGuide from "../assets/github-install-app.svg";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	pb5: {
			paddingBottom: "calc(4px * 5)"
	},
	w8: {
			width: "calc(4px * 8)"
	},
	borderTDashed: {
			borderTopWidth: "1px",
			borderTopStyle: "dashed",
			borderTopColor: "var(--border-strong)"
	},
	size12: {
			width: "calc(4px * 12)",
			height: "calc(4px * 12)"
	},
	size1: {
			width: "4px",
			height: "4px"
	},
	bgLineStrong: {
			backgroundColor: "var(--border-strong)"
	},
	gap5: {
			gap: "calc(4px * 5)"
	},
	textTooltipFg: {
			color: "var(--tooltip-fg)"
	},
	borderTooltipRing: {
			borderStyle: "solid",
			borderWidth: "1px",
			borderColor: "var(--tooltip-ring)"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap4: {
			gap: "calc(4px * 4)"
	},
	minW0: {
			minWidth: "0"
	},
	mt6: {
			marginTop: "calc(4px * 6)"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	pt1: {
			paddingTop: "4px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap2: {
			gap: "calc(4px * 2)"
	},
	wFull: {
			width: "100%"
	},
	flex1: {
			flex: "1"
	},
	textCenter: {
			textAlign: "center"
	},
	gap1: {
			gap: "4px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
});

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
		<div className={utilityClassName("group relative min-h-11")}>
			<Button
				size="lg"
				className={cn(
					utilityClassName("absolute inset-0 min-h-11 w-full"),
					complete && utilityClassName("disabled:opacity-100"),
				)}
				disabled={actionDisabled}
				onClick={onClick}
				{...(href
					? { render: <a href={href} target="_blank" rel="noreferrer" /> }
					: {})}
			>
				<span className={utilityClassName("sr-only")}>{label}</span>
			</Button>
			<div className={utilityClassName("pointer-events-none relative z-10 flex min-h-11 items-center px-3.5 text-base font-medium text-dim")}>
				<span
					aria-hidden="true"
					className={cn(
						utilityClassName("flex items-center gap-2 transition-colors duration-[var(--dur-micro)] group-hover:text-fg"),
						actionDisabled && !complete && utilityClassName("opacity-40 group-hover:text-dim"),
					)}
				>
					<IconCheckCircleFilled
						size={20}
						className={complete ? utilityClassName("text-green") : utilityClassName("text-faint")}
					/>
					<span className={utilityClassName("[text-box:trim-both_cap_alphabetic]")}>{label}</span>
				</span>
				<Tooltip
					side="top"
					align="center"
					offset={6}
					multiline
					popupClassName={utilityClassName("max-w-[424px]! p-2!")}
					label={
						<span className={utilityClassName("block w-[400px] max-w-[calc(100vw-32px)] whitespace-normal")}>
							<img
								src={guide}
								alt=""
								{...mergeStylexProps(utilityClassName("block h-auto w-full rounded-md"), sx.borderTooltipRing)}
							/>
							<span className={utilityClassName("block px-1 pt-2 pb-1 text-left text-supporting leading-snug font-normal text-tooltip-fg/75")}>
								{caption}
							</span>
						</span>
					}
				>
					<button
						type="button"
						aria-label={`Show help for ${label.toLowerCase()}`}
						className={utilityClassName("focus-ring pointer-events-auto ml-auto flex size-6 items-center justify-center rounded-control text-faint transition-colors duration-[var(--dur-micro)] hover:text-fg phone:size-8")}
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
}: {
	github: SetupGithub;
	returnTo: "welcome" | "settings";
	connectionStatus?: { tone: ChipTone; label: string };
	onContentSizeChange?: () => void;
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

	async function createApp() {
		if (starting || !ownerReady) return;
		setStarting(true);
		setError(null);
		try {
			const body = await setupRequest<{ action: string; manifest: string }>(
				"/api/setup/github/manifest",
				{
					method: "POST",
					json: {
						owner,
						returnTo,
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
			const form = document.createElement("form");
			form.method = "post";
			form.action = action;
			form.hidden = true;
			const manifest = document.createElement("input");
			manifest.type = "hidden";
			manifest.name = "manifest";
			manifest.value = body.manifest;
			form.append(manifest);
			document.body.append(form);
			if (returnTo === "welcome") {
				window.sessionStorage.setItem("opensession:first-mile-step", "github");
			}
			form.submit();
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
					<div {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyCenter, sx.gap2, sx.pb5)}>
						<IconTile name="github" size={48} />
						<span aria-hidden="true" {...stylex.props(sx.flex, sx.gap1)}>
							<span {...stylex.props(sx.size1, sx.bgLineStrong)} />
							<span {...stylex.props(sx.size1, sx.bgLineStrong)} />
							<span {...stylex.props(sx.size1, sx.bgLineStrong)} />
							<span {...stylex.props(sx.size1, sx.bgLineStrong)} />
						</span>
						<img
							src={`${BASE_PATH}/mac-app-icon.png`}
							alt=""
							{...stylex.props(sx.size12, sx.shrink0)}
						/>
					</div>
					<div className={utilityClassName("flex items-center justify-between gap-4")}>
						<div className={utilityClassName("min-w-0 text-dialog-title font-semibold text-fg")}>
							Install Open Session for GitHub
						</div>
						<StateChip tone={connectionStatus.tone} label={connectionStatus.label} />
					</div>
				</>
			) : (
				<div className={utilityClassName("text-dialog-title font-semibold text-fg")}>
					Install Open Session for GitHub
				</div>
			)}
			<div {...stylex.props(sx.flex, sx.flexCol, formOwner === "organization" ? sx.gap5 : sx.gap2)}>
				<Segmented
					label="GitHub App owner"
					value={owner}
					onValueChange={(value) => setOwner(value as GithubAppOwnerType)}
					className={mergeStylexOverrideClassName("", sx.wFull)}
				>
					<SegmentedOption
						value="personal"
						className={mergeStylexOverrideClassName("phone:min-h-11 [&>span:last-child]:justify-center", sx.flex1, sx.textCenter)}
					>
						Personal account
					</SegmentedOption>
					<SegmentedOption
						value="organization"
						className={mergeStylexOverrideClassName("phone:min-h-11 [&>span:last-child]:justify-center", sx.flex1, sx.textCenter)}
					>
						Organization
					</SegmentedOption>
				</Segmented>
				{formOwner === "organization" && (
					<label {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
						<span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>Organization ID</span>
						<Input
							value={formInstallationOwner}
							onChange={(event) =>
								setOwnerDrafts((current) => ({
									...current,
									organization: event.target.value,
								}))
							}
							placeholder="my-organization"
							className={mergeStylexOverrideClassName("phone:min-h-11 phone:text-input-phone", sx.fontMono)}
							disabled={starting}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
				)}
			</div>
			<div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
				<GithubSetupStep
					label="Create GitHub app"
					guide={githubCreateAppGuide}
					caption="Keep the suggested name, then create the GitHub App for your account or organization."
					complete={github.clientIdConfigured}
					disabled={
						github.clientIdConfigured || !ownerReady || ownerSwitching || starting
					}
					onClick={() => void createApp()}
				/>
				<GithubSetupStep
					label="Enable Device Flow"
					guide={githubDeviceFlowGuide}
					caption={
						<>
							Leave OAuth during installation off, then turn on Enable Device Flow.
							Click “<strong {...stylex.props(sx.fontSemibold, sx.textTooltipFg)}>Save changes</strong>”
							to finish.
						</>
					}
					href={settingsUrl}
				/>
				<GithubSetupStep
					label="Install GitHub app"
					guide={githubInstallAppGuide}
					caption="Choose all repositories or select the repositories Open Session can access, then click Install."
					href={installUrl}
				/>
			</div>
			{result === "created" && (
				<SettingsHint className={utilityClassName("m-0")}>
					GitHub App created. Enable Device Flow before you install it.
				</SettingsHint>
			)}
			{result === "error" && (
				<InlineAlert>GitHub App setup could not be completed. Try again.</InlineAlert>
			)}
			{error && <InlineAlert>{error}</InlineAlert>}
		</>
	);
}
