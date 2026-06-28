import React, { Suspense, lazy, useEffect, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { langForFile, langForGrep } from "../lib/lang";

// Shiki (the syntax highlighter) is multi-MB; keep it out of the initial
// bundle and load it only when a tool call is actually expanded. Until the
// chunk arrives, the code shows as a plain pre.
const CodeHighlightLazy = lazy(() =>
  import("./CodeHighlight").then((m) => ({ default: m.CodeHighlight }))
);

function CodeHighlight(props: {
  code: string;
  lang: string;
  gutter?: boolean;
  requireGutter?: boolean;
}) {
  return (
    <Suspense fallback={<pre className="tool-pre">{props.code}</pre>}>
      <CodeHighlightLazy {...props} />
    </Suspense>
  );
}

interface Props {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
}

/** Split "mcp__linear__list_issues" into { server: "linear", tool: "list_issues" }. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

export function ToolCallBlock({ entry, result }: Props) {
  const hasMedia = Boolean(result?.images?.length || result?.videos?.length);
  // Default closed for text-only output, but auto-open when media arrives
  // (covers both initial render and the live tool_result streaming in later).
  const [expanded, setExpanded] = useState(hasMedia);
  useEffect(() => {
    if (hasMedia) setExpanded(true);
  }, [hasMedia]);
  const toolName = entry.toolName || "Tool";
  const mcp = parseMcpTool(toolName);
  const summary = getSummary(toolName, entry.toolInput, entry.content);

  return (
    <div className="tool">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">{expanded ? "▾" : "▸"}</span>
        {mcp ? (
          <>
            <span className="tool-mcp-chip">{mcp.server}</span>
            <span className="tool-name">{mcp.tool}</span>
          </>
        ) : (
          <span className="tool-name">{toolName}</span>
        )}
        <span className="tool-summary">{summary}</span>
        {result && <span className="tool-ok">✓</span>}
      </div>
      {expanded && (
        <div className="tool-detail">
          {toolName === "Bash" && bashCommand(entry.toolInput) ? (
            <CodeHighlight code={bashCommand(entry.toolInput)!} lang="bash" />
          ) : (
            <pre className="tool-pre">{formatInput(entry.toolInput)}</pre>
          )}
          {result && (result.content || result.images?.length || result.videos?.length) && (
            <>
              <div className="tool-result-divider">Output</div>
              {result.content && renderResultContent(toolName, entry.toolInput, result.content)}
              {result.images && result.images.length > 0 && (
                <div className="tool-result-images">
                  {result.images.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="md-image-link">
                      <img className="md-image" src={src} alt="" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
              {result.videos && result.videos.length > 0 && (
                <div className="tool-result-videos">
                  {result.videos.map((src, i) => (
                    <video key={i} className="md-video" src={src} controls preload="metadata" />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function getSummary(toolName: string, input: unknown, fallback: string): string {
  if (!input || typeof input !== "object") return fallback;
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case "Read":
      return (inp.file_path as string) || fallback;
    case "Edit":
      return (inp.file_path as string) || fallback;
    case "Write":
      return (inp.file_path as string) || fallback;
    case "Bash":
      return truncate((inp.command as string) || fallback, 120);
    case "Grep":
      return `/${inp.pattern || ""}/ ${inp.path || ""}`;
    case "Glob":
      return `${inp.pattern || ""} ${inp.path || ""}`;
    case "Task":
    case "Agent":
      return [inp.subagent_type, inp.description].filter(Boolean).join(": ") || fallback;
    case "Workflow":
      return (inp.name as string) || (inp.description as string) || "orchestration script";
    case "Skill":
      return (inp.skill as string) || fallback;
    case "WebFetch":
    case "WebSearch":
      return (inp.url as string) || (inp.query as string) || fallback;
    default:
      return fallback;
  }
}

/**
 * Tool outputs that carry code get syntax highlighting: Read (cat -n format,
 * lang from file_path) and Grep content output (rg -n format, lang inferred
 * from path/glob/type — only highlighted when the gutter format is detected,
 * so file-list output stays plain).
 */
function renderResultContent(toolName: string, input: unknown, content: string) {
  const text = truncate(content, 2000);
  const lang =
    toolName === "Read"
      ? langForFile((input as any)?.file_path)
      : toolName === "Grep"
        ? langForGrep(input)
        : null;
  if (lang) {
    return <CodeHighlight code={text} lang={lang} gutter requireGutter={toolName === "Grep"} />;
  }
  // Unified diffs (git diff/show in Bash output) highlight as diff
  if (toolName === "Bash" && (text.startsWith("diff --git") || /^@@ -\d/m.test(text))) {
    return <CodeHighlight code={text} lang="diff" />;
  }
  return <pre className="tool-pre">{text}</pre>;
}

/**
 * Bash input rendered as a script: description and flags become `#` comments
 * above the command, so the whole block highlights as bash without losing info.
 */
function bashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  if (typeof inp.command !== "string") return null;

  const comments: string[] = [];
  if (typeof inp.description === "string" && inp.description) {
    comments.push(`# ${inp.description}`);
  }
  for (const [key, value] of Object.entries(inp)) {
    if (key === "command" || key === "description") continue;
    comments.push(`# ${key}: ${JSON.stringify(value)}`);
  }
  return [...comments, inp.command].join("\n");
}

function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}
