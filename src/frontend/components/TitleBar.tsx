import { IconChevronLeft, IconChevronRight, IconSearch } from "./icons";
import { Tooltip } from "../ui/tooltip";

/**
 * Back/forward cluster for Window Controls Overlay mode.
 *
 * When the app runs as the OS¹ desktop shell or an installed desktop PWA with
 * `display_override: window-controls-overlay`, the OS titlebar collapses to
 * just the window-control buttons overlaid on our own content — which also
 * takes the browser's back/forward buttons with it. There is no dedicated
 * titlebar band: the window's first content row is the titlebar (drag regions
 * + traffic-light inset live in the `html.wco` rules in global.css). The
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
	const navClassName = pane
		? "wco-nav wco-nav-pane absolute top-[calc((var(--desktop-header-h)-30px)/2)] left-[50px] z-20 items-center gap-0.5 [html.wco_&]:left-[calc(env(titlebar-area-x,78px)+42px)] [html.wco_&]:[-webkit-app-region:no-drag] [html.wco_&]:[app-region:no-drag]"
		: "wco-nav ml-auto hidden items-center gap-0.5 [html.wco_&]:flex";
	const buttonClassName =
		"wco-nav-btn inline-flex size-[30px] items-center justify-center rounded-[calc(8px*var(--rf))] border-0 bg-transparent p-0 text-dim cursor-pointer [corner-shape:var(--cs)] [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-hover hover:text-fg";

	return (
		<div className={navClassName}>
			<Tooltip label="Back" side="bottom">
				<button
					className={buttonClassName}
					onClick={() => history.back()}
					aria-label="Back"
				>
					<IconChevronLeft size={24} />
				</button>
			</Tooltip>
			<Tooltip label="Forward" side="bottom">
				<button
					className={buttonClassName}
					onClick={() => history.forward()}
					aria-label="Forward"
				>
					<IconChevronRight size={24} />
				</button>
			</Tooltip>
			{onSearch && (
				<Tooltip label="Command menu" side="bottom" shortcut={["⌘", "K"]}>
					<button
						className={buttonClassName}
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
