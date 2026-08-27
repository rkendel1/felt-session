import * as React from "react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { PageDescription, PageHeader, PageTitle } from "./page-header";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	Mt15: {
			marginTop: "-6px"
	},
	mb18px: {
			marginBottom: "18px"
	},
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap25: {
			gap: "10px"
	},
	minH0: {
			minHeight: "0"
	},
	wFull: {
			width: "100%"
	},
	flex1: {
			flex: "1"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	mxAuto: {
			marginInline: "auto"
	},
	px6: {
			paddingInline: "24px"
	},
	pb60px: {
			paddingBottom: "60px"
	},
	pt7: {
			paddingTop: "28px"
	},

	max560pxPx35: {
		"@media not all and (min-width: 560px)": {
			"paddingInline": "14px"
		}
	},
	max560pxPb12: {
		"@media not all and (min-width: 560px)": {
			"paddingBottom": "48px"
		}
	},
	max560pxPt18px: {
		"@media not all and (min-width: 560px)": {
			"paddingTop": "18px"
		}
	},
	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},

	maxW760px: {
		"maxWidth": "760px"
	},
	maxW860px: {
		"maxWidth": "860px"
	},
	maxW920px: {
		"maxWidth": "920px"
	},
	maxWNone: {
		"maxWidth": "none"
	},
});

export type PageContentWidth = "narrow" | "default" | "wide" | "full";

const contentWidths: Record<PageContentWidth, string> = {
	narrow: mergeStylexClassName("", sx.maxW760px),
	default: mergeStylexClassName("", sx.maxW860px),
	wide: mergeStylexClassName("", sx.maxW920px),
	full: mergeStylexClassName("", sx.maxWNone),
};

interface PageLayoutProps extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	filters?: React.ReactNode;
	contentWidth?: PageContentWidth;
}

export function PageLayout({
	title,
	description,
	actions,
	filters,
	contentWidth = "default",
	className,
	children,
	...props
}: PageLayoutProps) {
	return (
		<div
			// The scroller the app's top bar watches, so it can reveal the compact
			// title once this page has travelled under it. Read by App.tsx through
			// hooks/useScrollEdge.ts; it styles nothing.
			data-page-scroll {...mergeStylexProps(cn(className), sx.minH0, sx.wFull, sx.flex1, sx.overflowYAuto)}
			{...props}
		>
			<div {...mergeStylexProps(cn(mergeStylexClassName("", sx.max560pxPx35, sx.max560pxPb12, sx.max560pxPt18px), contentWidths[contentWidth]), sx.mxAuto, sx.wFull, sx.px6, sx.pb60px, sx.pt7)}
			>
				<PageHeader>
					<div>
						<PageTitle>{title}</PageTitle>
						{description !== undefined && (
							<PageDescription>{description}</PageDescription>
						)}
					</div>
					{actions !== undefined && (
						<div className={mergeStylexClassName("", sx.phoneWFull)}>{actions}</div>
					)}
				</PageHeader>
				{filters !== undefined && (
					<div {...stylex.props(sx.Mt15, sx.mb18px, sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap25)}>
						{filters}
					</div>
				)}
				{children}
			</div>
		</div>
	);
}

interface PageSectionProps extends React.ComponentPropsWithoutRef<"div"> {
	contentWidth?: PageContentWidth;
}

export function PageSection({
	contentWidth = "default",
	className,
	...props
}: PageSectionProps) {
	return <div {...mergeStylexProps(cn(contentWidths[contentWidth], className), sx.mxAuto, sx.wFull)} {...props} />;
}
