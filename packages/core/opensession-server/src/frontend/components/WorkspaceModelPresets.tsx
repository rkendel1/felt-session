import React, { useEffect, useState } from "react";
import type { Workspace } from "../lib/types";
import { randomUUID } from "../lib/random-uuid";
import { defaultWorkspaceModelSettings, fetchModels, updateWorkspaceApi, type ModelOption } from "../lib/api";
import { Button } from "../ui/button";
import { CardList } from "../ui/card";
import { cn } from "../ui/cn";
import { Modal } from "../ui/modal";
import { Select } from "../ui/select";
import { InlineAlert } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsField,
	SettingsGroupLabel,
	rowMenuTriggerClasses,
	settingsInputClass,
	settingsTextareaClass,
} from "../ui/settings";
import { EFFORTS, shortModelLabel } from "./ModelEffortSelect";
import { IconChevronDown, IconPlus, IconTrash } from "./icons";

type Settings = NonNullable<Workspace["modelSettings"]>;
type Preset = NonNullable<Settings["presets"]>[number];
type Supporting = NonNullable<Preset["supporting"]>[number];

const blankPreset = (): Preset => ({
	id: randomUUID().slice(0, 8),
	label: "New preset",
	instructions: "",
	lead: { model: "", effort: "high" },
	supporting: [],
});

/** The dialog's one select shape: a full-width field over the app's popup.
 *  Its four fields differ only in the list they offer. */
function ModelSelect({
	items,
	value,
	label,
	onChange,
	className,
}: {
	items: { value: string; label: string }[];
	value: string;
	label: string;
	onChange: (value: string) => void;
	className?: string;
}) {
	return (
		<Select.Root items={items} value={value} onValueChange={(next) => onChange(String(next))}>
			<Select.Trigger aria-label={label} className={className} />
			<Select.Popup>
				{items.map((item) => (
					<Select.Item key={item.value} value={item.value}>
						{item.label}
					</Select.Item>
				))}
			</Select.Popup>
		</Select.Root>
	);
}

/**
 * One preset in the list: a row you can read at a glance, and its editor
 * underneath once you open it. Seven presets ship by default, so showing every
 * field at once turned this dialog into a wall of inputs with no way to see
 * what a preset actually is.
 */
