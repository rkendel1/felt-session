import React, { useEffect, useRef, useState } from "react";
import { registerRepoApi, type RepoInfo } from "../lib/api";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { fieldClasses } from "../ui/input";
import { cn, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	wFull: {
			width: "100%"
	},
	flex1: {
			flex: "1"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	flex: {
			display: "flex"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap3: {
			gap: "12px"
	},
	gap15: {
			gap: "6px"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderRed30: {
			borderColor: "var(--red)"
	},
	bgRedSoft: {
			backgroundColor: "var(--red-soft)"
	},
	px3: {
			paddingInline: "12px"
	},
	py2: {
			paddingBlock: "8px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textRed: {
			color: "var(--red)"
	},
	repoInput: {
		height: "40px",
		borderColor: "var(--border-strong)",
		":focus": { boxShadow: "0 0 0 3px var(--accent-soft)" },
	},
});

type AddMode = "clone" | "path";

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

	return (
		<Modal.Root
			open={open}
			onOpenChange={(next) => {
				if (!adding) onOpenChange(next);
			}}
			disablePointerDismissal={adding}
		>
			<Modal.Content widthClassName={mergeStylexClassName("", sharedClassStyles.maxW28rem)} initialFocus={inputRef}>
				<Modal.Header
					title="Add repository"
					description="Clone a Git repository (GitHub or a code.storage remote), or register a checkout already on this Mac."
				/>

				<Segmented
					className={mergeStylexOverrideClassName("", sx.wFull)}
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
							className={mergeStylexOverrideClassName("", sx.flex1, sx.justifyCenter)}
							disabled={adding}
						>
							{label}
						</SegmentedOption>
					))}
				</Segmented>

				<form {...stylex.props(sx.flex, sx.flexCol, sx.gap3)} onSubmit={submit}>
					<label {...stylex.props(sx.flex, sx.flexCol, sx.gap15, sx.textSm, sx.fontMedium, sx.textFg)}>
						{mode === "clone" ? "Git clone URL" : "Absolute folder path"}
						<input
							ref={inputRef}
							type="text"
							/* Raw element for the ref; optics from the field primitive. The
							   40px height is the dialog's own — this is the modal's single
							   affordance and has no control beside it to match. */
							className={cn(
								fieldClasses("lg"),
								stylex.props(sx.repoInput, typography.label).className,
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

					{error && (
						<div
							{...stylex.props(sx.roundedMd, sx.border, sx.borderRed30, sx.bgRedSoft, sx.px3, sx.py2, sx.textXs, sx.leadingRelaxed, sx.textRed)}
							role="alert"
						>
							{error}
						</div>
					)}

					<Modal.Footer>
						<div {...stylex.props(sx.flex1)} />
						<Button
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={adding}
						>
							Cancel
						</Button>
						<Button variant="primary" type="submit" disabled={!value.trim() || adding}>
							{adding
								? mode === "clone"
									? "Cloning..."
									: "Adding..."
								: "Add repository"}
						</Button>
					</Modal.Footer>
				</form>
			</Modal.Content>
		</Modal.Root>
	);
}
