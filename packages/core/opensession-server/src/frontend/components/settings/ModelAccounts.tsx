import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { BASE_PATH } from "../../lib/base";
import React, {
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { usePeople } from "../../lib/people";
import { providerAccountLabel } from "../../lib/provider-account";
import { UserAvatar } from "../UserAvatar";
import {
	claudeLimits,
	liveLimits,
	type LimitWindow,
	type UsageWindow,
} from "../../lib/account-usage";
import { Field, Input } from "../../ui/input";
import { Menu } from "../../ui/menu";
import { Modal } from "../../ui/modal";
import { Select } from "../../ui/select";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { Button } from "../../ui/button";
import { DeviceCode } from "../../ui/device-code";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHint,
	rowMenuTriggerClasses,
} from "../../ui/settings";
import { cn } from "../../ui/cn";
import { toast } from "../../ui/toast";
import { BrandMark, IconTile } from "../BrandTile";
import {
	IconDotsHorizontal,
	IconHistory,
	IconPeople,
	IconPlug,
	IconPlus,
	IconSliders,
	IconTrash,
} from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	h4: {
			height: "calc(4px * 4)"
	},
	itemsCenter: {
			alignItems: "center"
	},
	leadingNone: {
			lineHeight: "1"
	},
	mt05: {
			marginTop: "calc(4px * 0.5)"
	},
	size7: {
			width: "calc(4px * 7)",
			height: "calc(4px * 7)"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	mt2: {
			marginTop: "calc(4px * 2)"
	},
	grid: {
			display: "grid"
	},
	maxW420px: {
			maxWidth: "420px"
	},
	gridCols3: {
			gridTemplateColumns: "repeat(3, minmax(0, 1fr))"
	},
	gap3: {
			gap: "calc(4px * 3)"
	},
	minW0: {
			minWidth: "0"
	},
	gapX2: {
			columnGap: "calc(4px * 2)"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	textEllipsis: {
			textOverflow: "ellipsis"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	h1: {
			height: "4px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)",

		cornerShape: "round",},
	bgActive: {
			backgroundColor: "var(--bg-active)"
	},
	textRight: {
			textAlign: "right"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gapX3: {
			columnGap: "calc(4px * 3)"
	},
	gap2: {
			gap: "calc(4px * 2)"
	},
	truncate: {
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
	},
	mt15: {
			marginTop: "calc(4px * 1.5)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textRed: {
			color: "var(--red)"
	},
	gap15: {
			gap: "calc(4px * 1.5)"
	},
	hidden: {
			display: "none"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gapY15: {
			rowGap: "calc(4px * 1.5)"
	},
	mb2: {
			marginBottom: "calc(4px * 2)"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap5: {
			gap: "calc(4px * 5)"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))",

		cornerShape: "var(--cs)",},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	px4: {
			paddingInline: "calc(4px * 4)"
	},
	py3: {
			paddingBlock: "calc(4px * 3)"
	},
	selfStart: {
			alignSelf: "flex-start"
	},
	gap35: {
			gap: "calc(4px * 3.5)"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	px5: {
			paddingInline: "calc(4px * 5)"
	},
	py35: {
			paddingBlock: "calc(4px * 3.5)"
	},
	itemsEnd: {
			alignItems: "flex-end"
	},
	flex1: {
			flex: "1"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	gap25: {
			gap: "calc(4px * 2.5)"
	},
	textLink: {
			color: "var(--link)"
	},
	underline: {
			textDecorationLine: "underline"
	},
	my2: {
			marginBlock: "calc(4px * 2)"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
});

// The Claude and Codex subscription accounts runs draw from, and how full each
// one is. Rendered by Settings → Providers; the account list and its meters live
// together because the answer to "this one is spent" is an action on the row
// (hand it an owner, connect its usage, take it out of the pool).

interface ClaudeAccountInfo {
	id: string;
	name: string;
	tokenMasked: string;
	authKind: "setup-token" | "oauth";
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
	email?: string;
	kind: "api_key" | "home";
	valueMasked: string;
	owner?: string;
	mode: "shared" | "personal";
	createdAt: string;
	exhaustedUntil: string | null;
	usable: boolean;
	usage: {
		fetchedAt: string;
		buckets: CodexUsageBucket[];
		resetCreditsAvailable: number | null;
		error?: string;
	} | null;
}

interface CodexUsageBucket {
	id: string;
	label?: string;
	plan?: string;
	primary: (UsageWindow & { windowDurationMins: number | null }) | null;
	secondary: (UsageWindow & { windowDurationMins: number | null }) | null;
	rateLimitReachedType?: string;
}

// ── Shared bits ────────────────────────────────────────────────────────────

/** Who an account belongs to: the shared pool, or one person's own
 *  subscription. Both account lists render this same row control. */
/** Cancel an in-flight OAuth login when its effect tears down. Reads the
 * latest pending id at teardown time, which is the point. */
function abortPendingOAuth(pending: { current: { id?: string; done: boolean } }) {
	const { id, done } = pending.current;
	if (!done && id) {
		fetch(
			`${BASE_PATH}/api/claude-accounts/oauth-login/${encodeURIComponent(id)}`,
			{ method: "DELETE" },
		).catch(() => {});
	}
}

function OwnerSelect({
	value,
	onChange,
	label,
	title,
	disabled,
	quiet = false,
	className,
}: {
	value: string;
	onChange: (owner: string) => void;
	label: string;
	title?: string;
	disabled?: boolean;
	/** Remove field chrome when the selected owner sits inside a row. */
	quiet?: boolean;
	className?: string;
}) {
	// The roster reactively, so the list and the pictures both fill in when
	// GET /api/people lands rather than only on the next render.
	const roster = usePeople().map((p) => p.name);
	// Keep a non-team owner (e.g. set via the API) selectable.
	const owners = value && !roster.includes(value) ? [value, ...roster] : roster;
	const items = [
		{ value: "", label: "Shared pool" },
		...owners.map((name) => ({ value: name, label: name })),
	];
	// The person's own picture, the way every other people picker in the app
	// draws them. The pool is everyone, so it takes the group glyph.
	const ownerIcon = (owner: string) =>
		owner ? <UserAvatar name={owner} size={16} /> : <IconPeople size={16} />;
	return (
		<Select.Root
			items={items}
			value={value}
			disabled={disabled}
			onValueChange={(next) => onChange(String(next))}
		>
			<Select.Trigger
				aria-label={label}
				title={title}
				icon={ownerIcon(value)}
				sizeTo={quiet ? undefined : items.map((i) => i.label)}
				children={
					quiet ? <span {...stylex.props(sx.flex, sx.h4, sx.itemsCenter, sx.leadingNone)}>{value || "Shared pool"}</span> : undefined
				}
				className={cn(
					quiet &&
						utilityClassName("w-auto border-transparent bg-transparent px-2 text-dim shadow-none transition-colors hover:border-transparent hover:bg-hover enabled:hover:shadow-none focus:border-transparent data-[popup-open]:border-transparent data-[popup-open]:bg-hover phone:min-h-11 [&>svg]:size-4"),
					className,
				)}
			/>
			<Select.Popup align="end">
				{items.map((i) => (
					<Select.Item key={i.value} value={i.value} icon={ownerIcon(i.value)}>
						{i.label}
					</Select.Item>
				))}
			</Select.Popup>
		</Select.Root>
	);
}

/** A provider mark keeps mixed account rows scannable without repeating a
 * column of colored tiles beside provider names that are already written out. */
function AccountProviderMark({ name }: { name: "claude" | "codex" }) {
	return (
		<span {...stylex.props(sx.mt05, sx.flex, sx.size7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textFaint)}>
			<BrandMark name={name} size={18} />
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
	red: { dot: "bg-red", text: "text-red" },
	yellow: { dot: "bg-yellow", text: "text-yellow" },
	muted: { dot: null, text: "rounded-full bg-yellow-soft px-2 py-[2px] text-yellow" },
} as const;

function AccountStatus({
	tone,
	children,
	...props
}: React.ComponentPropsWithoutRef<"span"> & { tone: keyof typeof statusToneClasses }) {
	return (
		<span
			className={cn(
				utilityClassName("inline-flex shrink-0 items-center gap-1.5 text-meta font-medium"),
				statusToneClasses[tone].text,
			)}
			{...props}
		>
			{statusToneClasses[tone].dot && (
				<span aria-hidden className={cn(utilityClassName("size-1.5 rounded-full"), statusToneClasses[tone].dot)} />
			)}
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
 * Usage windows sit beside each other so three limits add one compact strip
 * instead of three lines to every account. Each window owns its alignment,
 * which also lets Codex wrap a fourth window without changing its neighbours.
 * Phones keep one window per line because the same strip would be unreadable
 * at that width.
 */
function MeterGroup({ children }: { children: React.ReactNode }) {
	return (
		<div {...mergeStylexProps("phone:grid-cols-1 phone:gap-1.5", sx.mt2, sx.grid, sx.maxW420px, sx.gridCols3, sx.gap3, typography.meta)} >
			{children}
		</div>
	);
}

/** One compact limit: label and value, track, then its reset time. */
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
	/** 0-100, or null when the value is unknown. The track renders empty. */
	pct: number | null;
	value: React.ReactNode;
	note?: React.ReactNode;
	noteTitle?: string;
}) {
	return (
		<div {...mergeStylexProps("grid-cols-[minmax(0,1fr)_auto] gap-y-1 phone:grid-cols-[minmax(0,1fr)_72px_minmax(38px,auto)] phone:gap-x-2 phone:gap-y-0", sx.grid, sx.minW0, sx.itemsCenter, sx.gapX2)} >
			{/* `contents` gives the desktop label and reset time separate rows.
			    On phones they become one cell beside the track and value. */}
			<span {...mergeStylexProps("phone:overflow-visible phone:whitespace-normal desktop:contents", sx.minW0)} >
				<span
					{...mergeStylexProps("desktop:col-start-1 desktop:row-start-1", sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, sx.textDim)}
					title={labelTitle}
				>
					{label}
				</span>
				{note ? (
					<span
						{...mergeStylexProps("desktop:col-span-2 desktop:row-start-3", sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, sx.textFaint)}
						title={noteTitle}
					>
						<span className={utilityClassName("phone:inline desktop:hidden")}> · </span>
						{note}
					</span>
				) : null}
			</span>
			<div {...mergeStylexProps("desktop:col-span-2 desktop:row-start-2 phone:col-start-2 phone:row-start-1", sx.h1, sx.overflowHidden, sx.roundedFull, sx.bgActive)} >
				<div
					className={cn(
						utilityClassName("h-full rounded-full transition-[width] duration-300"),
						usageToneClasses[usageTone(pct)],
					)}
					style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
				/>
			</div>
			<span {...mergeStylexProps("tabular-nums desktop:col-start-2 desktop:row-start-1 phone:col-start-3 phone:row-start-1", sx.textRight, sx.textDim)} >
				{value}
			</span>
		</div>
	);
}

/**
 * Every limit an account is running against, one compact item each: the 5-hour
 * window, the 7-day window, and any per-model weekly cap. They free up at
 * different times, so which one is full changes what you do about it. A spent
 * 5h clears this afternoon, while a spent Fable cap holds that model for days.
 * Showing only the fullest of them put the rest a hover away, which is no place
 * for a fact someone came to this page to read. Quiet ink keeps a page of
 * accounts calm; colour still means one thing, that this limit is running out.
 */
function UsageMeters({ windows }: { windows: LimitWindow[] }) {
	return (
		<>
			{liveLimits(windows).map((w, i) => (
				<Meter
					key={`${w.label}-${i}`}
					label={w.label}
					pct={w.utilization}
					value={`${Math.round(w.utilization)}%`}
					note={formatReset(w.resetsAt)}
					noteTitle={absoluteReset(w.resetsAt)}
				/>
			))}
		</>
	);
}

/**
 * Usage-credits (extra usage) spend for one account: what's been billed past
 * the subscription's included limits this month, against the account's monthly
 * credit cap. Values from the OAuth usage endpoint are cents. Hidden until
 * something has actually been spent: an account with extra usage merely
 * switched on drew a "$0.00" bar every month, which is a cap, not a cost.
 */
function ExtraUsageRow({
	extra,
}: {
	extra: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null | undefined;
}) {
	if (!extra || extra.usedCredits <= 0) return null;
	const usd = (cents: number) =>
		`$${(cents / 100).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	const pct = extra.monthlyLimit > 0 ? (extra.usedCredits / extra.monthlyLimit) * 100 : null;
	return (
		<Meter
			label="Credits"
			labelTitle="Usage-credits: pay-as-you-go spend past the subscription limits, against this account's monthly credit cap (set at claude.ai)"
			pct={pct}
			value={usd(extra.usedCredits)}
			note={`${extra.monthlyLimit > 0 ? `${usd(extra.monthlyLimit)}/mo cap` : "no monthly cap"}${
				extra.enabled ? "" : " · off"
			}`}
		/>
	);
}

// ── Claude accounts ────────────────────────────────────────────────────────

/**
 * The one thing that needs attention, never stacked, so nothing collides. A
 * healthy account gets no status: its meters already say it is fine, and nine
 * green "In rotation" labels down a page hid the two accounts that weren't.
 */
function ClaudeAccountStatus({ a }: { a: ClaudeAccountInfo }) {
	if (a.usage?.error && a.usage.errorStatus === 401)
		return (
			<AccountStatus tone="red" title={a.usage.error}>
				Token error
			</AccountStatus>
		);
	if (a.usage?.error)
		return (
			<AccountStatus tone="yellow" title={a.usage.error}>
				Usage unknown
			</AccountStatus>
		);
	if (a.noUsageScope && !a.usage)
		return (
			<AccountStatus tone="muted" title="Add OAuth usage credentials to show dashboard usage.">
				Usage hidden
			</AccountStatus>
		);
	if (a.exhaustedUntil)
		return (
			<AccountStatus tone="red" title={`Sidelined until ${a.exhaustedUntil}`}>
				Limit hit
			</AccountStatus>
		);
	if (a.usable) return null;
	return <AccountStatus tone="yellow">Near limit</AccountStatus>;
}

function useClaudeAccounts() {
	const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
	const [signIn, setSignIn] = useState<ClaudeAccountInfo | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Stable identity: only setters are captured, so the polling effect can
	// list `load` without ever refiring from re-renders.
	const load = useCallback(async (forceUsage = false) => {
		if (forceUsage) setRefreshing(true);
		await (async () => {
const res = forceUsage
				? await fetch(`${BASE_PATH}/api/claude-accounts/refresh`, { method: "POST" })
				: await fetch(`${BASE_PATH}/api/claude-accounts`);
			if (!res.ok) throw new Error(`Could not load Anthropic accounts (${res.status})`);
			setAccounts((await res.json()).accounts);
})().catch(async (cause: any) => {
setError(cause.message || "Could not load Anthropic accounts");
			setAccounts((current) => current ?? []);
});
		setRefreshing(false);
	}, []);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 60_000);
		return () => clearInterval(timer);
	}, [load]);

	async function remove(account: ClaudeAccountInfo) {
		if (!confirm(`Remove Claude account "${providerAccountLabel(account)}"? Runs will stop using this account.`)) return;
		await (async () => {
const res = await fetch(
				`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(account.id)}`,
				{ method: "DELETE" },
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			void load();
})().catch(async (cause: any) => {
setError(cause.message);
});
	}

	async function setOwner(account: ClaudeAccountInfo, owner: string) {
		if (owner === (account.owner || "")) return;
		await (async () => {
const res = await fetch(
				`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(account.id)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ owner }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			void load();
})().catch(async (cause: any) => {
setError(cause.message);
});
	}

	async function setCredentialsPath(account: ClaudeAccountInfo) {
		const current =
			account.credentialsPath ||
			`~/.claude/accounts/${account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/credentials.json`;
		const credentialsPath = prompt(
			"Path to this account's Claude OAuth credentials.json for usage polling. Leave empty to clear it.",
			current,
		);
		if (credentialsPath === null) return;
		await (async () => {
const res = await fetch(
				`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(account.id)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ owner: account.owner || "", credentialsPath }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			void load(true);
})().catch(async (cause: any) => {
setError(cause.message);
});
	}

	return {
		accounts,
		error,
		load,
		refreshing,
		remove,
		setCredentialsPath,
		setError,
		setOwner,
		setSignIn,
		signIn,
	};
}

type ClaudeAccountsState = ReturnType<typeof useClaudeAccounts>;

function ClaudeAccountRows({ state }: { state: ClaudeAccountsState }) {
	return (
		<>
			{[...(state.accounts || [])]
				.sort(
					(left, right) =>
						providerAccountLabel(left).localeCompare(providerAccountLabel(right)) ||
						left.id.localeCompare(right.id),
				)
				.map((account) => (
					<React.Fragment key={account.id}>
						<SettingRow className={mergeStylexOverrideClassName("phone:px-4", sx.itemsStart, sx.gapX3)} >
							<AccountProviderMark name="claude" />
							<SettingRowText>
								<div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
									<SettingRowTitle className={mergeStylexOverrideClassName("", sx.truncate)}>
										{providerAccountLabel(account)}
									</SettingRowTitle>
									<ClaudeAccountStatus a={account} />
								</div>
								<SettingRowDescription
									className={mergeStylexOverrideClassName("", sx.truncate, typography.meta)}
									title={["Anthropic", account.plan?.replace("default_claude_", ""), account.tokenMasked]
										.filter(Boolean)
										.join(" · ")}
								>
									Anthropic
									{account.plan ? ` · ${account.plan.replace("default_claude_", "")}` : ""}
								</SettingRowDescription>
								{account.noUsageScope && !account.usage ? (
									<div {...stylex.props(sx.mt15, sx.leadingRelaxed, sx.textFaint, typography.meta)}>
										Sign in with Claude from the account menu to show usage.
									</div>
								) : (
									<>
										<MeterGroup>
											<UsageMeters windows={claudeLimits(account.usage)} />
											<ExtraUsageRow extra={account.usage?.extraUsage} />
										</MeterGroup>
										{account.usage?.source === "meridian" && (
											<div {...stylex.props(sx.mt15, sx.textFaint, typography.meta)}>
												Observed through Meridian from rate-limit events during live runs. The
												token cannot read the usage endpoint directly.
											</div>
										)}
										{account.usage?.error && (
											<div {...stylex.props(sx.mt15, sx.textRed, typography.meta)}>{account.usage.error}</div>
										)}
									</>
								)}
							</SettingRowText>
							<SettingRowControl className={mergeStylexOverrideClassName("phone:mt-1 phone:ml-0 phone:w-full phone:basis-full phone:gap-2.5 phone:pl-10", sx.flex, sx.itemsCenter, sx.gap15)} >
								<span {...mergeStylexProps("phone:inline", sx.hidden, sx.shrink0, sx.textFaint, typography.meta)} >Used by</span>
								<OwnerSelect
									value={account.owner || ""}
									onChange={(owner) => state.setOwner(account, owner)}
									label={`Owner of ${providerAccountLabel(account)}`}
									quiet
									className={utilityClassName("phone:ml-auto")}
									title={
										account.owner
											? `${account.owner}'s personal subscription. Their runs use it first, everyone else never does.`
											: "Shared pool account, used by everyone and by automations."
									}
								/>
								<Menu.Root>
									<Menu.Trigger
										className={rowMenuTriggerClasses}
										aria-label={`Manage ${providerAccountLabel(account)}`}
									>
										<IconDotsHorizontal size={18} />
									</Menu.Trigger>
									<Menu.Popup align="end" sideOffset={4}>
										<Menu.Item onClick={() => state.setSignIn(account)}>
											<IconPlug size={16} className={mergeStylexOverrideClassName("", sx.textFaint)} />
											Connect usage…
										</Menu.Item>
										{account.authKind === "setup-token" && (
											<Menu.Item onClick={() => state.setCredentialsPath(account)}>
												<IconSliders size={16} className={mergeStylexOverrideClassName("", sx.textFaint)} />
												Usage credentials…
											</Menu.Item>
										)}
										<Menu.Item
											onClick={() => state.remove(account)}
											className={mergeStylexOverrideClassName("data-[highlighted]:bg-red-soft", sx.textRed)}
										>
											<IconTrash size={16} />
											Remove account
										</Menu.Item>
									</Menu.Popup>
								</Menu.Root>
							</SettingRowControl>
						</SettingRow>
						{state.signIn?.id === account.id && (
							<ClaudeSignInForm
								account={account}
								onClose={() => state.setSignIn(null)}
								onDone={() => {
									state.setSignIn(null);
									void state.load();
								}}
							/>
						)}
					</React.Fragment>
				))}
		</>
	);
}

