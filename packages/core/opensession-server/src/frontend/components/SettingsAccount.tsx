import React from "react";
import { SETTINGS_NAV_ICON, SETTINGS_NAV_ROW } from "../lib/settings-classes";
import { SIDEBAR_HOVER_LAYER, SIDEBAR_RAIL_GAP } from "../lib/sidebar-classes";
import { Menu } from "../ui/menu";
import { IconCheck, IconChevronRight, IconLogOut } from "./icons";
import {
	TEAM,
	setCurrentUser,
	signOut,
	useAuthStatus,
	useCurrentUser,
} from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	shrink0: {
			flexShrink: "0"
	},
	flex: {
			display: "flex"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap05: {
			gap: "2px"
	},
	textLeft: {
			textAlign: "left"
	},
	leadingTight: {
			lineHeight: "var(--leading-tight)"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	sticky: {
			position: "sticky"
	},
	bottom0: {
			bottom: "0"
	},
	Mx3: {
			marginInline: "-12px"
	},
	Mb4: {
			marginBottom: "-16px"
	},
	mtAuto: {
			marginTop: "auto"
	},
	borderX0: {
			borderInlineStyle: "solid",
			borderInlineWidth: "0"
	},
	borderB0: {
			borderBottomStyle: "solid",
			borderBottomWidth: "0"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	borderSolid: {
			borderStyle: "solid"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	bgSidebar: {
			backgroundColor: "var(--sidebar-bg)"
	},
	px15: {
			paddingInline: "6px"
	},
	pb4: {
			paddingBottom: "16px"
	},
	pt3: {
			paddingTop: "12px"
	},
	minW200px: {
			minWidth: "200px"
	},
	gap9px: {
			gap: "9px"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px2: {
			paddingInline: "8px"
	},
	py15: {
			paddingBlock: "6px"
	},
	mb2: {
			marginBottom: "8px"
	},
	mt5: {
			marginTop: "20px"
	},
	px1: {
			paddingInline: "4px"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderDividerSoft: {
			borderColor: "var(--divider-soft)"
	},
	bgSettingsPlate: {
			backgroundColor: "var(--settings-plate)"
	},
	textAccent: {
			color: "var(--accent-ink)"
	},
	h7: {
			height: "28px"
	},
	w7: {
			width: "28px"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	textDim: {
			color: "var(--text-dim)"
	},

	pyVarSidebarRowPad: {
		"paddingBlock": "var(--sidebar-row-pad)"
	},
	pl25: {
		"paddingLeft": "10px"
	},
	pr2: {
		"paddingRight": "8px"
	},
	wFull: {
		"width": "100%"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},

	relative: {
		"position": "relative"
	},
	gap3: {
		"gap": "12px"
	},
	border0: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "0"
	},
	px35: {
		"paddingInline": "14px"
	},
	py3: {
		"paddingBlock": "12px"
	},
	afterAbsolute: {
		"::after": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	afterBottom0: {
		"::after": {
			"content": "var(--tw-content)",
			"bottom": "0"
		}
	},
	afterLeft54px: {
		"::after": {
			"content": "var(--tw-content)",
			"left": "54px"
		}
	},
	afterRight0: {
		"::after": {
			"content": "var(--tw-content)",
			"right": "0"
		}
	},
	afterHPx: {
		"::after": {
			"content": "var(--tw-content)",
			"height": "1px"
		}
	},
	afterBgDividerSoft: {
		"::after": {
			"content": "var(--tw-content)",
			"backgroundColor": "var(--divider-soft)"
		}
	},
	activeBgHover: {
		":active": {
			"backgroundColor": "var(--hover)"
		}
	},
});

// The account lives at the bottom of Settings: who your sessions act as, and
// the way out. Two shapes for the two Settings layouts — a footer pinned under
// the desktop sub-nav, and a last card in the phone sheet's root list.
//
// Two identity modes, same as everywhere else in the app: with GitHub sign-in
// the server decides who you are (nothing to switch, just a way out), without
// it the local "Acting as" name picker applies.

function useAccount() {
	const currentUser = useCurrentUser();
	const auth = useAuthStatus();
	// GitHub sign-in active ⇒ identity is server-verified, no account switcher.
	const githubAuth = auth?.required && auth.authenticated ? auth : null;
	return {
		currentUser,
		githubAuth,
		canSignOut: !!githubAuth,
		subtitle: githubAuth
			? githubAuth.login
				? `Signed in with GitHub · @${githubAuth.login}`
				: "Signed in with GitHub"
			: "Acting as",
	};
}

/** Avatar · name · how that name was decided. */
function AccountIdentity({
	name,
	subtitle,
}: {
	name: string;
	subtitle: string;
}) {
	return (
		<>
			<UserAvatar name={name} size={28} className={mergeStylexOverrideClassName("", sx.shrink0)} />
			<span {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.flexCol, sx.gap05, sx.textLeft, sx.leadingTight)}>
				<span {...stylex.props(sx.truncate, sx.fontSemibold, sx.textFg, typography.label)}>{name}</span>
				<span {...stylex.props(sx.truncate, sx.fontMedium, sx.textFaint, typography.meta)}>
					{subtitle}
				</span>
			</span>
		</>
	);
}

/** Desktop: pinned to the bottom of the settings sub-nav. */
export function SettingsAccountFooter() {
	const { currentUser, githubAuth, canSignOut, subtitle } = useAccount();

	return (
		// Sticky so it stays reachable once the section list outgrows the nav
		// (the negative margins cover the nav's own padding as rows scroll under).
		// It carries the nav's own surface, not a raised one: the block is the
		// bottom of that column, not a bar laid across it. Its 6px gutter is the
		// list's outdent spelled forwards, so the account row and Sign out sit on
		// the same rail as the sections above them.
		<div {...stylex.props(sx.sticky, sx.bottom0, sx.Mx3, sx.Mb4, sx.mtAuto, sx.flex, sx.flexCol, sx.borderX0, sx.borderB0, sx.borderT, sx.borderSolid, sx.borderDivider, sx.bgSidebar, sx.px15, sx.pb4, sx.pt3)}>
			{githubAuth ? (
				<div className={[mergeStylexClassName("", sx.flex, sx.itemsCenter), SIDEBAR_RAIL_GAP, mergeStylexClassName("", sx.pyVarSidebarRowPad, sx.pl25, sx.pr2)].filter(Boolean).join(" ")}>
					<AccountIdentity name={currentUser} subtitle={subtitle} />
				</div>
			) : (
				<Menu.Root>
					<Menu.Trigger
						aria-label="Switch account"
						className={[mergeStylexClassName("", sx.flex, sx.wFull, sx.minW0, sx.itemsCenter), SIDEBAR_RAIL_GAP, mergeStylexClassName("data-[popup-open]:bg-selected", sx.roundedRow, sx.borderNone, sx.bgTransparent, sx.pyVarSidebarRowPad, sx.pl25, sx.pr2, sx.textLeft), SIDEBAR_HOVER_LAYER].filter(Boolean).join(" ")}
					>
						<AccountIdentity name={currentUser} subtitle={subtitle} />
						<IconChevronRight size={20} className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)} />
					</Menu.Trigger>
					{/* The trigger sits at the very bottom — open upward. */}
					<Menu.Popup side="top" align="start" sideOffset={8} className={mergeStylexOverrideClassName("", sx.minW200px)}>
						<Menu.RadioGroup
							value={currentUser}
							onValueChange={(value) => setCurrentUser(String(value))}
						>
							{TEAM.map((name) => (
								<Menu.RadioItem
									key={name}
									value={name}
									closeOnClick
									className={mergeStylexOverrideClassName("", sx.gap9px, sx.roundedSm, sx.px2, sx.py15)}
								>
									<UserAvatar name={name} size={22} />
									<span {...stylex.props(sx.minW0, sx.flex1, sx.fontMedium)}>{name}</span>
									<Menu.Check on={name === currentUser} />
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Root>
			)}
			{canSignOut && (
				<button className={SETTINGS_NAV_ROW} onClick={() => void signOut()}>
					<span className={SETTINGS_NAV_ICON}>
						<IconLogOut />
					</span>
					Sign out
				</button>
			)}
		</div>
	);
}

/** Phone: the last card in the settings sheet's root list. */
export function SettingsAccountCard() {
	const { currentUser, githubAuth, canSignOut, subtitle } = useAccount();
	const rowClass =
		mergeStylexClassName("last:after:hidden", sx.relative, sx.flex, sx.wFull, sx.itemsCenter, sx.gap3, sx.border0, sx.bgTransparent, sx.px35, sx.py3, sx.textLeft, sx.afterAbsolute, sx.afterBottom0, sx.afterLeft54px, sx.afterRight0, sx.afterHPx, sx.afterBgDividerSoft, sx.activeBgHover);

	return (
		<div>
			<div {...stylex.props(sx.mb2, sx.mt5, sx.px1, sx.fontSemibold, sx.textFaint, typography.controlLabel)}>
				Account
			</div>
			<div {...stylex.props(sx.overflowHidden, sx.rounded2xl, sx.border, sx.borderDividerSoft, sx.bgSettingsPlate)}>
				{githubAuth ? (
					<div className={rowClass}>
						<AccountIdentity name={currentUser} subtitle={subtitle} />
					</div>
				) : (
					TEAM.map((name) => (
						<button
							key={name}
							className={rowClass}
							onClick={() => setCurrentUser(name)}
						>
							<UserAvatar name={name} size={28} className={mergeStylexOverrideClassName("", sx.shrink0)} />
							<span {...stylex.props(sx.minW0, sx.flex1, sx.fontMedium, sx.textFg, typography.itemTitle)}>
								{name}
							</span>
							{name === currentUser && (
								<IconCheck size={22} className={mergeStylexOverrideClassName("", sx.shrink0, sx.textAccent)} />
							)}
						</button>
					))
				)}
				{canSignOut && (
					<button className={rowClass} onClick={() => void signOut()}>
						<span {...stylex.props(sx.flex, sx.h7, sx.w7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textDim)}>
							<IconLogOut size={20} />
						</span>
						<span {...stylex.props(sx.minW0, sx.flex1, sx.fontMedium, sx.textFg, typography.itemTitle)}>
							Sign out
						</span>
					</button>
				)}
			</div>
		</div>
	);
}
