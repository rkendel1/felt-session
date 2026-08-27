import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	fetchModels,
	fetchPersonalOutputStyle,
	fetchPersonalPrompt,
	fetchRepos,
	savePersonalOutputStyle,
	savePersonalPrompt,
	type ModelOption,
	type PersonalOutputStyle,
	type RepoInfo,
} from "../../lib/api";
import { BASE_PATH } from "../../lib/base";
import {
	getBusySendPrefs,
	onBusySendChanged,
	setBusySendPref,
	type BusySendGesture,
	type BusySendPref,
	type BusySendPrefs,
} from "../../lib/busy-send-pref";
import {
	getDefaultModelPref,
	onDefaultModelPrefChanged,
	setDefaultModelPref,
} from "../../lib/default-model-pref";
import {
	getDefaultRepoPref,
	onDefaultRepoPrefChanged,
	setDefaultRepoPref,
} from "../../lib/default-repo-pref";
import {
	getDeskVoicePref,
	onDeskVoiceChanged,
	setDeskVoicePref,
} from "../../lib/desk-voice-pref";
import {
	getPinNewSessions,
	getPinNewWorkspaces,
	onPinNewSessionsChanged,
	onPinNewWorkspacesChanged,
	setPinNewSessions,
	setPinNewWorkspaces,
} from "../../lib/pins";
import {
	MOD_ENTER_GLYPH,
	MOD_ENTER_LABEL,
	type SendKeyPref,
} from "../../lib/send-key";
import {
	getSendKeyPref,
	onSendKeyChanged,
	setSendKeyPref,
} from "../../lib/send-key-pref";
import {
	getTurnActivityPrefs,
	onTurnActivityChanged,
	setToolCallsPref,
	setTurnWorkPref,
	type TurnActivityPrefs,
} from "../../lib/turn-activity";
import {
	getLiveTypingPref,
	onLiveTypingChanged,
	setLiveTypingPref,
} from "../../lib/live-typing-pref";
import {
	getReplySuggestionsPref,
	onReplySuggestionsChanged,
	setReplySuggestionsPref,
} from "../../lib/reply-suggestions";
import {
	getNextChatButtonPref,
	onNextChatButtonChanged,
	setNextChatButtonPref,
} from "../../lib/next-chat-pref";
import {
	getVimModePref,
	onVimModeChanged,
	setVimModePref,
} from "../../lib/vim-pref";
import { Input, Textarea } from "../../ui/input";
import { Button } from "../../ui/button";
import {
	SettingCard,
	SettingGroup,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	SettingsSection,
} from "../../ui/settings";
import { InlineAlert, Skeleton, SkeletonBar } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";
import {
	AppearanceSection,
	SidebarDisplayRows,
	SidebarItemsSection,
} from "./AppearancePanel";
import { PersonalSandboxDefaultRow } from "./SandboxDefaults";
import { RepoTile } from "../RepoTile";
import { ModelMark } from "../ModelMark";
import { IconRepo } from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexClassName, mergeStylexOverrideClassName } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap25: {
			gap: "10px"
	},
	h25: {
			height: "10px"
	},
	w72: {
			width: "72%"
	},
	w88: {
			width: "88%"
	},
	w46: {
			width: "46%"
	},
	mt2: {
			marginTop: "8px"
	},
	h4: {
			height: "16px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gap1: {
			gap: "4px"
	},
	px05: {
			paddingInline: "2px"
	},
	mt0: {
			marginTop: "0"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsEnd: {
			alignItems: "flex-end"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	gapX3: {
			columnGap: "12px"
	},
	gapY2: {
			rowGap: "8px"
	},
});

// ── Desk voice ─────────────────────────────────────────────────────────────

interface DeskVoiceStatus {
	configured: boolean;
	keyMasked?: string;
}

