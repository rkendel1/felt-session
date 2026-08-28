import React, { useEffect, useRef, useState } from "react";
import { registerRepoApi, type RepoInfo } from "../lib/api";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { fieldClasses } from "../ui/input";

type AddMode = "clone" | "path";

type LocalRepositoryBridge = {
	importLocal: () => Promise<{
		ok: boolean;
		path?: string;
		canceled?: boolean;
		error?: string;
	}>;
};

function localRepositoryBridge(): LocalRepositoryBridge | undefined {
	return (
		window as unknown as {
			os1?: { repositories?: LocalRepositoryBridge };
		}
	).os1?.repositories;
}

export function AddRepoDialog({
	open,
	onOpenChange,
	onAdded,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdded: (repo: RepoInfo) => void;
}) {
	const [mode, setMode] = useState<AddMode>("clone");
	const [cloneUrl, setCloneUrl] = useState("");
	const [folderPath, setFolderPath] = useState("");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const value = mode === "clone" ? cloneUrl : folderPath;
	const nativeLocal = localRepositoryBridge();

	useEffect(() => {
		if (!open) return;
		setError(null);
		queueMicrotask(() => inputRef.current?.focus());
	}, [open, mode]);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const input = value.trim();
		if (!input || adding) return;
		setAdding(true);
		setError(null);
		await (async () => {
const repo = await registerRepoApi(
				mode === "clone" ? { url: input } : { path: input },
			);
			onAdded(repo);
			if (mode === "clone") setCloneUrl("");
			else setFolderPath("");
			onOpenChange(false);
})().catch(async (cause) => {
setError(cause instanceof Error ? cause.message : String(cause));
}).finally(async () => {
setAdding(false);
});
	}

	async function chooseLocalFolder() {
		if (!nativeLocal || adding) return;
		setAdding(true);
		setError(null);
		try {
			const imported = await nativeLocal.importLocal();
			if (imported.canceled) return;
			if (!imported.ok || !imported.path) {
				throw new Error(imported.error || "Couldn't import that repository.");
			}
			const repo = await registerRepoApi({ path: imported.path });
			onAdded(repo);
			onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAdding(false);
		}
	}

	return (
		<Modal.Root
			open={open}
			onOpenChange={(next) => {
				if (!adding) onOpenChange(next);
			}}
			disablePointerDismissal={adding}
		>
			<Modal.Content widthClassName="max-w-[28rem]" initialFocus={inputRef}>
				<Modal.Header
					title="Add repository"
					description="Clone a Git repository (GitHub or a code.storage remote), or register a checkout already on this Mac."
				/>

				<Segmented
					className="w-full"
					label="Repository source"
					value={mode}
					onValueChange={(next) => {
						setMode(next as typeof mode);
						setError(null);
					}}
				>
					{([
						["clone", "Clone URL"],
						["path", "Local folder"],
					] as const).map(([nextMode, label]) => (
						<SegmentedOption
							key={nextMode}
							value={nextMode}
							className="flex-1 justify-center"
							disabled={adding}
						>
							{label}
						</SegmentedOption>
					))}
				</Segmented>

				<form className="flex flex-col gap-3" onSubmit={submit}>
					{mode === "path" && nativeLocal ? (
						<div className="flex flex-col gap-3">
							<p className="m-0 text-supporting leading-relaxed text-dim">
								Choose the repository folder. Open Session imports a lightweight managed clone of its committed code so background sessions can access it.
							</p>
							<Button
								variant="primary"
								type="button"
								className="min-h-11 w-full"
								onClick={() => void chooseLocalFolder()}
								disabled={adding}
							>
								{adding ? "Importing…" : "Choose folder…"}
							</Button>
						</div>
					) : (
					<label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
						{mode === "clone" ? "Git clone URL" : "Absolute folder path"}
						<input
							ref={inputRef}
							type="text"
							/* Raw element for the ref; optics from the field primitive. The
							   40px height is the dialog's own — this is the modal's single
							   affordance and has no control beside it to match. */
							className={fieldClasses(
								"lg",
								"h-10 border-line-strong text-sm focus:shadow-[0_0_0_3px_var(--accent-soft)]",
							)}
							value={value}
							onChange={(event) =>
								mode === "clone"
									? setCloneUrl(event.target.value)
									: setFolderPath(event.target.value)
							}
							placeholder={
								mode === "clone"
									? "git@github.com:owner/repo.git or https://org.code.storage/repo.git"
									: "/Users/you/code/repository"
							}
							disabled={adding}
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
						/>
					</label>
					)}

					{error && (
						<div
							className="rounded-md border border-red/30 bg-red-soft px-3 py-2 text-xs leading-relaxed text-red"
							role="alert"
						>
							{error}
						</div>
					)}

					<Modal.Footer>
						<div className="flex-1" />
						<Button
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={adding}
						>
							Cancel
						</Button>
						{!(mode === "path" && nativeLocal) && <Button variant="primary" type="submit" disabled={!value.trim() || adding}>
							{adding
								? mode === "clone"
									? "Cloning..."
									: "Adding..."
								: "Add repository"}
						</Button>}
					</Modal.Footer>
				</form>
			</Modal.Content>
		</Modal.Root>
	);
}
