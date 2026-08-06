import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState, useCallback } from "react";
import { TEAM } from "./UserPicker";
import { shortModelLabel, splitModelOptions } from "./ModelEffortSelect";
import { Menu } from "../ui/menu";
import { Button } from "../ui/button";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsField,
	SettingsForm,
	SettingsFormActions,
	SettingsFormTitle,
	SettingsGroupLabel,
	SettingsHint,
	rowMenuTriggerClasses,
	settingsInputClass,
	settingsSelectClass,
} from "../ui/settings";
import { Switch } from "../ui/switch";
import { cn } from "../ui/cn";
import { toast } from "../ui/toast";
import { IconDotsHorizontal, IconHistory, IconPlug, IconPlus, IconSliders, IconTrash } from "./icons";

// The Settings → Accounts panel: the Claude / Codex subscription accounts
// session runs draw from, plus the default model new runs start on. Everything
// here follows the Settings idiom (setting-card row lists), not the
// Connections card grid.

interface ModelInfo {
	id: string;
	provider: "claude" | "codex" | "opencode";
	label: string;
	aliases: string[];
	efforts: string[];
}

interface UsageWindow {
	utilization: number | null;
	resetsAt: string | null;
}

interface ClaudeAccountInfo {
	id: string;
	name: string;
	tokenMasked: string;
	email?: string;
	plan?: string;
	/** Personal sub of this person; unset = shared pool account. */
	owner?: string;
	mode: "shared" | "personal";
	usage: {
		fetchedAt: string;
		fiveHour: UsageWindow | null;
		sevenDay: UsageWindow | null;
		scopedLimits?: { label: string; utilization: number | null; resetsAt: string | null }[];
		/** Pay-as-you-go spend past the subscription limits; credits are cents. */
		extraUsage?: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null;
		/** "meridian" = observed via a live Meridian proxy, not the OAuth endpoint. */
		source?: "meridian";
		error?: string;
		errorStatus?: number;
	} | null;
	noUsageScope: boolean;
	credentialsPath?: string;
	exhaustedUntil: string | null;
	usable: boolean;
}

interface CodexAccountInfo {
	id: string;
	name: string;
	kind: "api_key" | "home";
	valueMasked: string;
	owner?: string;
	mode: "shared" | "personal";
	createdAt: string;
	exhaustedUntil: string | null;
	usable: boolean;
}

/** The subscription half of Settings → Models: the Anthropic/OpenAI accounts
 * runs draw from, and the model new runs start on. Renders as groups, not a
 * page — Settings' ModelsPanel owns the header, so this sits above the
 * bring-your-own-key providers rather than telling you to go find them. */
export function AccountsPanel() {
	return (
		<>
			<SettingsGroupLabel className="mt-0">Default model</SettingsGroupLabel>
			<SettingCard>
				<DefaultModelRow />
				<AutoFallbackRow />
			</SettingCard>

			<EnginesSection />

			<ClaudeAccountsSection />
			<CodexAccountsSection />

			<SettingsHint>
				Changes apply to new session runs immediately (config is read per run) — no restart
				needed. Per-session model overrides still win over the default.
			</SettingsHint>
		</>
	);
}

// ── Default model ──────────────────────────────────────────────────────────