function DeskVoiceApiKeyRow() {
	const [status, setStatus] = useState<DeskVoiceStatus | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = () => {
		fetch(`${BASE_PATH}/api/desk/voice/status`)
			.then((r) => r.json())
			.then(setStatus)
			.catch((e) => setError(e.message));
	};
	useEffect(load, [load]);

	async function put(value: string) {
		setBusy(true);
		setError(null);
		await (async () => {
const res = await fetch(`${BASE_PATH}/api/desk/voice/key`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: value }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setStatus(body);
			setApiKey("");
})().catch(async (e: any) => {
setError(e.message || "Failed to save the API key");
}).finally(async () => {
setBusy(false);
});
	}

	return (
		<>
			{status?.configured && (
				<SettingRow
					title="OpenAI API key"
					desc={status.keyMasked}
					control={
						<Button size="sm" disabled={busy} onClick={() => put("")}>
							Remove
						</Button>
					}
				/>
			)}
			<SettingRow
				title={status?.configured ? "Replace key" : "OpenAI API key"}
				desc={
					error || (
						<>
							Stored on the server, used only for Desk voice calls. Any
							signed-in user can start voice calls once set.
						</>
					)
				}
				control={
					<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
						<Input
							type="password"
							autoComplete="off"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="sk-…"
						/>
						<Button
							size="sm"
							variant="primary"
							disabled={busy || !apiKey.trim()}
							onClick={() => put(apiKey.trim())}
						>
							{busy ? "Saving…" : "Save"}
						</Button>
					</div>
				}
			/>
		</>
	);
}

function DeskVoicePanel() {
	const [on, setOn] = useState(getDeskVoicePref);
	useEffect(() => onDeskVoiceChanged(() => setOn(getDeskVoicePref())), []);

	return (
		<>
			<SettingsGroupLabel>Desk voice</SettingsGroupLabel>
			<SettingCard>
				<SettingGroup>
					<SettingRow
						title="Voice mode"
						control={
							<Switch
								aria-label="Voice mode"
								checked={on}
								onCheckedChange={setDeskVoicePref}
							/>
						}
					/>
					<DeskVoiceApiKeyRow />
				</SettingGroup>
			</SettingCard>
			<SettingsHint>
				Talk to your Desk, the standing session you summon with ⌘J, instead of
				typing. Voice mode adds a microphone button to the Desk overlay. The API
				key is shared by everyone on this instance.
			</SettingsHint>
		</>
	);
}

/** A server-backed personal choice, rather than localStorage: sessions started
 * from the web, native app, Slack, and GitHub all report work the same way. */
function PersonalOutputStyleRow() {
	const user = getCurrentUser();
	const [style, setStyle] = useState<PersonalOutputStyle | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchPersonalOutputStyle(user)
			.then((r) => {
				if (!alive) return;
				setStyle(r.outputStyle);
				setError(null);
			})
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, [user]);

	async function change(next: PersonalOutputStyle) {
		const previous = style ?? "default";
		setStyle(next);
		setSaving(true);
		setError(null);
		await (async () => {
const saved = await savePersonalOutputStyle(user, next);
			setStyle(saved.outputStyle);
})().catch(async (e: any) => {
setStyle(previous);
			setError(e?.message || "Failed to save output style");
			toast(e?.message || "Failed to save output style", { variant: "error" });
}).finally(async () => {
setSaving(false);
});
	}

	return (
		<SettingRow
			title="Output style"
			desc={
				error ||
				"Concise leads with the result and skips preamble and narration without reducing the work."
			}
			control={
				<Select
					label="Output style"
					value={style ?? "default"}
					options={[
						{ value: "default", label: "Default" },
						{ value: "concise", label: "Concise" },
					]}
					disabled={style === null || saving}
					onChange={change}
				/>
			}
		/>
	);
}

/** Settings → Personal prompt: a per-user standing-instructions block injected
 * into the system note of every interactive run the user starts (server-side:
 * personal-prompts.ts via memoryNoteFor). Automations never receive it. */
