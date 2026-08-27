import * as stylex from "@stylexjs/stylex";
import type { AssetViewMode } from "../lib/asset-view-mode";
import { cn } from "../ui/cn";
import { IconViewGrid, IconViewList } from "./icons";

const sx = stylex.create({
	root: {
		display: "flex",
		flexShrink: 0,
		alignItems: "center",
		gap: "1px",
		opacity: 0,
		transitionProperty: "opacity",
		transitionDuration: "150ms",
		":focus-within": { opacity: 1 },
		"@media (max-width: 720px)": { opacity: 1 },
	},
	button: {
		display: "grid",
		width: "20px",
		height: "20px",
		placeItems: "center",
		borderRadius: "var(--radius-control)",
		transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
		transitionDuration: "150ms",
		":focus-visible": {
			outline: "2px solid var(--accent-ink)",
			outlineOffset: "2px",
		},

		cornerShape: "var(--cs)",},
	active: {
		backgroundColor: "var(--hover)",
		color: "var(--text)",
	},
	inactive: {
		color: "var(--text-faint)",
		":hover": { "@media (hover: hover)": { color: "var(--text-dim)" } },
	},
});

const OPTIONS = [
	{ mode: "preview" as const, label: "Show previews", icon: IconViewGrid },
	{ mode: "list" as const, label: "Show as list", icon: IconViewList },
];

/**
 * Pictures or rows, for the two places a session's assets are shown: the
 * workspace summary card and the Workspace panel.
 *
 * It rides in the Assets heading and waits for a hover, because the answer is
 * usually already right: captures want the pictures, a folder of reports wants
 * the names. A control standing up permanently would make a decision out of
 * something most people never touch, in a heading whose job is to label the
 * band under it. Focus brings it back for the keyboard, and a touch client has
 * no hover to wait for, so there it stays up.
 *
 * The parent heading carries `group/assets`; this is what the hover is read
 * from, so the whole heading is the target rather than the 40px the two
 * buttons occupy.
 */
export function AssetViewToggle({
	mode,
	onChange,
	className,
}: {
	mode: AssetViewMode;
	onChange: (mode: AssetViewMode) => void;
	className?: string;
}) {
	return (
		<span
			className={cn(
				stylex.props(sx.root).className,
				"group-hover/assets:opacity-100",
				className,
			)}
		>
			{OPTIONS.map((option) => {
				const active = option.mode === mode;
				return (
					<button
						key={option.mode}
						type="button"
						aria-pressed={active}
						aria-label={option.label}
						title={option.label}
						onClick={(event) => {
							// Both headings sit in surfaces where a click means "open what
							// this row is about", so the toggle keeps its click.
							event.stopPropagation();
							onChange(option.mode);
						}}
						{...stylex.props(sx.button, active ? sx.active : sx.inactive)}
					>
						<option.icon size={16} />
					</button>
				);
			})}
		</span>
	);
}
