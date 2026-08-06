import { BASE_PATH } from "../lib/base";
import React from "react";
import { cn } from "../ui/cn";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconCopy } from "./icons";

// Shared vocabulary for the Settings → Setup page (Setup.tsx) and its section
// siblings (SetupTeam.tsx, SetupRepos.tsx): the /api/setup/* response shapes,
// the state chip, the inline mono tokens, and one fetch helper that unwraps
// the backend's `{error}` bodies.

export interface SetupEnvVar {
	name: string;
	required: boolean;
	description: string;
	present: boolean;
}

export interface SetupLink {
	label: string;
	url: string;
}

export interface SetupIntegration {
	id: string;
	label: string;
	doc: string;
	enabled: boolean;
	env: SetupEnvVar[];
	links: SetupLink[];
	missingRequired: string[];
}

export interface SetupGithub {
	userPrAuth: boolean;
	clientIdConfigured: boolean;
	clientSecretConfigured: boolean;
	redirectFlowAvailable: boolean;
	callbackUrl: string;
	botTokenPresent: boolean;
	appCreateUrl: string;
}

/** Whether a repo commits the lifecycle scripts that let sessions provision
 *  and boot it unattended (docs/repo-lifecycle.md). `dir` is the winning
 *  lifecycle directory, null when the repo commits neither. */
export interface SetupRepoLifecycle {
	dir: string | null;
	setup: boolean;
	start: boolean;
	previewJson: boolean;
	previewCommand: boolean;
}

export interface SetupRepo {
	id: string;
	label: string;
	path: string;
	lifecycle: SetupRepoLifecycle;
}

/** Whether the instance can actually run an agent turn — the one thing the
 *  Getting-started checklist used to omit. Server-side: engine-status.ts. */
export interface SetupEngine {
	opencodeBin: string | null;
	claudeBin: string | null;
	bridgeEnabled: boolean;
	claudeAccounts: number;
	codexAccounts: number;
	defaultModel: string;
	provider?: "claude" | "codex";
	ready: boolean;
	blocker: string | null;
	fix: string | null;
	/** The blocker is a PUT away, so the row can offer a button. */
	fixableInApp: boolean;
}

export interface SetupStatus {
	publicBaseUrl: string;
	repos: SetupRepo[];
	engine: SetupEngine;
	team: { count: number; names: string[] };
	github: SetupGithub;
	integrations: SetupIntegration[];
}

export interface TeamMember {
	name: string;
	email?: string;
	github?: string;
	slackId?: string;
	aliases?: string[];
}

export interface BrowseRepo {
	fullName: string;
	private: boolean;
	description?: string | null;
	defaultBranch?: string;
	registered: boolean;
}

/** Same-origin JSON fetch against the setup API: prefixes BASE_PATH, encodes
 * an optional `json` body, and surfaces the backend's `{error}` message (or a
 * plain status line) as a thrown Error. */
export async function setupRequest<T = unknown>(
	path: string,
	init?: RequestInit & { json?: unknown },
): Promise<T> {
	const { json, ...rest } = init ?? {};
	const res = await fetch(`${BASE_PATH}${path}`, {
		...rest,
		...(json !== undefined
			? {
					headers: {
						"Content-Type": "application/json",
						...(rest.headers as Record<string, string> | undefined),
					},
					body: JSON.stringify(json),
				}
			: {}),
	});
	let body: any = null;
	try {
		body = await res.json();
	} catch {}
	if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
	return body as T;
}

export type ChipTone = "on" | "warn" | "off";

const CHIP_DOTS: Record<ChipTone, string> = {
	on: "var(--green)",
	warn: "var(--yellow)",
	off: "var(--text-faint)",
};

/** Does this repo carry what a session needs to provision and boot it on its
 *  own? `start.sh` (or an instance `previewCommand`) is the load-bearing half
 *  — without it the Preview button has nothing to run and an agent can't see
 *  its own UI change. `setup.sh` alone still helps: worktrees provision, but
 *  nothing boots. Explained in docs/repo-lifecycle.md. */
export function repoLifecycleState(repo: SetupRepo): {
	tone: ChipTone;
	label: string;
	/** Sentence for the repo row — what works, or what to add. */
	description: string;
} {
	const { dir, setup, start, previewCommand } = repo.lifecycle;
	const where = dir ?? ".opensession";
	if (start)
		return {
			tone: "on",
			label: setup ? "Ready" : "Boots",
			description: setup
				? `${where}/ provisions each worktree and boots the dev server.`
				: `${where}/start.sh boots the dev server — add setup.sh to provision worktrees.`,
		};
	if (previewCommand)
		return {
			tone: "on",
			label: "Instance command",
			description: `Boots through this instance's previewCommand — commit ${where}/start.sh to keep the recipe with the code.`,
		};
	if (setup)
		return {
			tone: "warn",
			label: "Setup only",
			description: `${where}/setup.sh provisions worktrees — add start.sh to enable previews.`,
		};
	return {
		tone: "off",
		label: "None",
		description: `No ${where}/ scripts — previews stay disabled.`,
	};
}

export function StateChip({ tone, label }: { tone: ChipTone; label: string }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-label text-dim">
			<span
				className="h-1.5 w-1.5 rounded-full"
				style={{ background: CHIP_DOTS[tone] }}
			/>
			{label}
		</span>
	);
}

/** Inline monospace token — env var names, CLI commands, paths. Sits as a
 * well on the raised card surface so it reads as literal text to type. */
export function Code({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<code
			className={cn(
				"whitespace-nowrap rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[0.92em] text-fg",
				className,
			)}
		>
			{children}
		</code>
	);
}

/** Deep links into the third-party tool where a credential is created —
 * rendered as a chip row under an integration card's description. */
export function LinkChips({ links }: { links: SetupLink[] }) {
	if (!links.length) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-1.5">
			{links.map((link) => (
				<a
					key={link.url}
					href={link.url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 rounded-sm bg-surface px-2 py-1 text-label text-dim transition-colors hover:bg-active hover:text-fg"
				>
					{link.label}
					<span aria-hidden className="text-faint">
						↗
					</span>
				</a>
			))}
		</div>
	);
}

/** The callback URL and similar values you paste elsewhere: mono well + the
 * house copy affordance (inline check swap + toast). */
export function CopyableCode({ value }: { value: string }) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			className="inline-flex max-w-full items-center gap-1.5 rounded-sm bg-surface py-0.5 pl-1.5 pr-1 text-left font-mono text-[0.92em] text-fg transition-colors hover:bg-active"
			onClick={() => copy(value, { toast: "Copied" })}
			title="Copy"
		>
			<span className="min-w-0 break-all [overflow-wrap:anywhere] whitespace-normal">
				{value}
			</span>
			<CopyCheck
				copied={copied}
				size={14}
				className="shrink-0 text-faint"
				idle={<IconCopy size={14} />}
			/>
		</button>
	);
}
