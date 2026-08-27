import { useState } from "react";
import {
	PR_ROW_OUT,
	PR_STATE_TEXT,
	prStackChipClass,
} from "../../lib/pr-tone-classes";
import type { PrTone } from "../../lib/pr-refs";
import { stackLayersTopFirst } from "../../lib/pr-stack";
import { prPath } from "../../lib/share-link";
import type { PrDetails, PrStackLayer } from "../../lib/types";
import { cn, mergeStylexProps, mergeStylexClassName } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { IconArrowUpRight, IconStack } from "../icons";
import { StackNode, StackRail } from "./StackRail";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	py2: {
			paddingBlock: "8px"
	},
	noUnderline: {
			textDecorationLine: "none"
	},
	block: {
			display: "block"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	flex: {
			display: "flex"
	},
	flexCol: {
			flexDirection: "column"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	p0: {
			padding: "0"
	},
	m0: {
			margin: "0"
	},
	listNone: {
			listStyleType: "none"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},

	bgHover: {
		"backgroundColor": "var(--hover)"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textFg: {
		"color": "var(--text)"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	selfCenter: {
		"alignSelf": "center"
	},
	phoneSize11: {
		"@media (max-width: 720px)": {
			"width": "44px",
			"height": "44px"
		}
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	shrink0: {
		"flexShrink": "0"
	},
	borderB: {
		"borderBottomStyle": "var(--tw-border-style)",
		"borderBottomWidth": "1px"
	},
	borderDivider: {
		"borderColor": "var(--divider)"
	},
	px3: {
		"paddingInline": "12px"
	},
	py25: {
		"paddingBlock": "10px"
	},

	itemsStretch: {
		"alignItems": "stretch"
	},
	gap25: {
		"gap": "10px"
	},
	pr15: {
		"paddingRight": "6px"
	},
	pl3: {
		"paddingLeft": "12px"
	},
	maxHMin560px70vhVarAvailableHeight: {
		"maxHeight": "min(560px, 70vh, var(--available-height))"
	},
	wMin460pxCalc100vw24px: {
		"width": "min(460px,100vw - 24px)"
	},
});

/**
 * The stack, from the status strip: a chip reading `position/size` that opens
 * the whole stack on hover or click.
 *
 * The review panel already has a stack map (pr/Stack.tsx), but the strip is
 * where a person decides whether to merge — and merging a layer takes every
 * layer under it along, so the strip has to be able to show what "every layer
 * under it" actually is without leaving the session. Rows are drawn top-first
 * with the trunk as the last node, the way github.com draws a stack.
 */

/* The rail and its nodes live in ./StackRail so this component stays focused
   on the popup and its navigation rows. */

const ROW = mergeStylexClassName("", sx.flex, sx.itemsStretch, sx.gap25, sx.pr15, sx.pl3);

function StackRow({
	layer,
	current,
	first,
	repo,
	onOpenPr,
	onNavigate,
}: {
	layer: PrStackLayer;
	current: boolean;
	first: boolean;
	repo?: string;
	onOpenPr?: (repo: string, branch: string) => void;
	onNavigate: () => void;
}) {
	// Layers open in this session's review panel, not on github.com — the arrow
	// on the right is the way out. Falls back to the GitHub URL when the repo id
	// is unknown, so a row is never a dead end.
	const inApp = repo ? prPath(repo, layer.headRefName) : null;
	// "You are here" is painted as a wash, not a surface: bg-surface is an
	// absolute colour and lands *lighter* than the popup's panel in light mode.
	return (
		<li className={cn(ROW, current ? mergeStylexClassName("", sx.bgHover) : mergeStylexClassName("", sx.hoverBgHover))}>
			<StackRail first={first}>
				<StackNode state={layer.state} isDraft={layer.isDraft} />
			</StackRail>
			<a
				{...stylex.props(sx.minW0, sx.flex1, sx.py2, sx.noUnderline)}
				href={inApp || layer.url}
				{...(inApp ? {} : { target: "_blank", rel: "noopener" })}
				aria-current={current ? "true" : undefined}
				onClick={(e) => {
					// Modified clicks keep native new-tab behavior.
					if (e.metaKey || e.ctrlKey || e.shiftKey) return;
					onNavigate();
					if (!inApp || !onOpenPr) return;
					e.preventDefault();
					onOpenPr(repo!, layer.headRefName);
				}}
			>
				<span
					className={cn(
						mergeStylexClassName("", sx.block, sx.truncate, typography.label, sx.leadingSnug),
						current ? mergeStylexClassName("", sx.fontSemibold, sx.textFg) : mergeStylexClassName("", sx.fontMedium, sx.textFg),
					)}
				>
					{layer.title}
				</span>
				<span {...stylex.props(sx.block, sx.truncate, sx.leadingSnug, sx.textFaint, typography.meta)}>
					#{layer.number} · {layer.headRefName}
				</span>
			</a>
			<a
				className={cn(PR_ROW_OUT, mergeStylexClassName("", sx.selfCenter, sx.phoneSize11))}
				href={layer.url}
				target="_blank"
				rel="noopener"
				aria-label={`Open #${layer.number} on GitHub`}
			>
				<IconArrowUpRight size={20} />
			</a>
		</li>
	);
}

export function PrStackChip({
	pr,
	tone,
	size,
	headline,
	repo,
	onOpenPr,
}: {
	pr: PrDetails;
	tone: PrTone;
	/** Which strip the chip rides in — it sizes to that strip's other chips. */
	size: "bar" | "head";
	/** The strip's own headline, repeated as the popup's title so the popup
	 *  says what merging the stack would mean, not just what is in it. */
	headline: string;
	/** Registered repo id, for in-app links to the other layers. */
	repo?: string;
	onOpenPr?: (repo: string, branch: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const stack = pr.stack;
	if (!stack) return null;
	const layers = stackLayersTopFirst(stack);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				openOnHover
				delay={200}
				closeDelay={120}
				render={
					<button
						type="button"
						className={prStackChipClass(tone, size)}
						aria-label={`Stack #${stack.number}: layer ${stack.position} of ${stack.size}`}
					/>
				}
			>
				<IconStack size={20} />
				<span className={mergeStylexClassName("", sx.tabularNums)}>
					{stack.position}/{stack.size}
				</span>
			</Popover.Trigger>
			<Popover.Popup
				side="bottom"
				align="start"
				sideOffset={6} {...mergeStylexProps("", sx.maxHMin560px70vhVarAvailableHeight, sx.wMin460pxCalc100vw24px, sx.flex, sx.flexCol, sx.overflowHidden, sx.p0)}
			>
				{/* The strip's headline, in the strip's tone: the popup opens under a
				    green chip and has to keep saying what the green means. */}
				<div
					className={cn(
						mergeStylexClassName("", sx.shrink0, sx.borderB, sx.borderDivider, sx.px3, sx.py25, typography.itemTitle, sx.fontSemibold),
						PR_STATE_TEXT[tone],
					)}
				>
					{headline}
				</div>
				<ul {...stylex.props(sx.m0, sx.flex, sx.listNone, sx.flexCol, sx.overflowYAuto, sx.p0)}>
					{layers.map((layer, i) => (
						<StackRow
							key={layer.number}
							layer={layer}
							current={layer.number === pr.number}
							first={i === 0}
							repo={repo}
							onOpenPr={onOpenPr}
							onNavigate={() => setOpen(false)}
						/>
					))}
					{/* The trunk: not a layer, just where the bottom one lands. */}
					<li className={cn(ROW, mergeStylexClassName("", sx.py2))}>
						<StackRail last>
							<StackNode />
						</StackRail>
						<span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.fontMono, sx.textFaint, typography.label)}>
							{stack.baseRefName}
						</span>
					</li>
				</ul>
			</Popover.Popup>
		</Popover.Root>
	);
}
