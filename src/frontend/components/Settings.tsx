import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import {
	getNotifSettings,
	setNotifSettings,
	onNotifSettingsChanged,
	ensureNotificationPermission,
	playSound,
	SOUND_OPTIONS,
	WHEN_OPTIONS,
	type NotifSettings,
} from "../lib/notify";
import {
	getThemePref,
	setThemePref,
	onThemeChanged,
	type ThemePref,
} from "../lib/theme";
import {
	getWsTimePref,
	setWsTimePref,
	onWsTimeChanged,
	type WsTimePref,
} from "../lib/workspace-time";
import {
	getTurnActivityPref,
	setTurnActivityPref,
	onTurnActivityChanged,
	type TurnActivityPref,
} from "../lib/turn-activity";
import {
	MOD_ENTER_LABEL,
	MOD_ENTER_GLYPH,
	type SendKeyPref,
} from "../lib/send-key";
import {
	getSendKeyPref,
	setSendKeyPref,
	onSendKeyChanged,
} from "../lib/send-key-pref";
import {
	getBusySendPrefs,
	setBusySendPref,
	onBusySendChanged,
	type BusySendPrefs,
} from "../lib/busy-send-pref";
import {
	getDefaultModelPref,
	setDefaultModelPref,
	onDefaultModelPrefChanged,
} from "../lib/default-model-pref";
import {
	getVimModePref,
	setVimModePref,
	onVimModeChanged,
} from "../lib/vim-pref";
import {
	getPinNewSessions,
	setPinNewSessions,
	onPinNewSessionsChanged,
	getPinNewWorkspaces,
	setPinNewWorkspaces,
	onPinNewWorkspacesChanged,
} from "../lib/pins";
import { Connections } from "./Connections";
import { MyAccountsPanel } from "./MyAccounts";
import { AccountsPanel } from "./Models";
import { ModelProvidersPanel } from "./ModelProviders";
import {
	fetchAudit,
	fetchWarmTemplates,
	updateWarmTemplate,
	refreshWarmTemplateNow,
	fetchPreviewPool,
	updatePreviewPool,
	refreshPreviewPoolGolden,
	type PreviewPoolEntry,
	fetchMemory,
	addMemoryEntryApi,
	updateMemoryEntryApi,
	deleteMemoryEntryApi,
	fetchPapercuts,
	setPapercutsRepoEnabled,
	fetchKeychain,
	addKeychainCredential,
	deleteKeychainCredential,
	revokeKeychainGrant,
	fetchPersonalPrompt,
	savePersonalPrompt,
	relativeTime,
	fetchModels,
	fetchFeeds,
	type ModelOption,
	type WarmTemplateEntry,
	type MemoryScopeDto,
	type MemoryEntryDto,
	type PapercutDto,
	type PapercutsRepoConfig,
	type KeychainCredentialDto,
	type KeychainGrantDto,
	type KeychainAskDto,
} from "../lib/api";
import type { FeedDescriptor } from "../lib/types";
import { getPushState, enablePush, disablePush, type PushState } from "../lib/push";
import { getCurrentUser } from "./UserPicker";
import { useIsPhone } from "../hooks/useIsPhone";
import { BottomSheet } from "../ui/sheet";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import {
	SettingCard,
	SettingRow as SettingsRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	SettingsSection,
	settingsInputClass,
	settingsSelectClass,
	settingsTextareaClass,
} from "../ui/settings";
import { Switch } from "../ui/switch";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { Reorder } from "motion/react";
import {
	IconChevronDown,
	IconChevronLeft,
	IconChevronRight,
	IconPencil,
	IconPlus,
	IconTrash,
	IconX,
} from "./icons";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { AGENT_NAME, PRODUCT_NAME } from "../lib/brand";
import {
	onSidebarToolsChanged,
	readHiddenSidebarTools,
	setSidebarToolVisible,
	SIDEBAR_TOOL_IDS,
	SIDEBAR_TOOL_LABELS,
} from "../lib/sidebar-tools";
import {
	getSidebarOrder,
	onSidebarOrderChanged,
	setSidebarOrder,
	SIDEBAR_SECTION_LABELS,
	type SidebarSectionId,
} from "../lib/sidebar-order";
import {
	onSidebarFeedsChanged,
	readHiddenSidebarFeeds,
	setSidebarFeedVisible,
} from "../lib/sidebar-feeds";

// The full-window Settings surface: a left sub-nav + a scrolling body, reached
// from the "Settings" item in the account menu. Designed to grow — each area is
// just another entry in SECTIONS and a matching panel below. The "Tools" group
// holds the app's tool surfaces (Automations, Goals, …) — those render at their
// own routes (<base>/automations, …) with this surface as chrome, so the
// section is controlled by the router, not local state. The "Personal" group
// holds per-browser preferences (notifications, theme); the "Workspace" group holds
// shared setup that configures how every session runs (default model, connections).

/** Tool surfaces hosted inside Settings — App renders their panel as children. */
export type ToolSectionKey =
	| "automations"
	| "goals"
	| "actions"
	| "security";

export type SettingsSectionKey =
	| "notifications"
	| "composer"
	| "appearance"
	| "personalPrompt"
	| "myAccounts"
	| "workspace"
	| "model"
	| "modelProviders"
	| "connections"
	| "memory"
	| "warmPreviews"
	| "previewPool"
	| "papercuts"
	| "keychain"
	| "audit"
	| ToolSectionKey;

const TOOL_SECTIONS = new Set<SettingsSectionKey>([
	"automations",
	"goals",
	"actions",
	"security",
]);

const SECTIONS: {
	key: SettingsSectionKey;
	label: string;
	group: string;
	icon: React.ReactNode;
}[] = [
	{
		key: "automations",
		label: "Automations",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="5.5" />
				<path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		key: "goals",
		label: "Goals",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="6" />
				<circle cx="8" cy="8" r="3" />
				<circle cx="8" cy="8" r="0.6" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		key: "actions",
		label: "Actions",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9l-.5-5.5z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		key: "security",
		label: "Security",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 1.8l4.6 1.7v3.8c0 3-1.9 5.2-4.6 6.5-2.7-1.3-4.6-3.5-4.6-6.5V3.5L8 1.8z"
					strokeLinejoin="round"
				/>
				<path d="M6.1 8l1.3 1.3 2.5-2.6" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		key: "notifications",
		label: "Notifications",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 2.2a3.4 3.4 0 0 0-3.4 3.4c0 2.9-1.1 3.9-1.1 3.9h9A5.4 5.4 0 0 1 11.4 5.6 3.4 3.4 0 0 0 8 2.2z"
					strokeLinejoin="round"
				/>
				<path d="M6.7 12a1.4 1.4 0 0 0 2.6 0" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "composer",
		label: "Composer",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect x="1.75" y="4.25" width="12.5" height="7.5" rx="1.2" />
				<path
					d="M4 6.8h.01M6.7 6.8h.01M9.4 6.8h.01M12.1 6.8h.01M5 9.5h6"
					strokeLinecap="round"
				/>
			</svg>
		),
	},
	{
		key: "appearance",
		label: "Appearance",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="5.5" />
				<path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		key: "personalPrompt",
		label: "Personal prompt",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M3 3.5h10M3 6.5h10M3 9.5h6"
					strokeLinecap="round"
				/>
				<path
					d="M12.9 9.1l-3.4 3.4-.5 1.5 1.5-.5 3.4-3.4a1 1 0 0 0-1-1z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		key: "myAccounts",
		label: "My accounts",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="5.2" r="2.7" />
				<path d="M2.8 13.5a5.2 5.2 0 0 1 10.4 0" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "workspace",
		label: "General",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="5.5" r="2.5" />
				<path d="M3.5 13.5c.6-2.4 2.4-3.6 4.5-3.6s3.9 1.2 4.5 3.6" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "model",
		label: "Accounts",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
				<circle cx="5.75" cy="7" r="1.5" />
				<path d="M3.75 10.75c.4-1.1 1.3-1.6 2-1.6s1.6.5 2 1.6" strokeLinecap="round" />
				<path d="M9.75 6.5h2.75M9.75 9h2.75" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "modelProviders",
		label: "Model providers",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect x="2.25" y="2.25" width="5" height="5" rx="1" />
				<rect x="8.75" y="8.75" width="5" height="5" rx="1" />
				<circle cx="11.25" cy="4.75" r="2.5" />
				<path d="M4.75 9.5v1.75a1 1 0 0 0 1 1h1.75" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "connections",
		label: "Connections",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="4.5" cy="8" r="2" />
				<circle cx="11.5" cy="4" r="2" />
				<circle cx="11.5" cy="12" r="2" />
				<path d="M6.3 7.1l3.4-2.2M6.3 8.9l3.4 2.2" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "memory",
		label: "Memory",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path d="M8 2.5l5.5 2.75L8 8 2.5 5.25 8 2.5z" strokeLinejoin="round" />
				<path d="M2.5 8.25L8 11l5.5-2.75" strokeLinecap="round" strokeLinejoin="round" />
				<path d="M2.5 11.25L8 14l5.5-2.75" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		key: "warmPreviews",
		label: "Warm deps",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 1.8c.4 2.2 3.7 3.4 3.7 6.7a3.7 3.7 0 0 1-7.4 0c0-1.4.6-2.4 1.4-3.4.2 1 .7 1.6 1.4 2 0-1.9.2-3.9.9-5.3z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		key: "previewPool",
		label: "Preview pool",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path d="M3 4.5l5-2.7 5 2.7v7l-5 2.7-5-2.7v-7z" strokeLinejoin="round" />
				<path d="M3 4.5L8 7.2l5-2.7M8 7.2v7" strokeLinejoin="round" />
				<path d="M6.6 9.4l1.9 1.1 1.9-1.1" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		key: "keychain",
		label: "Keychain",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="5.4" cy="8" r="2.6" />
				<path d="M8 8h6M12 8v2.2M10 8v1.6" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "papercuts",
		label: "Papercuts",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect
					x="1.6"
					y="5.4"
					width="12.8"
					height="5.2"
					rx="2.6"
					transform="rotate(-45 8 8)"
					strokeLinejoin="round"
				/>
				<path d="M6.9 8h.01M9.1 8h.01M8 6.9v.01M8 9.1v.01" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "audit",
		label: "Audit log",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" strokeLinejoin="round" />
				<path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" strokeLinecap="round" />
			</svg>
		),
	},
];