/** Provider-specific summary used by onboarding. The full settings page uses
 * ProviderAccountsSection so every account shares one list and one toolbar. */
export function ClaudeAccountsSection({
	onChanged,
}: {
	compact?: boolean;
	onChanged?: () => void | Promise<void>;
} = {}) {
	const state = useClaudeAccounts();
	const [showAdd, setShowAdd] = useState(false);
	const available =
		state.accounts?.filter((account) => account.usable && !account.exhaustedUntil).length ?? 0;
	return (
		<>
			<SettingsGroupLabel
				actions={
					<Button size="sm" icon={<IconPlus size={16} />} onClick={() => setShowAdd(true)}>
						Add account
					</Button>
				}
			>
				Claude
			</SettingsGroupLabel>
			<Modal.Root open={showAdd} onOpenChange={setShowAdd}>
				<Modal.Content widthClassName={utilityClassName("max-w-[32rem]")}>
					<AddClaudeAccountForm
						onAccountAdded={() => {
							void state.load();
							void onChanged?.();
						}}
						onDone={() => setShowAdd(false)}
					/>
				</Modal.Content>
			</Modal.Root>
			<SettingCard>
				{!state.accounts ? (
					<LoadingState placement="row">Checking Claude…</LoadingState>
				) : (
					<SettingRow>
						<IconTile name="claude" size={28} />
						<SettingRowText>
							<SettingRowTitle>Claude</SettingRowTitle>
							<SettingRowDescription>
								{state.accounts.length === 0
									? "Add a Claude account before choosing an Anthropic model."
									: `${available} available of ${state.accounts.length} connected`}
							</SettingRowDescription>
						</SettingRowText>
						<span {...stylex.props(sx.shrink0, sx.textDim, typography.label)}>
							{available > 0
								? "Ready"
								: state.accounts.length > 0
									? "Unavailable"
									: "Not connected"}
						</span>
					</SettingRow>
				)}
			</SettingCard>
		</>
	);
}

