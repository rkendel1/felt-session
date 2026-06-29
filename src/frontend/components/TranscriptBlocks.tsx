import React from "react";
import type { TranscriptEntry } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { WorkBlock } from "./WorkBlock";

type RenderBlock =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "work"; items: TranscriptEntry[] };

interface Props {
  entries: TranscriptEntry[];
  /** Whether the conversation is live (last work block shows a spinner / stays open). */
  live?: boolean;
  /** Assistant messages show a "Fork from here" action when provided. */
  onFork?: (entryId: string) => void;
  /** Called when a Task/Agent block's "Open sub-agent" affordance is clicked. */
  onOpenSubagent?: (agentId: string, label: string) => void;
}

/**
 * Groups a flat transcript into Devin-style work blocks (consecutive tool calls)
 * and message bubbles, then renders them. Shared by the main session view and
 * the sub-agent sidebar so both render identically.
 */
export function TranscriptBlocks({ entries, live, onFork, onOpenSubagent }: Props) {
  // Build tool_use → tool_result map
  const toolResults = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.type === "tool_result" && e.toolUseId) toolResults.set(e.toolUseId, e);
  }

  const blocks: RenderBlock[] = [];
  for (const entry of entries) {
    if (entry.type === "tool_use") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "work") last.items.push(entry);
      else blocks.push({ kind: "work", items: [entry] });
    } else if (entry.type === "tool_result") {
      continue; // rendered inside work blocks via toolResults
    } else {
      blocks.push({ kind: "entry", entry });
    }
  }

  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "work" ? (
          <WorkBlock
            key={block.items[0].id}
            items={block.items}
            toolResults={toolResults}
            live={Boolean(live) && i === blocks.length - 1}
            onOpenSubagent={onOpenSubagent}
          />
        ) : (
          <MessageBubble key={block.entry.id} entry={block.entry} onFork={onFork} />
        )
      )}
    </>
  );
}