/** The active section's panel — shared by the desktop split and the phone
 * sheet's detail page. Tool panels come in via children (App owns them). */
function SectionPanel({
	section,
	children,
}: {
	section: SettingsSectionKey;
	children?: React.ReactNode;
}) {
	return (
		<>
			{TOOL_SECTIONS.has(section) && children}
			{section === "notifications" && <NotificationsPanel />}
			{section === "composer" && <ComposerPanel />}
			{section === "appearance" && <AppearancePanel />}
			{section === "workspace" && <WorkspacePanel />}
			{section === "audit" && <AuditPanel />}
			{section === "model" && <AccountsPanel />}
			{section === "modelProviders" && <ModelProvidersPanel />}
			{section === "connections" && <Connections />}
			{section === "personalPrompt" && <PersonalPromptPanel />}
			{section === "myAccounts" && <MyAccountsPanel />}
			{section === "memory" && <MemoryPanel />}
			{section === "warmPreviews" && <WarmPreviewsPanel />}
			{section === "previewPool" && <PreviewPoolPanel />}
			{section === "papercuts" && <PapercutsPanel />}
			{section === "keychain" && <KeychainPanel />}
		</>
	);
}

export function Settings({
	onBack,
	section,
	onSelect,
	onShowRoot,
	children,
}: {
	onBack: () => void;
	/** Active section, derived from the route (tools have their own URLs).
	 * Undefined = no explicit section: desktop defaults to Notifications, the
	 * phone sheet shows its root list of sections. */
	section?: SettingsSectionKey;
	/** Navigate to a section — App maps tool keys to their own routes. */
	onSelect: (key: SettingsSectionKey) => void;
	/** Phone sheet's back-to-root (navigate to sectionless /settings). */
	onShowRoot?: () => void;
	/** The active tool's panel (App owns the tool components and their props). */
	children?: React.ReactNode;
}) {
	const isPhone = useIsPhone();

	// No page-level Esc handler: Esc belongs to whatever is focused (cancelling
	// an inline edit, closing a menu), not to the settings page itself — losing
	// the whole page to a stray Esc is worse than having no keyboard exit.

	// Group the nav entries under their group label (order preserved).
	const groups: { group: string; items: typeof SECTIONS }[] = [];
	for (const s of SECTIONS) {
		let g = groups.find((x) => x.group === s.group);
		if (!g) groups.push((g = { group: s.group, items: [] }));
		g.items.push(s);
	}

	if (isPhone)
		return (
			<MobileSettings
				groups={groups}
				section={section}
				onSelect={onSelect}
				onShowRoot={onShowRoot}
				onBack={onBack}
			>
				{children}
			</MobileSettings>
		);

	const active = section ?? "notifications";

	return (
		<div className="settings-page">
			<aside className="settings-sidenav">
				<button className="settings-back" onClick={onBack}>
					<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
						<path
							d="M10 3.5L5.5 8l4.5 4.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					Back to app
				</button>
				{groups.map((g) => (
					<div className="settings-sidenav-group" key={g.group}>
						<div className="settings-sidenav-label">{g.group}</div>
						{g.items.map((s) => (
							<button
								key={s.key}
								className={`settings-sidenav-item ${
									active === s.key ? "active" : ""
								}`}
								onClick={() => onSelect(s.key)}
							>
								<span className="settings-sidenav-icon">{s.icon}</span>
								{s.label}
							</button>
						))}
					</div>
				))}
			</aside>

			{/* Tool sections fill the whole content area edge-to-edge (they carry
			    their own layout/scrolling); settings panels keep the centered,
			    padded reading column. */}
			<div
				className={`settings-content${
					TOOL_SECTIONS.has(active) ? " settings-content-tool" : ""
				}`}
			>
				{TOOL_SECTIONS.has(active) ? (
					<SectionPanel section={active}>{children}</SectionPanel>
				) : (
					<div className="settings-panel-frame">
						<SectionPanel section={active}>{children}</SectionPanel>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Phone Settings: a bottom sheet sliding up over the root page, with iOS-style
 * paging inside — the root page lists the sections as grouped tappable rows,
 * and picking one slides its panel in from the right (Back slides it out).
 * Which page shows is route-driven: a section in the URL = detail page.
 */
function MobileSettings({
	groups,
	section,
	onSelect,
	onShowRoot,
	onBack,
	children,
}: {
	groups: { group: string; items: typeof SECTIONS }[];
	section?: SettingsSectionKey;
	onSelect: (key: SettingsSectionKey) => void;
	onShowRoot?: () => void;
	onBack: () => void;
	children?: React.ReactNode;
}) {
	// Keep the last opened section mounted while popping back to the root, so
	// the detail page has content during its slide-out.
	const [lastSection, setLastSection] = useState<SettingsSectionKey | null>(
		section ?? null,
	);
	useEffect(() => {
		if (section) setLastSection(section);
	}, [section]);

	const detail = section ?? null;
	const shownSection = detail ?? lastSection;
	const shownLabel = SECTIONS.find((s) => s.key === shownSection)?.label;
	const pageEase = "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

	return (
		<BottomSheet onClose={onBack} label="Settings" className="settings-sheet h-[93dvh]">
			{(dismiss) => (
				<>
					<div className="relative flex h-11 shrink-0 items-center justify-center px-3">
						{detail && (
							<button
								className="absolute left-1 flex items-center gap-0.5 rounded-md border-none bg-transparent px-2 py-2 text-control-label font-medium text-accent"
								onClick={() => onShowRoot?.()}
							>
								<IconChevronLeft size={22} />
								Settings
							</button>
						)}
						<span className="text-section-title font-semibold text-fg">
							{detail ? shownLabel : "Settings"}
						</span>
						<button
							className="absolute right-3 flex h-8 w-8 items-center justify-center rounded-full border-none bg-active text-dim"
							onClick={dismiss}
							aria-label="Close settings"
						>
							<IconX size={22} />
						</button>
					</div>

					<div className="relative min-h-0 flex-1 overflow-hidden">
						{/* Root page: grouped section list. Parked slightly left while a
						    detail page covers it, iOS-style. */}
						<div
							className={cn(
								"absolute inset-0 overflow-y-auto px-4 pb-10",
								pageEase,
								detail && "-translate-x-1/3",
							)}
							aria-hidden={!!detail}
						>
							{groups.map((g) => (
								<div key={g.group}>
									<div className="mb-2 mt-5 px-1 text-control-label font-semibold text-faint">
										{g.group}
									</div>
									<div className="overflow-hidden rounded-2xl bg-raised">
										{g.items.map((s) => (
											<button
												key={s.key}
												className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line bg-transparent px-3.5 py-3 text-left last:border-b-0 active:bg-hover"
												onClick={() => onSelect(s.key)}
											>
												<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
													{s.icon}
												</span>
											<span className="min-w-0 flex-1 text-item-title font-medium text-fg">
													{s.label}
												</span>
												<IconChevronRight size={20} className="shrink-0 text-faint" />
											</button>
										))}
									</div>
								</div>
							))}
						</div>

						{/* Detail page: the picked section's panel, slid in from the right. */}
						<div
							className={cn(
								"absolute inset-0 flex flex-col bg-surface",
								pageEase,
								detail ? "translate-x-0" : "translate-x-full",
							)}
							aria-hidden={!detail}
						>
							{shownSection && (
								<div
									className={`settings-content min-h-0 flex-1${
										TOOL_SECTIONS.has(shownSection)
											? " settings-content-tool"
											: ""
									}`}
								>
									{TOOL_SECTIONS.has(shownSection) ? (
										<SectionPanel section={shownSection}>{children}</SectionPanel>
									) : (
										<div className="settings-panel-frame">
											<SectionPanel section={shownSection}>{children}</SectionPanel>
										</div>
									)}
								</div>
							)}
						</div>
					</div>
				</>
			)}
		</BottomSheet>
	);
}

// ── Reusable controls ──────────────────────────────────────────────────────

function SettingRow({
	title,
	desc,
	control,
}: {
	title: string;
	desc: React.ReactNode;
	control: React.ReactNode;
}) {
	return (
		<SettingsRow>
			<SettingRowText>
				<SettingRowTitle>{title}</SettingRowTitle>
				<SettingRowDescription>{desc}</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>{control}</SettingRowControl>
		</SettingsRow>
	);
}

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
}) {
	return (
		<Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
	);
}

function Select<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (v: T) => void;
	label: string;
}) {
	return (
		<span className="relative inline-grid">
			<select
				className={`${settingsSelectClass} appearance-none !pr-9`}
				aria-label={label}
				value={value}
				onChange={(e) => onChange(e.target.value as T)}
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
			<IconChevronDown
				className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
				size={20}
			/>
		</span>
	);
}

