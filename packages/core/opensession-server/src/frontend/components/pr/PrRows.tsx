import type React from "react";
import { avatarUrl, type Provider } from "../../lib/provider";
import type { PrFile, PrReviewer } from "../../lib/types";
import {
  IconCheck,
  IconClock,
  IconFile,
  IconMessage,
  IconX,
} from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../../ui/cn";

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
	roundedRow: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderTransparent: {
			borderColor: "transparent"
	},
	px15: {
			paddingInline: "6px"
	},
	py15: {
			paddingBlock: "6px"
	},
	size7: {
			width: "28px",
			height: "28px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	objectCover: {
			objectFit: "cover"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	textFg: {
			color: "var(--text)"
	},
	wFull: {
			width: "100%"
	},
	gap2: {
			gap: "8px"
	},
	py1: {
			paddingBlock: "4px"
	},
	textLeft: {
			textAlign: "left"
	},
	shrink0: {
			flexShrink: "0"
	},
	gap15: {
			gap: "6px"
	},
	textGreen: {
			color: "var(--green)"
	},
	textRed: {
			color: "var(--red)"
	},

	hoverBorderLine: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--border)"
			}
		}
	},
	hoverBgHover50: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in oklab, var(--hover) 50%, transparent)"
				}
			}
		}
	},
	textYellow: {
		"color": "var(--yellow)"
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledHoverBorderTransparent: {
		"@media (hover: hover)": {
			":disabled": {
				":hover": {
					"borderColor": "transparent"
				}
			}
		}
	},
	disabledHoverBgTransparent: {
		"@media (hover: hover)": {
			":disabled": {
				":hover": {
					"backgroundColor": "transparent"
				}
			}
		}
	},
});

export function ReviewerRow({ reviewer, provider }: { reviewer: PrReviewer; provider: Provider }) {
  const src = reviewer.isTeam ? null : avatarUrl(reviewer.login, provider, 40);
  const meta = reviewerStateMeta(reviewer.state);
  const toneClass =
    meta.tone === "green"
      ? mergeStylexClassName("", sx.textGreen)
      : meta.tone === "red"
        ? mergeStylexClassName("", sx.textRed)
        : meta.tone === "yellow"
          ? mergeStylexClassName("", sx.textYellow)
          : mergeStylexClassName("", sx.textFaint);
  return (
    <div {...mergeStylexProps("", sx.hoverBorderLine, sx.hoverBgHover50, sx.flex, sx.itemsCenter, sx.gap3, sx.roundedRow, sx.border, sx.borderTransparent, sx.px15, sx.py15)}>
      {src ? (
        <img {...stylex.props(sx.size7, sx.roundedFull, sx.objectCover)} src={src} alt="" loading="lazy" />
      ) : (
        <span
          {...stylex.props(sx.inlineFlex, sx.size7, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderLine, sx.bgSurface, sx.fontSemibold, sx.textFaint, typography.meta)}
          aria-hidden
        >
          {reviewer.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.textSm, sx.textFg)}>{reviewer.login}</span>
      <span className={[mergeStylexClassName("", sx.shrink0), toneClass].filter(Boolean).join(" ")} title={meta.label}>
        {meta.icon}
      </span>
    </div>
  );
}

export function reviewerStateMeta(state: PrReviewer["state"]): {
  label: string;
  tone: "green" | "red" | "muted" | "yellow";
  icon: React.ReactNode;
} {
  switch (state) {
    case "APPROVED":
      return { label: "Approved", tone: "green", icon: <IconCheck size={16} /> };
    case "CHANGES_REQUESTED":
      return { label: "Requested changes", tone: "red", icon: <IconX size={16} /> };
    case "COMMENTED":
      return { label: "Commented", tone: "muted", icon: <IconMessage size={16} /> };
    default:
      return { label: "Awaiting review", tone: "yellow", icon: <IconClock size={16} /> };
  }
}

/**
 * One changed file, sized for a narrow column: the file name and its diff
 * counts, with the full path on hover.
 *
 * The directory is deliberately absent. A path truncated to fit a 264px rail
 * leaves every row reading `packages/core/webapp/…`, which is the half that
 * tells you nothing, and the name is what a reviewer scans for. The whole path
 * is a click away, on the file's own diff header.
 */
export function FileRow({ file, onClick }: { file: PrFile; onClick?: () => void }) {
  const slash = file.path.lastIndexOf("/");
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      type="button" {...mergeStylexProps("", sx.hoverBorderLine, sx.hoverBgHover50, sx.disabledCursorDefault, sx.disabledHoverBorderTransparent, sx.disabledHoverBgTransparent, sx.flex, sx.wFull, sx.itemsCenter, sx.gap2, sx.roundedRow, sx.border, sx.borderTransparent, sx.px15, sx.py1, sx.textLeft)}
      onClick={onClick}
      disabled={!onClick}
      title={file.path}
    >
      <IconFile size={14} className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)} />
      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.textFg, typography.label)}>{base}</span>
      <span {...stylex.props(sx.inlineFlex, sx.shrink0, sx.itemsCenter, sx.gap15, typography.meta)}>
        {file.additions > 0 && <span {...stylex.props(sx.textGreen)}>+{file.additions}</span>}
        {file.deletions > 0 && <span {...stylex.props(sx.textRed)}>−{file.deletions}</span>}
      </span>
    </button>
  );
}