// ── Codex accounts ─────────────────────────────────────────────────────────

function CodexAccountStatus({ account }: { account: CodexAccountInfo }) {
	if (account.exhaustedUntil)
		return (
			<AccountStatus tone="red" title={`Sidelined until ${account.exhaustedUntil}`}>
				Limit hit
			</AccountStatus>
		);
	if (account.usage?.error)
		return (
			<AccountStatus tone="yellow" title={account.usage.error}>
				Usage unknown
			</AccountStatus>
		);
	return null;
}

function CodexUsageMeters({ account }: { account: CodexAccountInfo }) {
	if (account.kind === "api_key")
		return (
			<div {...stylex.props(sx.mt15, sx.textFaint, typography.meta)}>
				Platform usage is billed at the organization level, not per API key.
			</div>
		);
	if (!account.usage)
		return <div {...stylex.props(sx.mt15, sx.textFaint, typography.meta)}>Checking usage…</div>;
	if (account.usage.error)
		return <div {...stylex.props(sx.mt15, sx.textRed, typography.meta)}>{account.usage.error}</div>;

	const bucketName = (bucket: CodexUsageBucket) =>
		bucket.label || (bucket.id === "codex" ? "Codex" : bucket.id);
	const windowLabel = (minutes: number | null) => {
		if (!minutes) return "Usage";
		if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
		if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
		if (minutes % 60 === 0) return `${minutes / 60}h`;
		return `${minutes}m`;
	};
	// A bucket the account names is a per-model budget (GPT-5.3-Codex-Spark)
	// rather than the plan's own window, so it is listed after the plan's and
	// carries the model's name.
	const multipleBuckets = account.usage.buckets.length > 1;
	const windows: LimitWindow[] = account.usage.buckets.flatMap((bucket) =>
		[bucket.primary, bucket.secondary].flatMap((window) => {
			if (!window) return [];
			const duration = windowLabel(window.windowDurationMins);
			return [
				{
					label: multipleBuckets ? `${bucketName(bucket)} ${duration}` : duration,
					utilization: window.utilization,
					resetsAt: window.resetsAt,
					scoped: !!bucket.label,
				},
			];
		}),
	);
	return (
		<>
			{windows.length > 0 && (
				<MeterGroup>
					<UsageMeters windows={windows} />
				</MeterGroup>
			)}
			{account.usage.resetCreditsAvailable !== null &&
				account.usage.resetCreditsAvailable > 0 && (
					<div {...stylex.props(sx.mt15, sx.textFaint, typography.meta)}>
						{account.usage.resetCreditsAvailable} rate-limit reset
						{account.usage.resetCreditsAvailable === 1 ? "" : "s"} available
					</div>
				)}
		</>
	);
}