// ── Notifications ──────────────────────────────────────────────────────────

/** The device-level Web Push toggle inside Notifications. */
function PushRow() {
	const [state, setState] = useState<PushState | "loading">("loading");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		getPushState().then(setState);
	}, []);

	async function toggle(v: boolean) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			if (v) await enablePush(getCurrentUser());
			else await disablePush();
			setState(await getPushState());
		} catch (e: any) {
			setError(e.message);
			setState(await getPushState());
		}
		setBusy(false);
	}

	return (
		<SettingRow
			title="Push to this device"
			desc={
				error ||
				(state === "unsupported"
					? "Push needs an HTTPS origin. It isn't available on plain http."
					: state === "denied"
						? "Notifications are blocked for this site. Allow them in your browser to enable push."
						: "Buzz this device when a session needs your input, even with the app closed. It's per device, so enable it on your phone too.")
			}
			control={
				<Toggle
					label="Push to this device"
					checked={state === "on"}
					onChange={toggle}
				/>
			}
		/>
	);
}

function NotificationsPanel() {
	const [s, setS] = useState<NotifSettings>(getNotifSettings);
	useEffect(() => onNotifSettingsChanged(() => setS(getNotifSettings())), []);

	function patch(p: Partial<NotifSettings>) {
		setS(setNotifSettings(p));
	}

	return (
		<SettingsPanel>
			<SettingsHeader
				title="Notifications"
				description="How and when this device tells you a session needs you."
			/>

			<SettingsGroupLabel>Alerts</SettingsGroupLabel>
			<SettingCard>
				<PushRow />
				<SettingRow
					title="Desktop notifications"
					desc="Get a banner when one of your sessions needs input or finishes."
					control={
						<Toggle
							label="Desktop notifications"
							checked={s.desktop}
							onChange={(v) => {
								if (v) ensureNotificationPermission();
								patch({ desktop: v });
							}}
						/>
					}
				/>
				<SettingRow
					title="Completion sound"
					desc="What plays when a session needs input or finishes."
					control={
						<div className="flex items-center gap-2">
							<Select
								label="Completion sound"
								value={s.sound}
								options={SOUND_OPTIONS}
								onChange={(v) => patch({ sound: v })}
							/>
							<Button
								size="xs"
								variant="ghost"
								onClick={() => playSound(s.sound)}
								disabled={s.sound === "none"}
								title="Play sound"
							>
								<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
									<path
										d="M3 6v4h2.5L9 13V3L5.5 6H3z"
										stroke="currentColor"
										strokeWidth="1.3"
										strokeLinejoin="round"
									/>
									<path
										d="M11 6.2c.6.5.9 1.1.9 1.8s-.3 1.3-.9 1.8"
										stroke="currentColor"
										strokeWidth="1.3"
										strokeLinecap="round"
									/>
								</svg>
								Test
							</Button>
						</div>
					}
				/>
				<SettingRow
					title="When to notify"
					desc="Alert always, only when this tab is in the background, or never."
					control={
						<Select
							label="When to notify"
							value={s.when}
							options={WHEN_OPTIONS}
							onChange={(v) => patch({ when: v })}
						/>
					}
				/>
			</SettingCard>

			<SettingsGroupLabel>Events</SettingsGroupLabel>
			<SettingCard>
				<SettingRow
					title="Needs input"
					desc="Alert when a session is blocked waiting for your answer."
					control={
						<Toggle
							label="Needs input alerts"
							checked={s.needsInput}
							onChange={(v) => patch({ needsInput: v })}
						/>
					}
				/>
				<SettingRow
					title="Run complete"
					desc="Alert when one of your sessions finishes working."
					control={
						<Toggle
							label="Run complete alerts"
							checked={s.done}
							onChange={(v) => patch({ done: v })}
						/>
					}
				/>
			</SettingCard>
		</SettingsPanel>
	);
}

// ── Appearance ─────────────────────────────────────────────────────────────

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

// A miniature app mockup used inside the theme swatches. `tone` picks the fixed
// light/dark palette (independent of the current theme) via CSS-var classes.
function ThemeMock({ tone }: { tone: "light" | "dark" }) {
	return (
		<div className={`theme-mock mk-${tone}`}>
			<div className="theme-mock-head">
				<div className="theme-mock-bar w1" />
				<div className="theme-mock-bar w2" />
			</div>
			<div className="theme-mock-card">
				<div className="theme-mock-row" />
				<div className="theme-mock-row" />
				<div className="theme-mock-row" />
			</div>
		</div>
	);
}

function ThemeCard({
	option,
	active,
	onClick,
}: {
	option: ThemePref;
	active: boolean;
	onClick: () => void;
}) {
	const label = THEME_OPTIONS.find((o) => o.value === option)?.label ?? option;
	return (
		<button
			className={`theme-card ${active ? "active" : ""}`}
			role="radio"
			aria-checked={active}
			onClick={onClick}
		>
			<div className="theme-swatch">
				{/* System = light base with the dark mock clipped over the right half. */}
				<ThemeMock tone={option === "dark" ? "dark" : "light"} />
				{option === "system" && (
					<div className="theme-swatch-split">
						<ThemeMock tone="dark" />
					</div>
				)}
			</div>
			<span className="theme-card-label">{label}</span>
		</button>
	);
}

// ── Warm previews (per-repo prebuilt template worktrees) ────────────────────

const WARM_INTERVAL_OPTIONS: { value: string; label: string }[] = [
	{ value: "1", label: "Every hour" },
	{ value: "3", label: "Every 3 hours" },
	{ value: "6", label: "Every 6 hours" },
	{ value: "12", label: "Every 12 hours" },
	{ value: "24", label: "Daily" },
];

