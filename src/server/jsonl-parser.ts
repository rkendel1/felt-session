import { readFileSync, statSync } from "fs";
import { existsSync } from "fs";
import type { TranscriptEntry } from "./types";
import { SLACK_ID_TO_NAME } from "./shared/user-mappings";

const SLACK_USERS = SLACK_ID_TO_NAME;

const SLACK_CHANNELS: Record<string, string> = {
  C0AFQ7PV057: "michael-tinker",
  C01ED50A2KG: "chat",
  C0A77HH0XPT: "design-polish",
  C047JD2KX8B: "engineering",
  C099PSZ8D5M: "michael-log",
};

const SLACK_WORKSPACE = "tella-team";

function resolveSlackIds(text: string): string {
  // Replace <@USERID> with **Name**
  text = text.replace(/<@(U[A-Z0-9]+)>/g, (_match, id) => {
    const name = SLACK_USERS[id];
    return name ? `**@${name}**` : `@${id}`;
  });
  // Replace [USERID]: at start of lines with **Name**:
  text = text.replace(/\[(U[A-Z0-9]+)\]:/g, (_match, id) => {
    const name = SLACK_USERS[id];
    return name ? `**${name}**:` : `[${id}]:`;
  });
  // Replace <#CHANNELID|name> or <#CHANNELID> channel references
  text = text.replace(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id, name) => {
    const channelName = name || SLACK_CHANNELS[id] || id;
    return `[#${channelName}](https://app.slack.com/client/T8VB51YAR/${id})`;
  });
  // Ensure --- separators have blank lines around them (prevents setext heading)
  text = text.replace(/([^\n])\n---(\n)/g, "$1\n\n---$2");
  text = text.replace(/\n---\n([^\n])/g, "\n---\n\n$1");
  return text;
}

interface RawJsonlEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  // Harness-injected user lines (skill bodies, command output) — not typed by the user
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: any;
  };
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("\n");
  }
  return "";
}

/** Pull renderable image srcs out of content blocks (base64 → data URL, or a
 *  direct url). Covers Read-of-image tool results and pasted images. */
function extractImages(content: any): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (b?.type !== "image" || !b.source) continue;
    const src = b.source;
    if (src.type === "base64" && src.media_type && src.data) {
      out.push(`data:${src.media_type};base64,${src.data}`);
    } else if (src.type === "url" && src.url) {
      out.push(src.url);
    }
  }
  return out;
}

// Tools can't return video blocks (unlike Read-of-image), so a tool that
// produces a video prints `BACKSTAGE_VIDEO: <abs-path>` and we turn each marker
// into a /backstage/media URL the frontend streams. Used by tella-local rec.mjs.
const VIDEO_MARKER = /^\s*BACKSTAGE_VIDEO:\s*(\/\S+)\s*$/gm;

function extractVideos(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(VIDEO_MARKER)) {
    out.push(`/backstage/media?path=${encodeURIComponent(m[1])}`);
  }
  return out;
}

/**
 * Harness-injected user turns (not typed by a person). Task notifications get
 * a system line built from their <summary>; system-reminders are dropped.
 */
function harnessEntryFor(text: string, ts: string): TranscriptEntry[] | null {
  const t = text.trimStart();
  if (t.startsWith("<task-notification>")) {
    const summary = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    const status = t.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    return [{
      id: crypto.randomUUID(),
      type: "system",
      content: summary
        ? `Background task ${status || "update"}: ${summary}`
        : `Background task ${status || "update"}`,
      timestamp: ts,
    }];
  }
  if (t.startsWith("<system-reminder>")) return [];
  return null;
}