function PresetRow({
	preset,
	models,
	open,
	onToggle,
	onPatch,
	onRemove,
}: {
	preset: Preset;
	models: ModelOption[];
	open: boolean;
	onToggle: () => void;
	onPatch: (patch: Partial<Preset>) => void;
	onRemove: () => void;
}) {
	const supporting = preset.supporting || [];
	const effortsFor = (model: string) => {
		const supported = models.find((option) => option.id === model)?.efforts || [];
		return EFFORTS.filter((effort) => supported.includes(effort.id));
	};
	const leadEfforts = effortsFor(preset.lead.model);
	// The catalog's own label, so a row reads the same as the select under it.
	// shortModelLabel is the fallback for a model the catalog no longer lists.
	const labelFor = (model: string) =>
		models.find((option) => option.id === model)?.label || shortModelLabel(model, models);
	const patchSupporting = (index: number, patch: Partial<Supporting>) =>
		onPatch({ supporting: supporting.map((member, i) => (i === index ? { ...member, ...patch } : member)) });
	// "" is a real choice ("not set yet"), so it stays an item in the list
	// rather than becoming the trigger's placeholder.
	const modelItems = (prompt: string) => [
		{ value: "", label: prompt },
		...models.map((model) => ({ value: model.id, label: model.label })),
	];
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-hover"
			>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-item-title font-medium text-fg">
						{preset.label.trim() || "Untitled preset"}
					</span>
					<span className="mt-0.5 block truncate text-supporting text-dim">
						{preset.lead.model
							? [
									labelFor(preset.lead.model),
									supporting.length === 1
										? "1 supporting model"
										: supporting.length
											? `${supporting.length} supporting models`
											: "no supporting models",
								].join(" · ")
							: "No lead model yet"}
					</span>
				</span>
				<IconChevronDown
					size={18}
					className={cn("shrink-0 text-faint transition-transform", open && "rotate-180")}
				/>
			</button>
			{open && (
				<div className="flex flex-col gap-3 px-5 pb-4">
					<SettingsField className="mb-0">
						Name
						<input
							className={settingsInputClass}
							value={preset.label}
							onChange={(event) => onPatch({ label: event.target.value })}
							placeholder="Preset name"
						/>
					</SettingsField>
					<div className="flex flex-wrap items-end gap-2">
						<SettingsField className="mb-0 min-w-[13rem] flex-1">
							Lead model
							<ModelSelect
								items={modelItems("Choose a lead model")}
								value={preset.lead.model}
								label="Lead model"
								onChange={(model) => onPatch({ lead: { ...preset.lead, model } })}
							/>
						</SettingsField>
						{leadEfforts.length > 0 && (
							<SettingsField className="mb-0 w-32">
								Effort
								<ModelSelect
									items={leadEfforts.map((effort) => ({ value: effort.id, label: effort.label }))}
									value={preset.lead.effort || ""}
									label="Effort"
									onChange={(effort) => onPatch({ lead: { ...preset.lead, effort } })}
								/>
							</SettingsField>
						)}
					</div>
					<div className="flex flex-col gap-2">
						<span className="text-label font-medium text-dim">Supporting models</span>
						{supporting.map((member, index) => {
							const memberEfforts = effortsFor(member.model);
							return (
								// Four controls in one line only where they fit. A phone gets the
								// model and its remove button on the first line, then role and
								// effort under them, instead of four fields fighting over 200px.
								<div
									key={index}
									className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 desktop:grid-cols-[minmax(0,1fr)_10rem_8rem_auto]"
								>
									<ModelSelect
										className="col-start-1 row-start-1"
										items={modelItems("Choose a supporting model")}
										value={member.model}
										label="Supporting model"
										onChange={(model) => patchSupporting(index, { model })}
									/>
									<button
										type="button"
										className={cn(rowMenuTriggerClasses, "col-start-2 row-start-1 desktop:col-start-4")}
										aria-label="Remove supporting model"
										onClick={() => onPatch({ supporting: supporting.filter((_, i) => i !== index) })}
									>
										<IconTrash size={16} />
									</button>
									<input
										className={cn(settingsInputClass, "col-span-2 desktop:col-span-1 desktop:col-start-2 desktop:row-start-1")}
										value={member.role || ""}
										aria-label="What this model does"
										placeholder="Role"
										onChange={(event) => patchSupporting(index, { role: event.target.value })}
									/>
									{memberEfforts.length > 0 && (
										<ModelSelect
											className="col-span-2 desktop:col-span-1 desktop:col-start-3 desktop:row-start-1"
											items={memberEfforts.map((effort) => ({ value: effort.id, label: effort.label }))}
											value={member.effort || ""}
											label="Supporting model effort"
											onChange={(effort) => patchSupporting(index, { effort })}
										/>
									)}
								</div>
							);
						})}
						<Button
							size="sm"
							icon={<IconPlus size={16} />}
							className="w-fit"
							onClick={() => onPatch({ supporting: [...supporting, { model: "" }] })}
						>
							Add supporting model
						</Button>
					</div>
					<SettingsField className="mb-0">
						Instructions
						<textarea
							className={cn(settingsTextareaClass, "min-h-18")}
							value={preset.instructions || ""}
							onChange={(event) => onPatch({ instructions: event.target.value })}
							placeholder="When to use supporting models and how to integrate their work."
						/>
					</SettingsField>
					<div className="flex justify-end">
						<Button
							size="sm"
							variant="ghost"
							icon={<IconTrash size={16} />}
							className="text-red hover:bg-red-soft hover:text-red"
							onClick={onRemove}
						>
							Remove preset
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

export function WorkspaceModelPresets({
	workspace,
	open,
	onOpenChange,
	onSaved,
}: {
	workspace: Workspace;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const [settings, setSettings] = useState<Settings>(
		workspace.modelSettings || defaultWorkspaceModelSettings() || {},
	);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [openPreset, setOpenPreset] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(
		() => setSettings(workspace.modelSettings || defaultWorkspaceModelSettings() || {}),
		[workspace],
	);
	useEffect(() => {
		if (!open) return;
		fetchModels(workspace.id)
			.then((catalog) => setModels(catalog.models.filter((model) => !model.id.startsWith("workspace-preset/"))))
			.catch(() => setModels([]));
	}, [open, workspace.id]);
	const presets = settings.presets || [];
	const patchPreset = (index: number, patch: Partial<Preset>) =>
		setSettings((current) => ({
			...current,
			presets: (current.presets || []).map((preset, i) => i === index ? { ...preset, ...patch } : preset),
		}));
	const addPreset = () => {
		const preset = blankPreset();
		setSettings((current) => ({ ...current, presets: [...(current.presets || []), preset] }));
		setOpenPreset(preset.id);
	};
	const save = async () => {
		setSaving(true);
		setError(null);
		await (async () => {
const clean = {
				...settings,
				presets: presets
					.map((preset) => ({
						...preset,
						id: preset.id.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64),
						label: preset.label.trim(),
						instructions: preset.instructions?.trim() || undefined,
						lead: { ...preset.lead, model: preset.lead.model.trim() },
						supporting: (preset.supporting || []).filter((member) => member.model.trim()),
					}))
					.filter((preset) => preset.id && preset.label && preset.lead.model),
			};
			await updateWorkspaceApi(workspace.id, { modelSettings: clean });
			onSaved();
			onOpenChange(false);
})().catch(async (e) => {
setError(e instanceof Error ? e.message : "Could not save model presets.");
}).finally(async () => {
setSaving(false);
});
	};
	return (
		<Modal.Root open={open} onOpenChange={onOpenChange}>
			<Modal.Content widthClassName="max-w-[42rem]">
				<Modal.Header
					title="Agent roles and model presets"
					description="Choose which configured provider and model runs each role in this workspace. Presets can also delegate to supporting models."
				/>
				<div className="flex flex-col gap-2.5">
					{presets.length > 0 ? (
						<CardList>
							{presets.map((preset, index) => (
								<PresetRow
									key={preset.id}
									preset={preset}
									models={models}
									open={openPreset === preset.id}
									onToggle={() => setOpenPreset((current) => (current === preset.id ? null : preset.id))}
									onPatch={(patch) => patchPreset(index, patch)}
									onRemove={() =>
										setSettings((current) => ({
											...current,
											presets: (current.presets || []).filter((_, i) => i !== index),
										}))
									}
								/>
							))}
						</CardList>
					) : (
						<div className="rounded-xl bg-panel px-4 py-6 text-center text-supporting text-dim">
							No presets yet.
						</div>
					)}
					<Button icon={<IconPlus size={16} />} className="w-fit" onClick={addPreset}>
						Add preset
					</Button>
				</div>
				{error && <InlineAlert>{error}</InlineAlert>}
				<Modal.Footer>
					<Modal.Close render={<Button variant="ghost">Cancel</Button>} />
					<Button variant="primary" disabled={saving} onClick={() => void save()}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</Modal.Footer>
			</Modal.Content>
		</Modal.Root>
	);
}

/** Workspace-specific entry inside Settings → Providers. */
export function WorkspaceModelPresetSettings({ workspace }: { workspace?: Workspace }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<SettingsGroupLabel>This workspace</SettingsGroupLabel>
			<SettingCard>
				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>Agent roles and model presets</SettingRowTitle>
						<SettingRowDescription>
							{workspace
								? "Assign workspace roles and other presets to configured models."
								: "Open a workspace to set up its model presets."}
						</SettingRowDescription>
					</SettingRowText>
					<SettingRowControl>
						<Button disabled={!workspace} onClick={() => setOpen(true)}>Configure</Button>
					</SettingRowControl>
				</SettingRow>
			</SettingCard>
			{workspace && <WorkspaceModelPresets workspace={workspace} open={open} onOpenChange={setOpen} onSaved={() => window.dispatchEvent(new Event("opensession:workspaces-changed"))} />}
		</>
	);
}