function DefaultModelRow() {
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [current, setCurrent] = useState<string>("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				if (!body) return;
				setModels(body.models);
				setCurrent(body.default);
			})
			.catch(() => {});
	}, []);

	async function handleChange(id: string) {
		if (id === current) return;
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/models/default`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: id }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setCurrent(body.default);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	// Engine entries (opencode + pi) are the first-class list — opencode with
	// friendly names and no engine noise, pi keeping its registry label ("Pi ·
	// Claude Opus 5") so it never reads as a duplicate row in this flat select.
	// The native claude/codex entries stay selectable under de-emphasized
	// legacy groups while the migration lands.
	const { opencode: opencodeModels, legacy } = splitModelOptions(models || []);
	const claudeModels = legacy.filter((m) => m.provider === "claude");
	const codexModels = legacy.filter((m) => m.provider === "codex");
	const legacyGroup = (engine: string) =>
		opencodeModels.length > 0 ? `Legacy — ${engine} (direct SDK)` : engine;

	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>What new sessions run on</SettingRowTitle>
				<SettingRowDescription>
					{error ||
						"Sessions and agent runs (Slack, Linear, Plain, automations without their own model) start on this."}
				</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>
				<select
					className={settingsSelectClass}
					value={current}
					disabled={!models || saving}
					onChange={(e) => handleChange(e.target.value)}
					aria-label="Default model"
				>
					{opencodeModels.map((m) => (
						<option key={m.id} value={m.id}>
							{m.provider === "pi" ? m.label : shortModelLabel(m.id, models || [])}
						</option>
					))}
					{claudeModels.length > 0 && (
						<optgroup label={legacyGroup("Claude")}>
							{claudeModels.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</optgroup>
					)}
					{codexModels.length > 0 && (
						<optgroup label={legacyGroup("Codex")}>
							{codexModels.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</optgroup>
					)}
				</select>
			</SettingRowControl>
		</SettingRow>
	);
}

// ── Auto model-switch on out-of-credits ─────────────────────────────────────

/**
 * Manual vs auto: when a session's model runs out of usage credits pool-wide,
 * either drop it to a fallback model and keep going (auto, the default) or stop
 * on the limit notice and let the human pick the next model (manual). Global,
 * read fresh per run. The switch is always announced in the session as a divider.
 */
function AutoFallbackRow() {
	const [auto, setAuto] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setAuto(body.autoFallback !== false))
			.catch(() => {});
	}, []);

	async function toggle(next: boolean) {
		if (saving) return;
		setSaving(true);
		setError(null);
		const prev = auto;
		setAuto(next); // optimistic
		try {
			const res = await fetch(`${BASE_PATH}/api/models/auto-fallback`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ auto: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setAuto(body.autoFallback);
		} catch (e: any) {
			setError(e.message);
			setAuto(prev ?? null);
		}
		setSaving(false);
	}

	const on = auto ?? true;
	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>Auto-switch when out of credits</SettingRowTitle>
				<SettingRowDescription>
					{error ||
						"When a run has an explicit fallback model and the current model runs out of usage credits, keep going on that configured fallback. Off = the run halts and you pick the next model. Either way the switch shows in the session."}
				</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>
				<Switch
					checked={on}
					aria-label="Auto-switch model when out of credits"
					disabled={auto === null || saving}
					onCheckedChange={toggle}
				/>
			</SettingRowControl>
		</SettingRow>
	);
}

// ── Engines ────────────────────────────────────────────────────────────────

interface PiEngineConfig {
	enabled: boolean;
	pickerModels: string[];
}

/**
 * Engine switches: OpenCode (the default engine) and pi, plus which engine
 * new sessions default to. Which models each engine advertises in the picker
 * is config-owned (`pickerModels` in ~/.opensession-opencode.json /
 * ~/.opensession-pi.json) — no per-engine model curation UI, same as it has
 * always been for opencode.
 */
function EnginesSection() {
	const [ocEnabled, setOcEnabled] = useState<boolean | null>(null);
	const [pi, setPi] = useState<PiEngineConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/settings/opencode-engine`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setOcEnabled(body.enabled === true))
			.catch(() => {});
		fetch(`${BASE_PATH}/api/settings/pi-engine`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setPi(body))
			.catch(() => {});
	}, []);

	async function toggleOpencode(next: boolean) {
		if (saving) return;
		setSaving(true);
		setError(null);
		const prev = ocEnabled;
		setOcEnabled(next);
		try {
			const res = await fetch(`${BASE_PATH}/api/settings/opencode-engine`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setOcEnabled(body.enabled === true);
		} catch (e: any) {
			setOcEnabled(prev);
			setError(e.message);
			toast(e.message, { variant: "error" });
		}
		setSaving(false);
	}

	async function togglePi(next: boolean) {
		if (saving || !pi) return;
		setSaving(true);
		setError(null);
		const prev = pi;
		setPi({ ...pi, enabled: next });
		try {
			const res = await fetch(`${BASE_PATH}/api/settings/pi-engine`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setPi(body);
		} catch (e: any) {
			setPi(prev);
			setError(e.message);
			toast(e.message, { variant: "error" });
		}
		setSaving(false);
	}

	async function handleTestPi() {
		if (testing) return;
		setTesting(true);
		try {
			const res = await fetch(`${BASE_PATH}/api/admin/pi-smoke`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const body = await res.json();
			if (body.ok) toast(body.text || "Pi engine turn completed", { variant: "success" });
			else toast(body.reason || body.error || "Pi smoke turn failed", { variant: "error" });
		} catch (e: any) {
			toast(e.message || "Pi smoke turn failed", { variant: "error" });
		}
		setTesting(false);
	}

	return (
		<>
			<SettingsGroupLabel>Engines</SettingsGroupLabel>

			{error && (
				<InlineAlert className="mb-2" onDismiss={() => setError(null)}>
					{error}
				</InlineAlert>
			)}

			<SettingCard>
				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>OpenCode engine</SettingRowTitle>
						<SettingRowDescription>
							The default engine — Anthropic models on the Claude account pool via the
							Meridian bridge, OpenAI models on the codex pool, plus API-key providers.
						</SettingRowDescription>
					</SettingRowText>
					<SettingRowControl>
						<Switch
							checked={ocEnabled ?? false}
							aria-label="Enable the OpenCode engine"
							disabled={ocEnabled === null || saving}
							onCheckedChange={toggleOpencode}
						/>
					</SettingRowControl>
				</SettingRow>

				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>Pi engine</SettingRowTitle>
						<SettingRowDescription>
							pi.dev's coding agent as an alternative engine, on the same account pools —
							its models join the picker as pi/&lt;provider&gt;/&lt;model&gt; while enabled.
						</SettingRowDescription>
					</SettingRowText>
					<SettingRowControl className="flex items-center gap-2.5">
						<Button size="sm" onClick={handleTestPi} disabled={testing || !pi?.enabled}>
							{testing ? "Running…" : "Test"}
						</Button>
						<Switch
							checked={pi?.enabled ?? false}
							aria-label="Enable the pi engine"
							disabled={!pi || saving}
							onCheckedChange={togglePi}
						/>
					</SettingRowControl>
				</SettingRow>

				<DefaultEngineRow piEnabled={pi?.enabled ?? false} />
			</SettingCard>
			<SettingsHint>
				Both engines draw on the same subscription account pools. Which models each engine
				advertises comes from its config file's <code>pickerModels</code>; any well-formed
				engine id still resolves when typed. Changes apply to new runs immediately.
			</SettingsHint>
		</>
	);
}

/**
 * Which engine new sessions default to. Flips the default model's engine
 * prefix while keeping the same provider/model tail — the model choice itself
 * stays in the Default model select above.
 */
function DefaultEngineRow({ piEnabled }: { piEnabled: boolean }) {
	const [current, setCurrent] = useState<string>("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setCurrent(body.default))
			.catch(() => {});
	}, []);

	const engine = current.startsWith("pi/") ? "pi" : "opencode";
	const tail = current.startsWith("pi/")
		? current.slice("pi/".length)
		: current.startsWith("opencode/")
			? current.slice("opencode/".length)
			: null;
	// Pi only serves the subscription-bridge providers.
	const piCanServe = !!tail && (tail.startsWith("anthropic/") || tail.startsWith("openai/"));

	async function handleChange(next: string) {
		if (next === engine || !tail) return;
		const id = next === "pi" ? `pi/${tail}` : `opencode/${tail}`;
		setSaving(true);
		try {
			const res = await fetch(`${BASE_PATH}/api/models/default`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: id }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setCurrent(body.default);
			toast(`New sessions default to ${body.default}`);
		} catch (e: any) {
			toast(e.message, { variant: "error" });
		}
		setSaving(false);
	}

	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>Default engine</SettingRowTitle>
				<SettingRowDescription>
					{tail
						? `Moves the default model (currently ${current}) onto the chosen engine, keeping the same model.`
						: current
							? `The default (${current}) isn't an engine-prefixed model — pick an opencode/… or pi/… default model above to switch engines here.`
							: "Which engine new sessions start on."}
				</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>
				<select
					className={settingsSelectClass}
					value={engine}
					disabled={!current || saving || !tail}
					onChange={(e) => handleChange(e.target.value)}
					aria-label="Default engine"
				>
					<option value="opencode">OpenCode</option>
					<option value="pi" disabled={!piCanServe || !piEnabled}>
						{`Pi${!piEnabled ? " (disabled)" : !piCanServe ? " (model not served)" : ""}`}
					</option>
				</select>
			</SettingRowControl>
		</SettingRow>
	);
}

