import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
	configurePublicIngressCloudflare,
	fetchPublicIngress,
	installPublicIngressCaddy,
	savePrivateAppDomain,
	setupPrivateAppDomain,
	testPrivateAppDomain,
	testPublicIngress,
	type IngressExposure,
	type PublicIngressSettings,
} from "../../lib/api";
import {
	configuredAppDomain,
	configuredIngressDrafts,
	customCaddyConfig,
	customDnsRecords,
	ingressHealthDot,
	ingressHealthLabel,
	ingressHostname,
	privateAppCaddyConfig,
	privateAppDnsRecord,
} from "../../lib/ingress-ui";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useSetupStatus, type SetupController } from "../../hooks/useSetupStatus";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { CopyCheck, useCopy } from "../../ui/copy";
import { Input } from "../../ui/input";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsField,
	SettingsForm,
	SettingsFormActions,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	StatusChip,
} from "../../ui/settings";
import { ResponsiveDialog } from "../../ui/sheet";
import { InlineAlert, LoadingState } from "../../ui/state";
import { toast } from "../../ui/toast";
import { BrandMark } from "../BrandTile";
import { IconCopy, IconGlobe, IconServer, IconX } from "../icons";
import { SetupRestart } from "../SetupRestart";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minW0: {
			minWidth: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap1: {
			gap: "4px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))",

		cornerShape: "var(--cs)",},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	py1: {
			paddingBlock: "4px"
	},
	pr1: {
			paddingRight: "4px"
	},
	pl3: {
			paddingLeft: "calc(4px * 3)"
	},
	flex1: {
			flex: "1"
	},
	overflowXAuto: {
			overflowX: "auto"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	textFg: {
			color: "var(--text)"
	},
	shrink0: {
			flexShrink: "0"
	},
	relative: {
			position: "relative"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedXl: {
			borderRadius: "calc(18px * var(--rf))",

		cornerShape: "var(--cs)",},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderCodeWellLine: {
			borderColor: "var(--code-well-line)"
	},
	bgCodeWell: {
			backgroundColor: "var(--code-well)"
	},
	py25: {
			paddingBlock: "calc(4px * 2.5)"
	},
	pr14: {
			paddingRight: "calc(4px * 14)"
	},
	pl35: {
			paddingLeft: "calc(4px * 3.5)"
	},
	textCodeWellInk: {
			color: "var(--code-well-ink)"
	},
	absolute: {
			position: "absolute"
	},
	top1: {
			top: "4px"
	},
	right1: {
			right: "4px"
	},
	OverflowWrapAnywhere: {
			overflowWrap: "anywhere"
	},
	grid: {
			display: "grid"
	},
	listNone: {
			listStyleType: "none"
	},
	gap3: {
			gap: "calc(4px * 3)"
	},
	p0: {
			padding: "0"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	gap25: {
			gap: "calc(4px * 2.5)"
	},
	size6: {
			width: "calc(4px * 6)",
			height: "calc(4px * 6)"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)",

		cornerShape: "round",},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	pt05: {
			paddingTop: "calc(4px * 0.5)"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	mt1: {
			marginTop: "4px"
	},
	gap2: {
			gap: "calc(4px * 2)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	mb5: {
			marginBottom: "calc(4px * 5)"
	},
	gridCols2: {
			gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gapX3: {
			columnGap: "calc(4px * 3)"
	},
	mt15: {
			marginTop: "calc(4px * 1.5)"
	},
	block: {
			display: "block"
	},
	breakAll: {
			wordBreak: "break-all"
	},
	mb0: {
			marginBottom: "0"
	},
	minH11: {
			minHeight: "calc(4px * 11)"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	px4: {
			paddingInline: "calc(4px * 4)"
	},
	py3: {
			paddingBlock: "calc(4px * 3)"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	wFit: {
			width: "fit-content"
	},
	textLink: {
			color: "var(--link)"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))",

		cornerShape: "var(--cs)",},
	p3: {
			padding: "calc(4px * 3)"
	},
	mt3: {
			marginTop: "calc(4px * 3)"
	},
	gap4: {
			gap: "calc(4px * 4)"
	},
	mt2: {
			marginTop: "calc(4px * 2)"
	},
	px1: {
			paddingInline: "4px"
	},
	mt05: {
			marginTop: "calc(4px * 0.5)"
	},
	contentStart: {
			alignContent: "flex-start"
	},
	gap35: {
			gap: "calc(4px * 3.5)"
	},
	underline: {
			textDecorationLine: "underline"
	},
	underlineOffset2: {
			textUnderlineOffset: "2px"
	},
	pt35: {
			paddingTop: "calc(4px * 3.5)"
	},
	/** A step with its own controls splits into prose + controls on desktop. */
	firstPt0: {
		":first-child": {
			"paddingTop": "0"
		}
	},
	lastPb0: {
		":last-child": {
			"paddingBottom": "0"
		}
	},
	py4: {
			paddingBlock: "16px"
	},
	/** The connection-method header lays its prose beside the control on a
	 *  desktop width, and stacks them on a phone. */
	desktopRow: {
		"@media (min-width: 721px)": {
			"flexDirection": "row",
			"alignItems": "center",
			"justifyContent": "space-between"
		}
	},
	phoneFlex1: {
		"@media (max-width: 720px)": {
			"flex": "1"
		}
	},
	phoneJustifyCenter: {
		"@media (max-width: 720px)": {
			"justifyContent": "center"
		}
	},
	flexCol: {
			flexDirection: "column"
	},
	gap15: {
			gap: "6px"
	},
	bgFg: {
			backgroundColor: "var(--text)"
	},
	textBg: {
			color: "var(--bg)"
	},
	w52: {
			width: "208px"
	},
	/** On a desktop these panels sit on the panel surface; a phone keeps the
	 *  raised one so the cards stay legible against the page. */
	desktopBgPanel: {
		"@media (min-width: 721px)": {
			"backgroundColor": "var(--bg-panel)"
		}
	},
	desktopStepColumns: {
		"@media (min-width: 721px)": {
			"display": "grid",
			"gridTemplateColumns": "minmax(0,0.8fr) minmax(20rem,1.2fr)",
			"alignItems": "flex-start",
			"gap": "24px"
		}
	},
	desktopMt0: {
		"@media (min-width: 721px)": {
			"marginTop": "0"
		}
	},
});

const EMPTY_DRAFTS: Record<IngressExposure, string> = {
	cloudflare: "",
	custom: "",
};

function CodeBlock({ children }: { children: string }) {
	const { copied, copy } = useCopy();
	return (
		<div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap1, sx.roundedControl, sx.bgSurface, sx.py1, sx.pr1, sx.pl3)}>
			<code {...mergeStylexProps("select-all", sx.minW0, sx.flex1, sx.overflowXAuto, sx.whitespacePreWrap, sx.fontMono, sx.textFg, typography.meta)} >
				{children}
			</code>
			<Button
				variant="ghost"
				size="sm"
				aria-label={copied ? "Copied" : "Copy command"}
				icon={<CopyCheck copied={copied} size={15} idle={<IconCopy size={15} />} />}
				className={mergeStylexOverrideClassName("phone:size-10 phone:justify-center phone:p-0", sx.shrink0)}
				onClick={() => copy(children, { toast: "Copied" })}
			/>
		</div>
	);
}

/** A generated config file shown like a chat code fence, with its copy
 *  control fixed in the top-right corner. */
function ConfigCodeBlock({ code }: { code: string }) {
	const { copied, copy } = useCopy();
	return (
		<div {...stylex.props(sx.relative, sx.overflowHidden, sx.roundedXl, sx.border, sx.borderCodeWellLine, sx.bgCodeWell, sx.py25, sx.pr14, sx.pl35, sx.textCodeWellInk)}>
			<Button
				variant="ghost"
				size="sm"
				aria-label={copied ? "Copied" : "Copy configuration"}
				icon={<CopyCheck copied={copied} size={15} idle={<IconCopy size={15} />} />}
				className={mergeStylexOverrideClassName("phone:size-10 phone:justify-center phone:p-0", sx.absolute, sx.top1, sx.right1, sx.shrink0)}
				onClick={() => copy(code, { toast: "Copied" })}
			/>
			<pre {...mergeStylexProps("m-0", sx.overflowXAuto, sx.fontMono, sx.whitespacePreWrap, sx.OverflowWrapAnywhere, typography.meta)} >{code}</pre>
		</div>
	);
}

function SetupSteps({ children }: { children: React.ReactNode }) {
	return <ol {...mergeStylexProps(utilityClassName("m-0 list-none divide-y divide-line"), sx.grid, sx.p0, sx.textDim, typography.supporting)}>{children}</ol>;
}

function SetupStep({
	number,
	title,
	children,
	controls,
}: {
	number: number;
	title: string;
	children?: React.ReactNode;
	controls?: React.ReactNode;
}) {
	return (
		<li {...mergeStylexProps("grid-cols-[24px_minmax(0,1fr)]", sx.grid, sx.gap25, sx.py4, sx.firstPt0, sx.lastPb0)}>
			<span {...stylex.props(sx.flex, sx.size6, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgFg, sx.fontSemibold, sx.textBg, typography.meta)}>
				{number}
			</span>
			<div {...stylex.props(sx.minW0, sx.pt05, Boolean(controls) && sx.desktopStepColumns)}>
				<div {...stylex.props(sx.minW0)}>
					<div {...stylex.props(sx.fontMedium, sx.textFg)}>{title}</div>
					{children && <div {...stylex.props(sx.mt1, sx.grid, sx.gap2, sx.leadingRelaxed)}>{children}</div>}
				</div>
				{controls && <div {...stylex.props(sx.mt3, sx.grid, sx.minW0, sx.gap3, sx.desktopMt0)}>{controls}</div>}
			</div>
		</li>
	);
}

function IngressWaitingState({
	method,
	health,
}: {
	method: IngressExposure;
	health: PublicIngressSettings["health"];
}) {
	if (health !== "starting" && health !== "waiting_dns") return null;
	const message = method === "cloudflare"
		? "Waiting for Cloudflare to connect the public route."
		: health === "waiting_dns"
			? "Waiting for DNS to point to this server."
			: "Waiting for Caddy to finish HTTPS setup.";
	return <LoadingState placement="card">{message} This page checks automatically.</LoadingState>;
}

function PrivateAppSetup({
	settings,
	domain,
	onboarding,
	email,
	apiToken,
	provider,
	teamId,
	busy,
	action,
	onDomainChange,
	onEmailChange,
	onTokenChange,
	onProviderChange,
	onTeamIdChange,
	onSetup,
	onVerify,
	onSaveManual,
}: {
	settings: PublicIngressSettings;
	domain: string;
	onboarding: boolean;
	email: string;
	apiToken: string;
	provider: "cloudflare" | "vercel";
	teamId: string;
	busy: boolean;
	action: "setup" | "verify" | "save" | null;
	onDomainChange: (value: string) => void;
	onEmailChange: (value: string) => void;
	onTokenChange: (value: string) => void;
	onProviderChange: (value: "cloudflare" | "vercel") => void;
	onTeamIdChange: (value: string) => void;
	onSetup: () => void;
	onVerify: () => void;
	onSaveManual: () => void;
}) {
	const savedDomain = configuredAppDomain(settings);
	const dnsRecord = privateAppDnsRecord(settings, domain);
	const dirty = domain.trim() !== savedDomain;
	const managedCredential = settings.app.domain.credentialConfigured && domain.trim() === savedDomain && settings.app.domain.dnsProvider === provider;
	const managedInputMissing = !domain.trim() || (!managedCredential && (!email.trim() || !apiToken.trim()));
	const status = settings.app.domain.health;
	return (
		<>
			{!onboarding && savedDomain && (
				<SettingCard className={cn(utilityClassName("bg-raised"), mergeStylexOverrideClassName("", sx.desktopBgPanel))}>
					<SettingRow>
						<SettingRowText>
							<SettingRowTitle>Current address</SettingRowTitle>
							<div {...mergeStylexProps("selectable", sx.mt1, sx.breakAll, sx.fontMono, sx.textDim, typography.supporting)} >{settings.app.publicBaseUrl}</div>
						</SettingRowText>
					</SettingRow>
					{settings.app.domain.certificateExpiresAt && (
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Certificate</SettingRowTitle>
								<SettingRowDescription>
									Valid until {new Date(settings.app.domain.certificateExpiresAt).toLocaleDateString()}
									{settings.app.domain.credentialConfigured ? ". Renewal is automatic." : ". Managed outside Open Session."}
								</SettingRowDescription>
							</SettingRowText>
						</SettingRow>
					)}
				</SettingCard>
			)}
			<SettingsForm className={cn(
				utilityClassName("bg-raised"),
				mergeStylexOverrideClassName("", sx.desktopBgPanel),
				onboarding ? utilityClassName("mt-0") : utilityClassName("mt-3"),
			)}>
				{status === "ready" && !settings.app.domain.credentialConfigured && (
					<SettingsHint className={utilityClassName("m-0")}>This address is already working. Its certificate is managed outside Open Session.</SettingsHint>
				)}
				<SetupSteps>
					<SetupStep
						number={1}
						title="Choose the app domain"
						controls={
							<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
								Domain
								<Input value={domain} placeholder="os.example.com" disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onDomainChange(event.target.value)} />
							</SettingsField>
						}
					>
						<p className={utilityClassName("m-0")}>Keep it different from the public callback domain.</p>
					</SetupStep>
					<SetupStep
						number={2}
						title="Authorize the DNS provider"
						controls={
							<>
								<div {...stylex.props(sx.flex, sx.minW0, sx.flexCol, sx.gap15)}>
									<div {...mergeStylexProps("", sx.fontMedium, sx.textDim, typography.label)}>DNS provider</div>
									<Segmented
										label="Private domain DNS provider"
										value={provider}
										onValueChange={(value) => onProviderChange(value as "cloudflare" | "vercel")}
										className={utilityClassName("w-full")}
									>
										<SegmentedOption value="cloudflare" disabled={busy} className={utilityClassName("flex-1 justify-center phone:min-h-11")}>
											<BrandMark name="cloudflare" size={16} className={utilityClassName("shrink-0")} />
											Cloudflare
										</SegmentedOption>
										<SegmentedOption value="vercel" disabled={busy} className={utilityClassName("flex-1 justify-center phone:min-h-11")}>
											<BrandMark name="vercel" size={15} className={utilityClassName("shrink-0")} />
											Vercel
										</SegmentedOption>
									</Segmented>
								</div>
								<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
									Certificate email
									<Input type="email" value={email} placeholder={managedCredential && settings.app.domain.certificateEmailConfigured ? "Leave blank to keep the saved email" : "you@example.com"} disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onEmailChange(event.target.value)} />
								</SettingsField>
								<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
									{provider === "cloudflare" ? "Cloudflare" : "Vercel"} API token
									<Input type="password" value={apiToken} placeholder={managedCredential ? "Leave blank to keep the saved token" : "Paste the scoped token"} disabled={busy} autoComplete="off" onChange={(event) => onTokenChange(event.target.value)} />
								</SettingsField>
								{provider === "vercel" && (
									<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
										Team ID <span {...stylex.props(sx.fontNormal, sx.textFaint)}>Optional</span>
										<Input value={teamId} placeholder="team_…" disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onTeamIdChange(event.target.value)} />
									</SettingsField>
								)}
							</>
						}
					>
						<p className={utilityClassName("m-0")}>
							{provider === "cloudflare"
								? <>Create a token with <strong {...stylex.props(sx.fontMedium, sx.textFg)}>Zone:DNS Edit</strong> and <strong {...stylex.props(sx.fontMedium, sx.textFg)}>Zone:Zone Read</strong> for this zone.</>
								: <>Create a Vercel token with access to the team that owns this domain.</>}
							{" "}Open Session protects it with server file permissions and never returns it to the browser.
						</p>
						<a className={utilityClassName("w-fit text-link hover:underline")} href={provider === "cloudflare" ? "https://dash.cloudflare.com/profile/api-tokens" : "https://vercel.com/account/settings/tokens"} target="_blank" rel="noreferrer">Create {provider === "cloudflare" ? "Cloudflare" : "Vercel"} token</a>
					</SetupStep>
					<SetupStep number={3} title="Set up and verify">
						<p className={utilityClassName("m-0")}>Open Session creates the DNS-only A record, requests a Let’s Encrypt certificate with DNS-01, configures Caddy, and checks the private address. It checks renewal daily.</p>
						{(!settings.custom.caddyInstalled || !settings.app.domain.legoInstalled) && (
							<>
								<InlineAlert>Install Caddy and the certificate helper first, then reload this page.</InlineAlert>
								<CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --caddy --no-onboard"}</CodeBlock>
							</>
						)}
					</SetupStep>
				</SetupSteps>
						{status === "waiting_dns" && <InlineAlert>DNS has not reached this server yet. Wait a moment, then verify again.</InlineAlert>}
						{status === "unreachable" && ingressHostname(domain) === ingressHostname(savedDomain) && (
							<InlineAlert>DNS points to this server, but the HTTPS app is not reachable. Verify Caddy and the certificate, then try again.</InlineAlert>
						)}
				<SettingsFormActions className={utilityClassName("absolute inset-x-0 bottom-0 z-10 m-0 border-t border-line bg-raised px-5 py-4 phone:flex-col-reverse phone:bg-surface phone:px-4")}>
					<Button variant="soft" disabled={busy || !savedDomain || !settings.canManage} className={utilityClassName("phone:min-h-11 phone:w-full phone:justify-center")} onClick={onVerify}>
						{action === "verify" ? "Checking…" : "Verify address"}
					</Button>
					<Button variant="primary" disabled={busy || managedInputMissing || !dnsRecord || !settings.custom.caddyInstalled || !settings.app.domain.legoInstalled || !settings.canManage} className={utilityClassName("phone:min-h-11 phone:w-full phone:justify-center")} onClick={onSetup}>
						{action === "setup" ? "Setting up…" : managedCredential ? "Update setup" : "Set up private domain"}
					</Button>
				</SettingsFormActions>
				<details {...stylex.props(sx.roundedLg, sx.bgSurface, sx.p3, sx.textDim, typography.meta)}>
					<summary {...stylex.props(sx.cursorPointer, sx.fontMedium, sx.textFg)}>Use an externally managed certificate</summary>
					<div {...stylex.props(sx.mt3, sx.grid, sx.gap4)}>
						<SetupSteps>
							<SetupStep number={1} title="Choose the app domain">
								<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
									Domain
									<Input value={domain} placeholder="os.example.com" disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onDomainChange(event.target.value)} />
								</SettingsField>
							</SetupStep>
							<SetupStep number={2} title="Point DNS to Tailscale">
								<p className={utilityClassName("m-0")}>Add this DNS-only record at your provider. Only devices on your tailnet can connect.</p>
								{dnsRecord ? <CodeBlock>{dnsRecord}</CodeBlock> : <InlineAlert>Connect this server to Tailscale first, then reload this page.</InlineAlert>}
							</SetupStep>
							<SetupStep number={3} title="Install existing TLS files">
								<p className={utilityClassName("m-0")}>Only use this path when your infrastructure already issues and renews the certificate.</p>
								<CodeBlock>{`/etc/opensession/tls/${ingressHostname(domain, "os.example.com")}.crt`}</CodeBlock>
								<CodeBlock>{`/etc/opensession/tls/${ingressHostname(domain, "os.example.com")}.key`}</CodeBlock>
							</SetupStep>
							<SetupStep number={4} title="Configure Caddy">
								<p className={utilityClassName("m-0")}>Bind Caddy only to the Tailscale address and forward the app to loopback.</p>
							</SetupStep>
						</SetupSteps>
						<details {...stylex.props(sx.textDim, typography.meta)}>
							<summary {...stylex.props(sx.cursorPointer, sx.fontMedium, sx.textFg)}>Generated Caddy configuration</summary>
							<div {...stylex.props(sx.mt2)}><ConfigCodeBlock code={privateAppCaddyConfig(settings, domain)} /></div>
						</details>
						<div {...stylex.props(sx.grid, sx.gap2)}>
							<div {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>Apply Caddy</div>
							<CodeBlock>sudo caddy validate --config /etc/caddy/Caddyfile</CodeBlock>
							<CodeBlock>sudo systemctl reload caddy</CodeBlock>
						</div>
						<SettingsFormActions>
							<Button variant="primary" disabled={busy || !dirty || !domain.trim() || !dnsRecord || !settings.custom.caddyInstalled || !settings.canManage} className={utilityClassName("phone:min-h-11 phone:w-full phone:justify-center")} onClick={onSaveManual}>
								{action === "save" ? "Saving…" : "Save app domain"}
							</Button>
						</SettingsFormActions>
						<SettingsHint>Only use this when existing infrastructure already issues and renews the certificate.</SettingsHint>
					</div>
				</details>
			</SettingsForm>
		</>
	);
}

