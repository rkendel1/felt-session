/**
 * The `^b ?` overlay. Rows come from KEY_HELP so the keymap, this overlay and
 * the README can't drift apart.
 */

import { TextAttributes } from "@opentui/core";
import { KEY_HELP } from "./keymap";
import { theme } from "./theme";

export function Help({ height }: { height: number }) {
	// Two columns once there's no room to stack; the list is ~22 rows.
	const twoUp = height < KEY_HELP.length + 6;
	const half = Math.ceil(KEY_HELP.length / 2);
	const columns = twoUp ? [KEY_HELP.slice(0, half), KEY_HELP.slice(half)] : [KEY_HELP];

	return (
		<box
			position="absolute"
			left={2}
			right={2}
			top={1}
			bottom={2}
			border
			borderColor={theme.accent}
			backgroundColor={theme.panel}
			title=" keys "
			bottomTitle=" any key closes "
			flexDirection="row"
			zIndex={20}
			paddingLeft={1}
			paddingRight={1}
		>
			{columns.map((column, index) => (
				<box key={index} flexDirection="column" flexGrow={1}>
					{column.map((row) => (
						<box key={row.keys} flexDirection="row">
							<text fg={theme.fg} attributes={TextAttributes.BOLD} width={18} truncate>
								{row.keys}
							</text>
							<text fg={theme.dim} flexGrow={1} truncate>
								{row.label}
							</text>
						</box>
					))}
				</box>
			))}
		</box>
	);
}