function useCodexAccounts() {
	const [accounts, setAccounts] = useState<CodexAccountInfo[] | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (forceUsage = false) => {
		if (forceUsage) setRefreshing(true);
		await (async () => {
const res = forceUsage
				? await fetch(`${BASE_PATH}/api/codex-accounts/refresh`, { method: "POST" })
				: await fetch(`${BASE_PATH}/api/codex-accounts`);
			if (!res.ok) throw new Error(`Could not load OpenAI accounts (${res.status})`);
			setAccounts((await res.json()).accounts);
})().catch(async (cause: any) => {
setError(cause.message || "Could not load OpenAI accounts");
			setAccounts((current) => current ?? []);
});
		setRefreshing(false);
	}, []);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 60_000);
		return () => clearInterval(timer);
	}, [load]);

	async function setOwner(account: CodexAccountInfo, owner: string) {
		if (owner === (account.owner || "")) return;
		await (async () => {
const res = await fetch(
				`${BASE_PATH}/api/codex-accounts/${encodeURIComponent(account.id)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ owner }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			void load();
})().catch(async (cause: any) => {
setError(cause.message);
});
	}

	async function remove(account: CodexAccountInfo) {
		if (!confirm(`Remove Codex account "${providerAccountLabel(account)}"? Runs will stop using it.`)) return;
		await (async () => {
const res = await fetch(
				`${BASE_PATH}/api/codex-accounts/${encodeURIComponent(account.id)}`,
				{ method: "DELETE" },
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			void load();
})().catch(async (cause: any) => {
setError(cause.message);
});
	}

	return { accounts, error, load, refreshing, remove, setError, setOwner };
}

type CodexAccountsState = ReturnType<typeof useCodexAccounts>;

function CodexAccountRows({ state }: { state: CodexAccountsState }) {
	return (
		<>
			{[...(state.accounts || [])]
				.sort(
					(left, right) =>
						providerAccountLabel(left).localeCompare(providerAccountLabel(right)) ||
						left.id.localeCompare(right.id),
				)
				.map((account) => (
					<SettingRow key={account.id} className={mergeStylexOverrideClassName("phone:px-4", sx.itemsStart, sx.gapX3)} >
						<AccountProviderMark name="codex" />
						<SettingRowText>
							<div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
								<SettingRowTitle className={mergeStylexOverrideClassName("", sx.truncate)}>
									{providerAccountLabel(account)}
								</SettingRowTitle>
								<CodexAccountStatus account={account} />
							</div>
							<SettingRowDescription className={mergeStylexOverrideClassName("", sx.truncate, typography.meta)} title={account.valueMasked}>
								OpenAI · {account.kind === "api_key" ? "API key" : "ChatGPT login"}
								{account.usage?.buckets.find((bucket) => bucket.plan)?.plan
									? ` · ${account.usage.buckets.find((bucket) => bucket.plan)!.plan}`
									: ""}
								{account.kind === "api_key" ? ` · ${account.valueMasked}` : ""}
							</SettingRowDescription>
							<CodexUsageMeters account={account} />
						</SettingRowText>
						<SettingRowControl className={mergeStylexOverrideClassName("phone:mt-1 phone:ml-0 phone:w-full phone:basis-full phone:gap-2.5 phone:pl-10", sx.flex, sx.itemsCenter, sx.gap15)} >
							<span {...mergeStylexProps("phone:inline", sx.hidden, sx.shrink0, sx.textFaint, typography.meta)} >Used by</span>
							<OwnerSelect
								value={account.owner || ""}
								onChange={(owner) => state.setOwner(account, owner)}
								label={`Owner of ${providerAccountLabel(account)}`}
								quiet
								className={utilityClassName("phone:ml-auto")}
								title={
									account.owner
										? `${account.owner}'s personal subscription. Their runs use it first, everyone else never does.`
										: "Shared pool account, used by everyone and by automations."
								}
							/>
							<Menu.Root>
								<Menu.Trigger
									className={rowMenuTriggerClasses}
									aria-label={`Manage ${providerAccountLabel(account)}`}
								>
									<IconDotsHorizontal size={18} />
								</Menu.Trigger>
								<Menu.Popup align="end" sideOffset={4}>
									<Menu.Item
										onClick={() => state.remove(account)}
										className={mergeStylexOverrideClassName("data-[highlighted]:bg-red-soft", sx.textRed)}
									>
										<IconTrash size={16} />
										Remove account
									</Menu.Item>
								</Menu.Popup>
							</Menu.Root>
						</SettingRowControl>
					</SettingRow>
				))}
		</>
	);
}