export function IngressPanel({
	onboarding = false,
	embedded = false,
	initialUrls,
	onChanged,
	onStatusChange,
	setup: parentSetup,
}: {
	onboarding?: boolean;
	embedded?: boolean;
	initialUrls?: { app: string; callback: string };
	onChanged?: () => void | Promise<void>;
	onStatusChange?: (settings: PublicIngressSettings) => void;
	setup?: SetupController;
} = {}) {
	const localSetup = useSetupStatus();
	const setup = parentSetup || localSetup;
	const isPhone = useIsPhone();
	const [settings, setSettings] = useState<PublicIngressSettings | null>(null);
	const [surface, setSurface] = useState<"domain" | "callbacks" | null>(null);
	const [method, setMethod] = useState<IngressExposure>("custom");
	const [appDomain, setAppDomain] = useState("");
	const [certificateEmail, setCertificateEmail] = useState("");
	const [privateApiToken, setPrivateApiToken] = useState("");
	const [privateProvider, setPrivateProvider] = useState<"cloudflare" | "vercel">("cloudflare");
	const [vercelTeamId, setVercelTeamId] = useState("");
	const [privateAction, setPrivateAction] = useState<"setup" | "verify" | "save" | null>(null);
	const [drafts, setDrafts] = useState<Record<IngressExposure, string>>(EMPTY_DRAFTS);
	const [tunnelId, setTunnelId] = useState("");
	const [tunnelToken, setTunnelToken] = useState("");
	const [publicAddress, setPublicAddress] = useState("");
	const [busy, setBusy] = useState<"app" | "apply" | "test" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const loaded = useRef(false);
	const customDraftTouched = useRef(false);
	const url = drafts[method];

	function apply(next: PublicIngressSettings, selectConfigured = true) {
		setSettings(next);
		onStatusChange?.(next);
		if (!loaded.current) {
			setAppDomain(configuredAppDomain(next));
			setPrivateProvider(next.app.domain.dnsProvider || "cloudflare");
			setDrafts(configuredIngressDrafts(next));
			setPublicAddress(next.server.ipv4[0] || next.server.ipv6[0] || "");
			loaded.current = true;
		} else {
			const saved = configuredIngressDrafts(next);
			setDrafts((current) => ({
				...current,
				...(next.exposure ? { [next.exposure]: saved[next.exposure] } : {}),
				...(configuredAppDomain(next) && next.exposure !== "cloudflare" ? { cloudflare: saved.cloudflare } : {}),
				...(!customDraftTouched.current ? { custom: saved.custom } : {}),
			}));
		}
		if (selectConfigured) {
			setMethod(next.exposure || "custom");
			setTunnelId(next.cloudflare.tunnelId);
			setTunnelToken("");
		}
	}

	const applyFromEffect = useEffectEvent(apply);

	useEffect(() => {
		void fetchPublicIngress().then((next) => applyFromEffect(next)).catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : "Couldn’t load public ingress");
		});
	}, []);

	// Ingress setup can complete before public DNS or an edge route converges.
	// Keep pending and transiently unreachable states current without requiring
	// a repeated manual probe.
	useEffect(() => {
		const publicPending = settings?.health === "starting" || settings?.health === "waiting_dns" || settings?.health === "unreachable";
		const appPending = settings?.app.domain.health === "waiting_dns" || settings?.app.domain.health === "unreachable";
		if (!publicPending && !appPending) return;
		const timer = window.setInterval(() => {
			void fetchPublicIngress().then((next) => applyFromEffect(next, false)).catch(() => {});
		}, 5_000);
		return () => window.clearInterval(timer);
	}, [settings?.health, settings?.app.domain.health]);

	async function run(
		kind: "apply" | "test",
		work: () => Promise<PublicIngressSettings>,
		message: string | ((next: PublicIngressSettings) => string),
	) {
		if (busy) return;
		setBusy(kind);
		setError(null);
		await work()
			.then((next) => {
				apply(next);
				toast(typeof message === "function" ? message(next) : message, { variant: "success" });
				if (next.githubWebhook?.updated) {
					toast("GitHub callbacks connected", { variant: "success" });
				} else if (next.githubWebhook?.error) {
					toast("Public callbacks are ready, but the GitHub webhook needs attention.");
				}
				void onChanged?.();
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : "Public callbacks could not be updated");
			})
			.finally(() => setBusy(null));
	}

	async function runPrivateApp(
		action: "setup" | "save",
		work: () => Promise<PublicIngressSettings & { restartRequired: boolean }>,
		message: string | ((next: PublicIngressSettings) => string),
	) {
		if (busy || !settings) return;
		setBusy("app");
		setPrivateAction(action);
		setError(null);
		await work()
			.then((next) => {
				apply(next);
				setPrivateApiToken("");
				if (next.restartRequired) setup.requireRestart();
				const notice = typeof message === "function" ? message(next) : message;
				toast(notice, { variant: next.app.domain.health === "ready" ? "success" : "default" });
				void onChanged?.();
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : "Private app domain could not be updated");
			})
			.finally(() => { setBusy(null); setPrivateAction(null); });
	}

	async function verifyAppDomain() {
		if (busy || !settings) return;
		setBusy("app");
		setPrivateAction("verify");
		setError(null);
		await testPrivateAppDomain()
			.then((domain) => {
				setSettings((current) => current ? { ...current, app: { ...current.app, domain } } : current);
				toast(domain.health === "ready" ? "Private address is reachable" : "Private address is not ready yet", { variant: domain.health === "ready" ? "success" : "default" });
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Private app domain could not be verified"))
			.finally(() => { setBusy(null); setPrivateAction(null); });
	}

	async function applyMethod() {
		if (method === "custom") {
			await run(
				"apply",
				() => installPublicIngressCaddy(url, publicAddress.trim() || undefined),
				(next) => next.health === "ready" ? "Public callbacks are ready" : "Caddy configured. Waiting for DNS",
			);
			return;
		}
		await run(
			"apply",
			() => configurePublicIngressCloudflare({
				publicBaseUrl: url,
				tunnelId,
				...(tunnelToken ? { token: tunnelToken } : {}),
			}),
			"Cloudflare Tunnel started",
		);
	}

	const records = settings ? customDnsRecords(settings, drafts.custom, publicAddress) : [];
	const missingTool = settings && (
		(method === "cloudflare" && !settings.cloudflare.installed) ||
		(method === "custom" && !settings.custom.caddyInstalled)
	);
	const invalidInput =
		!url.trim() ||
		method === "custom" && records.length === 0 ||
		method === "cloudflare" && (!tunnelId.trim() || (!tunnelToken.trim() && !settings?.cloudflare.tokenConfigured));
	const selectedHealth = settings?.exposure === method ? settings.health : "not_configured";
	const privateDomain = settings ? configuredAppDomain(settings) : "";
	const domainUrl = settings?.app.publicBaseUrl || initialUrls?.app || "";
	const callbackUrl = settings?.publicBaseUrl || initialUrls?.callback || "";
	const pendingStatus = error
		? { label: "Unavailable", dot: "var(--red)" }
		: { label: "Checking", dot: "var(--text-faint)" };
	const domainStatus = settings
		? {
				label: ingressHealthLabel(settings.app.domain.health),
				dot: ingressHealthDot(settings.app.domain.health),
			}
		: pendingStatus;
	const callbackStatus = settings
		? {
				label: ingressHealthLabel(settings.health),
				dot: ingressHealthDot(settings.health),
			}
		: pendingStatus;

	return (
		<SettingsPanel className={onboarding ? utilityClassName("mx-auto max-w-[1120px]") : utilityClassName("relative")}>
			{!onboarding && !embedded && (
				<SettingsHeader
					title="Domains and callbacks"
					description="Set a friendly private address, then add the public endpoint external services need."
				/>
			)}

			{error && !surface && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
			{!settings && !initialUrls ? (
				<SettingCardSkeleton rows={3} label="Loading public ingress" />
			) : (
				<>
					<SettingCard aria-busy={!settings}>
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Domain</SettingRowTitle>
								<SettingRowDescription className={mergeStylexOverrideClassName("selectable", sx.breakAll, sx.fontMono)}>
									{domainUrl || "No domain configured"}
								</SettingRowDescription>
							</SettingRowText>
							<SettingRowControl className={mergeStylexOverrideClassName("", sx.flex, sx.itemsCenter, sx.gap2)}>
								<StatusChip {...domainStatus} />
								<Button size="sm" className={utilityClassName("phone:min-h-11")} disabled={!settings} onClick={() => setSurface("domain")}>Configure</Button>
							</SettingRowControl>
						</SettingRow>
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Public callback</SettingRowTitle>
								<SettingRowDescription className={mergeStylexOverrideClassName("selectable", sx.breakAll, sx.fontMono)}>
									{callbackUrl || "No public callback configured"}
								</SettingRowDescription>
							</SettingRowText>
							<SettingRowControl className={mergeStylexOverrideClassName("", sx.flex, sx.itemsCenter, sx.gap2)}>
								<StatusChip {...callbackStatus} />
								<Button size="sm" className={utilityClassName("phone:min-h-11")} disabled={!settings} onClick={() => setSurface("callbacks")}>Configure</Button>
							</SettingRowControl>
						</SettingRow>
					</SettingCard>

					{settings && <ResponsiveDialog
						open={surface !== null}
						onClose={() => setSurface(null)}
						phone={isPhone}
						label={surface === "domain" ? "Configure domain" : "Configure public callback"}
						modalClassName="h-[min(840px,calc(100dvh-32px))] max-h-[calc(100dvh-32px)] w-[min(760px,calc(100vw-32px))] max-w-[760px]"
						sheetClassName="h-[94dvh]"
					>
						{(dismiss) => (
							<>
								<header className={utilityClassName("flex shrink-0 items-start gap-3 border-b border-line px-5 py-4 phone:px-4")}>
									<div className={utilityClassName("min-w-0 flex-1")}>
										<h2 className={utilityClassName("m-0 text-dialog-title font-semibold text-fg")}>
											{surface === "domain" ? "Configure domain" : "Configure public callback"}
										</h2>
										<p className={utilityClassName("m-0 mt-1 text-supporting leading-relaxed text-dim")}>
											{surface === "domain"
												? "Give your team a memorable private address."
												: "Connect the public endpoint used by webhooks and remote services."}
										</p>
									</div>
									<Button variant="ghost" aria-label="Close" icon={<IconX size={20} />} className={utilityClassName("size-10 shrink-0 justify-center p-0 phone:size-11")} onClick={dismiss} />
								</header>
								<div className={cn(utilityClassName("min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 phone:p-4"), surface === "domain" && utilityClassName("pb-24 phone:pb-32"))}>
									{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
									{surface === "domain" ? (
										<PrivateAppSetup
								settings={settings}
								domain={appDomain}
								onboarding={onboarding}
								email={certificateEmail}
								apiToken={privateApiToken}
								provider={privateProvider}
								teamId={vercelTeamId}
								busy={busy === "app"}
								action={privateAction}
								onDomainChange={(value) => { setAppDomain(value); setError(null); }}
								onEmailChange={setCertificateEmail}
								onTokenChange={setPrivateApiToken}
								onProviderChange={(value) => { setPrivateProvider(value); setPrivateApiToken(""); }}
								onTeamIdChange={setVercelTeamId}
								onSetup={() => void runPrivateApp("setup", () => setupPrivateAppDomain({
									domain: appDomain,
									provider: privateProvider,
									...(certificateEmail ? { email: certificateEmail } : {}),
									...(privateApiToken ? { apiToken: privateApiToken } : {}),
									...(privateProvider === "vercel" && vercelTeamId ? { teamId: vercelTeamId } : {}),
								}), (next) => next.app.domain.health === "ready" ? "Private app domain is ready" : "Private app domain configured. Verification is still pending")}
								onVerify={() => void verifyAppDomain()}
								onSaveManual={() => void runPrivateApp("save", () => savePrivateAppDomain(appDomain), "Private app domain saved")}
							/>
					) : (
					<div {...stylex.props(sx.grid, sx.contentStart, sx.gap4)}>
						<SettingsForm className={cn(utilityClassName("m-0 min-w-0 gap-4 bg-raised p-6 phone:p-4"), mergeStylexOverrideClassName("", sx.desktopRow, sx.desktopBgPanel))}>
							<div {...mergeStylexProps("text-item-title", sx.px1, sx.fontSemibold, sx.textFg)}>Connection method</div>
							<Segmented
								label="Public callback method"
								value={method}
								onValueChange={(next) => setMethod(next as IngressExposure)}
								className={cn(utilityClassName("shrink-0 phone:w-full"), mergeStylexOverrideClassName("", sx.flex, sx.w52))}
							>
								<SegmentedOption value="custom" disabled={!!busy || !settings.canManage} className={mergeStylexOverrideClassName("", sx.flex, sx.flex1, sx.justifyCenter)}><IconServer size={14} /> Caddy</SegmentedOption>
								<SegmentedOption value="cloudflare" disabled={!!busy || !settings.canManage} className={mergeStylexOverrideClassName("", sx.flex, sx.flex1, sx.justifyCenter)}><IconGlobe size={14} /> Cloudflare</SegmentedOption>
							</Segmented>
						</SettingsForm>

						<SettingsForm className={cn(utilityClassName("m-0 min-w-0 gap-4 bg-raised p-6 phone:p-4"), mergeStylexOverrideClassName("", sx.desktopBgPanel))}>
							<div {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gap4)}>
								<div {...mergeStylexProps("text-item-title", sx.minW0, sx.fontSemibold, sx.textFg)}>{method === "custom" ? "Caddy" : "Cloudflare"}</div>
								<div {...stylex.props(sx.shrink0)}>
									<StatusChip label={busy === "apply" ? "Setting up" : ingressHealthLabel(selectedHealth)} dot={busy === "apply" ? "var(--yellow)" : ingressHealthDot(selectedHealth)} />
								</div>
							</div>
							<div {...stylex.props(sx.grid, sx.minW0, sx.contentStart, sx.gap35)}>
							{method === "cloudflare" && (
								<>
									{!settings.cloudflare.installed && (
										<InlineAlert>
											Install cloudflared first, then reload this page.
											<div {...stylex.props(sx.mt2)}><CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --cloudflare --no-onboard"}</CodeBlock></div>
										</InlineAlert>
									)}
									<SetupSteps>
										<SetupStep number={1} title="Create a remotely managed tunnel">
											<p className={utilityClassName("m-0")}>In Cloudflare Zero Trust, open <strong {...stylex.props(sx.fontMedium, sx.textFg)}>Networks → Connectors → Cloudflare Tunnels</strong> and create a Cloudflared tunnel.</p>
											<a {...mergeStylexProps("hover:underline", sx.wFit, sx.textLink)}  href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Open Cloudflare Zero Trust</a>
											<p className={utilityClassName("m-0")}>Use the dashboard rather than <code>cloudflared tunnel create</code>. Connector tokens require a remotely managed tunnel.</p>
										</SetupStep>
										<SetupStep number={2} title="Add the callback route">
											<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
												Public URL
												<Input key={method} type="url" value={url} placeholder="https://ingress.example.com" disabled={!!busy} readOnly={!!privateDomain} onChange={(event) => setDrafts((current) => ({ ...current, cloudflare: event.target.value }))} />
											</SettingsField>
											{privateDomain && <p className={utilityClassName("m-0")}>Open Session uses a separate <strong {...stylex.props(sx.fontMedium, sx.textFg)}>ingress</strong> hostname alongside the private app address.</p>}
											<p className={utilityClassName("m-0")}>Under <strong {...stylex.props(sx.fontMedium, sx.textFg)}>Published application routes</strong>, add <strong {...stylex.props(sx.fontMedium, sx.textFg)}>{ingressHostname(url)}</strong> and point its HTTP service to:</p>
											<CodeBlock>{settings.cloudflare.connectorTarget}</CodeBlock>
											<p className={utilityClassName("m-0")}>Cloudflare creates the DNS route. Never point this public hostname at the private app port.</p>
										</SetupStep>
										<SetupStep number={3} title="Connect this server">
											<p className={utilityClassName("m-0")}>Copy the tunnel ID and connector token from that same tunnel. Open Session protects the token on this server and starts cloudflared for you.</p>
											<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
												Tunnel ID
												<Input value={tunnelId} placeholder="00000000-0000-0000-0000-000000000000" disabled={!!busy} className={mergeStylexOverrideClassName("", sx.fontMono)} onChange={(event) => setTunnelId(event.target.value)} />
											</SettingsField>
											<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
												Tunnel token
												<Input
													type="password"
													value={tunnelToken}
													disabled={!!busy}
													autoComplete="off"
													placeholder={settings.cloudflare.tokenConfigured ? "Leave blank to keep the saved token" : "Paste the connector token"}
													onChange={(event) => setTunnelToken(event.target.value)}
												/>
											</SettingsField>
										</SetupStep>
									</SetupSteps>
									{settings.cloudflare.connectorRunning && <StatusChip label="Connector process running" dot="var(--green)" />}
								</>
							)}

							{method === "custom" && (
								<>
									<SetupSteps>
										<SetupStep
											number={1}
											title="Choose a separate public domain"
											controls={
												<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
													Domain
													<Input key={method} value={url} placeholder="ingress.example.com" disabled={!!busy} autoCapitalize="none" spellCheck={false} onChange={(event) => { customDraftTouched.current = true; setDrafts((current) => ({ ...current, custom: event.target.value })); }} />
												</SettingsField>
											}
										>
											<p className={utilityClassName("m-0")}>Do not use the private app hostname. HTTPS is added automatically.</p>
										</SetupStep>
										<SetupStep number={2} title="Open ports 80 and 443">
											<p className={utilityClassName("m-0")}>Allow inbound TCP traffic from the public internet to ports 80 and 443 in the server firewall and your cloud security group. Caddy uses port 80 for certificate validation and serves HTTPS on port 443.</p>
										</SetupStep>
										<SetupStep
											number={3}
											title="Add DNS records at your provider"
											controls={
												<>
													<SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
														Public IPv4 or IPv6 address
														<Input value={publicAddress} placeholder="203.0.113.10" disabled={!!busy} autoCapitalize="none" spellCheck={false} onChange={(event) => { setPublicAddress(event.target.value); setError(null); }} />
													</SettingsField>
													{records.length ? records.map((record) => <CodeBlock key={record}>{record}</CodeBlock>) : (
														<InlineAlert>Enter this server’s public address to generate the DNS record.</InlineAlert>
													)}
												</>
											}
										>
											<p className={utilityClassName("m-0")}>Point the domain to this server’s public IP address, not its private or Tailscale address.</p>
										</SetupStep>
										<SetupStep number={4} title="Configure Caddy">
											<p className={utilityClassName("m-0")}>Open Session adds this dedicated site to /etc/caddy/Caddyfile, binds it to the public-facing network interface, and reloads Caddy. If DNS is still propagating, the status stays at Waiting for DNS and checks again automatically.</p>
											{!settings.custom.caddyInstalled && <CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --caddy --no-onboard"}</CodeBlock>}
										</SetupStep>
									</SetupSteps>
									<details {...stylex.props(sx.textDim, typography.meta)}>
										<summary {...stylex.props(sx.cursorPointer, sx.fontMedium, sx.textFg)}>Caddy route preview</summary>
										<div {...stylex.props(sx.mt2)}><ConfigCodeBlock code={customCaddyConfig(url)} /></div>
										<p {...stylex.props(sx.mt2, sx.mb0)}>Automatic setup also adds the detected local interface bind.</p>
									</details>
								</>
							)}
							</div>

							{settings.exposure === method && (
								<IngressWaitingState method={method} health={settings.health} />
							)}
							{settings.health === "unreachable" && settings.exposure === method && (
								<InlineAlert>
									{method === "cloudflare" && settings.cloudflare.connectorRunning
										? <>The connector process is running, but Cloudflare cannot reach Open Session. Verify that this hostname routes to <strong>{settings.cloudflare.connectorTarget}</strong> and that the tunnel ID and token come from the same remotely managed tunnel.</>
										: "The public URL is configured but its health check is not reachable. Verify DNS and firewall rules, then check again."}
								</InlineAlert>
							)}

							<SettingsFormActions className={utilityClassName("phone:flex-col-reverse")}>
								<Button variant="soft" disabled={!!busy || !settings.canManage || settings.exposure !== method || !settings.publicBaseUrl} className={utilityClassName("phone:min-h-11 phone:w-full phone:justify-center")} onClick={() => void run("test", testPublicIngress, (next) => next.health === "ready" ? "Public callbacks are reachable" : "Public callbacks are not ready yet") }>
									{busy === "test" ? "Checking…" : settings.health === "waiting_dns" ? "Check again" : "Test connection"}
								</Button>
								<Button variant="primary" disabled={!!busy || !settings.canManage || !!missingTool || invalidInput} className={utilityClassName("phone:min-h-11 phone:w-full phone:justify-center")} onClick={() => void applyMethod()}>
									{busy === "apply" ? "Setting up…" : method === "custom" ? settings.exposure === "custom" ? "Update Caddy" : "Configure Caddy" : "Start tunnel"}
								</Button>
							</SettingsFormActions>
							<div {...stylex.props(sx.borderT, sx.borderLine, sx.pt35)}>
								<div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>Private by default</div>
								<p {...stylex.props(sx.mt1, sx.mb0, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
									Unknown methods and paths return 404. This endpoint never serves sessions, APIs, or the app UI.
								</p>
							</div>
						</SettingsForm>
					</div>
					)}
								</div>
							</>
						)}
					</ResponsiveDialog>}
					{!onboarding && !embedded && <SetupRestart setup={setup} />}
				</>
			)}
		</SettingsPanel>
	);
}
