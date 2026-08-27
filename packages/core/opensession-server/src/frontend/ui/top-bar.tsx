import * as React from "react";
import {
	MOBILE_BACK,
	MOBILE_TOP_BAR_CONTROL,
} from "../lib/app-header-classes";
import { IconChevronLeft } from "../components/icons";
import { Button, type ButtonProps } from "./button";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { type as typography } from "../styles/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minW0: {
			minWidth: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	shrink0: {
			flexShrink: "0"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)",
		"--settings-leading": "1.1"
	},
	textFg: {
			color: "var(--text)"
	},
	size11: {
			width: "44px",
			height: "44px"
	},
	minH11: {
			minHeight: "44px"
	},
	touchManipulation: {
			touchAction: "manipulation"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	p0: {
			padding: "0"
	},
	textDim: {
			color: "var(--text-dim)"
	},

	phoneRelative: {
		"@media (max-width: 720px)": {
			"position": "relative"
		}
	},
	phoneH11: {
		"@media (max-width: 720px)": {
			"height": "44px"
		}
	},
	phoneShrink0: {
		"@media (max-width: 720px)": {
			"flexShrink": "0"
		}
	},
	phoneJustifyCenter: {
		"@media (max-width: 720px)": {
			"justifyContent": "center"
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	shadowNone: {
		"--tw-shadow": "0 0 transparent",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	hoverBgPressed: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover-strong)"
			}
		}
	},
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
});

/**
 * Shared application top-bar structure. Feature bars keep their own position,
 * height and surface while using the same leading, title and action slots.
 */
type TopBarProps = React.HTMLAttributes<HTMLElement> & {
	as?: "div" | "header";
};

export const TopBar = React.forwardRef<HTMLElement, TopBarProps>(function TopBar(
	{ as = "div", className, ...props },
	ref,
) {
	return React.createElement(as, {
		ref,
		"data-top-bar": "",
		className: cn(mergeStylexClassName("", sx.flex, sx.minW0, sx.itemsCenter), className),
		...props,
	});
});

export const TopBarLeading = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<"div">
>(function TopBarLeading({ className, ...props }, ref) {
	return (
		<div
			ref={ref} {...mergeStylexProps(cn(className), sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}
			{...props}
		/>
	);
});

export const TopBarTitle = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<"div">
>(function TopBarTitle({ className, ...props }, ref) {
	return <div ref={ref} {...mergeStylexProps(cn(className), sx.minW0)} {...props} />;
});

export const TopBarActions = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<"div">
>(function TopBarActions({ className, ...props }, ref) {
	return (
		<div
			ref={ref} {...mergeStylexProps(cn(className), sx.mlAuto, sx.flex, sx.shrink0, sx.itemsCenter)}
			{...props}
		/>
	);
});

/**
 * Phone navigation row shared by full-screen pages and sheets. Position and
 * surface stay with the feature; its 44px rhythm and centred title do not.
 */
export const PhoneTopBar = React.forwardRef<
	HTMLElement,
	Omit<TopBarProps, "as">
>(
	function PhoneTopBar({ className, ...props }, ref) {
		return (
			<TopBar
				as="header"
				ref={ref}
				className={cn(
					mergeStylexClassName("", sx.phoneRelative, sx.phoneH11, sx.phoneShrink0, sx.phoneJustifyCenter, sx.phonePx3),
					className,
				)}
				{...props}
			/>
		);
	},
);

export const PhoneTopBarTitle = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<"div">
>(function PhoneTopBarTitle({ className, ...props }, ref) {
	return (
		<TopBarTitle
			ref={ref} {...mergeStylexProps(cn(className), typography.body, sx.fontTitle, sx.textFg)}
			{...props}
		/>
	);
});

/** The quiet 44px disc used for Back, Close and secondary phone actions. */
export const PhoneTopBarAction = React.forwardRef<
	HTMLButtonElement,
	Omit<ButtonProps, "children">
>(function PhoneTopBarAction({ className, ...props }, ref) {
	return (
		<Button
			ref={ref}
			variant="ghost"
			size="md" {...mergeStylexProps(cn(mergeStylexClassName("[&_svg]:size-6", sx.shadowNone, sx.hoverBgPressed, sx.activeScale096), className), sx.size11, sx.minH11, sx.shrink0, sx.touchManipulation, sx.roundedFull, sx.bgPanel, sx.p0, sx.textDim)}
			{...props}
		/>
	);
});

type TopBarActionProps = Omit<ButtonProps, "children"> & {
	icon: React.ReactNode;
	floating?: boolean;
};

export const TopBarAction = React.forwardRef<HTMLButtonElement, TopBarActionProps>(
	function TopBarAction({ className, floating = false, ...props }, ref) {
		return (
			<Button
				ref={ref}
				variant="ghost"
				size="md"
				className={cn(floating && MOBILE_TOP_BAR_CONTROL, className)}
				{...props}
			/>
		);
	},
);

type TopBarBackProps = Omit<ButtonProps, "children" | "icon"> & {
	"aria-label": string;
	floating?: boolean;
	iconSize?: number;
};

export const TopBarBack = React.forwardRef<HTMLButtonElement, TopBarBackProps>(
	function TopBarBack(
		{ className, floating = false, iconSize = 22, ...props },
		ref,
	) {
		return (
			<Button
				ref={ref}
				variant="ghost"
				size="md"
				icon={<IconChevronLeft size={iconSize} />}
				className={cn(floating && MOBILE_BACK, className)}
				{...props}
			/>
		);
	},
);