function parseEntry(raw: RawJsonlEntry): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  if (!raw.message?.content) return entries;

  const ts = raw.timestamp || new Date().toISOString();

  if (raw.type === "user") {
    const content = raw.message.content;

    // Check for tool_result blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          const images = extractImages(block.content);
          const videos = extractVideos(resultText);
          entries.push({
            // Keyed on the tool_use id: one jsonl line can carry several
            // tool_result blocks (parallel calls), and the live-stream copy
            // of the same result must upsert rather than duplicate.
            id: block.tool_use_id ? `tr-${block.tool_use_id}` : raw.uuid || crypto.randomUUID(),
            type: "tool_result",
            content: resultText,
            timestamp: ts,
            toolUseId: block.tool_use_id,
            ...(images.length > 0 ? { images } : {}),
            ...(videos.length > 0 ? { videos } : {}),
          });
        } else if (block.type === "text" && !raw.isMeta) {
          const harness = harnessEntryFor(block.text || "", ts);
          if (harness) {
            entries.push(...harness);
            continue;
          }
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "user",
            content: resolveSlackIds(block.text),
            timestamp: ts,
          });
        }
      }

      // Images pasted into a user message ride alongside its text blocks
      const pastedImages = extractImages(content);
      if (pastedImages.length > 0) {
        const lastUser = [...entries].reverse().find((e) => e.type === "user");
        if (lastUser) {
          lastUser.images = [...(lastUser.images || []), ...pastedImages];
        } else {
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "user",
            content: "",
            timestamp: ts,
            images: pastedImages,
          });
        }
      }
    } else if (!raw.isMeta) {
      const text = extractText(content);
      if (text) {
        const harness = harnessEntryFor(text, ts);
        if (harness) {
          entries.push(...harness);
        } else {
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "user",
            content: resolveSlackIds(text),
            timestamp: ts,
          });
        }
      }
    }
  }

  if (raw.type === "assistant") {
    const content = raw.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "assistant",
            content: block.text,
            timestamp: ts,
            requestId: raw.requestId,
          });
        }
        if (block.type === "tool_use") {
          entries.push({
            id: block.id || crypto.randomUUID(),
            type: "tool_use",
            content: summarizeToolUse(block.name, block.input),
            timestamp: ts,
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            requestId: raw.requestId,
          });
        }
      }
    } else {
      const text = extractText(content);
      if (text) {
        entries.push({
          id: raw.uuid || crypto.randomUUID(),
          type: "assistant",
          content: text,
          timestamp: ts,
          requestId: raw.requestId,
        });
      }
    }
  }

  return entries;
}

function summarizeToolUse(name: string, input: any): string {
  if (!input) return `Using ${name}`;
  switch (name) {
    case "Read":
      return `Read ${input.file_path || "file"}`;
    case "Edit":
      return `Edit ${input.file_path || "file"}`;
    case "Write":
      return `Write ${input.file_path || "file"}`;
    case "Bash":
      return `$ ${(input.command || "").split("\n")[0].slice(0, 80)}`;
    case "Grep":
      return `Grep: ${input.pattern || ""} ${input.glob || ""}`;
    case "Glob":
      return `Glob: ${input.pattern || ""}`;
    case "WebFetch":
      return `Fetch ${input.url || ""}`;
    case "WebSearch":
      return `Search: ${input.query || ""}`;
    case "Agent":
    case "Task":
      return `Agent: ${input.description || input.prompt?.slice(0, 60) || ""}`;
    default:
      return `Using ${name}`;
  }
}

// ── Codex rollout transcripts ────────────────────────────────
// Codex threads persist as rollout-<ts>-<threadId>.jsonl under a CODEX_HOME's
// sessions/YYYY/MM/DD/ tree. Lines are { timestamp, type, payload }. Messages
// are read from event_msg payloads (response_item message lines duplicate
// them and additionally carry harness-injected developer/AGENTS.md content);
// tool calls only exist as response_item lines.

function isCodexRolloutPath(path: string): boolean {
  return path.includes("/rollout-") || path.includes("\\rollout-");
}

