import React, { useEffect, useState } from "react";
import {
	fetchRepos,
	fetchRepoSwitchable,
	switchPrimaryRepoApi,
	type RepoInfo,
} from "../lib/api";
import { RepoTile } from "./RepoTile";
import { IconCheck } from "./icons";

interface Props {
	sessionId: string;
	primaryRepo: string;
	branch: string | null;
	onSwitched?: () => void;
}

/**
 * Repo switcher as flat menu rows for the phone ⋯ menu. On phones the inline
 * header RepoBar is CSS-hidden (the centered top-bar title replaces the title
 * row), so this is the only way to repoint a session at another repo. Switch
 * only — attach/detach stay on the desktop RepoBar. Same guarantees as RepoBar:
 * the old worktree (branch, commits, edits) is left on disk, and a switch that
 * would abandon in-progress work is confirmed first.
 */
export function RepoSwitchMenu({ sessionId, primaryRepo, branch, onSwitched }: Props) {
	const [repos, setRepos] = useState<RepoInfo[]>([]);
	const [switchable, setSwitchable] = useState(true);
	const [hasWork, setHasWork] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		fetchRepos().then(setRepos).catch(() => {});
		fetchRepoSwitchable(sessionId)
			.then(({ switchable, hasWork }) => {
				setSwitchable(switchable);
				setHasWork(hasWork);
			})
			.catch(() => {});
	}, [sessionId]);

	// Ask sessions read the shared checkout — there's no primary repo to switch.
	if (!switchable) return null;

	async function switchPrimary(repo: string) {
		if (repo === primaryRepo || busy) return;
		if (
			hasWork &&
			!window.confirm(
				`Switch this workspace from ${primaryRepo} to ${repo}?\n\n` +
					`Your current changes stay in the ${primaryRepo} worktree${
						branch ? ` (branch ${branch})` : ""
					} — they won't move to ${repo}. You can reopen them from that branch.`,
			)
		)
			return;

		setBusy(repo);
		try {
			await switchPrimaryRepoApi(sessionId, repo, hasWork);
			onSwitched?.();
		} catch (e: any) {
			window.alert(e.message || String(e));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="viewer-repo-menu">
			<span className="viewer-repo-menu-label">Repo</span>
			{repos.map((r) => (
				<button
					key={r.id}
					type="button"
					className={`btn-viewer-repo ${r.id === primaryRepo ? "current" : ""}`}
					onClick={() => switchPrimary(r.id)}
					disabled={!!busy || r.id === primaryRepo}
				>
					<RepoTile name={r.id} />
					<span className="btn-viewer-repo-name">
						{busy === r.id ? "Switching…" : r.id}
					</span>
					{r.id === primaryRepo && <IconCheck size={18} className="btn-viewer-repo-check" />}
				</button>
			))}
		</div>
	);
}