function PersonalPromptPanel() {
	const user = getCurrentUser();
	const [prompt, setPrompt] = useState<string | null>(null);
	const [savedPrompt, setSavedPrompt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

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

	// There is no Save button: the prompt commits when the box loses focus and
	// again when the panel goes away, so leaving the page keeps your edit. The
	// latest values live in a ref because the unmount effect must run once (a
	// dependency on `prompt` would re-fire the cleanup on every keystroke).
	const latest = useRef({ prompt, savedPrompt, user });
	useLayoutEffect(() => {
		latest.current = { prompt, savedPrompt, user };
	});

	// Stable identity: reads the latest-values ref, so the unmount effect can
	// list it and still only run its cleanup once.
	const commit = useCallback(async () => {
		const { prompt: draft, savedPrompt: saved, user: who } = latest.current;
		if (draft === null || draft === saved) return;
		setStatus("saving");
		await (async () => {
const r = await savePersonalPrompt(who, draft);
			setSavedPrompt(r.prompt);
			setStatus("saved");
})().catch(async (e: any) => {
setStatus("idle");
			toast(e?.message || "Failed to save personal prompt", {
				variant: "error",
			});
});
	}, []);

	useEffect(() => {
		// Fire-and-forget on the way out — nothing is left to render a result to.
		return () => void commit();
	}, [commit]);

	const label = (
		<SettingsGroupLabel>Personal prompt</SettingsGroupLabel>
	);

	if (prompt === null)
		return (
			<>
				{label}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					// The section it lands in, with the prose it holds — not a
					// ten-row grey slab, which is the editor's box rather than its
					// contents and reads as a field you have been locked out of.
					<Skeleton label="Loading your prompt">
						<SettingsSection className={mergeStylexOverrideClassName("", sx.flex, sx.flexCol, sx.gap25)}>
							<SkeletonBar className={mergeStylexOverrideClassName("", sx.h25, sx.w72)} />
							<SkeletonBar className={mergeStylexOverrideClassName("", sx.h25, sx.w88)} />
							<SkeletonBar className={mergeStylexOverrideClassName("", sx.h25, sx.w46)} />
						</SettingsSection>
					</Skeleton>
				)}
			</>
		);

	const dirty = prompt !== savedPrompt;
	return (
		<>
			{label}
			<SettingsSection>
				<Textarea
					rows={10}
					placeholder='e.g. "Keep answers short. Prefer tables for comparisons. Always mention which files you touched."'
					value={prompt}
					onChange={(e) => {
						setPrompt(e.target.value);
						setStatus("idle");
					}}
					onBlur={() => void commit()}
				/>
				<div {...stylex.props(sx.mt2, sx.h4, sx.fontMedium, sx.textFaint, typography.label)}>
					{status === "saving"
						? "Saving…"
						: dirty
							? "Saves when you click away"
							: status === "saved"
								? "Saved"
								: ""}
				</div>
			</SettingsSection>
			<SettingsHint>
				Added to the system prompt of every session you ({user}) start: tone,
				preferences, how you like work reported. It follows you across devices and
				is never given to automations. Leave it empty to turn it off.
			</SettingsHint>
		</>
	);
}

/** One send gesture's busy behavior, labelled with the chord it belongs to.
 *  The two gestures used to be two rows explaining each other; as a labelled
 *  pair they read as the one choice they are. */
function BusyGestureSelect({
	gesture,
	glyph,
	value,
}: {
	gesture: BusySendGesture;
	glyph: string;
	value: BusySendPref;
}) {
	const label = `Follow-up behavior for ${glyph}`;
	return (
		<span {...stylex.props(sx.flex, sx.flexCol, sx.itemsStart, sx.gap1)}>
			<span {...stylex.props(sx.px05, sx.fontMedium, sx.textFaint, typography.meta)}>{glyph}</span>
			<Select
				label={label}
				value={value}
				options={[
					{ value: "queue" as const, label: "Queue" },
					{ value: "steer" as const, label: "Steer" },
				]}
				onChange={(v) => setBusySendPref(gesture, v)}
			/>
		</span>
	);
}

/**
 * How the app looks and behaves for you: theme and accent, the composer keys,
 * what a follow-up does mid-run, and how much of a turn's work the transcript
 * shows. Everything here is yours alone, and the prefs backed by ui-prefs
 * follow you across devices.
 */