/** Provider-specific summary used by onboarding. */
export function CodexAccountsSection({
	onChanged,
}: {
	compact?: boolean;
	onChanged?: () => void | Promise<void>;
} = {}) {
	const state = useCodexAccounts();
	const [showAdd, setShowAdd] = useState(false);
	const available =
		state.accounts?.filter((account) => account.usable && !account.exhaustedUntil).length ?? 0;
	return (
		<>
			<SettingsGroupLabel
				actions={
					<Button size="sm" icon={<IconPlus size={16} />} onClick={() => setShowAdd(true)}>
						Add account
					</Button>
				}
			>
				OpenAI Codex
			</SettingsGroupLabel>
			<Modal.Root open={showAdd} onOpenChange={setShowAdd}>
				<Modal.Content>
					<AddCodexAccountForm
						onAdded={() => {
							setShowAdd(false);
							void state.load();
							void onChanged?.();
						}}
					/>
				</Modal.Content>
			</Modal.Root>
			<SettingCard>
				{!state.accounts ? (
					<LoadingState placement="row">Checking Codex…</LoadingState>
				) : (
					<SettingRow>
						<IconTile name="codex" size={28} />
						<SettingRowText>
							<SettingRowTitle>OpenAI Codex</SettingRowTitle>
							<SettingRowDescription>
								{state.accounts.length === 0
									? "Add a ChatGPT login or API key before choosing an OpenAI model."
									: `${available} available of ${state.accounts.length} connected`}
							</SettingRowDescription>
						</SettingRowText>
						<span {...stylex.props(sx.shrink0, sx.textDim, typography.label)}>
							{available > 0
								? "Ready"
								: state.accounts.length > 0
									? "Unavailable"
									: "Not connected"}
						</span>
					</SettingRow>
				)}
			</SettingCard>
		</>
	);
}

/** One provider, collapsed: how many accounts it has and how many can take a
 * run right now. The accounts themselves stay one click away, so a pool of a
 * dozen reads as two rows instead of a page of meters. */
