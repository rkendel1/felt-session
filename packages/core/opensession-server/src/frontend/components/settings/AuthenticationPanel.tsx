import { utilityClassName } from "../../ui/cn";
import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import { shouldReloadAfterGithubAuthEnabled } from "../../lib/github-app-setup";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { setupRequest, type SetupGithub } from "../setup-shared";
import { SetupRestart } from "../SetupRestart";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap4: {
			gap: "calc(4px * 4)"
	},
	px5: {
			paddingInline: "calc(4px * 5)"
	},
	py4: {
			paddingBlock: "calc(4px * 4)"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt05: {
			marginTop: "calc(4px * 0.5)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	relative: {
			position: "relative"
	},
});

function AuthenticationMethod({
	github,
	onSaved,
}: {
	github: SetupGithub;
	onSaved: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function select(provider: string) {
		const enabled = provider === "github";
		if (saving || enabled === github.userPrAuth) return;
		setSaving(true);
		setError(null);
		await setupRequest<{
			github: SetupGithub;
			restartRequired: boolean;
		}>("/api/setup/github", {
			method: "PUT",
			json: { userPrAuth: enabled },
		})
			.then((body) => {
				toast(`GitHub sign-in ${enabled ? "enabled" : "disabled"}`);
				onSaved(body.github, body.restartRequired === true);
				if (shouldReloadAfterGithubAuthEnabled(github.userPrAuth, body.github.userPrAuth)) {
					window.location.reload();
				}
			})
			.catch((cause) => {
				const message =
					cause instanceof Error ? cause.message : "Could not update authentication";
				setError(message);
				toast(message, { variant: "error" });
			});
		setSaving(false);
	}

	return (
		<>
			<SettingCard>
				<div {...mergeStylexProps("phone:flex-col phone:items-stretch phone:px-3", sx.flex, sx.itemsCenter, sx.gap4, sx.px5, sx.py4)} >
					<div {...stylex.props(sx.minW0, sx.flex1)}>
						<div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>Sign-in method</div>
						<div {...stylex.props(sx.mt05, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
							Require GitHub sign-in, or leave this workspace open.
						</div>
					</div>
					<Segmented
						label="Sign-in method"
						value={github.userPrAuth ? "github" : "none"}
						onValueChange={(value) => void select(value)}
						className={utilityClassName("phone:w-full")}
					>
						<SegmentedOption
							value="none"
							disabled={saving}
							className={utilityClassName("phone:min-h-11 phone:flex-1 phone:justify-center")}
						>
							None
						</SegmentedOption>
						<SegmentedOption
							value="github"
							disabled={saving}
							className={utilityClassName("phone:min-h-11 phone:flex-1 phone:justify-center")}
						>
							GitHub
						</SegmentedOption>
					</Segmented>
				</div>
			</SettingCard>
			{error && <InlineAlert>{error}</InlineAlert>}
		</>
	);
}

// Organization → Authentication controls only the workspace sign-in gate.
// Provider credentials belong to Organization → Integrations.
export function AuthenticationPanel() {
	const setup = useSetupStatus();
	const { status, failed } = setup;
	return (
		<SettingsPanel className={mergeStylexOverrideClassName("", sx.relative)}>
			<SettingsHeader
				title="Authentication"
				description="Choose how teammates sign in to this workspace."
			/>
			{!status ? (
				failed ? (
					<InlineAlert>Couldn&rsquo;t load authentication settings.</InlineAlert>
				) : (
					<SettingCardSkeleton rows={1} label="Loading authentication" />
				)
			) : (
				<>
					<SettingsGroupLabel>Workspace access</SettingsGroupLabel>
					<AuthenticationMethod github={status.github} onSaved={setup.applyGithub} />
					<SettingsHint>
						Configure the GitHub App and its credentials under Integrations.
					</SettingsHint>
				</>
			)}
			<SetupRestart setup={setup} />
		</SettingsPanel>
	);
}