function warmAgo(iso?: string): string {
	if (!iso) return "never";
	const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

// ── Memory: the repo/user/team/channel stores behind the opensession-memory
// tools and Slack channel memory — view, add, edit and delete entries. ──

const MEMORY_GROUPS: {
	kind: MemoryScopeDto["scope"]["kind"];
	title: string;
	/** Fixed groups render even when empty (there's always an add target). */
	fixed: boolean;
}[] = [
	{ kind: "team", title: "Team", fixed: true },
	{ kind: "repo", title: "Repos", fixed: true },
	{ kind: "user", title: "People", fixed: false },
	{ kind: "channel", title: "Slack channels", fixed: false },
];

function MemoryEntryRow({
	scopeKey,
	entry,
	onChanged,
}: {
	scopeKey: string;
	entry: MemoryEntryDto;
	onChanged: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(entry.text);
	const [busy, setBusy] = useState(false);

	async function save() {
		const text = draft.trim();
		if (!text || text === entry.text) return setEditing(false);
		setBusy(true);
		try {
			await updateMemoryEntryApi(scopeKey, entry.id, text);
			setEditing(false);
			onChanged();
		} catch (e: any) {
			toast(e?.message || "Failed to update memory", { variant: "error" });
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		setBusy(true);
		try {
			await deleteMemoryEntryApi(scopeKey, entry.id);
			toast("Memory forgotten", { variant: "success" });
			onChanged();
		} catch (e: any) {
			toast(e?.message || "Failed to delete memory", { variant: "error" });
			setBusy(false);
		}
	}

	if (editing)
		return (
			<div className="border-b border-line px-4 py-3 last:border-b-0">
				<textarea
					className={settingsTextareaClass}
					rows={2}
					value={draft}
					autoFocus
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
						if (e.key === "Escape") setEditing(false);
					}}
				/>
				<div className="mt-1.5 flex gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={busy || !draft.trim()}
						onClick={save}
					>
						Save
					</Button>
					<Button
						size="sm"
						onClick={() => {
							setDraft(entry.text);
							setEditing(false);
						}}
					>
						Cancel
					</Button>
				</div>
			</div>
		);

	return (
		<div className="group flex items-start gap-2 border-b border-line px-4 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="text-body font-medium leading-snug text-fg">
					{entry.text}
				</div>
				<div className="mt-0.5 text-meta font-medium text-faint">
					{entry.by} · {relativeTime(entry.at)}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					size="sm"
					variant="ghost"
					aria-label="Edit memory"
					icon={<IconPencil size={16} />}
					disabled={busy}
					onClick={() => {
						setDraft(entry.text);
						setEditing(true);
					}}
				/>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Forget memory"
					className="hover:text-red"
					icon={<IconTrash size={16} />}
					disabled={busy}
					onClick={remove}
				/>
			</div>
		</div>
	);
}

function MemoryScopeCard({
	scoped,
	onChanged,
}: {
	scoped: MemoryScopeDto;
	onChanged: () => void;
}) {
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);

	async function add() {
		const text = draft.trim();
		if (!text) return;
		setBusy(true);
		try {
			await addMemoryEntryApi(scoped.scope.key, text, getCurrentUser() || "settings");
			setDraft("");
			setAdding(false);
			toast("Memory saved", { variant: "success" });
			onChanged();
		} catch (e: any) {
			toast(e?.message || "Failed to add memory", { variant: "error" });
		} finally {
			setBusy(false);
		}
	}

	return (
		<SettingsSection className="mb-2 overflow-hidden p-0">
			<div className="flex items-center justify-between border-b border-line px-4 py-2.5">
				<div className="text-supporting font-semibold text-fg">
					{scoped.scope.label}
				</div>
				<Button
					size="sm"
					variant="ghost"
					aria-label={`Add memory to ${scoped.scope.label}`}
					icon={<IconPlus size={16} />}
					onClick={() => setAdding((v) => !v)}
				>
					Add
				</Button>
			</div>
			{scoped.entries.length === 0 && !adding && (
				<div className="px-4 py-3 text-body font-medium text-faint">
					No memories yet.
				</div>
			)}
			{scoped.entries.map((e) => (
				<MemoryEntryRow
					key={e.id}
					scopeKey={scoped.scope.key}
					entry={e}
					onChanged={onChanged}
				/>
			))}
			{adding && (
				<div className="border-t border-line px-4 py-3">
					<textarea
						className={settingsTextareaClass}
						rows={2}
						placeholder="A durable, self-contained fact…"
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
							if (e.key === "Escape") setAdding(false);
						}}
					/>
					<div className="mt-1.5 flex gap-2">
						<Button
							variant="primary"
							size="sm"
							disabled={busy || !draft.trim()}
							onClick={add}
						>
							Save
						</Button>
						<Button
							size="sm"
							onClick={() => setAdding(false)}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</SettingsSection>
	);
}

/** Settings → Personal prompt: a per-user standing-instructions block injected
 * into the system note of every interactive run the user starts (server-side:
 * personal-prompts.ts via memoryNoteFor). Automations never receive it. */
function PersonalPromptPanel() {
	const user = getCurrentUser();
	const [prompt, setPrompt] = useState<string | null>(null);
	const [savedPrompt, setSavedPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchPersonalPrompt(user)
			.then((r) => {
				if (!alive) return;
				setPrompt(r.prompt);
				setSavedPrompt(r.prompt);
			})
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [user]);

	async function save() {
		if (prompt === null || busy) return;
		setBusy(true);
		try {
			const r = await savePersonalPrompt(user, prompt);
			setPrompt(r.prompt);
			setSavedPrompt(r.prompt);
			toast(r.prompt ? "Personal prompt saved" : "Personal prompt cleared", {
				variant: "success",
			});
		} catch (e: any) {
			toast(e?.message || "Failed to save personal prompt", {
				variant: "error",
			});
		} finally {
			setBusy(false);
		}
	}

	const header = (
		<SettingsHeader
			title="Personal prompt"
			description={`Standing instructions added to the system prompt of every session you (${user}) start, on top of the built-in ones — tone, preferences, how you like work reported. It follows you across devices and surfaces (same identity as your memory store), and is never given to automations. Leave empty to turn it off.`}
		/>
	);

	if (prompt === null)
		return (
			<SettingsPanel>
				{header}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<LoadingState>Loading your prompt…</LoadingState>
				)}
			</SettingsPanel>
		);

	const dirty = prompt !== savedPrompt;
	return (
		<SettingsPanel>
			{header}
			<SettingsSection>
				<textarea
					className={settingsTextareaClass}
					rows={10}
					placeholder='e.g. "Keep answers short. Prefer tables for comparisons. Always mention which files you touched."'
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
					}}
				/>
				<div className="mt-3 flex items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={busy || !dirty}
						onClick={save}
					>
						{busy ? "Saving…" : "Save"}
					</Button>
					{dirty && !busy && (
						<span className="text-label font-medium text-faint">
							Unsaved changes
						</span>
					)}
				</div>
			</SettingsSection>
		</SettingsPanel>
	);
}

function MemoryPanel() {
	const [scopes, setScopes] = useState<MemoryScopeDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	function reload() {
		fetchMemory()
			.then((r) => setScopes(r.scopes))
			.catch((e) => setError(e.message));
	}
	useEffect(reload, []);

	const header = (
		<SettingsHeader
			title="Memory"
			description={`Durable facts injected into every matching session: team memory is workspace-wide (shared with ${AGENT_NAME} in Slack), repo memory follows the session's repo, people memory follows whoever is prompting. Sessions manage these with the opensession-memory tools ("remember that…"); this page is the same store, maintained by hand.`}
		/>
	);

	if (!scopes)
		return (
			<SettingsPanel>
				{header}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<LoadingState>Loading memory…</LoadingState>
				)}
			</SettingsPanel>
		);

	return (
		<SettingsPanel>
			{header}
			{MEMORY_GROUPS.map((g) => {
				const inGroup = scopes.filter((s) => s.scope.kind === g.kind);
				if (!inGroup.length && !g.fixed) return null;
				return (
					<div key={g.kind}>
						<SettingsGroupLabel>{g.title}</SettingsGroupLabel>
						{inGroup.map((s) => (
							<MemoryScopeCard key={s.scope.key} scoped={s} onChanged={reload} />
						))}
						{!inGroup.length && (
							<EmptyState placement="card">Nothing remembered yet.</EmptyState>
						)}
					</div>
				);
			})}
		</SettingsPanel>
	);
}

function WarmPreviewsPanel() {
	const [repos, setRepos] = useState<WarmTemplateEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchWarmTemplates()
			.then((r) => alive && setRepos(r.repos))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, []);

	// Poll while a refresh runs so the status line flips to "Warm at <sha>"
	// on its own.
	useEffect(() => {
		if (!repos?.some((e) => e.refreshing)) return;
		let alive = true;
		const t = setTimeout(() => {
			fetchWarmTemplates()
				.then((r) => alive && setRepos(r.repos))
				.catch(() => {});
		}, 5000);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [repos]);

	function apply(p: Promise<{ repos: WarmTemplateEntry[] }>) {
		p.then((r) => setRepos(r.repos)).catch((e) => setError(e.message));
	}

	const header = (
		<SettingsHeader
			title="Warm deps"
			description="Keep a template worktree per repo with node_modules installed, refreshed from its default branch on a schedule. Prebuilt spares of those dep trees are adopted into new session worktrees near-instantly, instead of every session paying a cold install."
		/>
	);

	if (!repos)
		return (
			<SettingsPanel>
				{header}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<LoadingState>Loading repos…</LoadingState>
				)}
			</SettingsPanel>
		);

	return (
		<SettingsPanel>
			{header}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

			<SettingCard>
				{repos.map((entry) => {
					const s = entry.state;
					const status = entry.refreshing
						? "Refreshing now — updating the template…"
						: !entry.enabled
							? "Off — fresh worktrees install cold."
							: s?.ok
								? `Warm at ${s.sha} · refreshed ${warmAgo(s.refreshedAt)} · ${
										entry.spares
									} spare${entry.spares === 1 ? "" : "s"} ready`
								: s?.lastError
									? `Last refresh failed: ${s.lastError}`
									: "Enabled — first refresh runs shortly.";
					return (
						<SettingRow
							key={entry.repoId}
							title={entry.repoId}
							desc={status}
							control={
								<div className="flex items-center gap-2">
									{entry.enabled && (
										<>
											<Button
												size="sm"
												disabled={entry.refreshing}
												onClick={() =>
													apply(refreshWarmTemplateNow(entry.repoId))
												}
											>
												{entry.refreshing ? "Building…" : "Run now"}
											</Button>
											<Select
												label={`Refresh interval for ${entry.repoId}`}
												value={String(entry.intervalHours)}
												options={WARM_INTERVAL_OPTIONS}
												onChange={(v) =>
													apply(
														updateWarmTemplate(entry.repoId, {
															intervalHours: parseInt(v, 10),
														}),
													)
												}
											/>
										</>
									)}
									<Toggle
										label={`Warm deps for ${entry.repoId}`}
										checked={entry.enabled}
										onChange={(v) =>
											apply(updateWarmTemplate(entry.repoId, { enabled: v }))
										}
									/>
								</div>
							}
						/>
					);
				})}
			</SettingCard>
		</SettingsPanel>
	);
}

