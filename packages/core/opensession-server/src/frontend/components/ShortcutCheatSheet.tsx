import * as React from "react";
import { useShortcutsVersion } from "../hooks/useShortcutBindings";
import {
	shortcutKeys,
	SHORTCUT_COMMANDS,
	SHORTCUT_GROUPS,
	SHORTCUT_REFERENCE,
} from "../lib/shortcuts";
import { Button } from "../ui/button";
import { Modal, useEnterOnMount } from "../ui/modal";
import { IconX } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap3: {
			gap: "12px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	px5: {
			paddingInline: "20px"
	},
	py4: {
			paddingBlock: "16px"
	},
	m0: {
			margin: "0"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	leadingTight: {
			lineHeight: "var(--leading-tight)"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	textFg: {
			color: "var(--text)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	relative: {
			position: "relative"
	},
	Mr15: {
			marginRight: "-6px"
	},
	size8: {
			width: "32px",
			height: "32px"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	p0: {
			padding: "0"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	maxH68dvh: {
			maxHeight: "68dvh"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	overscrollContain: {
			overscrollBehavior: "contain"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	columns1: {
			columns: "1"
	},
	gap8: {
			gap: "32px"
	},
	mb5: {
			marginBottom: "20px"
	},
	breakInsideAvoid: {
			breakInside: "avoid"
	},
	mb15: {
			marginBottom: "6px"
	},
	listNone: {
			listStyleType: "none"
	},
	flexCol: {
			flexDirection: "column"
	},
	minH8: {
			minHeight: "32px"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap4: {
			gap: "16px"
	},
	py05: {
			paddingBlock: "2px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	gap1: {
			gap: "4px"
	},
	inlineFlex: { display: "inline-flex" },
	minW6: { minWidth: "24px" },
	roundedMd: { borderRadius: "calc(7px * var(--rf))" ,
		cornerShape: "var(--cs)"},
	border: { borderStyle: "solid", borderWidth: "1px" },
	borderLineStrong: { borderColor: "var(--border-strong)" },
	bgHover: { backgroundColor: "var(--hover)" },
	px15: { paddingInline: "6px" },
	fontSans: { fontFamily: "var(--font-sans)" },
	textDim: { color: "var(--text-dim)" },

	afterAbsolute: {
		"::after": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	afterInset1: {
		"::after": {
			"content": "var(--tw-content)",
			"inset": "-4px"
		}
	},
	afterContent: {
		"::after": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	desktopColumns2: {
		"@media (min-width: 721px)": {
			"columns": "2"
		}
	},
});

/**
 * The whole keyboard surface on one card, summoned by its own chord.
 *
 * It reads the same registry the settings page does, so a rebind shows up here
 * without a second list to keep in step, and the reference rows ride along —
 * the picture is only whole if the keys that are part of the interface are in
 * it too. What this is NOT is a second place to edit bindings: an overlay you
 * opened mid-task is the wrong place to start recording chords, so it points
 * at the settings page and stays read-only.
 *
 * The dialog body is deliberately a separate component from the shell. The
 * shell is Base UI's portal, focus trap and Escape handling, none of which
 * render under `react-dom/server`; the body is plain markup, so the rows and
 * their keycaps can be asserted in a test without a DOM.
 */
export function ShortcutCheatSheet({
	open,
	onOpenChange,
	onCustomize,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Send the reader to Settings → Keyboard shortcuts. */
	onCustomize?: () => void;
}) {
	// Nothing mounts until it is asked for: this hangs off a window listener on
	// every route, and a closed overlay must cost nothing to have around.
	if (!open) return null;
	return <CheatSheet onOpenChange={onOpenChange} onCustomize={onCustomize} />;
}

function CheatSheet({
	onOpenChange,
	onCustomize,
}: {
	onOpenChange: (open: boolean) => void;
	onCustomize?: () => void;
}) {
	// The parent mounts us only while we are open, so Base UI needs one frame
	// at closed to play the enter transition (see ui/modal).
	const open = useEnterOnMount();
	// Land the keyboard on the list rather than on the first tabbable, which
	// is Customize: a reference you opened to read something should not arm a
	// navigation under Enter. The list takes focus so it can be scrolled with
	// the arrows, and Tab still reaches the actions.
	const listRef = React.useRef<HTMLDivElement>(null);
	return (
		<Modal.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) onOpenChange(false);
			}}
		>
			<Modal.Content
				variant="palette"
				widthClassName={mergeStylexClassName("", sharedClassStyles.wMin720px100)}
				initialFocus={listRef}
			>
				<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap3, sx.borderB, sx.borderDivider, sx.px5, sx.py4)}>
					<Modal.Title className={mergeStylexOverrideClassName("", sx.m0, sx.minW0, sx.flex1, sx.fontSemibold, sx.leadingTight, sx.tracking001em, sx.textFg, typography.itemTitle)}>
						Keyboard shortcuts
					</Modal.Title>
					{onCustomize && (
						<Button size="sm" variant="soft" onClick={onCustomize}>
							Customize
						</Button>
					)}
					<Modal.Close
						aria-label="Close" {...mergeStylexProps("", sx.afterAbsolute, sx.afterInset1, sx.afterContent, sx.hoverBgHover, sx.hoverTextFg, sx.focusRing, sx.relative, sx.Mr15, sx.flex, sx.size8, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.p0, sx.textFaint, sx.transitionColors)}
					>
						<IconX size={20} />
					</Modal.Close>
				</div>
				<div
					ref={listRef}
					tabIndex={-1}
					{...stylex.props(sx.maxH68dvh, sx.overflowYAuto, sx.overscrollContain, sx.px5, sx.py4, sx.outlineNone)}
				>
					<ShortcutCheatSheetBody />
				</div>
			</Modal.Content>
		</Modal.Root>
	);
}

/**
 * Every group, then the keys that are part of the interface. Multi-column
 * rather than a grid: the groups are different lengths, and a column flow
 * keeps each one whole instead of leaving ragged holes between them.
 */
export function ShortcutCheatSheetBody() {
	// Repaint on a rebind, so the caps here are what the reader's keyboard
	// actually answers to rather than the shipped defaults.
	useShortcutsVersion();
	return (
		<div {...mergeStylexProps("", sx.desktopColumns2, sx.columns1, sx.gap8)}>
			{SHORTCUT_GROUPS.map((group) => {
				const rows = SHORTCUT_COMMANDS.filter((c) => c.group === group);
				if (rows.length === 0) return null;
				return (
					<Section key={group} title={group}>
						{rows.map((command) => (
							<Row
								key={command.id}
								title={command.title}
								keys={shortcutKeys(command.id)[0]}
							/>
						))}
					</Section>
				);
			})}
			<Section title="Always on">
				{SHORTCUT_REFERENCE.map((entry) => (
					<Row key={entry.title} title={entry.title} keys={entry.keys} />
				))}
			</Section>
		</div>
	);
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		// `break-inside-avoid` on the section, not the rows: a group split down
		// the middle reads as two groups sharing a name.
		<section {...stylex.props(sx.mb5, sx.breakInsideAvoid)}>
			<h3 {...stylex.props(sx.m0, sx.mb15, sx.fontSemibold, sx.textFaint, typography.label)}>
				{title}
			</h3>
			<ul {...stylex.props(sx.m0, sx.flex, sx.listNone, sx.flexCol, sx.p0)}>{children}</ul>
		</section>
	);
}

/** One command and its primary chord. An unassigned command still shows: the
 *  page is a picture of the keyboard, and a blank row is what says a chord is
 *  there to be claimed. */
function Row({ title, keys }: { title: string; keys?: string[] }) {
	return (
		<li {...stylex.props(sx.flex, sx.minH8, sx.itemsCenter, sx.justifyBetween, sx.gap4, sx.py05)}>
			<span {...stylex.props(sx.minW0, sx.truncate, sx.textFg, typography.supporting)}>{title}</span>
			{keys && keys.length > 0 ? (
				<span {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap1)}>
					{keys.map((key, i) => (
						<Keycap key={`${key}-${i}`}>{key}</Keycap>
					))}
				</span>
			) : (
				<span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>Not set</span>
			)}
		</li>
	);
}

/** The settings page's keycap treatment, so one chord reads the same in both
 *  places. Kept local rather than shared out of ShortcutsPanel: a settings
 *  panel is the wrong module for an overlay to import from, and the two are
 *  four declarations that have never diverged. */
function Keycap({ children }: { children: React.ReactNode }) {
	return (
		<kbd {...stylex.props(sx.inlineFlex, sx.minW6, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.border, sx.borderLineStrong, sx.bgHover, sx.px15, sx.py05, sx.fontSans, sx.textDim, typography.meta)}>
			{children}
		</kbd>
	);
}
