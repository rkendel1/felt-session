import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
  capturePreviewShot,
  type PreviewStatus,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { CopyCheck, useCopy } from "../ui/copy";
import { Menu, MENU_ICON } from "../ui/menu";
import { Popover } from "../ui/popover";
import {
  IconArrowUpRight,
  IconCamera,
  IconChevronDown,
  IconLink,
  IconPlay,
  IconPlayOutline,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	grow: {
			flexGrow: "1"
	},
	fixed: {
			position: "fixed"
	},
	inset0: {
			inset: "0"
	},
	z300: {
			zIndex: "300"
	},
	bgBlack60: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 60%, transparent)"
	},
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	p6: {
			padding: "24px"
	},
	bgRaised: {
			backgroundColor: "var(--bg-raised)"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	roundedPanel: {
			borderRadius: "calc(var(--radius) * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	smoothShadowLg: {
			boxShadow: "0 4px 12px -4px var(--smooth-shadow-color), 0 18px 48px -14px var(--smooth-shadow-color)"
	},
	p3: {
			padding: "12px"
	},
	maxW90vw: {
			maxWidth: "90vw"
	},
	maxH90vh: {
			maxHeight: "90vh"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap25: {
			gap: "10px"
	},
	textRed: {
			color: "var(--red)"
	},
	px2: {
			paddingInline: "8px"
	},
	py4: {
			paddingBlock: "16px"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	maxH75vh: {
			maxHeight: "75vh"
	},
	objectContain: {
			objectFit: "contain"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	gap2: {
			gap: "8px"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	px14px: {
			paddingInline: "14px"
	},
	py1: {
			paddingBlock: "4px"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	minH26px: {
			minHeight: "26px"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	roundedXs: {
			borderRadius: "calc(2px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgControl: {
			backgroundColor: "var(--control-surface)"
	},
	px25: {
			paddingInline: "10px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	smoothShadowSm: {
			boxShadow: "0 1px 3px -1px var(--smooth-shadow-color), 0 4px 10px -4px var(--smooth-shadow-color)"
	},
	transition: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to,opacity,box-shadow,transform,translate,scale,rotate,filter,-webkit-backdrop-filter,backdrop-filter,display,content-visibility,overlay,pointer-events",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	minW240px: {
			minWidth: "240px"
	},
	p25: {
			padding: "10px"
	},
	mb2: {
			marginBottom: "8px"
	},
	fontBold: {
			fontWeight: "var(--font-weight-bold)"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	px0: {
			paddingInline: "0"
	},
	listNone: {
			listStyleType: "none"
	},
	gap5px: {
			gap: "5px"
	},
	p0: {
			padding: "0"
	},
	minH10: {
			minHeight: "40px"
	},
	gap7px: {
			gap: "7px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	underline: {
			textDecorationLine: "underline"
	},
	decorationTransparent: {
			textDecorationColor: "transparent"
	},
	underlineOffset2: {
			textUnderlineOffset: "2px"
	},
	transitionTextDecorationColor: {
			transitionProperty: "text-decoration-color",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	mt15: {
			marginTop: "6px"
	},
	textCenter: {
			textAlign: "center"
	},
	size5: {
			width: "20px",
			height: "20px"
	},
	shrink0: {
			flexShrink: "0"
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
	relative: {
			position: "relative"
	},
	w8: {
			width: "32px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	roundedLNone: {
			borderTopLeftRadius: "0",
			borderBottomLeftRadius: "0"
	,
		cornerShape: "var(--cs)"},
	outlineNone: {
			outlineStyle: "none"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	left12: {
			left: "50%"
	},
	top12: {
			top: "50%"
	},
	size25px: {
			width: "25px",
			height: "25px"
	},
	TranslateX12: {
			translate: "calc(calc(1 / 2 * 100%) * -1) 0"
	},
	TranslateY12: {
			translate: "0 calc(calc(1 / 2 * 100%) * -1)"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	borderTransparent: {
			borderColor: "transparent"
	},
	borderTCurrent: {
			borderTopColor: "currentColor"
	},
	opacity90: {
			opacity: ".9"
	},
	animatePreviewSpin07sLinearInfinite: {
			animation: ".7s linear infinite preview-spin"
	},
	itemsStretch: {
			alignItems: "stretch"
	},
	MlPx: {
			marginLeft: "-1px"
	},
	opacity80: {
			opacity: ".8"
	},
	inline: {
			display: "inline"
	},
	hidden: {
			display: "none"
	},
	textAccent: {
			color: "var(--accent-ink)"
	},

	textGreen: {
		"color": "var(--green)"
	},
	size7px: {
		"width": "7px",
		"height": "7px"
	},
	bgGreen: {
		"backgroundColor": "var(--green)"
	},
	bgVarTextFaint: {
		"backgroundColor": "var(--text-faint)"
	},
	shadowNone: {
		"--tw-shadow": "0 0 transparent",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	Ml3px: {
		"marginLeft": "-3px"
	},
	pxPx: {
		"paddingInline": "1px"
	},
	py3px: {
		"paddingBlock": "3px"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextGreen: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--green)"
			}
		}
	},
	hoverTextDim: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text-dim)"
			}
		}
	},
	textYellow: {
		"color": "var(--yellow)"
	},
	hoverTextYellow: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--yellow)"
			}
		}
	},
	cursorNotAllowed: {
		"cursor": "not-allowed"
	},
	opacity45: {
		"opacity": ".45"
	},
	gap15: {
		"gap": "6px"
	},
	roundedLCalc5pxVarRf: {
		"borderTopLeftRadius": "calc(5px * var(--rf))",
		"borderBottomLeftRadius": "calc(5px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px11px: {
		"paddingInline": "11px"
	},
	py5px: {
		"paddingBlock": "5px"
	},
	noUnderline: {
		"textDecorationLine": "none"
	},
	hoverRelative: {
		"@media (hover: hover)": {
			":hover": {
				"position": "relative"
			}
		}
	},
	hoverZ1: {
		"@media (hover: hover)": {
			":hover": {
				"zIndex": "1"
			}
		}
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	hoverTextRed: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--red)"
			}
		}
	},
	hoverBorderAccent: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--accent)"
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
	roundedRCalc5pxVarRf: {
		"borderTopRightRadius": "calc(5px * var(--rf))",
		"borderBottomRightRadius": "calc(5px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	z1: {
		"zIndex": "1"
	},

	shadow0002pxColorMixInSrgbVarGreen18Transparent: {
		"--tw-shadow": "0 0 0 2px var(--tw-shadow-color,var(--green))",
		"@supports (color: color-mix(in lab, red, red))": {
			"--tw-shadow": "0 0 0 2px var(--tw-shadow-color,color-mix(in srgb,var(--green) 18%,transparent))"
		},
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	hoverBorderColorMixInSrgbVarGreen50Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--green)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"borderColor": "color-mix(in srgb,var(--green) 50%,transparent)"
				}
			}
		}
	},
	hoverBgColorMixInSrgbVarGreen12Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--green)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,var(--green) 12%,transparent)"
				}
			}
		}
	},
	hoverBorderColorMixInSrgbVarRed40Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--red)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"borderColor": "color-mix(in srgb,var(--red) 40%,transparent)"
				}
			}
		}
	},
	hoverBgColorMixInSrgbVarRed10Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--red)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,var(--red) 10%,transparent)"
				}
			}
		}
	},
	textColorColorMixInSrgbVarGreen72VarTextDim: {
		"color": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"color": "color-mix(in srgb,var(--green) 72%,var(--text-dim))"
		}
	},
	borderColorMixInSrgbVarGreen50Transparent: {
		"borderColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--green) 50%,transparent)"
		}
	},
	bgColorMixInSrgbVarGreen12Transparent: {
		"backgroundColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--green) 12%,transparent)"
		}
	},

	hoverTextAccent: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--accent-ink)"
			}
		}
	},

	size10px: {
		"width": "10px",
		"height": "10px"
	},
	borderLineStrong: {
		"borderColor": "var(--border-strong)"
	},
	borderTAccent: {
		"borderTopColor": "var(--accent)"
	},
	hoverBorderLineStrong: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--border-strong)"
			}
		}
	},
	activeScale097: {
		":active": {
			"scale": ".97"
		}
	},
	hoverDecorationCurrent: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationColor": "currentColor"
			}
		}
	},
	focusVisibleDecorationCurrent: {
		":focusVisible": {
			"textDecorationColor": "currentColor"
		}
	},
	wFull: {
		"width": "100%"
	},
	borderColorMixInSrgbVarRed40Transparent: {
		"borderColor": "var(--red)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--red) 40%,transparent)"
		}
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity45: {
		":disabled": {
			"opacity": ".45"
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
	hoverBgColorMixInSrgbVarRed12Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--red)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,var(--red) 12%,transparent)"
				}
			}
		}
	},
	roundedRNone: {
		"borderTopRightRadius": "0",
		"borderBottomRightRadius": "0"
	,
		cornerShape: "var(--cs)"},
	py2: {
		"paddingBlock": "8px"
	},
	textLeft: {
		"textAlign": "left"
	},
	focusVisibleBgHover: {
		":focusVisible": {
			"backgroundColor": "var(--hover)"
		}
	},
	disabledOpacity50: {
		":disabled": {
			"opacity": ".5"
		}
	},
	focusVisibleTextFg: {
		":focusVisible": {
			"color": "var(--text)"
		}
	},
	px5px: {
		"paddingInline": "5px"
	},
});

