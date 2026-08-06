import React, { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHint,
	SettingsSection,
	settingsInputClass,
} from "../ui/settings";
import { toast } from "../ui/toast";
import { IconPlus, IconRepo } from "./icons";
import {
	StateChip,
	repoLifecycleState,
	setupRequest,
	type BrowseRepo,
	type SetupStatus,
} from "./setup-shared";

// Settings → Setup → Repositories: the registered repos sessions work in,
// plus an add flow. With a GitHub credential (a connected account or the bot
// token) the add flow browses the reachable repos; without one it falls back
// to a manual owner/name entry. Registering clones the repo server-side, so
// an add can take tens of seconds — the row keeps a working state the whole
// way and nothing here times out early.

export function ReposSection({
	repos,
	onChanged,
}: {
	repos: SetupStatus["repos"];
	onChanged: () => void | Promise<void>;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);
	return (
		<>
			<SettingsGroupLabel
				actions={
					<Button
						size="sm"
						icon={<IconPlus size={16} />}
						onClick={() => setPickerOpen((o) => !o)}
					>
						{pickerOpen ? "Close" : "Add repository"}
					</Button>
				}
			>
				Repositories
			</SettingsGroupLabel>
			{pickerOpen && <AddRepoPicker onAdded={onChanged} />}
			<SettingCard>
				{repos.length === 0 ? (
					<EmptyState placement="row">
						No repositories registered — sessions need at least one repo to work
						in. Add one above.
					</EmptyState>
				) : (
					repos.map((r) => {
						const lifecycle = repoLifecycleState(r);
						return (
							<SettingRow key={r.id}>
								<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
									<IconRepo size={16} />
								</span>
								<SettingRowText>
									<SettingRowTitle>{r.label}</SettingRowTitle>
									<SettingRowDescription className="truncate font-mono text-meta">
										{r.path}
									</SettingRowDescription>
									<SettingRowDescription>
										{lifecycle.description}
									</SettingRowDescription>
								</SettingRowText>
								<StateChip tone={lifecycle.tone} label={lifecycle.label} />
							</SettingRow>
						);
					})
				)}
			</SettingCard>
			<SettingsHint>
				Registering clones the repo onto the server; sessions then branch into
				isolated worktrees of it. New repos are usable right away — no restart.
				A repo that commits <code>.opensession/setup.sh</code> and{" "}
				<code>.opensession/start.sh</code> provisions its own worktrees and
				boots its dev server, so previews work and agents can check their UI
				changes in a real browser — see docs/repo-lifecycle.md.
			</SettingsHint>
		</>
	);
}

interface BrowseResult {
	source: "user" | "bot" | null;
	repos: BrowseRepo[];
}

function AddRepoPicker({ onAdded }: { onAdded: () => void | Promise<void> }) {
	const [browse, setBrowse] = useState<BrowseResult | null>(null);
	const [browseFailed, setBrowseFailed] = useState(false);
	const [filter, setFilter] = useState("");
	const [addingRepo, setAddingRepo] = useState<string | null>(null);
	const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [manual, setManual] = useState("");

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const body = await setupRequest<BrowseResult>("/api/setup/github/repos");
				if (!cancelled) setBrowse(body);
			} catch {
				if (!cancelled) setBrowseFailed(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const filtered = useMemo(() => {
		if (!browse) return [];
		const q = filter.trim().toLowerCase();
		if (!q) return browse.repos;
		return browse.repos.filter(
			(r) =>
				r.fullName.toLowerCase().includes(q) ||
				(r.description ?? "").toLowerCase().includes(q),
		);
	}, [browse, filter]);

	async function addRepo(fullName: string) {
		if (addingRepo) return;
		setAddingRepo(fullName);
		setError(null);
		try {
			// Registering clones server-side — can take tens of seconds. No client
			// timeout; the button holds its working state until the server answers.
			await setupRequest("/api/setup/repos", {
				method: "POST",
				json: { fullName },
			});
			setAdded((prev) => new Set(prev).add(fullName));
			setManual("");
			toast(`${fullName} registered`);
			await onAdded();
		} catch (e: any) {
			setError(e.message);
		} finally {
			setAddingRepo(null);
		}
	}

	const manualValid = /^[^/\s]+\/[^/\s]+$/.test(manual.trim());

	return (
		<SettingsSection className="mb-3">
			{!browse && !browseFailed ? (
				<LoadingState placement="row">Looking up your GitHub repositories…</LoadingState>
			) : browse && browse.source !== null ? (
				<>
					<input
						className={settingsInputClass}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder={`Filter ${browse.repos.length} ${
							browse.repos.length === 1 ? "repository" : "repositories"
						}…`}
						aria-label="Filter repositories"
						autoCapitalize="none"
						spellCheck={false}
					/>
					<div className="mt-2 max-h-[320px] overflow-y-auto">
						{filtered.length === 0 ? (
							<EmptyState placement="row" className="px-1">
								No repositories match.
							</EmptyState>
						) : (
							filtered.map((r) => {
								const registered = r.registered || added.has(r.fullName);
								const working = addingRepo === r.fullName;
								return (
									<div
										key={r.fullName}
										className="flex items-center gap-3 border-b border-line px-1 py-2 last:border-b-0"
									>
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 items-baseline gap-2">
												<span className="truncate text-control-label font-medium text-fg">
													{r.fullName}
												</span>
												{r.private && (
													<span className="shrink-0 rounded-sm bg-active px-1.5 py-px text-meta text-dim">
														private
													</span>
												)}
											</div>
											{r.description && (
												<div className="mt-0.5 truncate text-meta text-faint">
													{r.description}
												</div>
											)}
										</div>
										<Button
											size="sm"
											variant={registered ? "ghost" : "default"}
											disabled={registered || addingRepo !== null}
											onClick={() => addRepo(r.fullName)}
										>
											{registered ? "Added" : working ? "Cloning…" : "Add"}
										</Button>
									</div>
								);
							})
						)}
					</div>
					<div className="mt-2 text-meta text-faint">
						Browsing as the {browse.source === "user" ? "connected account" : "bot"} —
						only repos that credential can reach are listed.
					</div>
				</>
			) : (
				<>
					<div className="text-supporting leading-relaxed text-dim">
						{browseFailed ? (
							<>Couldn&rsquo;t load the GitHub repo list right now.</>
						) : (
							<>
								No GitHub credential yet, so the repo list can&rsquo;t be browsed
								— connect your account under Workspace → Connections, or set{" "}
								<code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[0.92em] text-fg">
									GITHUB_API_TOKEN
								</code>{" "}
								via the GitHub integration card below.
							</>
						)}{" "}
						You can still register a repo by name:
					</div>
					<div className="mt-2.5 flex items-center gap-2">
						<input
							className={cn(settingsInputClass, "flex-1 font-mono")}
							value={manual}
							onChange={(e) => setManual(e.target.value)}
							placeholder="owner/name"
							aria-label="Repository full name"
							autoCapitalize="none"
							spellCheck={false}
							onKeyDown={(e) => {
								if (e.key === "Enter" && manualValid && !addingRepo)
									addRepo(manual.trim());
							}}
						/>
						<Button
							variant="primary"
							disabled={!manualValid || addingRepo !== null}
							onClick={() => addRepo(manual.trim())}
						>
							{addingRepo ? "Cloning…" : "Add"}
						</Button>
					</div>
				</>
			)}
			{error && <InlineAlert className="mt-2.5">{error}</InlineAlert>}
		</SettingsSection>
	);
}