// ── Preview pool: warm pre-booted dev-server containers per repo — the
// Preview button claims one instantly instead of paying a cold boot. ──

const POOL_COUNT_OPTIONS = [0, 1, 2, 3].map((n) => ({
	value: String(n),
	label: String(n),
}));

const POOL_BACKEND_OPTIONS = [
	{ value: "docker", label: "Docker (local)" },
	{ value: "daytona", label: "Daytona (remote)" },
	{ value: "microvm", label: "MicroVM (snapshots)" },
];

function PreviewPoolPanel() {
	const [repos, setRepos] = useState<PreviewPoolEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchPreviewPool()
			.then((r) => alive && setRepos(r.repos))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, []);

	// Poll while a golden build runs (or containers are warming) so the
	// status line updates on its own.
	useEffect(() => {
		if (
			!repos?.some(
				(e) => e.goldenBuilding || e.containers.some((c) => c.state === "warming"),
			)
		)
			return;
		let alive = true;
		const t = setTimeout(() => {
			fetchPreviewPool()
				.then((r) => alive && setRepos(r.repos))
				.catch(() => {});
		}, 5000);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [repos]);

	function apply(p: Promise<{ repos: PreviewPoolEntry[] }>) {
		p.then((r) => setRepos(r.repos)).catch((e) => setError(e.message));
	}

	const header = (
		<SettingsHeader
			title="Preview pool"
			description="Keep dev-server containers pre-booted from a nightly golden image, so the Preview button claims one in seconds instead of paying a cold boot. Claims follow the session's branch (small edits stream in live; big branch jumps reboot the dev server cleanly) and are released on stop or after sitting unwatched."
		/>
	);

	if (!repos)
		return (
			<SettingsPanel>
				{header}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<LoadingState>Loading repos…</LoadingState>
				)}
			</SettingsPanel>
		);

	return (
		<SettingsPanel>
			{header}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

			<SettingCard>
				{repos.map((entry) => {
					const counts = {
						ready: entry.containers.filter((c) => c.state === "ready").length,
						paused: entry.containers.filter((c) => c.state === "paused").length,
						warming: entry.containers.filter((c) => c.state === "warming")
							.length,
						claimed: entry.containers.filter((c) => c.state === "claimed")
							.length,
					};
					const poolBits = [
						counts.ready && `${counts.ready} ready`,
						counts.paused && `${counts.paused} paused`,
						counts.warming && `${counts.warming} warming`,
						counts.claimed && `${counts.claimed} in use`,
					]
						.filter(Boolean)
						.join(" · ");
					const status = entry.goldenBuilding
						? "Building the golden image — boots the dev server once, warms routes, commits (~10 min)…"
						: !entry.config.enabled
							? "Off — previews boot cold on the host."
							: (entry.config.backend || "docker") === "daytona"
								? `Daytona sandboxes${poolBits ? ` · ${poolBits}` : " · pool provisioning (first sandbox takes ~10 min)…"}`
								: (entry.config.backend || "docker") === "microvm"
									? `Firecracker snapshots — claims restore in ~2s${poolBits ? ` · ${poolBits}` : " · restore-on-demand (no warm members needed)"}`
								: entry.golden?.sha
									? `Image at ${entry.golden.sha.slice(0, 10)} · built ${warmAgo(
											entry.golden.builtAt,
										)}${poolBits ? ` · ${poolBits}` : " · pool filling…"}${
											entry.golden.lastError
												? ` · last build failed: ${entry.golden.lastError.slice(0, 120)}`
												: ""
										}`
									: "Enabled — first golden image builds shortly.";
					return (
						<SettingRow
							key={entry.repoId}
							title={entry.repoId}
							desc={status}
							control={
								<div className="flex items-center gap-2">
									{entry.config.enabled && (
										<>
											<Select
												label={`Preview pool backend for ${entry.repoId}`}
												value={entry.config.backend || "docker"}
												options={POOL_BACKEND_OPTIONS}
												onChange={(v) =>
													apply(
														updatePreviewPool(entry.repoId, {
															backend: v as "docker" | "daytona" | "microvm",
														}),
													)
												}
											/>
											{(entry.config.backend || "docker") === "docker" && (
												<Button
													size="sm"
													disabled={entry.goldenBuilding}
													onClick={() =>
														apply(refreshPreviewPoolGolden(entry.repoId))
													}
												>
													{entry.goldenBuilding ? "Building…" : "Rebuild image"}
												</Button>
											)}
											<Select
												label={`Warm running containers for ${entry.repoId}`}
												value={String(entry.config.running)}
												options={POOL_COUNT_OPTIONS}
												onChange={(v) =>
													apply(
														updatePreviewPool(entry.repoId, {
															running: parseInt(v, 10),
														}),
													)
												}
											/>
											<Select
												label={`Paused spare containers for ${entry.repoId}`}
												value={String(entry.config.paused)}
												options={POOL_COUNT_OPTIONS}
												onChange={(v) =>
													apply(
														updatePreviewPool(entry.repoId, {
															paused: parseInt(v, 10),
														}),
													)
												}
											/>
										</>
									)}
									<Toggle
										label={`Preview pool for ${entry.repoId}`}
										checked={entry.config.enabled}
										onChange={(v) =>
											apply(updatePreviewPool(entry.repoId, { enabled: v }))
										}
									/>
								</div>
							}
						/>
					);
				})}
			</SettingCard>
		</SettingsPanel>
	);
}

