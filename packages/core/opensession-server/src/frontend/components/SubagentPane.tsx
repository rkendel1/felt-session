import React, { useEffect, useRef, useState } from "react";
import { fetchSubagent, type SubagentTranscript } from "../lib/api";
import { friendlyModelSlug, routedModelParts } from "./ModelEffortSelect";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { PANEL_BODY } from "../lib/session-panel-classes";
import { Badge } from "../ui/badge";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH0: {
			minHeight: "0"
	},
	flex1: {
			flex: "1"
	},
	flexCol: {
			flexDirection: "column"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	bgRaised: {
			backgroundColor: "var(--bg-raised)"
	},
	px25: {
			paddingInline: "10px"
	},
	pt2: {
			paddingTop: "8px"
	},
	pb25: {
			paddingBottom: "10px"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	textEllipsis: {
			textOverflow: "ellipsis"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	shrink0: {
			flexShrink: "0"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	px15: {
			paddingInline: "6px"
	},
	py05: {
			paddingBlock: "2px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mt2: {
			marginTop: "8px"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	borderNone: {
			borderStyle: "none"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	p0: {
			padding: "0"
	},
	mt15: {
			marginTop: "6px"
	},
	leading14: {
			lineHeight: "1.4"
	},
	m4: {
			margin: "16px"
	},
	minW0: {
			minWidth: "0"
	},
	liveDot: { width: "7px", height: "7px", flexShrink: 0, borderRadius: "calc(infinity * 1px)", backgroundColor: "var(--green)", animationName: pulse, animationDuration: "1.6s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite", "@media (prefers-reduced-motion: reduce)": { animationDuration: "1.6s !important", animationIterationCount: "infinite !important" },
		cornerShape: "var(--cs)",},
	px35: { paddingInline: "14px" },
	py3: { paddingBlock: "12px" },

	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
});

export interface SubagentRef {
  agentId: string;
  /** Human label for the breadcrumb (the Task summary, e.g. "Explore: find X"). */
  label: string;
}

interface Props {
  sessionId: string;
  /** Breadcrumb stack; the last entry is the sub-agent currently shown. */
  stack: SubagentRef[];
  /** Open a nested sub-agent (a Task call inside this sub-agent). */
  onOpenSubagent: (agentId: string, label: string) => void;
  /** Pop back to the parent sub-agent in the stack. */
  onBack: () => void;
  /** The name read off the sub-agent's own transcript. A link into a sub-agent
   *  carries ids only, so this is what gives its tab a real label. */
  onLabel?: (agentId: string, label: string) => void;
}

/**
 * A sub-agent's conversation, rendered full-width as its own view tab beside
 * the session tabs — a sub-agent run is a conversation, so it reads like one
 * instead of being squeezed into the right sidebar. Fetches over REST and,
 * while the parent session is still running, polls so a live sub-agent's
 * transcript fills in. Sub-agents that spawn their own sub-agents are
 * navigable via the breadcrumb stack.
 */
/** The pane's own liveness dot: 1.6s, slower than the sidebar's 1.4s. The
 * reduced-motion exception rides on the element — base.css blanks every
 * animation with !important and hands specific "still working" signals back,
 * and a name in that list stops matching the moment a migration renames the
 * element. */
export function SubagentPane({
  sessionId,
  stack,
  onOpenSubagent,
  onBack,
  onLabel,
}: Props) {
  const current = stack[stack.length - 1];
  const [data, setData] = useState<SubagentTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Stick to the bottom only while the reader is already there, so polling a
  // live sub-agent doesn't yank them up from scrollback.
  const followRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(initial: boolean) {
      if (initial) {
        setLoading(true);
        setError(null);
        setData(null);
        followRef.current = true;
      }
      await (async () => {
const next = await fetchSubagent(sessionId, current.agentId);
        if (cancelled) return;
        setData(next);
        setLoading(false);
        // Keep polling only while the parent session is live (the sub-agent may
        // still be streaming); once idle the transcript is final.
        if (next.sessionRunning) timer = setTimeout(() => load(false), 1500);
})().catch(async (e: any) => {
if (cancelled) return;
        setError(e?.message || "Failed to load sub-agent");
        setLoading(false);
});
    }

    load(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, current.agentId]);

  // After new content lands, keep a following reader pinned to the live edge.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  const meta = data?.meta;
  const title = meta?.agentType || current.label || "Sub-agent";
  // Hand the name up for the tab. A drill-in already arrived carrying the Task
  // call's summary; a link arrived with an agent id and nothing to call it.
  const resolvedLabel = meta?.description || meta?.agentType || null;
  useEffect(() => {
    if (resolvedLabel) onLabel?.(current.agentId, resolvedLabel);
  }, [current.agentId, resolvedLabel, onLabel]);
  const modelLabel = meta?.model
    ? friendlyModelSlug(routedModelParts(meta.model)?.model ?? meta.model)
    : null;

  return (
    <div {...stylex.props(sx.flex, sx.minH0, sx.flex1, sx.flexCol)}>
      <div {...stylex.props(sx.borderB, sx.borderDivider, sx.bgRaised, sx.px25, sx.pt2, sx.pb25)}>
        <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
          <Badge tone="accent">
            sub-agent
          </Badge>
          <span
            {...stylex.props(sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, sx.fontSemibold, sx.textFg, typography.label)}
            title={meta?.description || current.label}
          >
            {title}
          </span>
          {modelLabel && (
            <span
              {...stylex.props(sx.shrink0, sx.roundedSm, sx.bgSurface, sx.px15, sx.py05, sx.textDim, typography.meta)}
              title={meta?.model}
            >
              {modelLabel}
            </span>
          )}
          {/* No close button: the tab's × owns that, like Review and Assets. */}
          {data?.sessionRunning && <span
              {...stylex.props(sx.liveDot)}
              title="Session running"
            />}
        </div>
        {stack.length > 1 && (
          <button {...mergeStylexProps("", sx.hoverTextFg, sx.mt2, sx.maxWFull, sx.overflowHidden, sx.borderNone, sx.bgTransparent, sx.p0, sx.textEllipsis, sx.whitespaceNowrap, sx.textDim, typography.supporting)}
            onClick={onBack}
          >
            ← {stack[stack.length - 2].label}
          </button>
        )}
        {meta?.description && <div {...stylex.props(sx.mt15, sx.leading14, sx.textDim, typography.supporting)}>{meta.description}</div>}
      </div>

      <div {...mergeStylexProps(PANEL_BODY, sx.px35, sx.py3)} ref={bodyRef} onScroll={onScroll}>
        {loading ? (
          <LoadingState>Loading sub-agent…</LoadingState>
        ) : error ? (
          <InlineAlert className={mergeStylexOverrideClassName("", sx.m4)}>{error}</InlineAlert>
        ) : data && data.entries.length > 0 ? (
          <div {...stylex.props(sx.minW0)}>
            <TranscriptBlocks
              entries={data.entries}
              live={data.sessionRunning}
              onOpenSubagent={onOpenSubagent}
            />
          </div>
        ) : (
          <EmptyState>No transcript yet for this sub-agent.</EmptyState>
        )}
      </div>
    </div>
  );
}