// ── Shared bits ────────────────────────────────────────────────────────────

function Avatar({ name, className }: { name: string; className: string }) {
	return (
		<span
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[13px] font-bold text-white",
				className,
			)}
		>
			{name.charAt(0).toUpperCase()}
		</span>
	);
}

/**
 * A meter's fill. Normal usage is neutral ink, not green: an account that is
 * fine already says so in its "In rotation" pill, and three green bars per
 * account across nine accounts turned the whole page into colour with nothing
 * to look at. Colour here means "this one is running out" — so the two
 * accounts near a limit are the only things that catch the eye.
 */
const usageToneClasses = {
	unknown: "bg-line",
	high: "bg-red",
	warn: "bg-yellow",
	normal: "bg-faint",
} as const;

/** Utilization → tone. Shared so a meter and its neighbours can't drift. */
function usageTone(pct: number | null): keyof typeof usageToneClasses {
	return pct === null ? "unknown" : pct >= 90 ? "high" : pct >= 70 ? "warn" : "normal";
}

const statusToneClasses = {
	green: "bg-green-soft text-green",
	red: "bg-red-soft text-red",
	yellow: "bg-[rgba(210,153,34,0.15)] text-yellow",
} as const;

function StatusPill({
	tone,
	children,
	...props
}: React.ComponentPropsWithoutRef<"span"> & { tone: keyof typeof statusToneClasses }) {
	return (
		<span
			className={cn(
				"inline-flex min-w-[70px] shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-bold max-[720px]:min-w-0 max-[720px]:px-2",
				statusToneClasses[tone],
			)}
			{...props}
		>
			{children}
		</span>
	);
}

/**
 * "resets in 3h". An account reports three or four windows, so the absolute
 * timestamp this used to print ("resets Sat, Aug 1, 05:00 PM") was repeated
 * down the whole page — the single noisiest thing on it, for the least useful
 * reading. What a person wants from a limit is how long until it frees up; the
 * exact time stays one hover away.
 */
function formatReset(resetsAt: string | null): string {
	const d = resetsAt ? new Date(resetsAt) : null;
	if (!d || isNaN(d.getTime())) return "";
	const mins = Math.round((d.getTime() - Date.now()) / 60_000);
	if (mins <= 0) return "resets now";
	if (mins < 60) return `resets in ${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `resets in ${hours}h`;
	return `resets in ${Math.round(hours / 24)}d`;
}

function absoluteReset(resetsAt: string | null): string | undefined {
	const d = resetsAt ? new Date(resetsAt) : null;
	if (!d || isNaN(d.getTime())) return undefined;
	return `Resets ${d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The meters under an account share one grid, so labels, bars, values and
 * reset times line up down their columns however many windows the account
 * reports. Each meter used to be its own flex row carrying hard-coded column
 * widths (w-11 / w-[34px] / w-[132px]) — nothing was actually aligned, and a
 * label longer than 44px was simply truncated.
 */
function MeterGroup({ children }: { children: React.ReactNode }) {
	return (
		<div className="mt-2 grid max-w-[420px] grid-cols-[46px_minmax(0,1fr)_auto_minmax(88px,auto)] items-center gap-x-2.5 gap-y-1.5 text-meta">
			{children}
		</div>
	);
}

/** One row of MeterGroup's grid: label, bar, value, note. */
function Meter({
	label,
	labelTitle,
	pct,
	value,
	note,
	noteTitle,
}: {
	label: string;
	labelTitle?: string;
	/** 0-100, or null when the value is unknown — the track renders empty. */
	pct: number | null;
	value: React.ReactNode;
	note?: React.ReactNode;
	noteTitle?: string;
}) {
	return (
		<>
			<span className="truncate text-faint" title={labelTitle}>
				{label}
			</span>
			<div className="h-1.5 overflow-hidden rounded-full bg-active">
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-300",
						usageToneClasses[usageTone(pct)],
					)}
					style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
				/>
			</div>
			<span className="text-right tabular-nums text-dim">{value}</span>
			<span className="truncate text-faint" title={noteTitle}>
				{note}
			</span>
		</>
	);
}

