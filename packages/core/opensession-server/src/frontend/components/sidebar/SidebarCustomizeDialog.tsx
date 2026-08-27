import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { Reorder } from "motion/react";
import { useIsPhone } from "../../hooks/useIsPhone";
import type { SidebarToolId } from "../../lib/sidebar-tools";
import { Modal } from "../../ui/modal";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import { IconGripVertical, IconX } from "../icons";
import { RepoTile, repoLabel } from "../RepoTile";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../../ui/cn";
import { sharedClassStyles } from "../../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	Mx2: {
			marginInline: "-8px"
	},
	m0: {
			margin: "0"
	},
	mb15: {
			marginBottom: "6px"
	},
	px2: {
			paddingInline: "8px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	py4: {
			paddingBlock: "16px"
	},
	p05: {
			padding: "2px"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	flex: {
			display: "flex"
	},
	minH9: {
			minHeight: "36px"
	},
	cursorGrab: {
			cursor: "grab"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px15: {
			paddingInline: "6px"
	},
	py15: {
			paddingBlock: "6px"
	},
	textFg: {
			color: "var(--text)"
	},
	size5: {
			width: "20px",
			height: "20px"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	textDim: {
			color: "var(--text-dim)"
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
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	gap3: {
			gap: "12px"
	},
	px6: {
			paddingInline: "24px"
	},
	pb4: {
			paddingBottom: "16px"
	},
	pt05: {
			paddingTop: "2px"
	},
	leadingTight: {
			lineHeight: "var(--leading-tight)"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap5: {
			gap: "20px"
	},
	pb6: {
			paddingBottom: "24px"
	},
	maxH80dvh: {
			maxHeight: "80dvh"
	},

	phoneAfterAbsolute: {
		"@media (max-width: 720px)": {
			"::after": {
				"content": "var(--tw-content)",
				"position": "absolute"
			}
		}
	},
	phoneAfterInsetX0: {
		"@media (max-width: 720px)": {
			"::after": {
				"content": "var(--tw-content)",
				"insetInline": "0"
			}
		}
	},
	phoneAfterInsetY3: {
		"@media (max-width: 720px)": {
			"::after": {
				"content": "var(--tw-content)",
				"insetBlock": "-12px"
			}
		}
	},
	phoneAfterContent: {
		"@media (max-width: 720px)": {
			"::after": {
				"--tw-content": "\"\"",
				"content": "var(--tw-content)"
			}
		}
	},

	phoneBgSettingsPlate: {
		"@media (max-width: 720px)": {
			"backgroundColor": "var(--settings-plate)"
		}
	},
	selectNone: {
		"WebkitUserSelect": "none",
		"userSelect": "none"
	},
	activeCursorGrabbing: {
		":active": {
			"cursor": "grabbing"
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
});

type OrderItem<T extends string> = {
	id: T;
	label: string;
	icon: React.ReactNode;
	action?: React.ReactNode;
};

function OrderSection<T extends string>({
	label,
	items,
	onCommit,
}: {
	label: string;
	items: OrderItem<T>[];
	onCommit: (order: T[]) => void;
}) {
	const signature = items.map((item) => item.id).join("\u0000");
	const [order, setOrder] = useState<T[]>(() => items.map((item) => item.id));
	const orderRef = useRef(order);
	const committedRef = useRef(signature);
	const [announcement, setAnnouncement] = useState("");

	const resyncFromItems = useEffectEvent(() => {
		const next = items.map((item) => item.id);
		setOrder(next);
		orderRef.current = next;
		committedRef.current = signature;
	});
	useEffect(() => {
		resyncFromItems();
	}, [signature]);

	const byId = new Map(items.map((item) => [item.id, item]));

	function setDraft(next: T[]) {
		orderRef.current = next;
		setOrder(next);
	}

	function commit() {
		const next = orderRef.current;
		const nextSignature = next.join("\u0000");
		if (nextSignature === committedRef.current) return;
		committedRef.current = nextSignature;
		onCommit(next);
	}

	function move(id: T, offset: number) {
		const next = [...orderRef.current];
		const from = next.indexOf(id);
		const to = Math.max(0, Math.min(next.length - 1, from + offset));
		if (from < 0 || from === to) return;
		next.splice(from, 1);
		next.splice(to, 0, id);
		setDraft(next);
		committedRef.current = next.join("\u0000");
		onCommit(next);
		setAnnouncement(`${byId.get(id)?.label ?? id} moved to position ${to + 1}`);
	}

	return (
		<section
			{...stylex.props(sx.Mx2)}
			aria-labelledby={`sidebar-order-${label.toLowerCase()}`}
		>
			<h3
				id={`sidebar-order-${label.toLowerCase()}`}
				{...stylex.props(sx.m0, sx.mb15, sx.px2, sx.fontSemibold, sx.textFaint, typography.label)}
			>
				{label}
			</h3>
			{order.length === 0 ? (
				// Left-aligned like the rows it stands in for.
				<p {...mergeStylexProps("", sx.phoneBgSettingsPlate, sx.m0, sx.roundedLg, sx.bgPanel, sx.px2, sx.py4, sx.textFaint, typography.label)}>
					No {label.toLowerCase()} available.
				</p>
			) : (
				<Reorder.Group
					as="div"
					axis="y"
					values={order}
					onReorder={setDraft} {...mergeStylexProps("", sx.phoneBgSettingsPlate, sx.roundedLg, sx.bgPanel, sx.p05)}
					role="list"
				>
					{order.map((id, index) => {
						const item = byId.get(id);
						if (!item) return null;
						return (
							<Reorder.Item
								as="div"
								key={id}
								value={id}
								onDragEnd={commit}
								whileDrag={{ scale: 1.015, zIndex: 2 }} {...mergeStylexProps("group", sx.selectNone, sx.activeCursorGrabbing, sx.hoverBgHover, sx.phoneMinH11, sx.phoneBgSettingsPlate, sx.focusRing, sx.flex, sx.minH9, sx.cursorGrab, sx.itemsCenter, sx.gap2, sx.roundedControl, sx.bgPanel, sx.px15, sx.py15, sx.textFg, typography.itemTitle)}
								role="listitem"
								tabIndex={0}
								aria-label={`${item.label}, position ${index + 1} of ${order.length}. Use the up and down arrow keys to move it.`}
								onKeyDown={(event) => {
									if (event.target !== event.currentTarget) return;
									if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
									event.preventDefault();
									move(id, event.key === "ArrowUp" ? -1 : 1);
								}}
							>
								<span {...mergeStylexProps("group-hover:text-dim", sx.flex, sx.size5, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textFaint)}>
									<IconGripVertical size={18} />
								</span>
								{/* Shared geometry keeps every tool and repository label
								    on the same vertical line. */}
								<span {...mergeStylexProps("[&_svg]:size-[20px]", sx.flex, sx.size5, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textDim)}>
									{item.icon}
								</span>
								<span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>{item.label}</span>
								{item.action && (
									<span
										{...stylex.props(sx.shrink0)}
										onPointerDown={(event) => event.stopPropagation()}
									>
										{item.action}
									</span>
								)}
							</Reorder.Item>
						);
					})}
				</Reorder.Group>
			)}
			<div {...stylex.props(sx.srOnly)} aria-live="polite">
				{announcement}
			</div>
		</section>
	);
}

export function SidebarCustomizeDialog({
	open,
	onOpenChange,
	tools,
	repositories,
	onToolOrderChange,
	onRepositoryOrderChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	tools: Array<
		OrderItem<SidebarToolId> & {
			shown: boolean;
			onShownChange: (shown: boolean) => void;
		}
	>;
	repositories: string[];
	onToolOrderChange: (order: SidebarToolId[]) => void;
	onRepositoryOrderChange: (order: string[]) => void;
}) {
	const isPhone = useIsPhone();
	const sections = (
		<>
			<OrderSection
				label="Tools"
				items={tools.map((tool) => ({
					...tool,
					action: (
						<Switch
							size="sm"
							className={mergeStylexOverrideClassName("", sx.phoneAfterAbsolute, sx.phoneAfterInsetX0, sx.phoneAfterInsetY3, sx.phoneAfterContent)}
							checked={tool.shown}
							onCheckedChange={tool.onShownChange}
							aria-label={`${tool.shown ? "Hide" : "Show"} ${tool.label} in sidebar`}
						/>
					),
				}))}
				onCommit={onToolOrderChange}
			/>
			<OrderSection
				label="Repositories"
				items={repositories.map((repo) => ({
					id: repo,
					label: repoLabel(repo),
					icon: <RepoTile name={repo} size={20} />,
				}))}
				onCommit={onRepositoryOrderChange}
			/>
		</>
	);

	if (isPhone) {
		return (
			<ResponsiveDialog
				open={open}
				onClose={() => onOpenChange(false)}
				phone
				label="Customize sidebar"
				sheetClassName={mergeStylexClassName("", sharedClassStyles.maxH88dvh)}
			>
				<div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap3, sx.px6, sx.pb4, sx.pt05)}>
					<h2 {...stylex.props(sx.m0, sx.minW0, sx.flex1, sx.fontSemibold, sx.leadingTight, sx.tracking001em, sx.textFg, typography.dialogTitle)}>
						Customize sidebar
					</h2>
					<SheetIconButton
						aria-label="Close"
						onClick={() => onOpenChange(false)}
					>
						<IconX />
					</SheetIconButton>
				</div>
				<SheetBody className={mergeStylexOverrideClassName("", sx.flex, sx.flex1, sx.flexCol, sx.gap5, sx.px6, sx.pb6)}>
					{sections}
				</SheetBody>
			</ResponsiveDialog>
		);
	}

	return (
		<Modal.Root open={open} onOpenChange={onOpenChange}>
			<Modal.Content
				widthClassName={mergeStylexClassName("", sharedClassStyles.maxW32rem)}
				className={mergeStylexOverrideClassName("", sx.maxH80dvh, sx.gap3)}
			>
				<Modal.Header title="Customize sidebar" />
				{sections}
			</Modal.Content>
		</Modal.Root>
	);
}