// Any worktree session gets the control; whether a repo can actually boot a
// preview comes back on the status itself (`bootable` — repo-committed
// .agents/start.sh → configured previewCommand).
// Repos with no mechanism show a disabled button explaining what to add.
function isPreviewable(session: UnifiedSession): boolean {
  return !!session.worktreeDir;
}

const headerIconBase =
  mergeStylexClassName("", sx.inlineFlex, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.border, sx.borderTransparent, sx.bgTransparent, sx.px5px, sx.py3px, sx.textFaint, sx.noUnderline);

const splitSegmentBase =
  mergeStylexClassName("", sx.inlineFlex, sx.itemsCenter, sx.justifyCenter, sx.border, sx.borderLineStrong, sx.bgTransparent, sx.textDim);

const spinnerClass =
  mergeStylexClassName("", sx.size10px, sx.shrink0, sx.roundedFull, sx.border, sx.borderLineStrong, sx.borderTAccent, sx.animatePreviewSpin07sLinearInfinite);

const popoverActionClass =
  mergeStylexClassName("", sx.wFull, sx.roundedControl, sx.border, sx.borderColorMixInSrgbVarRed40Transparent, sx.bgTransparent, sx.px25, sx.py5px, sx.textXs, sx.fontSemibold, sx.textRed, sx.disabledCursorDefault, sx.disabledOpacity45, sx.disabledHoverBgTransparent, sx.hoverBgColorMixInSrgbVarRed12Transparent);

