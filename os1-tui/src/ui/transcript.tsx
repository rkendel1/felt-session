/**
 * The transcript pane: committed entries, the in-flight stream, queued chips
 * and the AskUserQuestion card.
 *
 * `stickyScroll` + `stickyStart: "bottom"` is what makes a streaming turn feel
 * right — the view follows new output but stops following the moment the user
 * scrolls up (scroll mode), which is the same intent model the web client uses.
 */

import { TextAttributes } from "@opentui/core";
import type { ReactNode, Ref } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { SessionState } from "../client/session-store";
import type { AskQuestion, QueueItem, Session } from "../client/types";
import { formatEntries, sessionSubtitle } from "./format";
import { SPINNER, theme } from "./theme";

export type TranscriptProps = {
	session?: Session;
	state: SessionState;
	focused: boolean;
	scrollMode: boolean;
	spinnerFrame: number;
	connection: "connecting" | "open" | "retrying";
	scrollRef?: Ref<ScrollBoxRenderable>;
	/** Cap on rendered entries — a 10k-entry transcript needn't all be live. */
	maxEntries?: number;
};

/** How many entries we keep as renderables. Older ones stay a `^b [ b` away. */
const DEFAULT_MAX_ENTRIES = 200;

function QueueChips({ queued, steered }: { queued: QueueItem[]; steered: QueueItem[] }) {
	if (!queued.length && !steered.length) return null;
	return (
		<box flexDirection="column" paddingLeft={1} paddingTop={1}>
			{steered.map((item) => (
				<text key={item.id} fg={theme.purple} truncate>
					⚡ {item.content.split("\n")[0]}
				</text>
			))}
			{queued.map((item, index) => (
				<text key={item.id} fg={theme.yellow} truncate>
					{index + 1}. queued: {item.content.split("\n")[0]}
				</text>
			))}
		</box>
	);
}

function AskCard({ ask }: { ask: AskQuestion }) {
	const question = ask.questions[0];
	if (!question) return null;
	return (
		<box
			flexDirection="column"
			border
			borderColor={theme.yellow}
			paddingLeft={1}
			paddingRight={1}
			marginTop={1}
			title={question.header ?? "needs you"}
		>
			<text fg={theme.fg} wrapMode="word" attributes={TextAttributes.BOLD}>
				{question.question}
			</text>
			{(question.options ?? []).map((option, index) => (
				<text key={`${index}-${option.label}`} fg={theme.dim} wrapMode="word">
					<span fg={theme.yellow}>{index + 1}</span> {option.label}
					{option.description ? <span fg={theme.faint}> — {option.description}</span> : null}
				</text>
			))}
			<text fg={theme.faint}>press a number · i to answer in your own words</text>
		</box>
	);
}

export function Transcript({
	session,
	state,
	focused,
	scrollMode,
	spinnerFrame,
	connection,
	scrollRef,
	maxEntries = DEFAULT_MAX_ENTRIES,
}: TranscriptProps) {
	const all = formatEntries(state.entries);
	const shown = all.length > maxEntries ? all.slice(-maxEntries) : all;
	const hidden = all.length - shown.length;

	const rows: ReactNode[] = [];

	if (state.truncated || hidden > 0) {
		rows.push(
			<text key="earlier" fg={theme.faint} paddingLeft={1}>
				── earlier history {hidden > 0 ? `(${hidden} more loaded) ` : ""}· ^b [ then b to
				load ──
			</text>,
		);
	}

	for (const entry of shown) {
		const color =
			entry.kind === "user"
				? theme.blue
				: entry.error
					? theme.red
					: entry.kind === "tool"
						? theme.faint
						: theme.fg;
		rows.push(
			<box key={entry.id} flexDirection="column" paddingLeft={1} paddingTop={entry.kind === "tool" ? 0 : 1}>
				{entry.kind === "tool" ? (
					<text fg={color} truncate>
						<span fg={entry.error ? theme.red : theme.purple}>{entry.prefix}</span>
						{entry.body ? ` ${entry.body}` : ""}
					</text>
				) : (
					<text fg={color} wrapMode="word">
						{entry.prefix ? `${entry.prefix} ` : ""}
						{entry.body}
						{entry.clamped ? <span fg={theme.faint}> …(clamped)</span> : null}
					</text>
				)}
			</box>,
		);
	}

	if (state.streamText) {
		rows.push(
			<box key="stream" flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.fg} wrapMode="word">
					{state.streamText}
					<span fg={theme.blue}>▌</span>
				</text>
			</box>,
		);
	} else if (state.isRunning) {
		rows.push(
			<text key="working" fg={theme.blue} paddingLeft={1} paddingTop={1}>
				{SPINNER[spinnerFrame % SPINNER.length]} working…
			</text>,
		);
	}

	if (state.ask) rows.push(<AskCard key="ask" ask={state.ask} />);
	rows.push(
		<QueueChips key="queue" queued={state.queued} steered={state.steered} />,
	);

	if (!session) {
		return (
			<box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
				<text fg={theme.dim}>no session open</text>
				<text fg={theme.faint}>↑/↓ to pick one · enter to open · ^b ? for keys</text>
			</box>
		);
	}

	const title = session.title?.trim() || session.branch || session.id.slice(0, 12);
	const bottom = scrollMode
		? " SCROLL — q exits, b loads earlier "
		: connection === "open"
			? undefined
			: ` ${connection === "retrying" ? "reconnecting…" : "connecting…"} `;

	return (
		<box flexGrow={1} flexDirection="column" minWidth={20}>
			<box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={theme.panel}>
				<text fg={theme.fg} attributes={TextAttributes.BOLD} flexGrow={1} truncate>
					{title}
				</text>
				<text fg={theme.faint} truncate>
					{sessionSubtitle(session)}
				</text>
			</box>
			<scrollbox
				ref={scrollRef}
				flexGrow={1}
				focused={focused}
				stickyScroll={!scrollMode}
				stickyStart="bottom"
				borderColor={focused ? theme.borderStrong : theme.border}
				bottomTitle={bottom}
				contentOptions={{ flexDirection: "column" }}
			>
				{state.loaded ? (
					rows
				) : (
					<text fg={theme.faint} paddingLeft={1}>
						loading transcript…
					</text>
				)}
			</scrollbox>
			{state.error ? (
				<text fg={theme.red} paddingLeft={1} wrapMode="word">
					{state.error}
				</text>
			) : null}
		</box>
	);
}