function ProviderSummaryRow({
	mark,
	title,
	accounts,
	expanded,
	onToggle,
	onAdd,
	children,
}: {
	mark: "claude" | "codex";
	title: string;
	accounts: { usable: boolean; exhaustedUntil: string | null }[];
	expanded: boolean;
	onToggle: () => void;
	onAdd: () => void;
	children: React.ReactNode;
}) {
	const total = accounts.length;
	const available = accounts.filter((a) => a.usable && !a.exhaustedUntil).length;
	return (
		<>
			<SettingRow>
				<IconTile name={mark} size={28} />
				<SettingRowText>
					<SettingRowTitle>{title}</SettingRowTitle>
					<SettingRowDescription>
						{total === 0
							? "No accounts yet"
							: `${total} account${total === 1 ? "" : "s"} · ${available} available`}
					</SettingRowDescription>
				</SettingRowText>
				<SettingRowControl className={mergeStylexOverrideClassName("", sx.flex, sx.itemsCenter, sx.gap15)}>
					{total > 0 && (
						<Button
							size="sm"
							variant="ghost"
							className={utilityClassName("phone:min-h-11")}
							aria-expanded={expanded}
							onClick={onToggle}
						>
							{expanded ? "Hide accounts" : "View accounts"}
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						className={utilityClassName("phone:min-h-11")}
						icon={<IconPlus size={16} />}
						onClick={onAdd}
					>
						Add account
					</Button>
				</SettingRowControl>
			</SettingRow>
			{expanded && children}
		</>
	);
}

/** Every subscription account in one provider-neutral list. Provider marks and
 * metadata preserve where each account comes from without splitting the pool
 * into separate cards.
 *
 * It opens collapsed — one row per provider with its account count — because
 * the full list is a page of usage meters and the question people arrive with
 * is "do we have capacity here". "All accounts" restores the flat list in
 * Settings; onboarding keeps the simpler provider summary. */
export function ProviderAccountsSection({
	onboarding = false,
	onChanged,
}: {
	onboarding?: boolean;
	onChanged?: () => void | Promise<void>;
} = {}) {
	const claude = useClaudeAccounts();
	const codex = useCodexAccounts();
	const [adding, setAdding] = useState<"claude" | "codex" | null>(null);
	const [view, setView] = useState<"providers" | "accounts">("providers");
	const [expanded, setExpanded] = useState<"claude" | "codex" | null>(null);
	const loading = claude.accounts === null || codex.accounts === null;
	const empty = !loading && claude.accounts?.length === 0 && codex.accounts?.length === 0;
	const refreshing = claude.refreshing || codex.refreshing;

	function refreshUsage() {
		void Promise.allSettled([claude.load(true), codex.load(true)]);
	}

	return (
		<>
			<SettingsGroupLabel
				className={cn(
					"phone:[&>span]:w-full phone:[&>div]:w-full phone:[&>div]:flex-wrap",
					onboarding && utilityClassName("px-6"),
				)}
				actions={
				<>
					{!onboarding && (
						<Button
							size="sm"
							variant="ghost"
							className={utilityClassName("phone:min-h-11")}
							icon={<IconHistory size={16} className={refreshing ? utilityClassName("animate-spin") : ""} />}
							onClick={refreshUsage}
							disabled={refreshing}
						>
							{refreshing ? "Checking…" : "Refresh usage"}
						</Button>
					)}
					<Menu.Root>
						<Menu.Trigger
							render={
								<Button
									size={onboarding ? "md" : "sm"}
									variant={onboarding ? "primary" : "default"}
									className={cn(
										utilityClassName("phone:min-h-11"),
										onboarding && utilityClassName("bg-fg text-bg hover:bg-fg/85"),
									)}
									icon={<IconPlus size={16} />}
									caret={!onboarding}
								>
									Add account
								</Button>
							}
						/>
						<Menu.Popup align="end" sideOffset={4}>
							<Menu.Item onClick={() => setAdding("claude")}>
								<IconTile name="claude" size={18} />
								Claude account
							</Menu.Item>
							<Menu.Item onClick={() => setAdding("codex")}>
								<IconTile name="codex" size={18} />
								OpenAI account
							</Menu.Item>
						</Menu.Popup>
					</Menu.Root>
				</>
			}
			>
				<span {...stylex.props(sx.inlineFlex, sx.flexWrap, sx.itemsCenter, sx.gapX3, sx.gapY15)}>
					Subscriptions
					{!onboarding && (
						<Segmented
							label="Account view"
							size="sm"
							value={view}
							onValueChange={(next) => setView(next as "providers" | "accounts")}
						>
							<SegmentedOption value="providers">Providers</SegmentedOption>
							<SegmentedOption value="accounts">All accounts</SegmentedOption>
						</Segmented>
					)}
				</span>
			</SettingsGroupLabel>

			{claude.error && (
				<InlineAlert className={mergeStylexOverrideClassName("", sx.mb2)} onDismiss={() => claude.setError(null)}>
					{claude.error}
				</InlineAlert>
			)}
			{codex.error && (
				<InlineAlert className={mergeStylexOverrideClassName("", sx.mb2)} onDismiss={() => codex.setError(null)}>
					{codex.error}
				</InlineAlert>
			)}

			<Modal.Root open={adding === "claude"} onOpenChange={(open) => !open && setAdding(null)}>
				<Modal.Content widthClassName={utilityClassName("max-w-[32rem]")}>
					<AddClaudeAccountForm
						onAccountAdded={() => {
							void claude.load();
							void onChanged?.();
						}}
						onDone={() => setAdding(null)}
					/>
				</Modal.Content>
			</Modal.Root>
			<Modal.Root open={adding === "codex"} onOpenChange={(open) => !open && setAdding(null)}>
				<Modal.Content>
					<AddCodexAccountForm
						onAdded={() => {
							setAdding(null);
							void codex.load();
							void onChanged?.();
						}}
					/>
				</Modal.Content>
			</Modal.Root>

			<SettingCard className={onboarding ? utilityClassName("p-1") : undefined}>
				{loading ? (
					<LoadingState placement="row">Loading accounts…</LoadingState>
				) : empty ? (
					<EmptyState placement="row">
						{onboarding
							? "Connect a Claude or OpenAI account to use its subscription."
							: "No accounts yet. Runs use this server's Claude and Codex sign-ins until you add an Anthropic or OpenAI account."}
					</EmptyState>
				) : view === "providers" ? (
					<>
						<ProviderSummaryRow
							mark="claude"
							title="Claude"
							accounts={claude.accounts || []}
							expanded={expanded === "claude"}
							onToggle={() => setExpanded(expanded === "claude" ? null : "claude")}
							onAdd={() => setAdding("claude")}
						>
							<ClaudeAccountRows state={claude} />
						</ProviderSummaryRow>
						<ProviderSummaryRow
							mark="codex"
							title="OpenAI"
							accounts={codex.accounts || []}
							expanded={expanded === "codex"}
							onToggle={() => setExpanded(expanded === "codex" ? null : "codex")}
							onAdd={() => setAdding("codex")}
						>
							<CodexAccountRows state={codex} />
						</ProviderSummaryRow>
					</>
				) : (
					<>
						<ClaudeAccountRows state={claude} />
						<CodexAccountRows state={codex} />
					</>
				)}
			</SettingCard>
			<SettingsHint className={onboarding ? utilityClassName("mt-4 px-6") : undefined}>
				Runs rotate through shared accounts for the selected model. Personal accounts
				are used only for their owner's runs.
			</SettingsHint>
		</>
	);
}

// ── Add forms ──────────────────────────────────────────────────────────────

function AddClaudeAccountForm({
	onAccountAdded,
	onDone,
}: {
	onAccountAdded: () => void;
	onDone: () => void;
}) {
	const [account, setAccount] = useState<ClaudeAccountInfo | null>(null);
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [owner, setOwner] = useState("");
	const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
	const [code, setCode] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef<{ id?: string; done: boolean }>({ done: false });
	useLayoutEffect(() => {
		pending.current.id = login?.id;
	});

	useEffect(() => {
		if (!account) return;
		let cancelled = false;
		void (async () => {
			await (async () => {
const res = await fetch(`${BASE_PATH}/api/claude-accounts/oauth-login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ accountId: account.id }),
				});
				const body = await res.json();
				if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
				if (!cancelled) setLogin(body);
})().catch(async (cause: any) => {
if (!cancelled) setError(cause.message);
});
		})();
		return () => {
			cancelled = true;
			abortPendingOAuth(pending);
		};
	}, [account]);

	async function handleAddToken() {
		setSaving(true);
		setError(null);
		await (async () => {
const res = await fetch(`${BASE_PATH}/api/claude-accounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					token: token.replace(/\s+/g, ""),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setAccount(body);
			onAccountAdded();
})().catch(async (cause: any) => {
setError(cause.message);
});
		setSaving(false);
	}

	async function handleConnectUsage() {
		if (!login) return;
		setSaving(true);
		setError(null);
		await (async () => {
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
			pending.current.done = true;
			toast(
				`Usage tracking connected for ${
					body.account
						? providerAccountLabel(body.account)
						: account
							? providerAccountLabel(account)
							: "Claude"
				}`,
			);
			onAccountAdded();
			onDone();
})().catch(async (cause: any) => {
setError(cause.message);
			setSaving(false);
});
	}

	if (account) {
		return (
			<>
				<Modal.Header
					title="Connect usage tracking"
					description="The setup token is connected for model runs."
				/>
				<form
					{...stylex.props(sx.flex, sx.flexCol, sx.gap5)}
					onSubmit={(event) => {
						event.preventDefault();
						if (login && code.trim() && !saving) void handleConnectUsage();
					}}
				>
					<div {...stylex.props(sx.flex, sx.flexCol, sx.gap3, sx.roundedMd, sx.bgSurface, sx.px4, sx.py3)}>
						{login ? (
							<Button
								render={<a {...stylex.props(sx.selfStart)} href={login.url} target="_blank" rel="noreferrer" />}
								icon={<IconPlug size={16} />}
							>
								Open Claude sign-in
							</Button>
						) : !error ? (
							<LoadingState placement="row">Preparing sign-in…</LoadingState>
						) : null}
						<SettingRowDescription>
							Sign in with the same Claude account to show usage and reset times. Claude asks
							you to reconnect about every 30 days.
						</SettingRowDescription>
						<Field label="Code">
							<Input
								value={code}
								onChange={(event) => setCode(event.target.value)}
								placeholder="Paste the code from Claude (…#…)"
								autoCapitalize="none"
								spellCheck={false}
							/>
						</Field>
						<p {...mergeStylexProps("m-0", sx.leadingRelaxed, sx.textFaint, typography.meta)} >
							You can finish later. Runs can use this account without usage tracking.
						</p>
					</div>

					{error && <InlineAlert>{error}</InlineAlert>}

					<Modal.Footer>
						<Button variant="ghost" type="button" disabled={saving} onClick={onDone}>
							Finish later
						</Button>
						<Button variant="primary" type="submit" disabled={saving || !login || !code.trim()}>
							{saving ? "Connecting…" : "Connect usage"}
						</Button>
					</Modal.Footer>
				</form>
			</>
		);
	}

	const ready = Boolean(name.trim() && token.trim());
	return (
		<>
			<Modal.Header
				title="Add Claude account"
				description="Claude uses a setup token for model runs and a separate sign-in for usage tracking."
			/>
			<form
				{...stylex.props(sx.flex, sx.flexCol, sx.gap5)}
				onSubmit={(event) => {
					event.preventDefault();
					if (ready && !saving) void handleAddToken();
				}}
			>
				<div {...stylex.props(sx.flex, sx.flexCol, sx.gap3)}>
					<Field label="Email">
						<Input
							required
							type="email"
							autoComplete="email"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="person@example.com"
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
					<Field label="Setup token">
						<Input
							required
							type="password"
							autoComplete="off"
							value={token}
							onChange={(event) => setToken(event.target.value)}
							placeholder="sk-ant-oat01-…"
						/>
					</Field>
					<p {...mergeStylexProps("m-0", sx.leadingRelaxed, sx.textFaint, typography.meta)} >
						Run <code>claude setup-token</code> while signed into this Claude account. The
						token powers model runs for about one year.
					</p>
					<Field label="Owner" title="Personal sub: this person's runs use the account first, with the shared pool as backup. Shared pool: used by everyone and by automations.">
						<OwnerSelect value={owner} onChange={setOwner} label="Owner" />
					</Field>
				</div>

				{error && <InlineAlert>{error}</InlineAlert>}

				<Modal.Footer>
					<Modal.Close render={<Button variant="ghost" disabled={saving}>Cancel</Button>} />
					<Button variant="primary" type="submit" disabled={saving || !ready}>
						{saving ? "Validating…" : "Continue"}
					</Button>
				</Modal.Footer>
			</form>
		</>
	);
}

/**
 * "Connect usage" attaches PKCE OAuth to an existing setup-token account.
 * The server hands us an authorize URL; the user signs in on any device and pastes
 * back the code Anthropic
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
			await (async () => {
const res = await fetch(`${BASE_PATH}/api/claude-accounts/oauth-login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ accountId: account.id }),
				});
				const body = await res.json();
				if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
				if (!cancelled) setLogin(body);
})().catch(async (e: any) => {
if (!cancelled) setError(e.message);
});
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
		await (async () => {
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
			toast(`Usage tracking connected for ${providerAccountLabel(account)}`);
			onDone();
})().catch(async (e: any) => {
setError(e.message);
			setBusy(false);
});
	}

	return (
		<div {...stylex.props(sx.flex, sx.flexCol, sx.gap35, sx.bgPanel, sx.px5, sx.py35)}>
			<SettingRowDescription>
				{account.authKind === "oauth"
					? "Reconnect this account for model runs and usage tracking. "
					: "Connect usage tracking. Runs keep using the existing setup token. "}
				Open the link, sign in as{" "}
				{account.email ? <b>{account.email}</b> : "the Claude account behind this token"}, then
				paste the code Claude shows you.
			</SettingRowDescription>

			{login ? (
				<div {...mergeStylexProps("phone:flex-col phone:items-stretch", sx.flex, sx.itemsEnd, sx.gap35)} >
					<a {...stylex.props(sx.shrink0)} href={login.url} target="_blank" rel="noreferrer">
						<Button icon={<IconPlug size={16} />}>Open Claude sign-in</Button>
					</a>
					<Field className={mergeStylexOverrideClassName("", sx.flex1)} label="Code">
						<Input
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="Paste the code from the sign-in page (…#…)"
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
				</div>
			) : !error ? (
				<LoadingState placement="row">Preparing sign-in…</LoadingState>
			) : null}

			{error && <InlineAlert>{error}</InlineAlert>}

			<div {...stylex.props(sx.flex, sx.justifyEnd, sx.gap25)}>
				<Button variant="soft" onClick={handleClose} disabled={busy}>
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
	account?: CodexAccountInfo;
}

/** How a Codex account is added: a ChatGPT sign-in, an existing CODEX_HOME
 *  directory, or a plain API key. */
const KIND_ITEMS = [
	{ value: "device", label: "ChatGPT sign-in · device code" },
	{ value: "oauth", label: "ChatGPT sign-in · link and paste" },
	{ value: "home", label: "ChatGPT login · existing CODEX_HOME directory" },
	{ value: "api_key", label: "OpenAI API key" },
];

function AddCodexAccountForm({ onAdded }: { onAdded: () => void }) {
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
	const [pendingDone, setPendingDone] = useState(false);

	// Abandoning a half-finished sign-in has to release it server-side, and the
	// dialog can now be dismissed by Escape or the backdrop as well as by
	// Cancel. The Effect Event gives unmount cleanup the latest committed login.
	const cleanupPendingLogin = useEffectEvent(() => {
		if (pendingDone) return;
		const loginId =
			login && (login.state === "starting" || login.state === "awaiting_code")
				? login.id
				: undefined;
		if (loginId)
			fetch(`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(loginId)}`, {
				method: "DELETE",
			}).catch(() => {});
		if (oauth?.id)
			fetch(`${BASE_PATH}/api/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`, {
				method: "DELETE",
			}).catch(() => {});
	});
	useEffect(() => () => cleanupPendingLogin(), []);

	// Poll an in-flight device sign-in until it lands (or fails). The tick
	// reads the live login/onAdded through an effect event; the effect only
	// re-arms when the login identity or its phase changes.
	const pollDeviceLoginTick = useEffectEvent(async () => {
		await (async () => {
const res = await fetch(
				`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(login?.id ?? "")}`
			);
			if (!res.ok) return;
			const next: CodexDeviceLogin = await res.json();
			setLogin(next);
			if (next.state === "done") {
				setPendingDone(true);
				onAdded();
			}
})().catch(async () => {

});
	});
	const loginId = login?.id;
	const loginState = login?.state;
	useEffect(() => {
		if (!loginId || loginState === "done" || loginState === "error") return;
		const t = setInterval(() => void pollDeviceLoginTick(), 2000);
		return () => clearInterval(t);
	}, [loginId, loginState]);

	async function handleStartDeviceLogin() {
		setSaving(true);
		setError(null);
		await (async () => {
const res = await fetch(`${BASE_PATH}/api/codex-accounts/device-login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setLogin(body);
})().catch(async (e: any) => {
setError(e.message);
});
		setSaving(false);
	}

	async function handleStartOauth() {
		setSaving(true);
		setError(null);
		await (async () => {
const res = await fetch(`${BASE_PATH}/api/codex-accounts/oauth-login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setOauth(body);
})().catch(async (e: any) => {
setError(e.message);
});
		setSaving(false);
	}

	async function handleCompleteOauth() {
		if (!oauth) return;
		setSaving(true);
		setError(null);
		await fetch(
			`${BASE_PATH}/api/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: oauthCode }),
			},
		)
			.then(async (res) => {
				const body = await res.json();
				if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
				toast(`Codex account ${providerAccountLabel(body.account)} added to the pool`);
				setPendingDone(true);
				onAdded();
			})
			.catch((error: any) => {
				setError(error.message);
				setSaving(false);
			});
	}

	async function handleAdd() {
		setSaving(true);
		setError(null);
		await (async () => {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(kind === "api_key" ? { name: name.trim() } : {}),
					kind,
					value: value.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setPendingDone(true);
			onAdded();
		})().catch((error: any) => {
			setError(error.message);
			setSaving(false);
		});
	}

	const loginPending = login && (login.state === "starting" || login.state === "awaiting_code");

	return (
		<>
			<Modal.Header
				title="Add Codex account"
				description={kind === "device" ? (
					<>
						Sign in with ChatGPT from here, with no VPS access needed. You'll get a link and a
						one-time code to enter on any device. (Device-code login must be enabled in the
						ChatGPT workspace's security settings.)
					</>
				) : kind === "oauth" ? (
					<>
						Sign in with ChatGPT on any device. Works even where device-code login is
						disabled. After signing in you'll land on a <code>localhost</code> page that
						fails to load; copy that page's full address and paste it back here.
					</>
				) : kind === "home" ? (
					<>
						On the VPS run <code>CODEX_HOME=~/.codex-accounts/&lt;account&gt; codex login</code>{" "}
						(or copy an <code>auth.json</code> from another machine into that directory),
						then register the directory here.
					</>
				) : (
					<>For platform billing, paste an OpenAI API key.</>
				)}
			/>

			<form
				{...stylex.props(sx.flex, sx.flexCol, sx.gap5)}
				onSubmit={(event) => {
					event.preventDefault();
					if (saving) return;
					if (kind === "device") {
						if (!loginPending && login?.state !== "done") void handleStartDeviceLogin();
					} else if (kind === "oauth") {
						if (oauth) {
							if (oauthCode.trim()) void handleCompleteOauth();
						} else void handleStartOauth();
					} else if (value.trim() && (kind !== "api_key" || name.trim())) void handleAdd();
				}}
			>
			<div {...stylex.props(sx.flex, sx.flexCol, sx.gap3)}>
				{kind === "api_key" && (
					<Field label="Name">
						<Input
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Platform key"
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
				)}
				<Field label="Kind">
					<Select.Root
						items={KIND_ITEMS}
						value={kind}
						disabled={!!login || !!oauth}
						onValueChange={(next) => setKind(next as "device" | "oauth" | "api_key" | "home")}
					>
						<Select.Trigger aria-label="Kind" />
						<Select.Popup>
							{KIND_ITEMS.map((k) => (
								<Select.Item key={k.value} value={k.value}>
									{k.label}
								</Select.Item>
							))}
						</Select.Popup>
					</Select.Root>
				</Field>
				{kind !== "device" && kind !== "oauth" && (
					<Field label={kind === "api_key" ? "API key" : "CODEX_HOME path"}>
						<Input
							type={kind === "api_key" ? "password" : "text"}
							required
							autoComplete={kind === "api_key" ? "off" : undefined}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder={kind === "api_key" ? "sk-…" : "~/.codex-accounts/team"}
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
				)}
				<Field label="Owner" title="Personal sub: this person's runs use the account first, with the shared pool as backup. Shared pool: used by everyone and by automations.">
					<OwnerSelect
						value={owner}
						onChange={setOwner}
						label="Owner"
						disabled={!!login || !!oauth}
					/>
				</Field>
			</div>

			{login && (
				// A well inside the dialog, so the live sign-in stands apart
				// from the fields without another border.
				<div role="status" aria-live="polite" {...stylex.props(sx.roundedMd, sx.bgSurface, sx.px4, sx.py3, typography.supporting)}>
					{login.state === "starting" && <div {...stylex.props(sx.textDim)}>Starting sign-in…</div>}
					{login.state === "awaiting_code" && (
						<>
							<div>
								1. Open{" "}
								<a
									href={login.url}
									target="_blank"
									rel="noreferrer"
									{...stylex.props(sx.textLink, sx.underline)}
								>
									{login.url}
								</a>{" "}
								and sign in to the ChatGPT account.
							</div>
							<div {...stylex.props(sx.mt15)}>2. Enter this one-time code (expires in 15 min):</div>
							{login.code && (
								<div {...stylex.props(sx.my2)}>
									<DeviceCode code={login.code} className={mergeStylexOverrideClassName("", typography.sectionTitle)} />
								</div>
							)}
							<div {...stylex.props(sx.textDim)}>
								Waiting for the sign-in to complete… this panel updates by itself.
							</div>
						</>
					)}
					{login.state === "done" && (
						<div>
							Signed in. {login.account ? providerAccountLabel(login.account) : "Account"} added
							to the pool.
						</div>
					)}
					{login.state === "error" && (
						<InlineAlert
							className={mergeStylexOverrideClassName("", sx.whitespacePreWrap)}
							onRetry={() => setLogin(null)}
							retryLabel="Try again"
						>
							{login.error || "Sign-in failed."}
						</InlineAlert>
					)}
				</div>
			)}

			{oauth && (
				<div {...stylex.props(sx.roundedMd, sx.bgSurface, sx.px4, sx.py3, typography.supporting)}>
					<div>
						1. Open{" "}
						<a
							href={oauth.url}
							target="_blank"
							rel="noreferrer"
							{...stylex.props(sx.textLink, sx.underline)}
						>
							the ChatGPT sign-in
						</a>{" "}
						and sign in to the account.
					</div>
					<div {...stylex.props(sx.mt15)}>
						2. The browser lands on a <code>localhost</code> page that can't load. Copy its
						full address (starts with <code>http://localhost:1455/…</code>) and paste it:
					</div>
					<Input
						className={mergeStylexOverrideClassName("", sx.mt2)}
						value={oauthCode}
						onChange={(e) => setOauthCode(e.target.value)}
						placeholder="http://localhost:1455/auth/callback?code=…"
						aria-label="Pasted sign-in redirect URL"
						autoCapitalize="none"
						spellCheck={false}
					/>
				</div>
			)}

			{error && <InlineAlert>{error}</InlineAlert>}

			<Modal.Footer>
				<Modal.Close
					render={
						<Button variant="ghost" disabled={saving}>
							{loginPending || oauth ? "Cancel sign-in" : "Cancel"}
						</Button>
					}
				/>
				{kind === "device" ? (
					<Button
						variant="primary"
						type="submit"
						disabled={saving || !!loginPending || login?.state === "done"}
					>
						{saving ? "Starting…" : loginPending ? "Waiting for sign-in…" : "Start sign-in"}
					</Button>
				) : kind === "oauth" ? (
					oauth ? (
						<Button variant="primary" type="submit" disabled={saving || !oauthCode.trim()}>
							{saving ? "Connecting…" : "Connect"}
						</Button>
					) : (
						<Button variant="primary" type="submit" disabled={saving}>
							{saving ? "Starting…" : "Start sign-in"}
						</Button>
					)
				) : (
					<Button
						variant="primary"
						type="submit"
						disabled={saving || !value.trim() || (kind === "api_key" && !name.trim())}
					>
						{saving ? "Adding…" : "Add account"}
					</Button>
				)}
			</Modal.Footer>
			</form>
		</>
	);
}
