import type { ModelOption } from "../lib/api";
import { Menu } from "../ui/menu";
import { IconArrowDownRight } from "./icons";
import { shortModelLabel } from "./ModelEffortSelect";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
	},
	size5: {
			width: "20px",
			height: "20px"
	},
	shrink0: {
			flexShrink: "0"
	},
	maxW300px: {
			maxWidth: "300px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	pl2: {
			paddingLeft: "8px"
	},
  textFaint: { color: "var(--text-faint)" },
  chip: {
    display: "inline-flex",
    maxWidth: "220px",
    alignItems: "center",
    gap: "4px",
    borderRadius: "var(--radius-control)",
    paddingInline: "6px",
    paddingBlock: "2px",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--text-dim)",
    transitionProperty: "color, background-color",
    ":hover": { "@media (hover: hover)": { backgroundColor: "var(--hover)", color: "var(--text)" } },

		cornerShape: "var(--cs)",},
  tabularNums: { fontVariantNumeric: "tabular-nums" },
  dot: { width: "6px", height: "6px", flexShrink: 0, borderRadius: "50%",
		cornerShape: "var(--cs)",},
  bgYellow: { backgroundColor: "var(--yellow)" },
  bgLineStrong: { backgroundColor: "var(--border-strong)" },
});

/**
 * The DOWNWARD half of a session's orchestrator/executor tree: the workers this
 * session delegated to, derived by the caller from the sessions list (each
 * carries this session's id as its `parentSessionId`). Hopping down into one
 * and steering it is the whole point of making the engines interchangeable.
 *
 * The upward half is not a chip. A worker's header renders its parent as a
 * breadcrumb crumb before the title (repo > session > worker, see
 * SessionViewer), because "where am I" belongs in the path, not in a chip after
 * the name.
 */

export interface RelatedSession {
	id: string;
	title: string;
	model?: string;
	isRunning?: boolean;
}

function shortModel(
  model: string | undefined,
  models: ModelOption[],
): string | null {
	if (!model) return null;
	return shortModelLabel(model, models);
}

export function SessionRelations({
	workers,
	models,
	onOpen,
}: {
	workers?: RelatedSession[];
	models: ModelOption[];
	onOpen: (id: string) => void;
}) {
	const hasWorkers = !!workers && workers.length > 0;
	if (!hasWorkers) return null;
	const workerLabel = `${workers!.length} delegated worker${workers!.length > 1 ? "s" : ""}`;

	return (
		<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
			{hasWorkers && (
				<Menu.Root>
					{/* Count only: the arrow already says "delegated to", so the word
					    "workers" was two thirds of the chip carrying no information.
					    The glyph and the number take that room instead, and the
					    accessible name still spells it out. */}
					<Menu.Trigger
            {...mergeStylexProps("data-[popup-open]:bg-hover data-[popup-open]:text-fg", sx.chip, typography.label)}
						aria-label={workerLabel}
						title={workerLabel}
					>
						<IconArrowDownRight className={mergeStylexOverrideClassName("", sx.size5, sx.shrink0)} />
            <span {...stylex.props(sx.tabularNums)}>{workers!.length}</span>
					</Menu.Trigger>
					<Menu.Popup align="start" className={mergeStylexOverrideClassName("", sx.maxW300px)}>
						{/* GroupLabel MUST live inside a Group — bare it throws Base UI
						    error #31 and white-screens the app on open. */}
						<Menu.Group>
							<Menu.GroupLabel>Delegated workers</Menu.GroupLabel>
							{workers!.map((w) => (
								<Menu.Item key={w.id} onClick={() => onOpen(w.id)}>
									<span
                    {...stylex.props(
                      sx.dot,
                      w.isRunning ? sx.bgYellow : sx.bgLineStrong,
										)}
									/>
									<span {...stylex.props(sx.truncate)}>{w.title}</span>
									{shortModel(w.model, models) && (
                    <span
                      {...stylex.props(
                        sx.mlAuto,
                        sx.shrink0,
                        sx.pl2,
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
											{shortModel(w.model, models)}
										</span>
									)}
								</Menu.Item>
							))}
						</Menu.Group>
					</Menu.Popup>
				</Menu.Root>
			)}
		</div>
	);
}
