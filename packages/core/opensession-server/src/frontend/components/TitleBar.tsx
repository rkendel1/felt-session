import { useEffect } from "react";
import { IconChevronLeft, IconChevronRight, IconSearch } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { matchesShortcut } from "../lib/shortcuts";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexProps, mergeStylexClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	inlineFlex: {
			display: "inline-flex"
	},
	size30px: {
			width: "30px",
			height: "30px"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	borderNone: {
			borderStyle: "none"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	p0: {
			padding: "0"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	AppRegionNoDrag: {
			appRegion: "no-drag"
	},
	phoneHidden: {
		display: {
			default: null,
			"@media (max-width: 720px)": "none",
		},
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
	WebkitAppRegionNoDrag: {
		"WebkitAppRegion": "no-drag"
	},
});

/**
 * Back/forward cluster for Window Controls Overlay mode.
 *
 * When the app runs as the Open Session desktop shell or an installed desktop PWA with
 * `display_override: window-controls-overlay`, the OS titlebar collapses to
 * just the window-control buttons overlaid on our own content — which also
 * takes the browser's back/forward buttons with it. There is no dedicated
 * titlebar band: the window's first content row is the titlebar (drag regions
 * + traffic-light inset live in the `html.wco` rules in base.css). The
 * cluster carries the in-app back/forward, wired to the same history the
 * router drives (pushState / popstate), and sits at the right edge of the
 * sidebar's top chrome row. The `pane` variant is a floating fallback in the
 * detail pane, shown only while the sidebar is collapsed (its row — and the
 * primary cluster with it — is display:none then). Rendered always but
 * `display:none` outside WCO — the class is set by the WCO detection script
 * in index.html, which also covers the Electron desktop shell where the
 * display-mode media query never matches.
 */
export function TitleBar({
	pane,
	onSearch,
}: {
	pane?: boolean;
	onSearch?: () => void;
}) {
	const commandMenuKeys = useShortcutKeys("command-menu");
	const backKeys = useShortcutKeys("history-back");
	const forwardKeys = useShortcutKeys("history-forward");

	useEffect(() => {
		// App renders a second, pane-positioned copy for a collapsed sidebar. The
		// primary instance owns the listener so one keypress moves one history entry.
		if (pane) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (matchesShortcut(event, "history-back")) {
				event.preventDefault();
				history.back();
				return;
			}
			if (matchesShortcut(event, "history-forward")) {
				event.preventDefault();
				history.forward();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [pane]);

	return (
		<div
			{...mergeStylexProps(pane ? "wco-nav wco-nav-pane" : "wco-nav", sx.phoneHidden)}
		>
			<Tooltip label="Back" side="bottom" shortcut={backKeys ?? undefined}>
				<button {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.WebkitAppRegionNoDrag, sx.inlineFlex, sx.size30px, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.borderNone, sx.bgTransparent, sx.p0, sx.textDim, sx.AppRegionNoDrag)}
					onClick={() => history.back()}
					aria-label="Back"
				>
					<IconChevronLeft size={24} />
				</button>
			</Tooltip>
			<Tooltip label="Forward" side="bottom" shortcut={forwardKeys ?? undefined}>
				<button {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.WebkitAppRegionNoDrag, sx.inlineFlex, sx.size30px, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.borderNone, sx.bgTransparent, sx.p0, sx.textDim, sx.AppRegionNoDrag)}
					onClick={() => history.forward()}
					aria-label="Forward"
				>
					<IconChevronRight size={24} />
				</button>
			</Tooltip>
			{onSearch && (
				<Tooltip label="Command menu" side="bottom" shortcut={commandMenuKeys ?? undefined}>
					<button {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.WebkitAppRegionNoDrag, sx.inlineFlex, sx.size30px, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.borderNone, sx.bgTransparent, sx.p0, sx.textDim, sx.AppRegionNoDrag)}
						onClick={onSearch}
						aria-label="Open command menu"
					>
						<IconSearch size={24} />
					</button>
				</Tooltip>
			)}
		</div>
	);
}
