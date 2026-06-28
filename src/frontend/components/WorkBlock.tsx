import React, { useState, useEffect } from "react";
import type { TranscriptEntry } from "../lib/types";
import { ToolCallBlock, parseMcpTool } from "./ToolCallBlock";

interface Props {
  items: TranscriptEntry[]; // tool_use entries, in order
  toolResults: Map<string, TranscriptEntry>;
  live: boolean; // this is the active block of a running stream
}

/** Devin-style collapsed segment: "Worked for 12s · 5 steps". */
export function WorkBlock({ items, toolResults, live }: Props) {
  // If any tool in the block returned media (image or video), keep the block
  // open so the screenshot/recording stays visible after the run finishes
  // (otherwise the user has to expand "Worked" then the tool to see what the
  // model showed them).
  const hasMedia = items.some((it) => {
    const r = it.toolUseId ? toolResults.get(it.toolUseId) : undefined;
    return (r?.images?.length ?? 0) > 0 || (r?.videos?.length ?? 0) > 0;
  });
  const [expanded, setExpanded] = useState(live || hasMedia);

  useEffect(() => {
    if (live || hasMedia) setExpanded(true);
  }, [live, hasMedia]);

  const duration = blockDuration(items, toolResults);
  const last = items[items.length - 1];

  return (
    <div className={`work-block ${live ? "work-block-live" : ""}`}>
      <button className="work-block-header" onClick={() => setExpanded(!expanded)}>
        <span className="work-block-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="work-block-title">
          {live ? "Working" : "Worked"}
          {duration ? ` for ${duration}` : ""}
        </span>
        <span className="work-block-steps">
          {items.length} step{items.length === 1 ? "" : "s"}
        </span>
        {!expanded && last && (
          <span className="work-block-preview">
            {displayToolName(last.toolName)}: {previewOf(last)}
          </span>
        )}
        {live && <span className="work-block-spinner" />}
      </button>

      {expanded && (
        <div className="work-block-body">
          {items.map((entry) => (
            <ToolCallBlock
              key={entry.id}
              entry={entry}
              result={entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function blockDuration(
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>
): string | null {
  if (items.length === 0) return null;
  const first = new Date(items[0].timestamp).getTime();
  const lastItem = items[items.length - 1];
  const lastResult = lastItem.toolUseId ? toolResults.get(lastItem.toolUseId) : undefined;
  const last = new Date((lastResult || lastItem).timestamp).getTime();
  const secs = Math.round((last - first) / 1000);
  if (!isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function displayToolName(name?: string): string {
  if (!name) return "Tool";
  const mcp = parseMcpTool(name);
  return mcp ? `${mcp.server}:${mcp.tool}` : name;
}

function previewOf(entry: TranscriptEntry): string {
  const text = entry.content || "";
  return text.length > 70 ? text.slice(0, 70) + "…" : text;
}
