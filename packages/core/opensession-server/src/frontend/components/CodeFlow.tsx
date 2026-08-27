import React, { useId } from "react";
import type { CodeFlowNode, CodeFlowResult } from "../lib/types";
import { Button } from "../ui/button";
import { InlineAlert, LoadingState } from "../ui/state";
import { IconBranches } from "./icons";
import { Badge } from "../ui/badge";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mlAuto: {
			marginLeft: "auto"
	},
	maxW52: {
			maxWidth: "208px"
	},
	shrink0: {
			flexShrink: "0"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	px15: {
			paddingInline: "6px"
	},
	fontSans: {
			fontFamily: "var(--sans)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	flex: {
			display: "flex"
	},
	minH8: {
			minHeight: "32px"
	},
	minW0: {
			minWidth: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	py05: {
			paddingBlock: "2px"
	},
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	m0: {
			margin: "0"
	},
	p0: {
			padding: "0"
	},
	minH48: {
			minHeight: "192px"
	},
	m4: {
			margin: "16px"
	},
	flexCol: {
			flexDirection: "column"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	px4: {
			paddingInline: "16px"
	},
	textCenter: {
			textAlign: "center"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	maxWMd: {
			maxWidth: "var(--container-md)"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
	leading5: {
			lineHeight: "20px"
	},
	mxAuto: {
			marginInline: "auto"
	},
	wFull: {
			width: "100%"
	},
	maxW1100px: {
			maxWidth: "1100px"
	},
	px3: {
			paddingInline: "12px"
	},
	py4: {
			paddingBlock: "16px"
	},
	mb3: {
			marginBottom: "12px"
	},
	px1: {
			paddingInline: "4px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedXl: {
			borderRadius: "calc(18px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	minH10: {
			minHeight: "40px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	bgRaised: {
			backgroundColor: "var(--bg-raised)"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	justifyStart: {
			justifyContent: "flex-start"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	py1: {
			paddingBlock: "4px"
	},
	mt3: { marginTop: "12px" },
	relative: { position: "relative" },
	listNone: { listStyleType: "none" },
	depth: { marginLeft: "16px", borderLeftStyle: "solid", borderLeftWidth: "1px", borderColor: "color-mix(in srgb, var(--border) 70%, transparent)", paddingLeft: "12px" },
	w3: { width: "12px" },
	fontBold: { fontWeight: "var(--font-weight-bold)" },
	bgTransparent: { backgroundColor: "transparent" },
	textGreen: { color: "var(--green)" },
	textRed: { color: "var(--red)" },
	textYellow: { color: "var(--yellow)" },

	hoverTextLink: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--link)"
			}
		}
	},
	phoneMaxW32: {
		"@media (max-width: 720px)": {
			"maxWidth": "128px"
		}
	},
	phonePx2: {
		"@media (max-width: 720px)": {
			"paddingInline": "8px"
		}
	},
});

const TONE = {
	same: sx.textDim,
	added: sx.textGreen,
	removed: sx.textRed,
	modified: sx.textYellow,
};

const MARK: Record<CodeFlowNode["status"], string> = {
	same: "·",
	added: "+",
	removed: "−",
	modified: "~",
};

function shortPath(path: string): string {
	const parts = path.split("/");
	return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : path;
}

function FlowNode({
	node,
	depth,
	sectionFile,
	onOpenLocation,
}: {
	node: CodeFlowNode;
	depth: number;
	sectionFile?: string;
	onOpenLocation?: (path: string) => void;
}) {
	const location = node.file && node.file !== sectionFile && node.status !== "same" && onOpenLocation && (
		<Button
			variant="ghost"
			size="md" {...mergeStylexProps("", sx.hoverTextLink, sx.phoneMaxW32, sx.mlAuto, sx.maxW52, sx.shrink0, sx.truncate, sx.px15, sx.fontSans, sx.textFaint, typography.meta)}
			onClick={() => onOpenLocation?.(node.file!)}
			title={`Open ${node.file} in the file diff`}
		>
			{shortPath(node.file)}
		</Button>
	);
	return (
		<li {...stylex.props(sx.relative, sx.listNone, depth > 0 && sx.depth)}>
			<div {...stylex.props(sx.flex, sx.minH8, sx.minW0, sx.itemsCenter, sx.gap2, sx.py05)}>
				<span {...stylex.props(sx.w3, sx.shrink0, sx.textCenter, sx.fontMono, typography.label, sx.fontBold, TONE[node.status])} aria-hidden="true">
					{MARK[node.status]}
				</span>
				<code {...stylex.props(sx.minW0, sx.truncate, sx.bgTransparent, sx.p0, typography.label, sx.leading5, TONE[node.status])} title={node.label}>
					<span {...stylex.props(sx.srOnly)}>{node.status}: </span>
					{node.label}
				</code>
				{location}
			</div>
			{node.children.length > 0 && (
				<ol {...stylex.props(sx.m0, sx.p0)}>
					{node.children.map((child, index) => (
						<FlowNode
							key={`${child.key}:${child.status}:${index}`}
							node={child}
							depth={depth + 1}
							sectionFile={sectionFile}
							onOpenLocation={onOpenLocation}
						/>
					))}
				</ol>
			)}
		</li>
	);
}

function changedFile(node: CodeFlowNode): string | undefined {
	if (node.status !== "same" && node.file) return node.file;
	for (const child of node.children) {
		const file = changedFile(child);
		if (file) return file;
	}
	return node.file;
}

export function CodeFlow({
	data,
	loading,
	error,
	onRetry,
	onOpenLocation,
}: {
	data: CodeFlowResult | null;
	loading: boolean;
	error: string | null;
	onRetry: () => void;
	onOpenLocation?: (path: string) => void;
}) {
	const titleId = useId();
	const files = new Map<string, CodeFlowResult["trees"]>();
	for (const tree of data?.trees ?? []) {
		const file = changedFile(tree.tree) ?? "Project structure";
		const entries = files.get(file) ?? [];
		entries.push(tree);
		files.set(file, entries);
	}
	if (loading && !data) return <LoadingState className={mergeStylexOverrideClassName("", sx.minH48)}>Mapping code flow…</LoadingState>;
	if (error && !data) {
		return (
			<InlineAlert className={mergeStylexOverrideClassName("", sx.m4)} onRetry={onRetry}>{error}</InlineAlert>
		);
	}
	if (!data?.trees.length) {
		const limited = Boolean(data?.truncated || data?.skippedFiles);
		return (
			<div {...stylex.props(sx.flex, sx.minH48, sx.flexCol, sx.itemsCenter, sx.justifyCenter, sx.gap2, sx.px4, sx.textCenter)}>
				<IconBranches size={24} className={mergeStylexOverrideClassName("", sx.textFaint)} />
				<div {...stylex.props(sx.textSm, sx.fontMedium, sx.textDim)}>
					{limited ? "Code flow was limited" : "No code-flow changes detected"}
				</div>
				<div {...stylex.props(sx.maxWMd, sx.textXs, sx.leading5, sx.textFaint)}>
					{limited
						? `${data?.skippedFiles || "Some"} changed file${data?.skippedFiles === 1 ? "" : "s"} could not be analyzed, so no reliable structural result is available.`
						: "The changed TypeScript, TSX, Rust, and ReScript files keep the same call and component structure."}
				</div>
			</div>
		);
	}
	return (
		<section {...mergeStylexProps("", sx.phonePx2, sx.mxAuto, sx.wFull, sx.maxW1100px, sx.px3, sx.py4)} aria-labelledby={titleId}>
			<header {...stylex.props(sx.mb3, sx.flex, sx.itemsCenter, sx.gap2, sx.px1)}>
				<IconBranches size={17} className={mergeStylexOverrideClassName("", sx.textDim)} />
				<h2 id={titleId} {...stylex.props(sx.m0, sx.textSm, sx.fontSemibold, sx.textFg)}>Code flow</h2>
				<span {...stylex.props(sx.textXs, sx.textFaint)}>{data.languages.join(" · ")}</span>
				{loading && <span {...stylex.props(sx.mlAuto, sx.textFaint, typography.meta)} role="status">Updating…</span>}
				{data.truncated && !loading && <Badge tone="warning" className={mergeStylexOverrideClassName("", sx.mlAuto)}>bounded</Badge>}
			</header>
			{error && <InlineAlert className={mergeStylexOverrideClassName("", sx.mb3)} onRetry={onRetry}>{error}</InlineAlert>}
			<div className="space-y-2">
				{[...files].map(([file, trees]) => (
					<article key={file} {...stylex.props(sx.overflowHidden, sx.roundedXl, sx.bgPanel)}>
						<header {...mergeStylexProps("", sx.phonePx2, sx.flex, sx.minH10, sx.itemsCenter, sx.borderB, sx.borderDivider, sx.bgRaised, sx.px3)}>
							{file !== "Project structure" && onOpenLocation ? (
								<Button
									variant="ghost"
									size="md" {...mergeStylexProps("", sx.hoverTextLink, sx.minW0, sx.maxWFull, sx.justifyStart, sx.truncate, sx.px1, sx.fontMono, sx.textXs, sx.fontSemibold, sx.textFg)}
									onClick={() => onOpenLocation(file)}
									title={`Open ${file} in the file diff`}
								>
									{file}
								</Button>
							) : (
								<span {...stylex.props(sx.fontMono, sx.textXs, sx.fontSemibold, sx.textFg)}>{file}</span>
							)}
							<span {...stylex.props(sx.mlAuto, sx.shrink0, sx.textFaint, typography.meta)}>
								{trees.length} changed {trees.length === 1 ? "flow" : "flows"}
							</span>
						</header>
						<div {...mergeStylexProps("divide-y divide-line/70", sx.phonePx2, sx.px3, sx.py1)}>
							{trees.map(({ entry, tree }) => (
								<ol key={entry} {...stylex.props(sx.m0, sx.py1, sx.p0)}>
									<FlowNode node={tree} depth={0} sectionFile={file} onOpenLocation={onOpenLocation} />
								</ol>
							))}
						</div>
					</article>
				))}
			</div>
			<footer {...stylex.props(sx.mt3, sx.px1, sx.textFaint, typography.supporting)}>
				Approximate, syntax-based structure{data.skippedFiles ? ` · ${data.skippedFiles} file${data.skippedFiles === 1 ? "" : "s"} skipped` : ""}
			</footer>
		</section>
	);
}