function UsageBar({ label, window: w }: { label: string; window: UsageWindow | null }) {
	const pct = w?.utilization ?? null;
	return (
		<Meter
			label={label}
			pct={pct}
			value={pct === null ? "—" : `${Math.round(pct)}%`}
			note={formatReset(w?.resetsAt ?? null)}
			noteTitle={absoluteReset(w?.resetsAt ?? null)}
		/>
	);
}

/**
 * Usage-credits (extra usage) spend for one account: what's been billed past
 * the subscription's included limits this month, against the account's monthly
 * credit cap. Values from the OAuth usage endpoint are cents. Hidden when the
 * account has extra usage off and nothing spent — most accounts, most months.
 */
function ExtraUsageRow({
	extra,
}: {
	extra: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null | undefined;
}) {
	if (!extra || (!extra.enabled && extra.usedCredits <= 0)) return null;
	const usd = (cents: number) =>
		`$${(cents / 100).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	const pct = extra.monthlyLimit > 0 ? (extra.usedCredits / extra.monthlyLimit) * 100 : null;
	return (
		<Meter
			label="Credits"
			labelTitle="Usage-credits — pay-as-you-go spend past the subscription limits, against this account's monthly credit cap (set at claude.ai)"
			pct={pct}
			value={usd(extra.usedCredits)}
			note={`${extra.monthlyLimit > 0 ? `of ${usd(extra.monthlyLimit)}/mo` : "no monthly cap"}${
				extra.enabled ? "" : " · off"
			}`}
		/>
	);
}

// ── Claude accounts ────────────────────────────────────────────────────────

/** The one pill that matters most — never stacked, so nothing collides. */
function ClaudeStatusPill({ a }: { a: ClaudeAccountInfo }) {
	if (a.usage?.error && a.usage.errorStatus === 401)
		return (
			<StatusPill tone="red" title={a.usage.error}>
				Token error
			</StatusPill>
		);
	if (a.usage?.error)
		return (
			<StatusPill tone="yellow" title={a.usage.error}>
				Usage unknown
			</StatusPill>
		);
	if (a.noUsageScope && !a.usage)
		return (
			<StatusPill tone="yellow" title="Add OAuth usage credentials to show dashboard usage.">
				Usage hidden
			</StatusPill>
		);
	if (a.exhaustedUntil)
		return (
			<StatusPill tone="red" title={`Sidelined until ${a.exhaustedUntil}`}>
				Limit hit
			</StatusPill>
		);
	if (a.usable) return <StatusPill tone="green">In rotation</StatusPill>;
	return <StatusPill tone="yellow">Near limit</StatusPill>;
}

function ClaudeAccountsSection() {
	const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [signIn, setSignIn] = useState<ClaudeAccountInfo | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (forceUsage = false) => {
		if (forceUsage) setRefreshing(true);
		try {
			const res = forceUsage
				? await fetch(`${BASE_PATH}/api/claude-accounts/refresh`, { method: "POST" })
				: await fetch(`${BASE_PATH}/api/claude-accounts`);
			if (res.ok) setAccounts((await res.json()).accounts);
		} catch {}
		setRefreshing(false);
	}, []);

	useEffect(() => {
		load();
		const t = setInterval(() => load(), 60_000);
		return () => clearInterval(t);
	}, [load]);

	async function handleRemove(a: ClaudeAccountInfo) {
		if (!confirm(`Remove Claude account "${a.name}"? Runs will stop using its token.`)) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(a.id)}`, {
				method: "DELETE",
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function handleSetOwner(a: ClaudeAccountInfo, owner: string) {
		if (owner === (a.owner || "")) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(a.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ owner }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function handleSetCredentialsPath(a: ClaudeAccountInfo) {
		const current =
			a.credentialsPath ||
			`~/.claude/accounts/${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/credentials.json`;
		const credentialsPath = prompt(
			"Path to this account's Claude OAuth credentials.json for usage polling. Leave empty to clear it.",
			current,
		);
		if (credentialsPath === null) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(a.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ owner: a.owner || "", credentialsPath }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load(true);
		} catch (e: any) {
			setError(e.message);
		}
	}

	return (
		<>
			<SettingsGroupLabel
				actions={
					<>
						<Button
							size="sm"
							icon={<IconHistory size={16} className={refreshing ? "animate-spin" : ""} />}
							onClick={() => load(true)}
							disabled={refreshing}
						>
							{refreshing ? "Checking…" : "Refresh usage"}
						</Button>
						<Button size="sm" icon={<IconPlus size={16} />} onClick={() => setShowAdd(true)}>
							Add account
						</Button>
					</>
				}
			>
				Claude accounts
			</SettingsGroupLabel>

			{error && (
				<InlineAlert className="mb-2" onDismiss={() => setError(null)}>
					{error}
				</InlineAlert>
			)}

			{showAdd && (
				<AddClaudeAccountForm
					onClose={() => setShowAdd(false)}
					onAdded={() => {
						setShowAdd(false);
						load();
					}}
				/>
			)}

			<SettingCard>
				{!accounts ? (
					<LoadingState placement="row">Loading accounts…</LoadingState>
				) : accounts.length === 0 ? (
					<EmptyState placement="row">
						No accounts yet — runs use the VPS's own Claude login. Add Max-account tokens
						(<code>claude setup-token</code>) and runs pick the least-used one, rotating when
						one hits its limit.
					</EmptyState>
				) : (
					accounts.map((a) => (
						<React.Fragment key={a.id}>
						<SettingRow className="items-start">
							<Avatar name={a.name} className="bg-[#d97757]" />
							<SettingRowText>
								<div className="flex items-center gap-2 min-w-0">
									<SettingRowTitle className="truncate">{a.name}</SettingRowTitle>
									<ClaudeStatusPill a={a} />
								</div>
								<SettingRowDescription className="truncate">
									{a.email ? `${a.email} · ` : ""}
									{a.plan ? `${a.plan.replace("default_claude_", "")} · ` : ""}
									{a.tokenMasked}
								</SettingRowDescription>
								{a.noUsageScope && !a.usage ? (
									<div className="mt-1.5 text-meta text-faint">
										Usage not visible — setup-tokens cannot read the usage endpoint. Use
										“Sign in with Claude” in this account's menu to connect usage.
									</div>
								) : (
									<>
										<MeterGroup>
											<UsageBar label="5h" window={a.usage?.fiveHour ?? null} />
											<UsageBar label="7d" window={a.usage?.sevenDay ?? null} />
											{(a.usage?.scopedLimits ?? []).map((s) => (
												<UsageBar key={s.label} label={s.label} window={s} />
											))}
											<ExtraUsageRow extra={a.usage?.extraUsage} />
										</MeterGroup>
										{a.usage?.source === "meridian" && (
											<div className="mt-1.5 text-meta text-faint">
												Observed via the Meridian bridge (rate-limit events from live
												runs) — the token can’t read the usage endpoint directly.
											</div>
										)}
										{a.usage?.error && (
											<div className="mt-1.5 text-meta text-red">{a.usage.error}</div>
										)}
									</>
								)}
							</SettingRowText>
							<SettingRowControl className="flex items-center gap-1.5">
								<select
									className={settingsSelectClass}
									value={a.owner || ""}
									onChange={(e) => handleSetOwner(a, e.target.value)}
									aria-label={`Owner of ${a.name}`}
									title={
										a.owner
											? `${a.owner}'s personal sub — their runs use it first, everyone else never does.`
											: "Shared pool account — used by everyone and by automations."
									}
								>
									<option value="">Shared pool</option>
									{/* Keep a non-team owner (e.g. set via API) selectable. */}
									{a.owner && !TEAM.includes(a.owner) && (
										<option value={a.owner}>👤 {a.owner}</option>
									)}
									{TEAM.map((name) => (
										<option key={name} value={name}>
											👤 {name}
										</option>
									))}
								</select>
								<Menu.Root>
									<Menu.Trigger
										className={rowMenuTriggerClasses}
										aria-label={`Manage ${a.name}`}
									>
										<IconDotsHorizontal size={18} />
									</Menu.Trigger>
									<Menu.Popup align="end" sideOffset={4}>
										<Menu.Item onClick={() => setSignIn(a)}>
											<IconPlug size={16} className="text-faint" />
											Sign in with Claude (usage)…
										</Menu.Item>
										<Menu.Item onClick={() => handleSetCredentialsPath(a)}>
											<IconSliders size={16} className="text-faint" />
											Usage credentials…
										</Menu.Item>
										<Menu.Item
											onClick={() => handleRemove(a)}
											className="text-red data-[highlighted]:bg-red-soft"
										>
											<IconTrash size={16} />
											Remove account
										</Menu.Item>
									</Menu.Popup>
								</Menu.Root>
							</SettingRowControl>
						</SettingRow>
						{signIn?.id === a.id && (
							<ClaudeSignInForm
								account={a}
								onClose={() => setSignIn(null)}
								onDone={() => {
									setSignIn(null);
									load();
								}}
							/>
						)}
						</React.Fragment>
					))
				)}
			</SettingCard>
			<SettingsHint>
				The usage pool for Claude session runs — each run picks the least-used usable account.
				A personal account is used first by its owner's runs and never by anyone else's;
				automations only use the shared pool. For usage bars, use “Sign in with Claude” in an
				account's menu: it stores its own auto-refreshing OAuth credentials, so usage tracking
				doesn't share (and can't lose) the CLI's login.
			</SettingsHint>
		</>
	);
}

