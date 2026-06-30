import React, { useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";

interface Props {
	tabs: UnifiedSession[];
	activeId: string | null;
	/** IDs of sessions that are pinned; the rest are transient (current route only). */
	pinnedIds: Set<string>;
	/** Map of session id → swatch key for tabs the user has colored. */
	colors: Record<string, string>;
	onSelect: (session: UnifiedSession) => void;
	onTogglePin: (id: string) => void;
	/** Set a tab's color (swatch key), or clear it with `null`. */
	onSetColor: (id: string, color: string | null) => void;
	/** Jump to the New Session view (the reveal-on-hover "+" tab). */
	onNewSession: () => void;
}

/** Open swatch menu: which session, and where to anchor it (viewport coords). */
type Menu = { id: string; x: number; y: number };

/**
 * Horizontal strip of session tabs above the session title, on every view.
 * Pinned tabs persist (the pins store — star on Home, or the ★ in the session
 * header). The currently-open session also shows as a *transient* tab even when
 * unpinned: like Chrome, it closes as soon as you navigate away. Clicking the
 * ☆ on a transient tab promotes it to a pinned one; the ★ on a pinned tab
 * unpins (removing the tab). Hovering the strip also reveals a trailing "+"
 * tab that jumps straight to the New Session view.
 *
 * Right-clicking a tab opens a swatch menu to color it (a per-user view
 * preference, synced across devices like pins) — handy for telling a row of
 * lookalike tabs apart at a glance.
 */
export function SessionTabs({
	tabs,
	activeId,
	pinnedIds,
	colors,
	onSelect,
	onTogglePin,
	onSetColor,
	onNewSession,
}: Props) {
	const [menu, setMenu] = useState<Menu | null>(null);

	// Dismiss the swatch menu on any outside click, scroll, or Escape.
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	if (tabs.length === 0) return null;

	return (
		<div className="session-tabs" role="tablist">
			{tabs.map((s) => {
				const pinned = pinnedIds.has(s.id);
				const waiting = !!s.waitingForInput;
				const hex = colorHex(colors[s.id]);
				return (
					<div
						key={s.id}
						role="tab"
						aria-selected={s.id === activeId}
						className={`session-tab ${s.id === activeId ? "session-tab-active" : ""} ${
							pinned ? "" : "session-tab-transient"
						} ${waiting ? "session-tab-waiting" : ""} ${hex ? "session-tab-colored" : ""}`}
						style={
							hex ? ({ "--tab-color": hex } as React.CSSProperties) : undefined
						}
						onClick={() => onSelect(s)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ id: s.id, x: e.clientX, y: e.clientY });
						}}
						title={waiting ? `${s.title} — waiting for your input` : s.title}
					>
						{waiting ? (
							<span className="session-tab-dot session-tab-dot-waiting" />
						) : (
							s.isRunning && <span className="session-tab-dot" />
						)}
						<span className="session-tab-title">{s.title}</span>
						<span
							className={`session-tab-pin ${pinned ? "session-tab-pin-on" : ""}`}
							role="button"
							aria-label={pinned ? "Unpin (remove tab)" : "Pin tab"}
							title={pinned ? "Unpin" : "Pin tab"}
							onClick={(e) => {
								e.stopPropagation();
								onTogglePin(s.id);
							}}
						>
							{pinned ? "★" : "☆"}
						</span>
					</div>
				);
			})}
			<button
				type="button"
				className="session-tab session-tab-new"
				aria-label="New session"
				title="New session"
				onClick={onNewSession}
			>
				+
			</button>

			{menu && (
				<div
					className="tab-color-menu"
					style={{ left: menu.x, top: menu.y }}
					// Keep clicks inside the menu from bubbling to the window-level closer.
					onClick={(e) => e.stopPropagation()}
				>
					{TAB_COLORS.map((c) => (
						<button
							key={c.key}
							type="button"
							className={`tab-color-swatch ${colors[menu.id] === c.key ? "tab-color-swatch-on" : ""}`}
							style={{ background: c.hex }}
							aria-label={c.label}
							title={c.label}
							onClick={() => {
								onSetColor(menu.id, c.key);
								setMenu(null);
							}}
						/>
					))}
					<button
						type="button"
						className="tab-color-swatch tab-color-swatch-none"
						aria-label="No color"
						title="No color"
						onClick={() => {
							onSetColor(menu.id, null);
							setMenu(null);
						}}
					/>
				</div>
			)}
		</div>
	);
}