// ── Keychain: per-person credentials sessions can BORROW with your approval
// (src/server/keychain.ts). Registration lives here rather than in a tool
// because a secret pasted into a session prompt is a secret in the transcript. ──
function KeychainPanel() {
	const [data, setData] = useState<{
		credentials: KeychainCredentialDto[];
		grants: KeychainGrantDto[];
		asks: KeychainAskDto[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [service, setService] = useState("");
	const [host, setHost] = useState("");
	const [secret, setSecret] = useState("");
	const [description, setDescription] = useState("");
	const [header, setHeader] = useState("");
	const [methods, setMethods] = useState("");
	const [prefixes, setPrefixes] = useState("");
	const [busy, setBusy] = useState(false);

	const reload = useCallback(() => {
		fetchKeychain()
			.then(setData)
			.catch((e) => setError(e.message));
	}, []);
	useEffect(reload, [reload]);

	const submit = () => {
		setBusy(true);
		addKeychainCredential({
			service: service.trim(),
			host: host.trim(),
			secret,
			...(description.trim() ? { description: description.trim() } : {}),
			...(header.trim() ? { injection: { header: header.trim() } } : {}),
			...(methods.trim()
				? { allowedMethods: methods.split(",").map((m) => m.trim()).filter(Boolean) }
				: {}),
			...(prefixes.trim()
				? { allowedPathPrefixes: prefixes.split(",").map((p) => p.trim()).filter(Boolean) }
				: {}),
		})
			.then(() => {
				// Clear the secret first and always — it must not survive a
				// failed reload in a React state a devtools user can read back.
				setSecret("");
				setService("");
				setHost("");
				setDescription("");
				setHeader("");
				setMethods("");
				setPrefixes("");
				setAdding(false);
				reload();
			})
			.catch((e) => setError(e.message))
			.finally(() => setBusy(false));
	};

	const panelHeader = (
		<SettingsHeader
			title="Keychain"
			description="Credentials you own that a session can borrow — with your approval, for a stated purpose. Approved calls go through a broker that injects the secret server-side, so the agent never sees it. Grants are scoped to one session, expire, and are revocable."
		/>
	);

	if (!data)
		return (
			<SettingsPanel>
				{panelHeader}
				{error ? <InlineAlert>{error}</InlineAlert> : <LoadingState>Loading keychain…</LoadingState>}
			</SettingsPanel>
		);

	const byId = new Map(data.credentials.map((c) => [c.id, c]));
	const activeGrants = data.grants.filter((g) => g.status === "active");
	const pendingAsks = data.asks.filter((a) => a.status === "pending");

	return (
		<SettingsPanel>
			{panelHeader}
			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

			<SettingsGroupLabel className="flex items-center justify-between gap-2">
				Credentials
				<Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
					{adding ? "Cancel" : "Add credential"}
				</Button>
			</SettingsGroupLabel>

			{adding && (
				<SettingCard>
					<div className="flex flex-col gap-2 p-4">
						<input
							className={settingsInputClass}
							value={service}
							onChange={(e) => setService(e.target.value)}
							placeholder="service slug, e.g. vercel"
							aria-label="Service slug"
						/>
						<input
							className={settingsInputClass}
							value={host}
							onChange={(e) => setHost(e.target.value)}
							placeholder="api host, e.g. api.vercel.com"
							aria-label="API host"
						/>
						<input
							className={settingsInputClass}
							type="password"
							value={secret}
							onChange={(e) => setSecret(e.target.value)}
							placeholder="secret (never shown again, never sent to a model)"
							aria-label="Secret"
						/>
						<input
							className={settingsInputClass}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="what it's for (optional)"
							aria-label="Description"
						/>
						<input
							className={settingsInputClass}
							value={header}
							onChange={(e) => setHeader(e.target.value)}
							placeholder="header (optional, default: Authorization: Bearer)"
							aria-label="Injection header"
						/>
						<input
							className={settingsInputClass}
							value={methods}
							onChange={(e) => setMethods(e.target.value)}
							placeholder="allowed methods, comma-separated (optional — e.g. GET)"
							aria-label="Allowed methods"
						/>
						<input
							className={settingsInputClass}
							value={prefixes}
							onChange={(e) => setPrefixes(e.target.value)}
							placeholder="allowed path prefixes, comma-separated (optional — e.g. /v1/deployments)"
							aria-label="Allowed path prefixes"
						/>
						<SettingsHint>
							Narrow the methods and paths where you can — a grant can only ever reach what the
							credential allows, so this is the ceiling on anything you approve later.
						</SettingsHint>
						<Button
							size="sm"
							disabled={busy || !service.trim() || !host.trim() || !secret}
							onClick={submit}
						>
							{busy ? "Saving…" : "Save credential"}
						</Button>
					</div>
				</SettingCard>
			)}

			{data.credentials.length === 0 ? (
				<EmptyState placement="card">
					No credentials yet. Add one to let sessions ask you for scoped access instead of going
					without — or instead of a token ending up in a prompt.
				</EmptyState>
			) : (
				<SettingCard>
					{data.credentials.map((c) => (
						<SettingRow
							key={c.id}
							title={`${c.service} · ${c.host}`}
							desc={[
								`owner ${c.owner}`,
								c.description,
								c.allowedMethods?.length ? `methods ${c.allowedMethods.join("/")}` : null,
								c.allowedPathPrefixes?.length
									? `paths ${c.allowedPathPrefixes.join(", ")}`
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
							control={
								<Button
									size="sm"
									variant="ghost"
									onClick={() =>
										deleteKeychainCredential(c.id)
											.then(reload)
											.catch((e) => setError(e.message))
									}
								>
									Delete
								</Button>
							}
						/>
					))}
				</SettingCard>
			)}

			{pendingAsks.length > 0 && (
				<>
					<SettingsGroupLabel>Awaiting your answer</SettingsGroupLabel>
					<SettingCard>
						{pendingAsks.map((a) => (
							<SettingRow
								key={a.id}
								title={`${byId.get(a.credentialId)?.service ?? a.credentialId} — ${a.requestedBy}`}
								desc={`${a.requestedMode} · ${a.purpose}`}
								control={null}
							/>
						))}
					</SettingCard>
					<SettingsHint>
						Answer these where they were asked — the Slack DM, or the card in the session.
					</SettingsHint>
				</>
			)}

			<SettingsGroupLabel>Active grants</SettingsGroupLabel>
			{activeGrants.length === 0 ? (
				<EmptyState placement="card">No session currently holds a keychain grant.</EmptyState>
			) : (
				<SettingCard>
					{activeGrants.map((g) => (
						<SettingRow
							key={g.id}
							title={`${byId.get(g.credentialId)?.service ?? g.credentialId} → ${g.requestedBy}`}
							desc={`${g.mode} · expires ${new Date(g.expiresAt).toLocaleString()} · ${g.purpose}`}
							control={
								<Button
									size="sm"
									variant="ghost"
									onClick={() =>
										revokeKeychainGrant(g.id)
											.then(reload)
											.catch((e) => setError(e.message))
									}
								>
									Revoke
								</Button>
							}
						/>
					))}
				</SettingCard>
			)}
		</SettingsPanel>
	);
}

// ── Papercuts: the cross-session friction log agents append via the
// opensession-papercuts tools — per-repo toggles + the recent entries. ──
function PapercutsPanel() {
	const [repos, setRepos] = useState<PapercutsRepoConfig[] | null>(null);
	const [entries, setEntries] = useState<PapercutDto[]>([]);
	const [repoFilter, setRepoFilter] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchPapercuts({ repo: repoFilter || undefined, days: 30 })
			.then((r) => {
				if (!alive) return;
				setRepos(r.repos);
				setEntries(r.entries);
			})
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [repoFilter]);

	const header = (
		<SettingsHeader
			title="Papercuts"
			description="Small frictions agents log in the moment while working — retried tool calls, flaky commands, misleading errors, undocumented gotchas. None block on their own; together they show where a repo needs sanding down. The nightly Dreaming digest reads them too."
		/>
	);

	if (!repos)
		return (
			<SettingsPanel>
				{header}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<LoadingState>Loading papercuts…</LoadingState>
				)}
			</SettingsPanel>
		);

	return (
		<SettingsPanel>
			{header}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

			<SettingsGroupLabel>Repos</SettingsGroupLabel>
			<SettingCard>
				{repos.map((r) => (
					<SettingRow
						key={r.repoId}
						title={r.repoId}
						desc={
							r.enabled
								? "Sessions and automations in this repo get the log_papercut tool and the nudge to use it."
								: "Off — runs in this repo don't log papercuts."
						}
						control={
							<Toggle
								label={`Papercuts for ${r.repoId}`}
								checked={r.enabled}
								onChange={(v) =>
									setPapercutsRepoEnabled(r.repoId, v)
										.then((res) => setRepos(res.repos))
										.catch((e) => setError(e.message))
								}
							/>
						}
					/>
				))}
			</SettingCard>

			<SettingsGroupLabel className="flex items-center justify-between gap-2">
				Last 30 days · {entries.length} logged
				<Select
					label="Filter papercuts by repo"
					value={repoFilter}
					options={[
						{ value: "", label: "All repos" },
						...repos.map((r) => ({ value: r.repoId, label: r.repoId })),
					]}
					onChange={setRepoFilter}
				/>
			</SettingsGroupLabel>
			{entries.length === 0 ? (
				<EmptyState placement="card">
					Nothing logged yet — papercuts appear here as agents hit friction.
				</EmptyState>
			) : (
				<SettingCard>
					{entries.map((e, i) => (
						<div
							key={`${e.ts}-${i}`}
							className="border-b border-line px-4 py-3 last:border-b-0"
						>
							<div className="text-body leading-relaxed text-fg">
								{e.message}
							</div>
							<div className="mt-1 text-meta text-faint">
								{[
									e.repo,
									e.by,
									e.runKind && e.runKind !== "prompt" ? e.runKind : null,
									warmAgo(e.ts),
								]
									.filter(Boolean)
									.join(" · ")}
							</div>
						</div>
					))}
				</SettingCard>
			)}
		</SettingsPanel>
	);
}

/** Summarize one audit event for its row (the details live in the expand). */
function auditSummary(e: Record<string, unknown>): string {
	const parts: string[] = [];
	if (e.tool_name) parts.push(String(e.tool_name));
	if (e.action) parts.push(`${e.context ? `${e.context}.` : ""}${e.action}`);
	if (e.decision) parts.push(`decision: ${e.decision}`);
	if (e.account) parts.push(`account: ${e.account}`);
	if (e.model) parts.push(String(e.model));
	if (typeof e.ok === "boolean") parts.push(e.ok ? "ok" : "failed");
	if (e.error) parts.push(`error: ${String(e.error).slice(0, 80)}`);
	if (e.text_snippet) parts.push(`“${String(e.text_snippet).slice(0, 100)}”`);
	return parts.join(" · ");
}

/** Read-only viewer over ~/.backstage-audit daily JSONL (agent flight recorder). */
function AuditPanel() {
	const [dates, setDates] = useState<string[]>([]);
	const [date, setDate] = useState("");
	const [type, setType] = useState("");
	const [types, setTypes] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [all, setAll] = useState(false);
	const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
	const [total, setTotal] = useState(0);
	const [expanded, setExpanded] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);

	// Debounced reload on any filter change.
	useEffect(() => {
		const t = setTimeout(() => {
			setLoading(true);
			fetchAudit({ date: date || undefined, type: type || undefined, q: q || undefined, all })
				.then((page) => {
					setDates(page.dates);
					if (!date && page.dates.length) {
						setDate(page.dates[0]);
						return; // effect re-runs with the date set
					}
					setEvents(page.events || []);
					setTotal(page.total || 0);
					setTypes(page.types || []);
					setExpanded(null);
					setLoading(false);
				})
				.catch(() => setLoading(false));
		}, 250);
		return () => clearTimeout(t);
	}, [date, type, q, all]);

	async function loadMore() {
		const page = await fetchAudit({
			date,
			type: type || undefined,
			q: q || undefined,
			all,
			offset: events.length,
		});
		setEvents([...events, ...(page.events || [])]);
	}

	return (
		<SettingsPanel>
			<SettingsHeader
				title="Audit log"
				description="Every agent run's structured events — prompts, tool decisions, account switches, human confirmations. Read-only; files live under ~/.backstage-audit (400-day retention)."
			/>

			<div className="mb-3 flex flex-wrap items-center gap-2 px-4">
				<select className={settingsSelectClass} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date">
					{dates.map((d) => (
						<option key={d} value={d}>
							{d}
						</option>
					))}
				</select>
				<select className={settingsSelectClass} value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type">
					<option value="">{all ? "All events" : "Significant events"}</option>
					{types.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				<label className="flex cursor-pointer items-center gap-2 text-label text-dim">
					<Switch checked={all} onCheckedChange={setAll} />
					Include tool firehose
				</label>
				<input
					className={`${settingsSelectClass} min-w-[140px] flex-1`}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Search (session id, tool, text…)"
					aria-label="Search audit log"
				/>
			</div>

			<div className="mb-2 px-4 text-meta text-faint">
				{loading ? "Loading…" : `${events.length} of ${total} events (newest first)`}
			</div>

			<SettingCard>
				{events.map((e, i) => {
					const time = String(e.time || "").slice(11, 19);
					const t = String(e.kind || e.msg || "event");
					const sid = typeof e.bks_session_id === "string" ? e.bks_session_id : "";
					return (
						<div key={i} className={expanded === i ? "bg-pressed" : ""}>
							<button
								className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 px-4 py-1.5 text-left text-label hover:bg-hover"
								onClick={() => setExpanded(expanded === i ? null : i)}
							>
								<span className="text-faint shrink-0">{time}</span>
								<span className="text-fg font-medium shrink-0">{t}</span>
								{e.run_kind ? <span className="text-faint shrink-0">{String(e.run_kind)}</span> : null}
								<span className="text-dim truncate">{auditSummary(e)}</span>
								{sid && (
									<a
										className="ml-auto shrink-0 font-mono text-meta text-faint underline"
										href={`${BASE_PATH}/session/${sid}`}
										onClick={(ev) => ev.stopPropagation()}
									>
										{sid.slice(0, 18)}…
									</a>
								)}
							</button>
							{expanded === i && (
								<pre className="m-0 overflow-x-auto border-t border-line px-4 py-2.5 text-meta leading-relaxed text-dim">
									{JSON.stringify(e, null, 2)}
								</pre>
							)}
						</div>
					);
				})}
				{!loading && events.length === 0 && (
					<EmptyState placement="row">No events match.</EmptyState>
				)}
			</SettingCard>

			{events.length < total && (
				<div className="mt-2">
					<Button size="sm" onClick={loadMore}>
						Load more ({total - events.length} left)
					</Button>
				</div>
			)}
		</SettingsPanel>
	);
}

/** Composer preferences — per-browser, like theme (lib/send-key). */
function ComposerPanel() {
	const [sendKey, setSendKey] = useState<SendKeyPref>(getSendKeyPref);
	const [busySend, setBusySend] = useState<BusySendPrefs>(getBusySendPrefs);
	const [vimMode, setVimMode] = useState<boolean>(getVimModePref);
	const [pinNew, setPinNew] = useState<boolean>(getPinNewSessions);
	const [pinNewWs, setPinNewWs] = useState<boolean>(getPinNewWorkspaces);
	useEffect(() => onSendKeyChanged(() => setSendKey(getSendKeyPref())), []);
	useEffect(() => onBusySendChanged(() => setBusySend(getBusySendPrefs())), []);
	useEffect(() => onVimModeChanged(() => setVimMode(getVimModePref())), []);
	useEffect(
		() => onPinNewSessionsChanged(() => setPinNew(getPinNewSessions())),
		[],
	);
	useEffect(
		() => onPinNewWorkspacesChanged(() => setPinNewWs(getPinNewWorkspaces())),
		[],
	);
	// Per-user default model for NEW sessions ("" = no preference — the
	// workspace default from GET /api/models applies).
	const [modelPref, setModelPref] = useState<string>(getDefaultModelPref);
	const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
	useEffect(
		() => onDefaultModelPrefChanged(() => setModelPref(getDefaultModelPref())),
		[],
	);
	useEffect(() => {
		fetchModels()
			.then((m) => setModelOptions(m.models))
			.catch(() => {});
	}, []);

	return (
		<SettingsPanel>
			<SettingsHeader
				title="Composer"
				description="How the message box behaves when you write and send."
			/>
			<SettingCard>
				<SettingRow
					title="Default model"
					desc="What new sessions you start are preselected to run on. No preference keeps the workspace default. Stored per user, follows you across devices."
					control={
						<Select
							label="Default model"
							value={
								modelPref &&
								modelOptions.some((m) => m.id === modelPref)
									? modelPref
									: ""
							}
							options={[
								{ value: "", label: "No preference" },
								...modelOptions.map((m) => ({
									value: m.id,
									label: m.label,
								})),
							]}
							onChange={setDefaultModelPref}
						/>
					}
				/>
				<SettingRow
					title="Send messages with"
					desc={`Choose which key combination sends messages. Use ${
						sendKey === "mod-enter" ? "↵" : "⇧↵"
					} for new lines.`}
					control={
						<Select
							label="Send messages with"
							value={sendKey}
							options={[
								{ value: "enter", label: "Enter" },
								{ value: "mod-enter", label: MOD_ENTER_LABEL },
							]}
							onChange={setSendKeyPref}
						/>
					}
				/>
				<SettingRow
					title="Follow-up behavior"
					desc={
						<>
							What {sendKey === "enter" ? "Enter" : "sending"} does while the
							agent is busy. Queue waits until the run fully finishes
							(including running worker sessions); Steer folds your message
							into the running turn at its next step, without stopping the
							work. Stored per user, follows you across devices.
						</>
					}
					control={
						<Select
							label="Follow-up behavior"
							value={busySend.enter}
							options={[
								{ value: "queue", label: "Queue" },
								{ value: "steer", label: "Steer" },
							]}
							onChange={(v) => setBusySendPref("enter", v)}
						/>
					}
				/>
				{sendKey === "enter" && (
					<SettingRow
						title={`${MOD_ENTER_LABEL} while busy`}
						desc={
							<>
								What {MOD_ENTER_GLYPH} does while the agent is busy — set both
								to the same action if you never want the modifier to change
								it. Also applies when ⌘/Ctrl-clicking the send button.
							</>
						}
						control={
							<Select
								label={`${MOD_ENTER_LABEL} while busy`}
								value={busySend.mod}
								options={[
									{ value: "queue", label: "Queue" },
									{ value: "steer", label: "Steer" },
								]}
								onChange={(v) => setBusySendPref("mod", v)}
							/>
						}
					/>
				)}
				<SettingRow
					title="Vim mode"
					desc="Modal editing in the message composer: Esc for normal mode, the usual motions and operators, i to type. Enter still sends."
					control={
						<Toggle label="Vim mode" checked={vimMode} onChange={setVimModePref} />
					}
				/>
				<SettingRow
					title="Pin new sessions"
					desc="Automatically pin a session to your tab strip when you start it."
					control={
						<Toggle
							label="Pin new sessions"
							checked={pinNew}
							onChange={setPinNewSessions}
						/>
					}
				/>
				<SettingRow
					title="Pin new workspaces"
					desc="Also pin a workspace to your tab strip when you create one."
					control={
						<Toggle
							label="Pin new workspaces"
							checked={pinNewWs}
							onChange={setPinNewWorkspaces}
						/>
					}
				/>
			</SettingCard>
		</SettingsPanel>
	);
}

// ── Workspace · General ─────────────────────────────────────────────────────

const IDENTITY_INPUT_CLASS = cn(settingsInputClass, "w-[140px]");

/**
 * Instance identity. The source of truth is ~/.backstage/config.json
 * (persona.name / branding.productName) on the server — there is no
 * settings-write API for the config file yet, so the fields render the
 * built-in defaults, disabled, until a read/write endpoint exists (the
 * needed backend change is documented in docs/rename-opensession-plan.md).
 */
function WorkspacePanel() {
	return (
		<SettingsPanel>
			<SettingsHeader
				title="General"
				description="Workspace-wide settings, shared by everyone on this instance."
			/>
			<SettingsGroupLabel>Identity</SettingsGroupLabel>
			<SettingCard>
				<SettingRow
					title="Agent name"
					desc={
						<>
							What the agent calls itself in prompts, Slack messages, and the
							UI. Configured via <code>persona.name</code> in{" "}
							<code>~/.backstage/config.json</code> on the server.
						</>
					}
					control={
						<Tooltip label="Wire-up pending. Edit ~/.backstage/config.json for now.">
							{/* Disabled inputs swallow hover events, so the tooltip
							    hangs off a wrapping span. */}
							<span className="inline-flex">
								<input
									className={IDENTITY_INPUT_CLASS}
									value={AGENT_NAME}
									disabled
									readOnly
									aria-label="Agent name"
								/>
							</span>
						</Tooltip>
					}
				/>
				<SettingRow
					title="Product name"
					desc={
						<>
							What this app calls itself in titles and headers. Configured via{" "}
							<code>branding.productName</code> in the same config file.
						</>
					}
					control={
						<Tooltip label="Wire-up pending. Edit ~/.backstage/config.json for now.">
							<span className="inline-flex">
								<input
									className={IDENTITY_INPUT_CLASS}
									value={PRODUCT_NAME}
									disabled
									readOnly
									aria-label="Product name"
								/>
							</span>
						</Tooltip>
					}
				/>
			</SettingCard>
			<SettingsHint>
				Changes to the config file apply to new runs without a restart; a
				settings-write API for these fields is pending.
			</SettingsHint>
		</SettingsPanel>
	);
}

function AppearancePanel() {
	const [pref, setPref] = useState<ThemePref>(getThemePref);
	useEffect(() => onThemeChanged(() => setPref(getThemePref())), []);
	const [wsTime, setWsTime] = useState<WsTimePref>(getWsTimePref);
	useEffect(() => onWsTimeChanged(() => setWsTime(getWsTimePref())), []);
	const [hiddenSidebarTools, setHiddenSidebarTools] = useState(
		readHiddenSidebarTools,
	);
	const [sidebarFeeds, setSidebarFeeds] = useState<FeedDescriptor[]>([]);
	const [hiddenSidebarFeeds, setHiddenSidebarFeeds] = useState(
		readHiddenSidebarFeeds,
	);
	useEffect(() => {
		let alive = true;
		fetchFeeds()
			.then((feeds) => {
				if (alive) setSidebarFeeds(feeds);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	const [sidebarOrder, setSidebarOrderState] = useState(getSidebarOrder);
	const sidebarOrderRef = React.useRef(sidebarOrder);
	useEffect(
		() =>
			onSidebarOrderChanged(() => {
				const next = getSidebarOrder();
				sidebarOrderRef.current = next;
				setSidebarOrderState(next);
			}),
		[],
	);
	useEffect(
		() =>
			onSidebarToolsChanged(() =>
				setHiddenSidebarTools(readHiddenSidebarTools()),
			),
		[],
	);
	useEffect(
		() =>
			onSidebarFeedsChanged(() =>
				setHiddenSidebarFeeds(readHiddenSidebarFeeds()),
			),
		[],
	);
	const [turnActivity, setTurnActivity] =
		useState<TurnActivityPref>(getTurnActivityPref);
	useEffect(
		() => onTurnActivityChanged(() => setTurnActivity(getTurnActivityPref())),
		[],
	);

	return (
		<SettingsPanel>
			<SettingsHeader
				title="Appearance"
				description="How this app looks on this device, and what the sidebar shows."
			/>
			<SettingsGroupLabel>Theme</SettingsGroupLabel>
			<SettingsSection>
				<div className="theme-cards" role="radiogroup" aria-label="Theme">
					{THEME_OPTIONS.map((o) => (
						<ThemeCard
							key={o.value}
							option={o.value}
							active={pref === o.value}
							onClick={() => {
								setThemePref(o.value);
								setPref(o.value);
							}}
						/>
					))}
				</div>
				<div className="mt-3 text-meta text-faint">
					{pref === "system"
						? "Matches your operating system."
						: `Always ${pref} mode.`}
				</div>
			</SettingsSection>

			<SettingsGroupLabel>
				Chat
			</SettingsGroupLabel>
			<SettingCard>
				<SettingRow
					title="Tool calls & messages"
					desc="How each turn's working — tool calls and in-between messages — folds in the chat. Work stays folded by default; expanding a turn does not open its individual tool inputs."
					control={
						<Select
							label="Tool calls & messages"
							value={turnActivity}
							options={[
								{ value: "collapsed", label: "Always folded" },
								{ value: "auto", label: "Expand while running" },
								{ value: "expanded", label: "Always expanded" },
							]}
							onChange={setTurnActivityPref}
						/>
					}
				/>
			</SettingCard>

			<SettingsGroupLabel>
				Sidebar
			</SettingsGroupLabel>
			<SettingCard>
				<SettingsRow className="flex-col !items-stretch">
					<SettingRowText>
						<SettingRowTitle>Section order</SettingRowTitle>
						<SettingRowDescription>
							Reorder the sections below Tools. Stored per user and follows you
							across devices.
						</SettingRowDescription>
					</SettingRowText>
					<Reorder.Group
						as="div"
						axis="y"
						values={sidebarOrder}
						onReorder={(next: SidebarSectionId[]) => {
							sidebarOrderRef.current = next;
							setSidebarOrderState(next);
						}}
						className="mt-2 overflow-hidden rounded-lg bg-surface"
					>
						{sidebarOrder.map((section, index) => (
							<SidebarOrderRow
								key={section}
								section={section}
								index={index}
								onCommit={() => setSidebarOrder(sidebarOrderRef.current)}
							/>
						))}
					</Reorder.Group>
				</SettingsRow>
				<SettingRow
					title="Show last used time"
					desc="Show when each workspace was last active in the sidebar. A live run always shows its running time regardless."
					control={
						<Select
							label="Show last used time"
							value={wsTime}
							options={[
								{ value: "off", label: "Off" },
								{ value: "always", label: "Always" },
								{ value: "hover", label: "On hover" },
							]}
							onChange={setWsTimePref}
						/>
					}
				/>
				{SIDEBAR_TOOL_IDS.map((toolId) => (
					<SettingRow
						key={toolId}
						title={SIDEBAR_TOOL_LABELS[toolId]}
						desc="Show this tool in the sidebar."
						control={
							<Toggle
								label={`Show ${SIDEBAR_TOOL_LABELS[toolId]} in sidebar`}
								checked={!hiddenSidebarTools.has(toolId)}
								onChange={(visible) =>
									setSidebarToolVisible(toolId, visible)
								}
							/>
						}
					/>
				))}
				{sidebarFeeds.map((feed) => (
					<SettingRow
						key={feed.id}
						title={feed.title}
						desc="Show this source in the sidebar. Hidden sources stop refreshing until shown again."
						control={
							<Toggle
								label={`Show ${feed.title} in sidebar`}
								checked={!hiddenSidebarFeeds.has(feed.id)}
								onChange={(visible) =>
									setSidebarFeedVisible(feed.id, visible)
								}
							/>
						}
					/>
				))}
			</SettingCard>
		</SettingsPanel>
	);
}

function SidebarOrderRow({
	section,
	index,
	onCommit,
}: {
	section: SidebarSectionId;
	index: number;
	onCommit: () => void;
}) {
	return (
		<Reorder.Item
			as="div"
			value={section}
			onDragEnd={onCommit}
			whileDrag={{
				scale: 1.015,
				zIndex: 3,
				borderRadius: "calc(8px * var(--rf))",
				boxShadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
			}}
			className="relative flex min-h-11 touch-none cursor-grab select-none items-center gap-2 border-b border-line bg-surface px-3 first:rounded-t-lg last:rounded-b-lg last:border-b-0 active:cursor-grabbing"
		>
			<span className="w-5 text-meta tabular-nums text-faint">
				{index + 1}
			</span>
			<span className="min-w-0 flex-1 text-body font-medium text-fg">
				{SIDEBAR_SECTION_LABELS[section]}
			</span>
			<span
				className="inline-flex size-9 items-center justify-center text-faint"
				aria-hidden="true"
			>
				<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
					<circle cx="6" cy="4" r="1.2" />
					<circle cx="12" cy="4" r="1.2" />
					<circle cx="6" cy="9" r="1.2" />
					<circle cx="12" cy="9" r="1.2" />
					<circle cx="6" cy="14" r="1.2" />
					<circle cx="12" cy="14" r="1.2" />
				</svg>
			</span>
		</Reorder.Item>
	);
}
