
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
	m0: {
		"margin": "0"
	},
	maxH80: {
		"maxHeight": "320px"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	fontMono: {
		"fontFamily": "var(--mono)"
	},
	leading15: {
		"--tw-leading": "1.5",
		"lineHeight": "1.5"
	},
	whitespacePreWrap: {
		"whiteSpace": "pre-wrap"
	},
	WordBreakBreakWord: {
		"wordBreak": "break-word"
	},
	TabSize2: {
		"tabSize": "2"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	overflowXAuto: {
		"overflowX": "auto"
	},
	roundedMd: {
		"borderRadius": "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	borderCodeWellLine: {
		"borderColor": "var(--code-well-line)"
	},
	bgCodeWell: {
		"backgroundColor": "var(--code-well)"
	},
	px25: {
		"paddingInline": "10px"
	},
	py2: {
		"paddingBlock": "8px"
	},
	mt15: {
		"marginTop": "6px"
	},
	flex: {
		"display": "flex"
	},
	flexWrap: {
		"flexWrap": "wrap"
	},
	gap2: {
		"gap": "8px"
	},
	inlineFlex: {
		"display": "inline-flex"
	},
	flexShrink0: {
		"flexShrink": "0"
	},
	selfCenter: {
		"alignSelf": "center"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap05: {
		"gap": "2px"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgHover: {
		"backgroundColor": "var(--hover)"
	},
	py2px: {
		"paddingBlock": "2px"
	},
	pl2: {
		"paddingLeft": "8px"
	},
	pr1: {
		"paddingRight": "4px"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	leading4: {
		"--tw-leading": "calc(4px * 4)",
		"lineHeight": "16px"
	},
	hoverBgPressed: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover-strong)"
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
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
	focusRing: {
		":focusVisible": {
			"outline": "2px solid var(--accent-ink)",
			"outlineOffset": "2px"
		},
		"@media (forced-colors: active)": {
			":focusVisible": {
				"outlineColor": "highlight"
			}
		}
	},
	gap1: {
		"gap": "4px"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},

	transitionColorBackgroundColorScale: {
		"transitionProperty": "color,background-color,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
});

/**
 * The tool call block's code surfaces.
 *
 * Two pieces that compose: `TOOL_PRE` is the monospace body, `TOOL_CODE_WELL`
 * is the sunk surface it usually sits on. They land either nested (a well
 * `div` wrapping a highlighted `pre`) or on the same element (a bare `pre`
 * that is its own well), which is why the well states its ink twice — once as
 * a descendant rule and once for itself. Both compile to two-class selectors,
 * so they outrank `TOOL_PRE`'s own `text-dim` exactly the way the legacy
 * `.tool-code-surface .tool-pre` / `.tool-pre.tool-code-surface` pair did.
 *
 * `tool-pre` stays on the markup as a bare hook with no rule behind it:
 * ToolCallBlock tints a failed result through `[&_.tool-pre]:text-red/75`, and
 * that has to reach both the `pre` and the highlighter's wrapper `div`, so a
 * `[&_pre]` selector would miss half of them.
 *
 * The well's colours are tokens (`--code-well*` in base.css) rather than the
 * hexes that were inlined here: the surface needs a value per theme, and only
 * a token re-resolves under `html[data-theme]`.
 */

/** Monospace body. Ink is `text-dim`; a well overrides it.
 *
 * `[tab-size:2]` is not decoration: code output is full of tab indentation
 * (`cat -n` / `rg -n`), and at the default 8 columns a deeply indented line
 * out-runs a phone-width pane — the run of tabs hangs past the edge instead
 * of wrapping. */
export const TOOL_PRE =
	mergeStylexClassName("tool-pre", sx.m0, sx.maxH80, sx.overflowYAuto, sx.fontMono, typography.meta, sx.leading15) + " " +
	mergeStylexClassName("", sx.whitespacePreWrap, sx.WordBreakBreakWord, sx.TabSize2, sx.textDim);

/** The sunk surface a snippet sits on. */
export const TOOL_CODE_WELL =
	mergeStylexClassName("", sx.overflowXAuto, sx.roundedMd, sx.border, sx.borderCodeWellLine, sx.bgCodeWell) + " " +
	mergeStylexClassName("", sx.px25, sx.py2, sx.TabSize2) + " " +
	"[&_.tool-pre]:text-code-well-ink [&.tool-pre]:text-code-well-ink " +
	"[&_.shiki-gutter]:text-code-well-gutter";

/**
 * The highlighter's output wrapper. Shiki emits its own `pre.shiki` with a
 * theme background and type of its own; every declaration here is undoing
 * that so the snippet inherits the well instead.
 */
export const TOOL_PRE_CODE =
	`${TOOL_PRE} ` +
	"[&_pre.shiki]:m-0 [&_pre.shiki]:p-0 [&_pre.shiki]:!bg-transparent " +
	"[&_pre.shiki]:font-[inherit] [&_pre.shiki]:text-[length:inherit] " +
	"[&_pre.shiki]:leading-[inherit] [&_pre.shiki]:whitespace-pre-wrap " +
	"[&_pre.shiki]:[word-break:break-word] " +
	"[&_pre.shiki_code]:font-[inherit] [&_pre.shiki_code]:text-[length:inherit]";

/** Image and video grids under a tool result. */
export const TOOL_RESULT_MEDIA = mergeStylexClassName("", sx.mt15, sx.flex, sx.flexWrap, sx.gap2);

/**
 * The tool row's trailing drill-in chip — "Open ↗" on a file the call wrote,
 * "Watch ↗" on a sub-agent still running.
 * It matches the chip tier in `SessionRelations`: a compact pill with a
 * translucent plate instead of a hairline box that reads like an input.
 */
export const TOOL_ROW_CHIP =
	mergeStylexClassName("", sx.inlineFlex, sx.flexShrink0, sx.selfCenter, sx.itemsCenter, sx.gap05, sx.roundedControl) + " " +
	mergeStylexClassName("", sx.bgHover, sx.py2px, sx.pl2, sx.pr1, typography.meta, sx.fontMedium, sx.leading4, sx.textDim) + " " +
	mergeStylexClassName("", sx.transitionColorBackgroundColorScale, sx.hoverBgPressed, sx.hoverTextFg) + " " +
	mergeStylexClassName("", sx.activeScale096, sx.focusRing);

/**
 * Says a collapsed row is holding media the agent didn't ask to show — a Read
 * of a screenshot, a path that turned up in output. Not a control: the row
 * itself is the button, and this only has to make the media discoverable, so
 * it sits in the trailing meta at the same weight as the duration rather than
 * competing with the "Open ↗" chip beside it.
 */
export const TOOL_ROW_MEDIA_HINT =
	mergeStylexClassName("", sx.inlineFlex, sx.flexShrink0, sx.selfCenter, sx.itemsCenter, sx.gap1, typography.meta) + " " +
	mergeStylexClassName("group-hover:text-dim", sx.leading4, sx.textFaint, sx.transitionColors);
