import React from "react";
import type { SessionWalkthrough, TranscriptEntry } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { TurnBlock } from "./TurnBlock";
import { TurnFooter, collectTouchedFiles, type TouchedFile } from "./TurnFooter";
import { VirtualTranscriptBlock } from "./VirtualTranscriptBlock";
import { WalkthroughCard } from "./WalkthroughCard";
import { walkthroughInsertIndex } from "./walkthrough-placement";

type RenderBlock =
	| { kind: "entry"; entry: TranscriptEntry }
	| { kind: "turn"; items: TranscriptEntry[] }
	| {
			kind: "footer";
			entry: TranscriptEntry;
			durationMs: number;
			files: TouchedFile[];
	  }
	| { kind: "walkthrough"; walkthrough: SessionWalkthrough };

interface Props {
	entries: TranscriptEntry[];
	/** Whether the conversation is live (last work block shows a spinner / stays open). */
	live?: boolean;
	/** Assistant messages show a "Fork from here" action when provided. */
	onFork?: (entryId: string) => void;
	/** Called when a Task/Agent block's "Open sub-agent" affordance is clicked. */
	onOpenSubagent?: (agentId: string, label: string) => void;
	/** Session owner (startedBy) — credited on un-attributed user turns. */
	owner?: string;
	/** Lets wire-clamped entries' "Show full message" fetch the full content. */
	sessionId?: string;
	/** Agent-published walkthrough — rendered inline where it was published.
	 *  Pass a referentially stable object (see SessionViewer) so the memo holds. */
	walkthrough?: SessionWalkthrough;
}

/**
 * Groups a flat transcript into per-turn fold blocks and message bubbles, then
 * renders them. A turn's working (tool calls + intermediate assistant notes)
 * folds into one collapsed TurnBlock; only the turn's final answer stays out
 * as a normal bubble — so the session reads question → answer, calm by default.
 * Shared by the main session view and the sub-agent sidebar so both render
 * identically.
 */
// Memoized: the transcript is expensive to render (markdown parsing + code
// highlighting across every bubble/work block), and unrelated SessionViewer
// re-renders — most notably toggling the workspace panel on/off — would
// otherwise re-render the whole thing synchronously and stall the interaction.
// With stable props (entries reference unchanged, callbacks memoized upstream)
// this bails out entirely on a panel toggle. See SessionViewer's useCallbacks.
export const TranscriptBlocks = React.memo(function TranscriptBlocks({
	entries,
	live,
	onFork,
	onOpenSubagent,
	owner,
	sessionId,
	walkthrough,
}: Props) {
	// Build tool_use → tool_result map
	const toolResults = new Map<string, TranscriptEntry>();
	for (const e of entries) {
		if (e.type === "tool_result" && e.toolUseId)
			toolResults.set(e.toolUseId, e);
	}

	const blocks: RenderBlock[] = [];
	// The current assistant turn: consecutive assistant/tool_use entries between
	// user/system boundaries, accumulated then flushed as one fold.
	let turn: TranscriptEntry[] = [];

	const flushTurn = (trailing = false) => {
		if (turn.length === 0) return;
		const last = turn[turn.length - 1];
		const final = last.type === "assistant" ? last : null;
		if (!turn.some((e) => e.type === "tool_use")) {
			// Plain answer(s), nothing to fold.
			for (const e of turn) blocks.push({ kind: "entry", entry: e });
		} else {
			// The turn's final answer (when it ended with one) stays visible;
			// everything before it folds. A turn still mid-tools folds entirely.
			const folded = final ? turn.slice(0, -1) : turn;
			if (folded.length > 0) blocks.push({ kind: "turn", items: folded });
			if (final) blocks.push({ kind: "entry", entry: final });
		}
		// Meta row under the settled turn's final answer: duration, copy / ⋯
		// actions, per-file edit chips. The live trailing turn skips it — its
		// footer appears when the run finishes.
		if (final && !(live && trailing)) {
			blocks.push({
				kind: "footer",
				entry: final,
				durationMs:
					new Date(final.timestamp).getTime() -
					new Date(turn[0].timestamp).getTime(),
				files: collectTouchedFiles(turn),
			});
		}
		turn = [];
	};

	for (const entry of entries) {
		if (entry.type === "tool_result") {
			continue; // rendered inside turn blocks via toolResults
		} else if (entry.type === "assistant" || entry.type === "tool_use") {
			turn.push(entry);
		} else {
			flushTurn();
			blocks.push({ kind: "entry", entry });
		}
	}
	flushTurn(true);

	if (walkthrough)
		blocks.splice(walkthroughInsertIndex(blocks, walkthrough.publishedAt), 0, {
			kind: "walkthrough",
			walkthrough,
		});

	return (
		<>
			{blocks.map((block, i) => {
				const key =
					block.kind === "turn"
						? block.items[0].id
						: block.kind === "walkthrough"
							? "walkthrough"
							: block.kind === "footer"
								? `${block.entry.id}:footer`
								: block.entry.id;
				const anchorId =
					block.kind === "turn"
						? `${block.items[block.items.length - 1].id}#turn`
						: key;
				// While streaming, flushTurn splits trailing assistant text out as
				// its own block after the fold, so the live turn alternates between
				// being last and second-to-last as text and tool calls interleave —
				// a turn fold directly before the tail is still the live turn.
				const isLiveTail =
					Boolean(live) &&
					(i === blocks.length - 1 ||
						(block.kind === "turn" && i === blocks.length - 2));
				const content =
					block.kind === "turn" ? (
					<TurnBlock
						items={block.items}
						toolResults={toolResults}
						live={isLiveTail}
						onOpenSubagent={onOpenSubagent}
						sessionId={sessionId}
					/>
				) : block.kind === "walkthrough" ? (
					<WalkthroughCard walkthrough={block.walkthrough} variant="session" />
				) : block.kind === "footer" ? (
					<TurnFooter
						entry={block.entry}
						durationMs={block.durationMs}
						files={block.files}
						onFork={onFork}
					/>
				) : (
					<MessageBubble
						entry={block.entry}
						owner={owner}
						sessionId={sessionId}
					/>
				);
				return (
					<VirtualTranscriptBlock
						key={key}
						anchorId={anchorId}
						enabled={!isLiveTail && i < blocks.length - 24}
					>
						{content}
					</VirtualTranscriptBlock>
				);
			})}
		</>
	);
});