function parseCodexEntry(raw: any): TranscriptEntry[] {
  const ts = raw.timestamp || new Date().toISOString();
  const p = raw.payload;
  if (!p || typeof p !== "object") return [];

  if (raw.type === "event_msg") {
    if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
      // Hide harness-appended run-policy/fallback notes from the rendered prompt
      const message = p.message
        .split("\n\n[Run policy:")[0]
        .split("\n\n[Note: a previous attempt")[0];
      return [{
        id: crypto.randomUUID(),
        type: "user",
        content: resolveSlackIds(message),
        timestamp: ts,
      }];
    }
    if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
      return [{
        id: crypto.randomUUID(),
        type: "assistant",
        content: p.message,
        timestamp: ts,
      }];
    }
    return [];
  }

  if (raw.type === "response_item") {
    const parseArgs = (v: unknown): unknown => {
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return v; }
    };
    const outputText = (v: unknown): string => {
      const parsed = parseArgs(v) as any;
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.output === "string") return parsed.output;
        return JSON.stringify(parsed, null, 2);
      }
      return String(v ?? "");
    };

    // MCP / custom tool calls
    if ((p.type === "function_call" || p.type === "custom_tool_call") && p.name) {
      const input = parseArgs(p.arguments ?? p.input);
      return [{
        id: p.call_id || crypto.randomUUID(),
        type: "tool_use",
        content: `Using ${p.name}`,
        timestamp: ts,
        toolName: p.name,
        toolInput: input,
        toolUseId: p.call_id,
      }];
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      return [{
        id: crypto.randomUUID(),
        type: "tool_result",
        content: outputText(p.output),
        timestamp: ts,
        toolUseId: p.call_id,
      }];
    }
    // Shell commands
    if (p.type === "local_shell_call") {
      const command = Array.isArray(p.action?.command)
        ? p.action.command.join(" ")
        : String(p.action?.command || "");
      return [{
        id: p.call_id || crypto.randomUUID(),
        type: "tool_use",
        content: `$ ${command.split("\n")[0].slice(0, 80)}`,
        timestamp: ts,
        toolName: "Bash",
        toolInput: { command },
        toolUseId: p.call_id,
      }];
    }
    if (p.type === "local_shell_call_output") {
      return [{
        id: crypto.randomUUID(),
        type: "tool_result",
        content: outputText(p.output),
        timestamp: ts,
        toolUseId: p.call_id,
      }];
    }
    if (p.type === "web_search_call") {
      return [{
        id: crypto.randomUUID(),
        type: "tool_use",
        content: `Search: ${p.action?.query || ""}`,
        timestamp: ts,
        toolName: "WebSearch",
        toolInput: p.action,
      }];
    }
    return [];
  }

  return [];
}

function parseCodexLines(lines: string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(...parseCodexEntry(JSON.parse(line)));
    } catch {
      continue;
    }
  }
  return entries;
}

export function parseTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];

  if (isCodexRolloutPath(path)) {
    const raw = readFileSync(path, "utf-8");
    return parseCodexLines(raw.split("\n").filter((l) => l.trim()));
  }

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries: TranscriptEntry[] = [];
  const seenRequestIds = new Map<string, number>(); // requestId → last index in entries

  for (const line of lines) {
    let parsed: RawJsonlEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip non-message types
    if (
      parsed.type !== "user" &&
      parsed.type !== "assistant"
    ) {
      continue;
    }

    const newEntries = parseEntry(parsed);
    for (const entry of newEntries) {
      // Deduplicate assistant messages with same requestId (keep last)
      if (
        entry.type === "assistant" &&
        entry.requestId
      ) {
        const prevIdx = seenRequestIds.get(entry.requestId);
        if (prevIdx !== undefined) {
          entries[prevIdx] = entry;
          continue;
        }
        seenRequestIds.set(entry.requestId, entries.length);
      }
      entries.push(entry);
    }
  }

  return entries;
}

export function parseTranscriptFrom(
  path: string,
  byteOffset: number
): { entries: TranscriptEntry[]; newOffset: number } {
  if (!existsSync(path)) return { entries: [], newOffset: byteOffset };

  const file = Bun.file(path);
  const size = file.size;
  if (size <= byteOffset) return { entries: [], newOffset: byteOffset };

  const buf = readFileSync(path);
  const chunk = buf.subarray(byteOffset).toString("utf-8");
  const lines = chunk.split("\n").filter((l) => l.trim());

  if (isCodexRolloutPath(path)) {
    return { entries: parseCodexLines(lines), newOffset: size };
  }

  const entries: TranscriptEntry[] = [];

  for (const line of lines) {
    let parsed: RawJsonlEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    entries.push(...parseEntry(parsed));
  }

  return { entries, newOffset: size };
}