// ── Codex accounts ─────────────────────────────────────────────────────────

function CodexAccountsSection() {
	const [accounts, setAccounts] = useState<CodexAccountInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts`);
			if (res.ok) setAccounts((await res.json()).accounts);
		} catch {}
	}, []);

	useEffect(() => {
		load();
		const t = setInterval(() => load(), 60_000);
		return () => clearInterval(t);
	}, [load]);

	async function handleSetOwner(a: CodexAccountInfo, owner: string) {
		if (owner === (a.owner || "")) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/${encodeURIComponent(a.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ owner }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function handleRemove(a: CodexAccountInfo) {
		if (!confirm(`Remove Codex account "${a.name}"? Runs will stop using it.`)) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/${encodeURIComponent(a.id)}`, {
				method: "DELETE",
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	return (
		<>
			<SettingsGroupLabel
				actions={
					<Button size="sm" icon={<IconPlus size={16} />} onClick={() => setShowAdd(true)}>
						Add account
					</Button>
				}
			>
				Codex accounts
			</SettingsGroupLabel>

			{error && (
				<InlineAlert className="mb-2" onDismiss={() => setError(null)}>
					{error}
				</InlineAlert>
			)}

			{showAdd && (
				<AddCodexAccountForm
					onClose={() => setShowAdd(false)}
					onAdded={() => {
						setShowAdd(false);
						load();
					}}
				/>
			)}

			<SettingCard>
				{!accounts ? (
					<LoadingState placement="row">Loading accounts…</LoadingState>
				) : accounts.length === 0 ? (
					<EmptyState placement="row">
						No accounts yet — Codex runs use the VPS's own <code>codex login</code> (~/.codex).
						Add an OpenAI API key, or a CODEX_HOME directory holding a ChatGPT-plan{" "}
						<code>auth.json</code>, and runs rotate across the pool.
					</EmptyState>
				) : (
					accounts.map((a) => (
						<SettingRow key={a.id} className="items-start">
							<Avatar name={a.name} className="bg-[#10a37f]" />
							<SettingRowText>
								<div className="flex items-center gap-2 min-w-0">
									<SettingRowTitle className="truncate">{a.name}</SettingRowTitle>
									{a.exhaustedUntil ? (
										<StatusPill tone="red" title={`Sidelined until ${a.exhaustedUntil}`}>
											Limit hit
										</StatusPill>
									) : (
										<StatusPill tone="green">In rotation</StatusPill>
									)}
								</div>
								<SettingRowDescription className="truncate">
									{a.kind === "api_key" ? "API key" : "ChatGPT login"}
									{" · "}
									{a.valueMasked}
								</SettingRowDescription>
							</SettingRowText>
							<SettingRowControl className="flex items-center gap-1.5">
								<select
									className={settingsSelectClass}
									value={a.owner || ""}
									onChange={(e) => handleSetOwner(a, e.target.value)}
									aria-label={`Owner of ${a.name}`}
									title={
										a.owner
											? `${a.owner}'s personal subscription — their runs use it first, everyone else never does.`
											: "Shared pool account — used by everyone and by automations."
									}
								>
									<option value="">Shared pool</option>
									{/* Keep a non-team owner (e.g. set via API) selectable. */}
									{a.owner && !TEAM.includes(a.owner) && (
										<option value={a.owner}>👤 {a.owner}</option>
									)}
									{TEAM.map((name) => (
										<option key={name} value={name}>
											👤 {name}
										</option>
									))}
								</select>
								<Menu.Root>
									<Menu.Trigger
										className={rowMenuTriggerClasses}
										aria-label={`Manage ${a.name}`}
									>
										<IconDotsHorizontal size={18} />
									</Menu.Trigger>
									<Menu.Popup align="end" sideOffset={4}>
										<Menu.Item
											onClick={() => handleRemove(a)}
											className="text-red data-[highlighted]:bg-red-soft"
										>
											<IconTrash size={16} />
											Remove account
										</Menu.Item>
									</Menu.Popup>
								</Menu.Root>
							</SettingRowControl>
						</SettingRow>
					))
				)}
			</SettingCard>
			<SettingsHint>
				The pool for GPT/Codex session runs — runs rotate to the next account when one hits its
				usage limit. A personal account is used first by its owner's runs and never by anyone
				else's; automations only use the shared pool.
			</SettingsHint>
		</>
	);
}

// ── Add forms ──────────────────────────────────────────────────────────────

function AddClaudeAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [owner, setOwner] = useState("");
	const [credentialsPath, setCredentialsPath] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleAdd() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					// Strip all whitespace — CLI copies often carry line-wrap newlines.
					token: token.replace(/\s+/g, ""),
					...(owner.trim() ? { owner: owner.trim() } : {}),
					...(credentialsPath.trim() ? { credentialsPath: credentialsPath.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			onAdded();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	return (
		<SettingsForm className="mb-3 flex flex-col gap-3.5">
			<SettingsFormTitle className="mb-0">Add Claude account</SettingsFormTitle>
			<SettingRowDescription className="-mt-2">
				On any machine, log into the Max account with <code>claude</code>, run{" "}
				<code>claude setup-token</code>, and paste the one-year token here. It's stored on the
				VPS (0600) and only ever shown masked. To show usage afterwards, use “Sign in with
				Claude” from the account's menu.
			</SettingRowDescription>

			<div className="flex gap-3.5 max-[700px]:flex-col">
				<SettingsField className="mb-0 flex-1">
					Name
					<input className={settingsInputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="team" />
				</SettingsField>
				<SettingsField className="mb-0 flex-1">
					Token
					<input
						className={settingsInputClass}
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						placeholder="sk-ant-oat01-…"
					/>
				</SettingsField>
				<SettingsField className="mb-0 flex-1" title="Personal sub: this person's runs use the account first, with the shared pool as backup — nobody else's runs touch it. Shared pool = used by everyone and by automations.">
					Owner
					<select className={settingsInputClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
						<option value="">Shared pool</option>
						{TEAM.map((n) => (
							<option key={n} value={n}>
								👤 {n}
							</option>
						))}
					</select>
				</SettingsField>
				<SettingsField className="mb-0 flex-1">
					Usage credentials path
					<input
						className={settingsInputClass}
						value={credentialsPath}
						onChange={(e) => setCredentialsPath(e.target.value)}
						placeholder="~/.claude/accounts/team/credentials.json"
					/>
				</SettingsField>
			</div>

			{error && <InlineAlert>{error}</InlineAlert>}

			<SettingsFormActions className="mt-0 gap-2.5">
				<Button onClick={onClose} disabled={saving}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={handleAdd}
					disabled={saving || !name.trim() || !token.trim()}
				>
					{saving ? "Validating…" : "Add account"}
				</Button>
			</SettingsFormActions>
		</SettingsForm>
	);
}

/**
 * "Sign in with Claude" — PKCE OAuth that attaches auto-refreshing usage
 * credentials to an existing pool account. The server hands us an authorize
 * URL; the user signs in on any device and pastes back the code Anthropic
 * displays (`…#…`), which the server exchanges and stores.
 *
 * Renders as an expansion directly beneath the triggering account row inside
 * the SettingCard (CardList draws the divider) — row-triggered content must
 * uncollapse in place, never teleport to the top of the section.
 */
function ClaudeSignInForm({
	account,
	onClose,
	onDone,
}: {
	account: ClaudeAccountInfo;
	onClose: () => void;
	onDone: () => void;
}) {
	const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`${BASE_PATH}/api/claude-accounts/oauth-login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ accountId: account.id }),
				});
				const body = await res.json();
				if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
				if (!cancelled) setLogin(body);
			} catch (e: any) {
				if (!cancelled) setError(e.message);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [account.id]);

	function handleClose() {
		if (login) {
			fetch(`${BASE_PATH}/api/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`, {
				method: "DELETE",
			}).catch(() => {});
		}
		onClose();
	}

	async function handleConnect() {
		if (!login) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			toast(`Usage tracking connected for ${account.name}`);
			onDone();
		} catch (e: any) {
			setError(e.message);
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-3.5 bg-panel px-4 py-3.5">
			<SettingRowDescription>
				Connect usage tracking with its own auto-refreshing Claude login (runs keep using the
				setup-token). Open the link, sign in as{" "}
				{account.email ? <b>{account.email}</b> : "the Claude account behind this token"}, then
				paste the code Anthropic shows you.
			</SettingRowDescription>

			{login ? (
				<div className="flex gap-3.5 max-[700px]:flex-col">
					<SettingsField className="mb-0 shrink-0 self-end">
						<a href={login.url} target="_blank" rel="noreferrer">
							<Button icon={<IconPlug size={16} />}>Open Claude sign-in</Button>
						</a>
					</SettingsField>
					<SettingsField className="mb-0 flex-1">
						Code
						<input
							className={settingsInputClass}
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="Paste the code from the sign-in page (…#…)"
						/>
					</SettingsField>
				</div>
			) : !error ? (
				<LoadingState placement="row">Preparing sign-in…</LoadingState>
			) : null}

			{error && <InlineAlert>{error}</InlineAlert>}

			<div className="flex justify-end gap-2.5">
				<Button onClick={handleClose} disabled={busy}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={handleConnect}
					disabled={busy || !login || !code.trim()}
				>
					{busy ? "Connecting…" : "Connect usage"}
				</Button>
			</div>
		</div>
	);
}

interface CodexDeviceLogin {
	id: string;
	name: string;
	state: "starting" | "awaiting_code" | "done" | "error" | "cancelled";
	url?: string;
	code?: string;
	error?: string;
}

function AddCodexAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"device" | "oauth" | "api_key" | "home">("device");
	const [value, setValue] = useState("");
	const [owner, setOwner] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
	// Paste-link OAuth flow (kind "oauth") — the codex analog of the Claude
	// sign-in: open the URL anywhere, paste back the localhost redirect.
	const [oauth, setOauth] = useState<{ id: string; url: string } | null>(null);
	const [oauthCode, setOauthCode] = useState("");

	// Poll an in-flight device sign-in until it lands (or fails).
	useEffect(() => {
		if (!login || login.state === "done" || login.state === "error") return;
		const t = setInterval(async () => {
			try {
				const res = await fetch(
					`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(login.id)}`
				);
				if (!res.ok) return;
				const next: CodexDeviceLogin = await res.json();
				setLogin(next);
				if (next.state === "done") onAdded();
			} catch {}
		}, 2000);
		return () => clearInterval(t);
	}, [login?.id, login?.state]);

	async function handleStartDeviceLogin() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/device-login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setLogin(body);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	function handleCancel() {
		if (login && (login.state === "starting" || login.state === "awaiting_code")) {
			fetch(`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(login.id)}`, {
				method: "DELETE",
			}).catch(() => {});
		}
		if (oauth) {
			fetch(`${BASE_PATH}/api/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`, {
				method: "DELETE",
			}).catch(() => {});
		}
		onClose();
	}

	async function handleStartOauth() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/oauth-login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setOauth(body);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	async function handleCompleteOauth() {
		if (!oauth) return;
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code: oauthCode }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			toast(`Codex account "${name.trim()}" added to the pool`);
			onAdded();
			return;
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	async function handleAdd() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					kind,
					value: value.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			onAdded();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	const loginPending = login && (login.state === "starting" || login.state === "awaiting_code");

	return (
		<SettingsForm className="mb-3 flex flex-col gap-3.5">
			<SettingsFormTitle className="mb-0">Add Codex account</SettingsFormTitle>
			<SettingRowDescription className="-mt-2">
				{kind === "device" ? (
					<>
						Sign in with ChatGPT from here — no VPS access needed. You'll get a link and a
						one-time code to enter on any device. (Device-code login must be enabled in the
						ChatGPT workspace's security settings.)
					</>
				) : kind === "oauth" ? (
					<>
						Sign in with ChatGPT on any device — works even where device-code login is
						disabled. After signing in you'll land on a <code>localhost</code> page that
						fails to load; copy that page's full address and paste it back here.
					</>
				) : kind === "home" ? (
					<>
						On the VPS run <code>CODEX_HOME=~/.codex-accounts/&lt;name&gt; codex login</code>{" "}
						(or copy an <code>auth.json</code> from another machine into that directory),
						then register the directory here.
					</>
				) : (
					<>For platform billing, paste an OpenAI API key.</>
				)}
			</SettingRowDescription>

			<div className="flex gap-3.5 max-[700px]:flex-col">
				<SettingsField className="mb-0 flex-1">
					Name
					<input
						className={settingsInputClass}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="team"
						disabled={!!login || !!oauth}
					/>
				</SettingsField>
				<SettingsField className="mb-0 flex-1">
					Kind
					<select
						className={settingsInputClass}
						value={kind}
						onChange={(e) => setKind(e.target.value as "device" | "oauth" | "api_key" | "home")}
						disabled={!!login || !!oauth}
					>
						<option value="device">ChatGPT sign-in — device code</option>
						<option value="oauth">ChatGPT sign-in — link + paste</option>
						<option value="home">ChatGPT login — existing CODEX_HOME directory</option>
						<option value="api_key">OpenAI API key</option>
					</select>
				</SettingsField>
				{kind !== "device" && kind !== "oauth" && (
					<SettingsField className="mb-0 flex-1">
						{kind === "api_key" ? "API key" : "CODEX_HOME path"}
						<input
							className={settingsInputClass}
							type={kind === "api_key" ? "password" : "text"}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder={kind === "api_key" ? "sk-…" : "~/.codex-accounts/team"}
						/>
					</SettingsField>
				)}
				<SettingsField className="mb-0 flex-1" title="Personal sub: this person's runs use the account first, with the shared pool as backup — nobody else's runs touch it. Shared pool = used by everyone and by automations.">
					Owner
					<select className={settingsInputClass} value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!!login || !!oauth}>
						<option value="">Shared pool</option>
						{TEAM.map((n) => (
							<option key={n} value={n}>
								👤 {n}
							</option>
						))}
					</select>
				</SettingsField>
			</div>

			{login && (
				// A well inside the form (which is itself raised), so the live
				// sign-in stands apart from the fields without another border.
				<div className="mt-2 rounded-md bg-surface px-4 py-3 text-supporting">
					{login.state === "starting" && <div className="text-dim">Starting sign-in…</div>}
					{login.state === "awaiting_code" && (
						<>
							<div>
								1. Open{" "}
								<a
									href={login.url}
									target="_blank"
									rel="noreferrer"
									className="text-accent underline"
								>
									{login.url}
								</a>{" "}
								and sign in to the ChatGPT account.
							</div>
							<div className="mt-1.5">2. Enter this one-time code (expires in 15 min):</div>
							<div className="my-2 font-mono text-page-title font-bold tracking-[0.12em] text-fg">
								{login.code}
							</div>
							<div className="text-dim">
								Waiting for the sign-in to complete… this panel updates by itself.
							</div>
						</>
					)}
					{login.state === "done" && (
						<div>Signed in — account "{login.name}" added to the pool.</div>
					)}
					{login.state === "error" && (
						<InlineAlert
							className="whitespace-pre-wrap"
							onRetry={() => setLogin(null)}
							retryLabel="Try again"
						>
							{login.error || "Sign-in failed."}
						</InlineAlert>
					)}
				</div>
			)}

			{oauth && (
				<div className="mt-2 rounded-md bg-surface px-4 py-3 text-supporting">
					<div>
						1. Open{" "}
						<a
							href={oauth.url}
							target="_blank"
							rel="noreferrer"
							className="text-accent underline"
						>
							the ChatGPT sign-in
						</a>{" "}
						and sign in to the account.
					</div>
					<div className="mt-1.5">
						2. The browser lands on a <code>localhost</code> page that can't load — copy its
						full address (starts with <code>http://localhost:1455/…</code>) and paste it:
					</div>
					<input
						className={cn(settingsInputClass, "mt-2 w-full")}
						value={oauthCode}
						onChange={(e) => setOauthCode(e.target.value)}
						placeholder="http://localhost:1455/auth/callback?code=…"
						aria-label="Pasted sign-in redirect URL"
					/>
				</div>
			)}

			{error && <InlineAlert>{error}</InlineAlert>}

			<SettingsFormActions className="mt-0 gap-2.5">
				<Button onClick={handleCancel} disabled={saving}>
					{loginPending || oauth ? "Cancel sign-in" : "Cancel"}
				</Button>
				{kind === "device" ? (
					<Button
						variant="primary"
						onClick={handleStartDeviceLogin}
						disabled={saving || !name.trim() || !!loginPending || login?.state === "done"}
					>
						{saving ? "Starting…" : loginPending ? "Waiting for sign-in…" : "Start sign-in"}
					</Button>
				) : kind === "oauth" ? (
					oauth ? (
						<Button
							variant="primary"
							onClick={handleCompleteOauth}
							disabled={saving || !oauthCode.trim()}
						>
							{saving ? "Connecting…" : "Connect"}
						</Button>
					) : (
						<Button
							variant="primary"
							onClick={handleStartOauth}
							disabled={saving || !name.trim()}
						>
							{saving ? "Starting…" : "Start sign-in"}
						</Button>
					)
				) : (
					<Button
						variant="primary"
						onClick={handleAdd}
						disabled={saving || !name.trim() || !value.trim()}
					>
						{saving ? "Adding…" : "Add account"}
					</Button>
				)}
			</SettingsFormActions>
		</SettingsForm>
	);
}
