import React, { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { getCurrentUser } from "./UserPicker";
import { DeskConversation } from "./DeskConversation";
import { ResponsiveDialog } from "../ui/sheet";
import { IconDesk, IconExpand, IconX } from "./icons";
import { Button } from "../ui/button";

/**
 * The Desk — a summonable overlay (⌘J / the floating desk button) on top of
 * whatever you're doing. It is a standing concierge session for quick asks
 * and kicking off work without leaving the current view.
 *
 * Persistence is the point: after the first summon the body STAYS MOUNTED
 * (hidden, not unmounted) — the chat's scoped socket keeps watching, so every
 * later ⌘J is instant with the transcript already in place. No enter/exit
 * animations
 * either; summon-dismiss-summon should feel like toggling a HUD.
 *
 * The chat is a normal durable session (desk: true, hidden from the session
 * lists) pinned to a fast model+effort server-side; "Clear" sets a display
 * marker (server-stored) so the modal starts visually fresh while the full
 * transcript stays in the expanded session view.
 */

interface DeskOverlayProps {
	open: boolean;
	onClose: () => void;
	phone: boolean;
	/** Open the Desk session in the full viewer. */
	onOpenSession: (sessionId: string) => void;
}

function DeskBody({
	active,
	phone,
	onClose,
	onOpenSession,
}: Omit<DeskOverlayProps, "open"> & { active: boolean }) {
	const user = getCurrentUser();
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [clearedAt, setClearedAt] = useState<string | undefined>(undefined);
	const [ensureError, setEnsureError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// One-time boot (the body stays mounted after the first summon): resolve
	// the standing Desk session + the clear marker.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`${BASE_PATH}/api/desk/ensure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ user }),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as {
					sessionId: string;
					clearedAt: string | null;
				};
				if (cancelled) return;
				setSessionId(data.sessionId);
				if (data.clearedAt) setClearedAt(data.clearedAt);
			} catch (e: any) {
				if (!cancelled) setEnsureError(e?.message || "Failed to open the Desk");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [user]);

	// On summon: drop the caret straight into the composer (desktop — a phone
	// keyboard popping open unasked is hostile).
	useEffect(() => {
		if (!active || phone) return;
		const ta = rootRef.current?.querySelector("textarea");
		(ta as HTMLTextAreaElement | null)?.focus();
	}, [active, phone]);

	async function clearChat() {
		try {
			const res = await fetch(`${BASE_PATH}/api/desk/clear`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user }),
			});
			const data = (await res.json()) as { clearedAt?: string };
			if (data.clearedAt) setClearedAt(data.clearedAt);
		} catch {}
	}

	return (
		// flex-1 rather than h-full: on phone the sheet's drag grabber is a
		// sibling above us, so we take the remainder instead of the whole panel.
		<div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
			{/* Header */}
			<div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-2.5">
				<IconDesk size={22} className="text-dim" />
				<span className="min-w-0 flex-1 truncate text-item-title font-semibold text-fg">
					Desk
				</span>
				<Button
					variant="ghost"
					size="xs"
					className="shrink-0 text-faint"
					onClick={clearChat}
					title="Clear the chat here — the full transcript stays in the expanded session"
				>
					Clear
				</Button>
				{sessionId && (
					<Button
						variant="ghost"
						size="xs"
						className="min-h-0 shrink-0 rounded-md border-0 p-1 font-medium text-faint hover:bg-surface hover:text-fg"
						onClick={() => {
							onClose();
							onOpenSession(sessionId);
						}}
						title="Open as a full session"
					>
						<IconExpand size={20} />
					</Button>
				)}
				<Button
					variant="ghost"
					size="xs"
					className="min-h-0 shrink-0 rounded-md border-0 p-1 font-medium text-faint hover:bg-surface hover:text-fg"
					onClick={onClose}
					aria-label="Close"
				>
					<IconX size={20} />
				</Button>
			</div>

			{/* Concierge chat */}
			<div className="min-h-0 flex-1">
				{ensureError ? (
					<div className="px-4 py-6 text-center text-[13px] font-medium text-dim">
						{ensureError}
					</div>
				) : sessionId ? (
					<DeskConversation
						sessionId={sessionId}
						effort="low"
						hideBefore={clearedAt}
						placeholder="Ask your Desk…"
						emptyState={
							<>
								Ask a quick question or kick off a session without leaving what
								you're working on.
							</>
						}
					/>
				) : (
					<div className="px-4 py-6 text-center text-[13px] font-medium text-dim">
						Opening…
					</div>
				)}
			</div>
		</div>
	);
}

export function DeskOverlay({
	open,
	onClose,
	phone,
	onOpenSession,
}: DeskOverlayProps) {
	return (
		<ResponsiveDialog
			open={open}
			onClose={onClose}
			phone={phone}
			label="Desk"
			// The body stays mounted after the first summon — see the module doc.
			keepMounted
			// ⌘J is a HUD toggle, not a dialog: summon-dismiss-summon stays
			// instant on desktop. The phone sheet animates like every other
			// sheet, so its drag-to-dismiss has something to follow.
			desktopTransition="none"
			// bg-raised on both breakpoints, overriding the sheet's bg-surface:
			// the Desk's controls are recessed bg-surface inputs, which would
			// dissolve into a bg-surface panel.
			sheetClassName="h-[85dvh] bg-raised"
			modalClassName="h-[540px] max-h-[80vh] max-w-[560px]"
		>
			<DeskBody
				active={open}
				phone={phone}
				onClose={onClose}
				onOpenSession={onOpenSession}
			/>
		</ResponsiveDialog>
	);
}
