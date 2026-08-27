import { useEffect, useState } from "react";
import {
	fetchSandboxStatus,
	saveSandboxDefault,
	type SandboxStatusInfo,
} from "../../lib/api";
import {
	SettingCard,
	SettingsGroupLabel,
	SettingsHint,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexClassName, mergeStylexOverrideClassName } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	textFaint: {
			color: "var(--text-faint)"
	},
	mt0: {
			marginTop: "0"
	},
	saving: {
		pointerEvents: "none",
		opacity: 0.6,
	},
});

type Scope = "workspace" | "personal";

function providerLabel(id: string): string {
	if (id === "none") return "None";
	if (id === "docker") return "Docker";
	if (id === "daytona") return "Daytona";
	if (id === "e2b") return "E2B";
	if (id === "box") return "Box";
	if (id === "modal") return "Modal";
	if (id === "microvm") return "Local MicroVM";
	if (id === "lambda-microvm") return "AWS Lambda MicroVM";
	return id;
}

function SandboxDefaultRow({ scope, canManage = true }: { scope: Scope; canManage?: boolean }) {
	const user = getCurrentUser();
	const [status, setStatus] = useState<SandboxStatusInfo | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		fetchSandboxStatus(user).then(setStatus).catch(() => {});
	}, [user]);

	if (!status?.defaults) {
		return (
			<SettingRow
				title="Default sandbox"
				desc="Loading available sandbox providers…"
				control={<span {...stylex.props(sx.textFaint, typography.supporting)}>Loading…</span>}
			/>
		);
	}

	const providers = status.connections?.length
		? status.connections
				.filter((connection) => connection.state === "ready")
				.map((connection) => ({ id: connection.provider }))
		: status.providers.filter((provider) => provider.configured && provider.certified);
	const workspace = status.defaults.workspace || "none";
	const value = scope === "workspace" ? workspace : status.defaults.personal || "workspace";
	const available = new Set<string>(providers.map((provider) => provider.id));
	const unavailableSelection =
		value !== "workspace" && value !== "none" && !available.has(value)
			? [{ value, label: `${providerLabel(value)} · unavailable`, disabled: true }]
			: [];
	const options = [
		...(scope === "personal"
			? [{ value: "workspace", label: `Workspace default · ${providerLabel(workspace)}` }]
			: []),
		{ value: "none", label: "None" },
		...unavailableSelection,
		...providers.map((provider) => ({
			value: provider.id,
			label: providerLabel(provider.id),
		})),
	];

	async function save(next: string) {
		setSaving(true);
		await (async () => {
const response = await saveSandboxDefault({ scope, value: next, user });
			setStatus((current) =>
				current ? { ...current, defaults: response.defaults } : current,
			);
})().catch(async (error) => {
toast(error instanceof Error ? error.message : "Failed to save sandbox default", {
				variant: "error",
			});
			fetchSandboxStatus(user).then(setStatus).catch(() => {});
}).finally(async () => {
setSaving(false);
});
	}

	return (
		<SettingRow
			title="Default sandbox"
			desc={
				scope === "personal"
					? "Your environment for new sessions. A per-session choice still overrides it."
					: "The environment new sessions use unless a person or session chooses another."
			}
			control={
				<div {...stylex.props(saving && sx.saving)}>
					<Select
						label={`${scope === "personal" ? "Personal" : "Workspace"} default sandbox`}
						value={value}
						options={options}
						onChange={(next) => void save(next)}
						disabled={scope === "workspace" && !canManage}
					/>
				</div>
			}
		/>
	);
}

export function PersonalSandboxDefaultRow() {
	return <SandboxDefaultRow scope="personal" />;
}

export function WorkspaceSandboxDefaults({ canManage = true }: { canManage?: boolean }) {
	return (
		<>
			<SettingsGroupLabel className={mergeStylexOverrideClassName("", sx.mt0)}>Session environment</SettingsGroupLabel>
			<SettingCard>
				<SandboxDefaultRow scope="workspace" canManage={canManage} />
			</SettingCard>
			<SettingsHint>
				None keeps sessions on this host. Only configured providers that passed the live
				behavior and warm-restore matrices are offered.
			</SettingsHint>
		</>
	);
}
