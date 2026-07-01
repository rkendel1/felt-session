import React, { useEffect, useRef, useState } from "react";
import { TEAM, setCurrentUser, useCurrentUser } from "./UserPicker";

// The dropdown behind the "Michael" title in the top bar — the "Michael menu". It
// holds the account switcher (who you're acting as), the live connection status,
// and an entry into the full Settings page (theme, notifications, …). Appearance
// and other preferences live in Settings now, not inline here.

export function SettingsMenu({
	onOpenSettings,
	connected,
}: {
	onOpenSettings?: () => void;
	connected?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [actingOpen, setActingOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	const currentUser = useCurrentUser();

	// Dismiss on outside click / Escape while open.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Collapse the acting-as submenu whenever the whole menu closes.
	useEffect(() => {
		if (!open) setActingOpen(false);
	}, [open]);

	return (
		<div className="settings-menu" ref={ref}>
			<button
				className={`settings-trigger ${open ? "active" : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-label="Settings"
				aria-haspopup="menu"
				aria-expanded={open}
			>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<path
						d="M2 3.5L5 6.5L8 3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open && (
				<div className="settings-dropdown" role="menu">
					<div
						className="settings-section settings-submenu"
						onMouseEnter={() => setActingOpen(true)}
						onMouseLeave={() => setActingOpen(false)}
					>
						<button
							className={`settings-menu-item settings-submenu-trigger${
								actingOpen ? " active" : ""
							}`}
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={actingOpen}
							onClick={() => setActingOpen((v) => !v)}
						>
							<span className="settings-user-avatar active">
								{currentUser.charAt(0).toUpperCase()}
							</span>
							<span className="settings-submenu-label">
								<span className="settings-submenu-title">Acting as</span>
								<span className="settings-submenu-value">{currentUser}</span>
							</span>
							<svg
								className="settings-submenu-chevron"
								width="10"
								height="10"
								viewBox="0 0 10 10"
								aria-hidden="true"
							>
								<path
									d="M3.5 2L6.5 5L3.5 8"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</button>
						{actingOpen && (
							<div className="settings-submenu-panel" role="menu">
								<div className="settings-user-list">
									{TEAM.map((name) => (
										<button
											key={name}
											className={`settings-user-item${
												name === currentUser ? " active" : ""
											}`}
											role="menuitemradio"
											aria-checked={name === currentUser}
											onClick={() => {
											setCurrentUser(name);
											setActingOpen(false);
											setOpen(false);
										}}
										>
											<span className="settings-user-avatar">
												{name.charAt(0).toUpperCase()}
											</span>
											<span className="settings-user-name">{name}</span>
											{name === currentUser && (
												<svg
													className="settings-user-check"
													width="13"
													height="13"
													viewBox="0 0 16 16"
													fill="none"
												>
													<path
														d="M3.5 8.5l3 3 6-7"
														stroke="currentColor"
														strokeWidth="1.6"
														strokeLinecap="round"
														strokeLinejoin="round"
													/>
												</svg>
											)}
										</button>
									))}
								</div>
							</div>
						)}
					</div>

					<div className="settings-section">
						<div className="settings-status-row">
							<span
								className={`connection-dot ${
									connected ? "connected" : "disconnected"
								}`}
							/>
							{connected ? "Connected" : "Reconnecting…"}
						</div>
					</div>

					<div className="settings-section">
					<button
						className="settings-menu-item"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							onOpenSettings?.();
						}}
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
							<path
								d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
							/>
						</svg>
						Settings
					</button>
					</div>
				</div>
			)}
		</div>
	);
}
