/**
 * The composer, plus the two overlays that borrow it (command prompt, picker).
 *
 * Keys are routed through the same `resolveKey` the app uses — the textarea's
 * own `onKeyDown` fires before its default insert, so a consumed key gets
 * `preventDefault()` and never lands as text. That's why there's exactly one
 * keymap in this app and not one per focus target.
 */

import { TextAttributes, type KeyEvent, type TextareaRenderable } from "@opentui/core";
import type { Ref } from "react";
import { theme } from "./theme";

export type ComposerProps = {
	focused: boolean;
	busy: boolean;
	/** Queued count, so the hint can say what enter will do. */
	queuedCount: number;
	placeholder: string;
	onKeyDown: (key: KeyEvent) => void;
	inputRef?: Ref<TextareaRenderable>;
	/** Non-empty while the session's workspace is still being created. */
	notice?: string;
};

export function Composer({
	focused,
	busy,
	queuedCount,
	placeholder,
	onKeyDown,
	inputRef,
	notice,
}: ComposerProps) {
	const hint = busy
		? "enter queues · ctrl+enter steers · ^b x cancels"
		: queuedCount
			? `${queuedCount} queued · enter sends`
			: "enter sends · ^b ? keys";

	return (
		<box
			flexDirection="column"
			border={["top"]}
			borderColor={focused ? theme.borderStrong : theme.border}
			flexShrink={0}
		>
			{notice ? (
				<text fg={theme.yellow} paddingLeft={1}>
					{notice}
				</text>
			) : null}
			<box flexDirection="row" paddingLeft={1} paddingRight={1}>
				<text fg={focused ? theme.accent : theme.faint}>{focused ? "› " : "  "}</text>
				<textarea
					ref={inputRef}
					focused={focused}
					placeholder={placeholder}
					onKeyDown={onKeyDown}
					flexGrow={1}
					maxHeight={6}
				/>
			</box>
			<box flexDirection="row" paddingLeft={1} paddingRight={1}>
				<text fg={theme.faint} flexGrow={1}>
					{hint}
				</text>
			</box>
		</box>
	);
}

export type PromptOverlayProps = {
	title: string;
	value: string;
	hint?: string;
	rows?: { label: string; detail?: string; selected: boolean }[];
	inputRef?: Ref<TextareaRenderable>;
	onKeyDown: (key: KeyEvent) => void;
};

/**
 * One overlay shape for the command prompt, the session picker, rename and the
 * new-session prompt — they differ only in title and whether they list rows.
 */
export function PromptOverlay({
	title,
	value,
	hint,
	rows,
	inputRef,
	onKeyDown,
}: PromptOverlayProps) {
	return (
		<box
			position="absolute"
			left={4}
			right={4}
			top={3}
			border
			borderColor={theme.accent}
			backgroundColor={theme.panel}
			flexDirection="column"
			title={` ${title} `}
			zIndex={10}
			paddingLeft={1}
			paddingRight={1}
		>
			<box flexDirection="row">
				<text fg={theme.accent}>› </text>
				<textarea
					ref={inputRef}
					focused
					onKeyDown={onKeyDown}
					flexGrow={1}
					maxHeight={2}
				/>
			</box>
			{rows?.length ? (
				<box flexDirection="column" paddingTop={1}>
					{rows.slice(0, 10).map((row, index) => (
						<box
							key={`${index}-${row.label}`}
							flexDirection="row"
							backgroundColor={row.selected ? theme.active : undefined}
						>
							<text
								fg={row.selected ? theme.fg : theme.dim}
								attributes={row.selected ? TextAttributes.BOLD : undefined}
								flexGrow={1}
								truncate
							>
								{row.label}
							</text>
							{row.detail ? (
								<text fg={theme.faint} truncate>
									{row.detail}
								</text>
							) : null}
						</box>
					))}
				</box>
			) : null}
			{hint ? <text fg={theme.faint}>{hint}</text> : null}
		</box>
	);
}