export function PreferencesPanel() {
	const [sendKey, setSendKey] = useState<SendKeyPref>(getSendKeyPref);
	const [busySend, setBusySend] = useState<BusySendPrefs>(getBusySendPrefs);
	const [vimMode, setVimMode] = useState<boolean>(getVimModePref);
	const [quickReplies, setQuickReplies] = useState<boolean>(
		getReplySuggestionsPref,
	);
	const [nextChatButton, setNextChatButton] = useState<boolean>(
		getNextChatButtonPref,
	);
	const [pinNew, setPinNew] = useState<boolean>(getPinNewSessions);
	const [pinNewWs, setPinNewWs] = useState<boolean>(getPinNewWorkspaces);
	useEffect(() => onSendKeyChanged(() => setSendKey(getSendKeyPref())), []);
	useEffect(() => onBusySendChanged(() => setBusySend(getBusySendPrefs())), []);
	useEffect(() => onVimModeChanged(() => setVimMode(getVimModePref())), []);
	useEffect(
		() =>
			onReplySuggestionsChanged(() =>
				setQuickReplies(getReplySuggestionsPref()),
			),
		[],
	);
	useEffect(
		() =>
			onNextChatButtonChanged(() =>
				setNextChatButton(getNextChatButtonPref()),
			),
		[],
	);
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
	// Per-user default repo for NEW sessions ("" = no preference — the
	// workspace's own default from GET /api/repos applies).
	const [repoPref, setRepoPref] = useState<string>(getDefaultRepoPref);
	const [repoOptions, setRepoOptions] = useState<RepoInfo[]>([]);
	useEffect(
		() => onDefaultRepoPrefChanged(() => setRepoPref(getDefaultRepoPref())),
		[],
	);
	const [turnActivity, setTurnActivity] =
		useState<TurnActivityPrefs>(getTurnActivityPrefs);
	useEffect(
		() => onTurnActivityChanged(() => setTurnActivity(getTurnActivityPrefs())),
		[],
	);
	const [liveTyping, setLiveTyping] = useState<boolean>(getLiveTypingPref);
	useEffect(
		() => onLiveTypingChanged(() => setLiveTyping(getLiveTypingPref())),
		[],
	);
	useEffect(() => {
		fetchModels()
			.then((m) => setModelOptions(m.models))
			.catch(() => {});
	}, []);
	useEffect(() => {
		fetchRepos()
			.then(setRepoOptions)
			.catch(() => {});
	}, []);

	return (
		<SettingsPanel>
			<SettingsHeader title="Preferences" />
			<SettingsGroupLabel className={mergeStylexOverrideClassName("", sx.mt0)}>Messages</SettingsGroupLabel>
			<SettingCard>
				{/* These four choices become one starting state for every new session. */}
				<SettingGroup>
					<SettingRow
						title="Default model"
						control={
							<Select
								label="Default model"
								value={
									modelPref && modelOptions.some((m) => m.id === modelPref)
										? modelPref
										: ""
								}
								options={[
									{ value: "", label: "No preference" },
									...modelOptions.map((m) => ({
										value: m.id,
										label: m.label,
										icon: (
											<ModelMark
												id={m.id}
												provider={m.provider}
												composition={m.composition}
											/>
										),
									})),
								]}
								onChange={setDefaultModelPref}
							/>
						}
					/>

					<SettingRow
						title="Default repository"
						desc="Where a new session starts."
						control={
							<Select
								label="Default repository"
								value={
									repoOptions.some((r) => r.id === repoPref)
										? repoPref
										: ""
								}
								options={[
									{
										value: "",
										label: "Use the workspace default",
										icon: <IconRepo size={16} />,
									},
									...repoOptions.map((r) => ({
										value: r.id,
										label: r.label || r.id,
										icon: <RepoTile name={r.id} size={16} />,
									})),
								]}
								onChange={setDefaultRepoPref}
							/>
						}
					/>
					<PersonalSandboxDefaultRow />
					<PersonalOutputStyleRow />
				</SettingGroup>
				{/* The send key also determines which busy-turn gesture is available. */}
				<SettingGroup>
					<SettingRow
						title="Send messages with"
						desc={
							sendKey === "mod-enter"
								? "↵ makes a new line."
								: "⇧↵ makes a new line. On a phone ↵ always makes one, so send with the button."
						}
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
						title="Follow-up while busy"
						desc="Queue waits until the run fully finishes; steer folds your message into the running turn without stopping it."
						control={
							<div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsEnd, sx.justifyEnd, sx.gapX3, sx.gapY2)}>
								<BusyGestureSelect
									gesture="enter"
									glyph={sendKey === "enter" ? "↩" : MOD_ENTER_GLYPH}
									value={busySend.enter}
								/>
								{/* The modifier only has its own answer while plain Enter is
							    the send key; otherwise ⌘↵ IS sending, set just above. */}
								{sendKey === "enter" && (
									<BusyGestureSelect
										gesture="mod"
										glyph={MOD_ENTER_GLYPH}
										value={busySend.mod}
									/>
								)}
							</div>
						}
					/>
				</SettingGroup>
				<SettingRow
					title="Quick replies"
					desc="Suggest short follow-ups above the composer when a turn ends on a choice. Picking one fills the draft."
					control={
						<Switch
							aria-label="Quick replies"
							checked={quickReplies}
							onCheckedChange={setReplySuggestionsPref}
						/>
					}
				/>
				<SettingRow
					title="Next button"
					desc="Show the Next button above the composer."
					control={
						<Switch
							aria-label="Next button"
							checked={nextChatButton}
							onCheckedChange={setNextChatButtonPref}
						/>
					}
				/>
				<SettingRow
					title="Vim mode"
					desc="Modal editing in the composer. Esc for normal mode, i to type. Enter still sends."
					control={
						<Switch
							aria-label="Vim mode"
							checked={vimMode}
							onCheckedChange={setVimModePref}
						/>
					}
				/>
			</SettingCard>
			<AppearanceSection />
			<SettingsGroupLabel>Sidebar</SettingsGroupLabel>
			<SettingCard>
				<SidebarDisplayRows repos={repoOptions} />
				<SettingGroup>
					<SettingRow
						title="Pin new sessions"
						control={
							<Switch
								aria-label="Pin new sessions"
								checked={pinNew}
								onCheckedChange={setPinNewSessions}
							/>
						}
					/>
					<SettingRow
						title="Pin new workspaces"
						control={
							<Switch
								aria-label="Pin new workspaces"
								checked={pinNewWs}
								onCheckedChange={setPinNewWorkspaces}
							/>
						}
					/>
				</SettingGroup>
			</SettingCard>
			<SidebarItemsSection />
			<SettingsGroupLabel>Transcript</SettingsGroupLabel>
			<SettingCard>
				<SettingGroup>
					<SettingRow
						title="Steps"
						desc="Choose whether steps stay closed, open when the agent writes updates, or remain open."
						control={
							<Select
								label="Steps"
								value={turnActivity.work}
								options={[
									{ value: "folded", label: "Closed" },
									{ value: "running", label: "With updates" },
									{ value: "open", label: "Open" },
								]}
								onChange={setTurnWorkPref}
							/>
						}
					/>
					<SettingRow
						title="Tool calls"
						desc="Choose whether tool calls start open or stay folded into a single step."
						control={
							<Select
								label="Tool calls"
								value={turnActivity.tools}
								options={[
									{ value: "folded", label: "Closed" },
									{ value: "open", label: "Open" },
								]}
								onChange={setToolCallsPref}
							/>
						}
					/>
				</SettingGroup>
				<SettingRow
					title="Live typing"
					desc="Type the reply out as the model writes it. Off, each part appears when it is finished."
					control={
						<Switch
							aria-label="Live typing"
							checked={liveTyping}
							onCheckedChange={setLiveTypingPref}
						/>
					}
				/>
			</SettingCard>

			<DeskVoicePanel />
			<PersonalPromptPanel />
		</SettingsPanel>
	);
}