/**
 * Header control for a session's local dev server ("Preview"). When the
 * webapp is up it links to it (`https://<host>:<httpsPort>` — a Caddy-fronted
 * secure origin over the tailnet); when it's off, a ▶ play button starts it
 * (runs the repo's preview boot script in the worktree), showing a
 * "Starting…" state until the server is listening. A caret popover lists the
 * dev services and can stop them. Renders for any session with a worktree;
 * repos without a boot mechanism get a disabled state pointing at the docs.
 */
export function PreviewButton({
  session,
  onAttachImage,
  onStatusChange,
  onOpenTab,
  variant = "bar",
}: {
  session: UnifiedSession;
  /** Open the in-app Preview view-tab instead of a new window/interstitial —
   *  the default wherever App provides it (the Mac shell turned window.opens
   *  into stray Electron windows). The interstitial flow stays for contexts
   *  without a tab (phones, PreviewWait deep links). */
  onOpenTab?: () => void;
  /** When set, the snapshot modal offers "Attach to session" (stages the PNG as a
   *  composer image, like a paste). */
  onAttachImage?: (dataUrl: string) => void;
  /** Mirrors the polled status to the parent so other preview affordances can
   *  appear and disappear with the dev server without polling it twice. */
  onStatusChange?: (status: PreviewStatus | null) => void;
  /** "bar" = the full segmented split button (right panel's action row);
   *  "header" = a single state-colored ▶ icon for the session header, sized to
   *  match the panel-toggle icon it sits beside. "action" = a compact cell for
   *  the mobile workspace Actions grid. "menu" = a single overflow-menu row. */
  variant?: "bar" | "header" | "action" | "menu";
}) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  const previewable = isPreviewable(session);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  // Poll the dev-server status while this session is open. Poll faster while a
  // bring-up is in flight so the button flips to the live link promptly; `ss`
  // is cheap and only the active SessionViewer is mounted.
  const busy = starting || (status?.starting ?? false);
  useEffect(() => {
    if (!previewable) {
      setStatus(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPreview(session.id)
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, busy ? 3000 : 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session.id, previewable, busy]);

  // Once the webapp is actually up, drop the optimistic "starting" flag.
  useEffect(() => {
    if (status?.running) setStarting(false);
  }, [status?.running]);

  // Dismissal (outside press, Escape) comes from ui/popover — the popup is
  // portalled, so a hand-rolled "outside click" test against wrapRef would
  // read every press inside the popup as outside and close it.

  if (!previewable) return null;

  // The webapp is only openable once Caddy has fronted it with an HTTPS origin
  // (previewUrl). A secure origin is required for the app to load fully.
  const running = !!status?.running && status.previewUrl != null;
  // Deep-link to the route the agent flagged (set_preview_path), so the human
  // lands on the feature under test instead of the app root.
  const url = status?.previewUrl
    ? withPreviewPath(status.previewUrl, session.previewPath)
    : "#";
  const anyRunning = status?.services.some((s) => s.running) ?? false;
  const isStarting = busy && !running;
  // Absent on pre-field servers — treat as bootable so the button still works
  // against a not-yet-restarted backend.
  const bootable = status?.bootable !== false;
  const notBootableHint = `No preview boot mechanism for this repo. Commit an .agents/start.sh to the repo, or set previewCommand on its repos config entry.`;

  // The menu row renders before the status lands, unlike every other variant.
  // A control in a toolbar can afford to not exist until there is something to
  // preview; a row in a menu cannot, because it appears under a cursor that is
  // already moving down the list and pushes everything below it. `previewable`
  // is a synchronous read of the session, so the row is decided the moment the
  // menu opens and only its label and colour fill in afterwards.
  if (variant === "menu") {
    return (
      <Menu.Item
        disabled={!bootable && !isStarting}
        onClick={() => {
          if (isStarting) void stop();
          else void start();
        }}
        title={bootable ? "Open or start the local preview" : notBootableHint}
      >
        {isStarting ? (
          <span className={spinnerClass} />
        ) : (
          <IconPlayOutline size={20} className={running ? mergeStylexClassName("", sx.textGreen) : MENU_ICON} />
        )}
        <span {...stylex.props(sx.grow)}>
          {isStarting ? "Cancel preview startup" : running ? "Open preview" : "Preview"}
        </span>
      </Menu.Item>
    );
  }

  if (!status) return null;

  // Same-origin interstitial that waits for the boot and then redirects itself
  // to the preview (PreviewWait.tsx). The agent-flagged deep link rides along
  // so the redirect lands where a click on the live link would.
  const waitUrl =
    `${BASE_PATH}/preview-wait/${encodeURIComponent(session.id)}` +
    (session.previewPath ? `?path=${encodeURIComponent(session.previewPath)}` : "");

  const start = async () => {
    // In-app tab flow: opening the tab both starts the preview (the pane
    // kicks the claim) and shows its progress — no popup, no interstitial.
    if (onOpenTab) {
      onOpenTab();
      return;
    }
    // Poll lag can leave a Start affordance up when the server is already
    // running — nothing to wait for, open the app directly. (Out-of-scope
    // origin, so installed PWAs hand this to a normal browser context.)
    if (status?.running && status.previewUrl) {
      window.open(url, `preview-${session.id}`, "noopener");
      return;
    }
    // Popup-blocker-safe "open when ready": window.open must fire synchronously
    // inside the click gesture, but the preview URL doesn't exist yet — so open
    // the interstitial NOW and let it redirect itself once the status endpoint
    // reports running. On the iOS PWA this opens the in-app browser view — a
    // new context, never replacing the app window. A blocked open returns null
    // and simply degrades to today's inline starting state.
    // Per-session window NAME (not _blank): reopening the same session's
    // preview reuses its own tab instead of spawning duplicates, and — the
    // real reason — a coalesced/reused browser view (iOS PWA in-app sheet)
    // can never end up showing ANOTHER session's interstitial (seen live
    // 2026-07-23: several sessions all presented preview-wait/<other-id>).
    const wait = window.open(waitUrl, `preview-${session.id}`);
    setStarting(true);
    await (async () => {
const s = await startPreviewApi(session.id);
      setStatus(s);
      // Nothing actually started (repo not bootable, sandbox gate off) — don't
      // leave the interstitial spinning toward a boot that will never come.
      if (!s.running && !s.starting) wait?.close();
})().catch(async () => {
setStarting(false);
      wait?.close();
});
  };

  const stop = async () => {
    setStopping(true);
    await (async () => {
setStatus(await stopPreviewApi(session.id));
      setStarting(false);
})().catch(async () => {

}).finally(async () => {
setStopping(false);
});
  };

  async function snap() {
    if (snapping) return;
    setSnapping(true);
    setShotError(null);
    await (async () => {
setShot(await capturePreviewShot(session.id));
})().catch(async (e: any) => {
setShotError(e.message);
      setShot(null);
});
    setSnapping(false);
    // Hand over to the snapshot modal. The popup keeps its "Capturing…" label
    // until the result lands, then steps aside — it is portalled at the popover
    // layer, above this modal, so leaving it open would cover the screenshot.
    setOpen(false);
  }

  // Shared snapshot preview modal — rendered by both layouts.
  const snapshotModal = (shot || shotError) && (
    <div
      {...stylex.props(sx.fixed, sx.inset0, sx.z300, sx.bgBlack60, sx.flex, sx.itemsCenter, sx.justifyCenter, sx.p6)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          setShot(null);
          setShotError(null);
        }
      }}
    >
      <div {...stylex.props(sx.bgRaised, sx.border, sx.borderLine, sx.roundedPanel, sx.smoothShadowLg, sx.p3, sx.maxW90vw, sx.maxH90vh, sx.flex, sx.flexCol, sx.gap25)}>
        {shotError ? (
          <div {...stylex.props(sx.textRed, sx.px2, sx.py4, typography.label)}>{shotError}</div>
        ) : (
          <img
            src={shot!}
            alt="Preview screenshot"
            {...stylex.props(sx.maxWFull, sx.maxH75vh, sx.objectContain, sx.roundedMd, sx.border, sx.borderLine)}
          />
        )}
        <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2, sx.justifyEnd)}>
          {shot && onAttachImage && (
            <Button
              variant="primary"
              size="sm"
              className={mergeStylexOverrideClassName("", sx.px14px, sx.py1)}
              onClick={() => {
                onAttachImage(shot);
                setShot(null);
              }}
            >
              Attach to session
            </Button>
          )}
          {shot && (
            <a {...mergeStylexProps("", sx.hoverBorderLineStrong, sx.hoverTextFg, sx.activeScale097, sx.inlineFlex, sx.minH26px, sx.itemsCenter, sx.justifyCenter, sx.whitespaceNowrap, sx.roundedXs, sx.border, sx.borderLine, sx.bgControl, sx.px25, sx.textXs, sx.fontMedium, sx.textDim, sx.smoothShadowSm, sx.transition)}
              href={shot}
              download={`preview-${session.id}.png`}
            >
              Download
            </a>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              setShot(null);
              setShotError(null);
            }}
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );

  // Shared dev-services popover — the stop/start control and per-service list.
  // In header mode it also carries the snapshot action (there's no caret for it).
  // Anchored to the whole control cluster rather than to one trigger, because
  // every variant can open it from more than one place (caret, right-click, the
  // disabled button) — `align="end"` then reproduces the old `right-0` edge.
  const servicesPopup = (
    <Popover.Popup
      anchor={wrapRef}
      side="bottom"
      align="end"
      sideOffset={6}
      // Holds real controls, so let the keyboard in (the hover cards on this
      // primitive deliberately don't take focus).
      initialFocus
      className={mergeStylexOverrideClassName("", sx.minW240px, sx.p25)}
    >
      <div {...stylex.props(sx.mb2, sx.fontBold, sx.tracking001em, sx.textFaint, typography.meta)}>Dev services</div>
      {status.services.length === 0 ? (
        <div {...stylex.props(sx.px0, sx.py1, sx.textXs, sx.textFaint)}>
          {isStarting ? "Starting up…" : "Not started yet"}
        </div>
      ) : (
        <ul {...stylex.props(sx.mb2, sx.flex, sx.listNone, sx.flexCol, sx.gap5px, sx.p0)}>
          {status.services.map((s) => (
            <li key={s.key} {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap7px, sx.textXs, sx.textDim)}>
              <span
                className={cn(
                  mergeStylexClassName("", sx.size7px, sx.shrink0, sx.roundedFull),
                  s.running
                    ? mergeStylexClassName("", sx.shadow0002pxColorMixInSrgbVarGreen18Transparent, sx.bgGreen)
                    : mergeStylexClassName("", sx.bgVarTextFaint, sx.shadowNone),
                )}
              />
              {s.running && s.previewUrl ? (
                <a
                  href={s.previewUrl}
                  target="_blank"
                  rel="noreferrer" {...mergeStylexProps("", sx.hoverDecorationCurrent, sx.focusVisibleDecorationCurrent, sx.fontSemibold, sx.textFg, sx.underline, sx.decorationTransparent, sx.underlineOffset2, sx.transitionTextDecorationColor)}
                >
                  {s.name}
                </a>
              ) : (
                <span {...stylex.props(sx.fontSemibold)}>{s.name}</span>
              )}
              <span {...stylex.props(sx.textFaint)}>:{s.port}</span>
              <span className={cn(mergeStylexClassName("", sx.mlAuto, typography.meta, sx.textFaint), s.running && mergeStylexClassName("", sx.textGreen))}>
                {s.running ? "running" : "stopped"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {running || anyRunning ? (
        <button className={popoverActionClass} onClick={stop} disabled={!anyRunning || stopping}>
          {stopping ? "Stopping…" : "Stop dev server"}
        </button>
      ) : isStarting ? (
        <button className={popoverActionClass} onClick={stop} disabled={stopping}>
          {stopping ? "Cancelling…" : "Cancel startup"}
        </button>
      ) : bootable ? (
        <button className={popoverActionClass} onClick={start}>
          Start dev server
        </button>
      ) : (
        <div {...stylex.props(sx.px0, sx.py1, sx.textXs, sx.textFaint)}>{notBootableHint}.</div>
      )}
      {variant !== "bar" && running && (
        <button className={cn(popoverActionClass, mergeStylexClassName("", sx.mt15))} onClick={snap} disabled={snapping}>
          {snapping ? "Capturing…" : "Snapshot preview"}
        </button>
      )}
      {/* Compact modes have no room for dedicated snapshot/copy segments, so
          those actions live here. The bar layout keeps its split controls. */}
      {variant !== "bar" && running && (
        <button
          className={cn(popoverActionClass, mergeStylexClassName("", sx.mt15))}
          onClick={() => copy(url, { toast: "Preview link copied" })}
        >
          Copy preview link
        </button>
      )}
      <div {...stylex.props(sx.mt15, sx.textCenter, sx.textFaint, typography.meta)}>
        {running || anyRunning ? (
          "Stops this worktree's dev process group only."
        ) : bootable ? (
          "Runs the repo's preview boot script in this worktree (first build ~1 min)."
        ) : (
          "Add .agents/start.sh or configure previewCommand."
        )}
      </div>
    </Popover.Popup>
  );

  // Right-click and disabled-state paths only OPEN the popup: the caret is a
  // real Popover.Trigger and owns toggling, so a second toggling opener would
  // race Base UI's outside-press dismissal (which fires on the press first,
  // then our handler would reopen what it just closed).
  const openServices = (e?: React.MouseEvent) => {
    e?.preventDefault();
    setOpen(true);
  };

  if (variant === "action") {
    const mainClass =
      mergeStylexClassName("aria-disabled:cursor-default aria-disabled:opacity-50", sx.flex, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap2, sx.roundedMd, sx.roundedRNone, sx.px25, sx.py2, sx.textLeft, typography.supporting, sx.fontSemibold, sx.textFg, sx.noUnderline, sx.outlineNone, sx.transitionColors, sx.hoverBgHover, sx.focusVisibleBgHover, sx.disabledCursorDefault, sx.disabledOpacity50);
    const mainContent = (
      <>
        <span {...stylex.props(sx.inlineFlex, sx.size5, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textFaint)}>
          {isStarting ? <span className={spinnerClass} /> : <IconPlay size={17} />}
        </span>
        <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
          {isStarting ? (stopping ? "Cancelling…" : "Starting…") : "Preview"}
        </span>
      </>
    );

    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div {...stylex.props(sx.relative, sx.flex, sx.minW0)} ref={wrapRef}>
          {running ? (
            <a
              className={mainClass}
              href={url}
              target="_blank"
              rel="noopener"
              title={`Open the webapp · ${url}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  copy(url, { toast: "Preview link copied" });
                } else if (onOpenTab) {
                  e.preventDefault();
                  onOpenTab();
                }
              }}
            >
              {mainContent}
            </a>
          ) : isStarting ? (
            <button className={mainClass} onClick={stop} disabled={stopping}>
              {mainContent}
            </button>
          ) : !bootable ? (
            <button className={mainClass} onClick={openServices} aria-disabled="true">
              {mainContent}
            </button>
          ) : (
            <button className={mainClass} onClick={start}>
              {mainContent}
            </button>
          )}
          <Popover.Trigger
            render={
              <button {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.focusVisibleBgHover, sx.focusVisibleTextFg, sx.flex, sx.w8, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.roundedLNone, sx.textFaint, sx.outlineNone, sx.transitionColors)}
                title="Dev services"
                aria-label="Dev services"
              >
                <IconChevronDown size={16} />
              </button>
            }
          />
          {snapshotModal}
        </div>
        {servicesPopup}
      </Popover.Root>
    );
  }

  // Header mode: a single ▶ icon, color-coded by state (dim=off, amber=starting,
  // green=live), sized to sit next to the panel-toggle icon. Left-click does the
  // primary action; right-click opens the services popover (stop / snapshot).
  // While the server is up (or starting) a small caret rides beside the icon —
  // the popover's stop action was right-click-only and nobody found it
  // (seen live, 2026-07-09).
  if (variant === "header") {
    const menuCaret = (running || anyRunning || isStarting) && (
      <Tooltip label="Dev services: stop the server, snapshot" side="bottom">
        <Popover.Trigger
          render={
            <button
              className={cn(
                headerIconBase,
                mergeStylexClassName("", sx.Ml3px, sx.pxPx, sx.py3px),
                open
                  ? mergeStylexClassName("", sx.textGreen, sx.hoverBgHover, sx.hoverTextGreen)
                  : mergeStylexClassName("", sx.textFaint, sx.hoverBgHover, sx.hoverTextDim),
              )}
              aria-label="Dev services"
            >
              <IconChevronDown size={16} />
            </button>
          }
        />
      </Tooltip>
    );
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div {...stylex.props(sx.relative, sx.inlineFlex, sx.itemsCenter)} ref={wrapRef}>
          {running ? (
            <Tooltip
              label={
                copied
                  ? "Link copied"
                  : "Open the running app. ⌘-click copies the link, right-click opens dev services."
              }
              side="bottom"
            >
              <a
                className={cn(headerIconBase, mergeStylexClassName("", sx.textGreen, sx.hoverBgHover, sx.hoverTextGreen))}
                href={url}
                target="_blank"
                rel="noopener"
                onContextMenu={openServices}
                onClick={(e) => {
                  // ⌘/Ctrl-click copies instead of opening (the same modifier
                  // semantics as StagingLink's globe).
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    copy(url, { toast: "Preview link copied" });
                    return;
                  }
                  // In-app tab everywhere it exists — the tab's toolbar owns
                  // the break-out; a bare anchor here opened the browser and
                  // made the button feel random (tab sometimes, window others).
                  if (onOpenTab) {
                    e.preventDefault();
                    onOpenTab();
                  }
                }}
              >
                <CopyCheck copied={copied} size={22} idle={<IconPlayOutline size={22} />} />
              </a>
            </Tooltip>
          ) : isStarting ? (
            <Tooltip
              label={stopping ? "Cancelling…" : "Starting the dev server. Click to cancel."}
              side="bottom"
            >
              <button
                className={cn(headerIconBase, mergeStylexClassName("", sx.textYellow, sx.hoverBgHover, sx.hoverTextYellow))}
                onClick={stop}
                onContextMenu={openServices}
                disabled={stopping}
              >
                <span {...stylex.props(sx.relative, sx.inlineFlex, sx.itemsCenter, sx.justifyCenter)}>
                  <span
                    {...stylex.props(sx.pointerEventsNone, sx.absolute, sx.left12, sx.top12, sx.size25px, sx.TranslateX12, sx.TranslateY12, sx.roundedFull, sx.border, sx.borderTransparent, sx.borderTCurrent, sx.opacity90, sx.animatePreviewSpin07sLinearInfinite)}
                    aria-hidden="true"
                  />
                  <IconPlayOutline size={22} />
                </span>
              </button>
            </Tooltip>
          ) : !bootable ? (
            <Tooltip label={`${notBootableHint} Right-click for details.`} side="bottom" multiline>
              <button
                className={cn(
                  headerIconBase,
                  mergeStylexClassName("", sx.cursorNotAllowed, sx.textFaint, sx.opacity45, sx.hoverBgHover, sx.hoverTextDim),
                )}
                onClick={openServices}
                onContextMenu={openServices}
                aria-disabled="true"
              >
                <IconPlayOutline size={22} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Run the dev server (right-click for dev services)" side="bottom">
              <button
                className={cn(headerIconBase, mergeStylexClassName("", sx.textFaint, sx.hoverBgHover, sx.hoverTextDim))}
                onClick={start}
                onContextMenu={openServices}
              >
                <IconPlayOutline size={22} />
              </button>
            </Tooltip>
          )}
          {menuCaret}
          {snapshotModal}
        </div>
        {servicesPopup}
      </Popover.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div {...stylex.props(sx.relative, sx.inlineFlex, sx.itemsStretch)} ref={wrapRef}>
        {running ? (
          <a
            className={cn(
              splitSegmentBase,
              mergeStylexClassName("", sx.gap15, sx.whitespaceNowrap, sx.roundedLCalc5pxVarRf, sx.px11px, sx.py5px, typography.label, sx.fontSemibold, sx.textGreen, sx.noUnderline),
              mergeStylexClassName("", sx.hoverBorderColorMixInSrgbVarGreen50Transparent, sx.hoverBgColorMixInSrgbVarGreen12Transparent, sx.hoverRelative, sx.hoverZ1, sx.hoverTextGreen),
            )}
            href={url}
            target="_blank"
            rel="noopener"
            title={`Open the webapp · ${url}`}
            onClick={(e) => {
              if (onOpenTab && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                onOpenTab();
              }
            }}
          >
            <IconPlay size={15} className={mergeStylexOverrideClassName("", sx.opacity90)} />
            Preview
            <IconArrowUpRight size={15} className={mergeStylexOverrideClassName("", sx.MlPx, sx.opacity80)} />
          </a>
        ) : isStarting ? (
          <button
            className={cn(
              splitSegmentBase,
              mergeStylexClassName("group", sx.gap15, sx.whitespaceNowrap, sx.roundedLCalc5pxVarRf, sx.px11px, sx.py5px, typography.label, sx.fontSemibold, sx.textDim),
              mergeStylexClassName("", sx.hoverBorderColorMixInSrgbVarRed40Transparent, sx.hoverBgColorMixInSrgbVarRed10Transparent, sx.cursorPointer, sx.hoverRelative, sx.hoverZ1, sx.hoverTextRed),
            )}
            onClick={stop}
            disabled={stopping}
            title="Starting the dev server (first build can take a minute). Click to cancel."
          >
            <span className={spinnerClass} />
            <span {...mergeStylexProps("group-hover:hidden", sx.inline)}>
              {stopping ? "Cancelling…" : "Starting…"}
            </span>
            <span {...mergeStylexProps("group-hover:inline", sx.hidden)}>Cancel</span>
          </button>
        ) : !bootable ? (
          <button
            className={cn(
              splitSegmentBase,
              mergeStylexClassName("", sx.gap15, sx.whitespaceNowrap, sx.roundedLCalc5pxVarRf, sx.px11px, sx.py5px, typography.label, sx.fontSemibold, sx.textDim, sx.opacity45),
              mergeStylexClassName("", sx.cursorNotAllowed),
            )}
            onClick={openServices}
            aria-disabled="true"
            title={`${notBootableHint}.`}
          >
            <IconPlay size={15} className={mergeStylexOverrideClassName("", sx.textAccent)} />
            Preview
          </button>
        ) : (
          <button
            className={cn(
              splitSegmentBase,
              mergeStylexClassName("", sx.gap15, sx.whitespaceNowrap, sx.roundedLCalc5pxVarRf, sx.px11px, sx.py5px, typography.label, sx.fontSemibold, sx.textDim),
              mergeStylexClassName("", sx.cursorPointer, sx.hoverRelative, sx.hoverZ1, sx.hoverBorderAccent, sx.hoverBgHover, sx.hoverTextFg),
            )}
            onClick={start}
            title="Start the dev server and preview this session"
          >
            <IconPlay size={15} className={mergeStylexOverrideClassName("", sx.textAccent)} />
            Preview
          </button>
        )}
        {/* Copy segment — the split's secondary action. Enabled once a previewUrl
            exists (server up + Caddy fronting it); before that there's no stable
            URL to hand out, so it sits disabled with a hint. */}
        <button
          className={cn(
            splitSegmentBase,
            mergeStylexClassName("", sx.MlPx, sx.px2, sx.py1),
            running
              ? mergeStylexClassName("", sx.textColorColorMixInSrgbVarGreen72VarTextDim, sx.hoverBorderColorMixInSrgbVarGreen50Transparent, sx.hoverBgColorMixInSrgbVarGreen12Transparent, sx.hoverRelative, sx.hoverZ1, sx.hoverTextGreen)
              : mergeStylexClassName("", sx.hoverTextAccent, sx.hoverRelative, sx.hoverZ1, sx.hoverBorderAccent, sx.hoverBgHover),
            "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:border-line-strong aria-disabled:hover:bg-transparent aria-disabled:hover:text-dim",
          )}
          onClick={() => {
            if (running) copy(url, { toast: "Preview link copied" });
          }}
          aria-disabled={!running || undefined}
          title={running ? `Copy the preview link · ${url}` : "Start the preview first"}
        >
          <CopyCheck copied={copied} size={18} idle={<IconLink size={18} />} />
        </button>
        {running && (
          <button
            className={cn(
              splitSegmentBase,
              mergeStylexClassName("", sx.textColorColorMixInSrgbVarGreen72VarTextDim, sx.MlPx, sx.px2, sx.py1),
              mergeStylexClassName("", sx.hoverBorderColorMixInSrgbVarGreen50Transparent, sx.hoverBgColorMixInSrgbVarGreen12Transparent, sx.hoverRelative, sx.hoverZ1, sx.hoverTextGreen),
            )}
            onClick={snap}
            disabled={snapping}
            title="Snapshot the preview (headless Chrome screenshot)"
          >
            {snapping ? <span className={spinnerClass} /> : <IconCamera size={18} />}
          </button>
        )}
        <Popover.Trigger
          render={
            <button
              className={cn(
                splitSegmentBase,
                mergeStylexClassName("", sx.MlPx, sx.roundedRCalc5pxVarRf, sx.px2, sx.py1),
                running
                  ? mergeStylexClassName("", sx.textColorColorMixInSrgbVarGreen72VarTextDim)
                  : mergeStylexClassName("", sx.textDim),
                open || running
                  ? mergeStylexClassName("", sx.borderColorMixInSrgbVarGreen50Transparent, sx.bgColorMixInSrgbVarGreen12Transparent, sx.relative, sx.z1, sx.textGreen)
                  : "",
                !running && mergeStylexClassName("", sx.hoverTextAccent, sx.hoverRelative, sx.hoverZ1, sx.hoverBorderAccent, sx.hoverBgHover),
                running && !open &&
                  mergeStylexClassName("", sx.hoverBorderColorMixInSrgbVarGreen50Transparent, sx.hoverBgColorMixInSrgbVarGreen12Transparent, sx.hoverRelative, sx.hoverZ1, sx.hoverTextGreen),
              )}
              title="Dev server processes"
            >
              <IconChevronDown size={16} />
            </button>
          }
        />

        {snapshotModal}
      </div>
      {servicesPopup}
    </Popover.Root>
  );
}
