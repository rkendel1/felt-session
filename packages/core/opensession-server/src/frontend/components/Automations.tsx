import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import {
  fetchAutomations,
  createAutomationApi,
  updateAutomationApi,
  deleteAutomationApi,
  runAutomationApi,
  retriggerAutomationApi,
  fetchModels,
  fetchAutomationTemplates,
  draftAutomationApi,
  fetchConnections,
  fetchProviderAccounts,
  relativeTime,
  type ModelOption,
  type ProviderAccountOption,
  type AutomationTemplate,
  type AutomationDraft,
} from "../lib/api";
import { fetchWorkspaces } from "../lib/api/workspaces";
import { providerAccountLabel } from "../lib/provider-account";
import type { Workspace } from "../lib/types";
import { getCurrentUser } from "./UserPicker";
import { CheckStatusIcon } from "./CheckStatusIcon";
import {
  IconBolt,
  IconChevronLeft,
  IconClock,
  IconHash,
  IconPlayOutline,
  IconPlug,
  IconPlus,
} from "./icons";
import { AGENT_NAME, WEBHOOK_BASE_URL, docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { Input, Select, Textarea } from "../ui/input";
import { Modal, useEnterOnMount } from "../ui/modal";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { WorkingPill } from "../ui/status";
import { Switch } from "../ui/switch";
import { formatDuration } from "../lib/time";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	flex: {
			display: "flex"
	},
	minH0: {
			minHeight: "0"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	flexCol: {
			flexDirection: "column"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	absolute: {
			position: "absolute"
	},
	inset0: {
			inset: "0"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	outlineNone: {
			outlineStyle: "none"
	},
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	leading5: {
			lineHeight: "20px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	flexAuto: {
			flex: "auto"
	},
	borderL: {
			borderLeftStyle: "solid",
			borderLeftWidth: "1px"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	shrink0: {
			flexShrink: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap25: {
			gap: "10px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	px4: {
			paddingInline: "16px"
	},
	py3: {
			paddingBlock: "12px"
	},
	My1: {
			marginBlock: "-4px"
	},
	Ml05: {
			marginLeft: "-2px"
	},
	hidden: {
			display: "none"
	},
	gap175: {
			gap: "7px"
	},
	px15: {
			paddingInline: "6px"
	},
	py1: {
			paddingBlock: "4px"
	},
	textFg: {
			color: "var(--text)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	gap15: {
			gap: "6px"
	},
	size7: {
			width: "28px",
			height: "28px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	gap35: {
			gap: "14px"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	px5: {
			paddingInline: "20px"
	},
	pt45: {
			paddingTop: "18px"
	},
	pb10: {
			paddingBottom: "40px"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	roundedPanel: {
			borderRadius: "calc(var(--radius) * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px35: {
			paddingInline: "14px"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	grid: {
			display: "grid"
	},
	gridColsMaxContent1fr: {
			gridTemplateColumns: "max-content 1fr"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	gapX5: {
			columnGap: "20px"
	},
	gapY2: {
			rowGap: "8px"
	},
	textGreen: {
			color: "var(--green)"
	},
	textRed: {
			color: "var(--red)"
	},
	leading17: {
			lineHeight: "1.7"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	pbPx: {
			paddingBottom: "1px"
	},
	leadingNone: {
			lineHeight: "1"
	},
	mt25: {
			marginTop: "10px"
	},
	pt2: {
			paddingTop: "8px"
	},
	gap1: {
			gap: "4px"
	},
	gap2: {
			gap: "8px"
	},
	textYellow: {
			color: "var(--yellow)"
	},
	wFull: {
			width: "100%"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gap3: {
			gap: "12px"
	},
	roundedRow: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px25: {
			paddingInline: "10px"
	},
	py225: {
			paddingBlock: "9px"
	},
	textLeft: {
			textAlign: "left"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	size5: {
			width: "20px",
			height: "20px"
	},
	maxWNone: {
			maxWidth: "none"
	},
	scale115: {
			scale: "1.15"
	},
	gap075: {
			gap: "3px"
	},
	leadingNormal: {
			lineHeight: "var(--leading-normal)"
	},
	mt05: {
			marginTop: "2px"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	Mx25: {
			marginInline: "-10px"
	},
	overscrollContain: {
			overscrollBehavior: "contain"
	},
	underline: {
			textDecorationLine: "underline"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	px3: {
			paddingInline: "12px"
	},
	py2: {
			paddingBlock: "8px"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	border0: {
			borderStyle: "solid",
			borderWidth: "0"
	},
	maxH180px: {
			maxHeight: "180px"
	},
	py15: {
			paddingBlock: "6px"
	},
	ml2: {
			marginLeft: "8px"
	},
	minH10: {
			minHeight: "40px"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderDashed: {
			borderStyle: "dashed"
	},
	p3: {
			padding: "12px"
	},
	mb2: {
			marginBottom: "8px"
	},
	maxW150px: {
			maxWidth: "150px"
	},
	mt2: {
			marginTop: "8px"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gapY1: {
			rowGap: "4px"
	},
	mt1: {
			marginTop: "4px"
	},
	w110px: {
			width: "110px"
	},
	gridCols2: {
			gridTemplateColumns: "repeat(2,minmax(0,1fr))"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	py25: {
			paddingBlock: "10px"
	},
	ml15: {
			marginLeft: "6px"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	mrAuto: {
			marginRight: "auto"
	},

	flex00340px: {
		"flex": "0 0 340px"
	},
	borderR: {
		"borderRightStyle": "var(--tw-border-style)",
		"borderRightWidth": "1px"
	},
	pt4: {
		"paddingTop": "16px"
	},
	max900pxHidden: {
		"@media not all and (min-width: 900px)": {
			"display": "none"
		}
	},
	px6: {
		"paddingInline": "24px"
	},
	pt7: {
		"paddingTop": "28px"
	},
	pb15: {
		"paddingBottom": "60px"
	},
	max560pxPx4: {
		"@media not all and (min-width: 560px)": {
			"paddingInline": "16px"
		}
	},
	max560pxPt5: {
		"@media not all and (min-width: 560px)": {
			"paddingTop": "20px"
		}
	},
	max560pxPb12: {
		"@media not all and (min-width: 560px)": {
			"paddingBottom": "48px"
		}
	},
	mxAuto: {
		"marginInline": "auto"
	},
	maxW860px: {
		"maxWidth": "860px"
	},
	max560pxMb5: {
		"@media not all and (min-width: 560px)": {
			"marginBottom": "20px"
		}
	},
	max560pxFlexCol: {
		"@media not all and (min-width: 560px)": {
			"flexDirection": "column"
		}
	},
	max560pxItemsStart: {
		"@media not all and (min-width: 560px)": {
			"alignItems": "flex-start"
		}
	},
	max560pxGap35: {
		"@media not all and (min-width: 560px)": {
			"gap": "14px"
		}
	},
	textBase: {
		"fontSize": "var(--type-body)",
		"lineHeight": "var(--tw-leading,var(--text-base--line-height))"
	},
	py275: {
		"paddingBlock": "11px"
	},
	max560pxGap25: {
		"@media not all and (min-width: 560px)": {
			"gap": "10px"
		}
	},
	max560pxPx1: {
		"@media not all and (min-width: 560px)": {
			"paddingInline": "4px"
		}
	},
	max560pxPy3: {
		"@media not all and (min-width: 560px)": {
			"paddingBlock": "12px"
		}
	},
	bgActive: {
		"backgroundColor": "var(--bg-active)"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	opacity55: {
		"opacity": ".55"
	},
	selfStart: {
		"alignSelf": "flex-start"
	},
	max560pxHidden: {
		"@media not all and (min-width: 560px)": {
			"display": "none"
		}
	},
	w21: {
		"width": "84px"
	},
	textRight: {
		"textAlign": "right"
	},
	hoverBgRedSoft: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--red-soft)"
			}
		}
	},
	hoverTextRed: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--red)"
			}
		}
	},
	itemsEnd: {
		"alignItems": "flex-end"
	},

	mb35: {
		"marginBottom": "14px"
	},

	focusVisibleRing2: {
		":focusVisible": {
			"--tw-ring-shadow": "var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor)",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	focusVisibleRingInset: {
		":focusVisible": {
			"--tw-ring-inset": "inset"
		}
	},
	focusVisibleRingAccent50: {
		":focusVisible": {
			"--tw-ring-color": "var(--accent)"
		},
		"@supports (color: color-mix(in lab, red, red))": {
			":focusVisible": {
				"--tw-ring-color": "color-mix(in oklab, var(--accent) 50%, transparent)"
			}
		}
	},
	max560pxMaxW92px: {
		"@media not all and (min-width: 560px)": {
			"maxWidth": "92px"
		}
	},
	max560pxOverflowHidden: {
		"@media not all and (min-width: 560px)": {
			"overflow": "hidden"
		}
	},
	max560pxTextEllipsis: {
		"@media not all and (min-width: 560px)": {
			"textOverflow": "ellipsis"
		}
	},
	max900pxBorderL0: {
		"@media not all and (min-width: 900px)": {
			"borderLeftStyle": "var(--tw-border-style)",
			"borderLeftWidth": "0"
		}
	},
	max900pxInlineFlex: {
		"@media not all and (min-width: 900px)": {
			"display": "inline-flex"
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	mb15: {
		"marginBottom": "6px"
	},
	px175: {
		"paddingInline": "7px"
	},
	pyPx: {
		"paddingBlock": "1px"
	},
	textLink: {
		"color": "var(--link)"
	},
	noUnderline: {
		"textDecorationLine": "none"
	},
	hoverUnderline: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationLine": "underline"
			}
		}
	},
	phoneMaxHNone: {
		"@media (max-width: 720px)": {
			"maxHeight": "none"
		}
	},
	desktopMaxH32dvh: {
		"@media (min-width: 721px)": {
			"maxHeight": "32dvh"
		}
	},
	placeholderTextFaint: {
		"::placeholder": {
			"color": "var(--text-faint)"
		}
	},
	phoneFlexCol: {
		"@media (max-width: 720px)": {
			"flexDirection": "column"
		}
	},
	phoneGridCols1: {
		"@media (max-width: 720px)": {
			"gridTemplateColumns": "repeat(1,minmax(0,1fr))"
		}
	},
});

/* The old .automation-form family, as utilities. Two of its rules reached in
   from the form to the fields inside it and have to stay descendant selectors:
   every field goes to 16px on phones (below that iOS zooms a focused field),
   and a multi-line brief keeps paragraph leading, which the type scale
   doesn't set. */
const FORM_FIELDS =
  "[&_textarea]:leading-normal phone:[&_input]:text-input-phone phone:[&_select]:text-input-phone phone:[&_textarea]:text-input-phone";
/** The form's own layout, with no chrome of its own: whatever hosts it (the
 *  detail drawer, the create dialog) already provides the surface, the padding
 *  and the heading. */
const FORM_INLINE = [mergeStylexClassName("", sx.flex, sx.flexCol, sx.gap35), FORM_FIELDS].filter(Boolean).join(" ");
/** .automation-form label */
const FIELD_LABEL = mergeStylexClassName("", sx.flex, sx.flex1, sx.flexCol, sx.gap15, typography.label, sx.fontMedium, sx.textDim);

/** .automation-form-actions */
const FORM_ACTIONS = mergeStylexClassName("", sx.flex, sx.justifyEnd, sx.gap25);
/** .automation-form-row */
const FORM_ROW = mergeStylexClassName("", sx.flex, sx.gap35, sx.phoneFlexCol);
/** .automations-drawer-section-label */
const SECTION_LABEL = mergeStylexClassName("", sx.mb15, typography.label, sx.fontSemibold, sx.textFaint);
/** .automation-session-link */
const LINK = mergeStylexClassName("", sx.cursorPointer, sx.textLink, sx.noUnderline, sx.hoverUnderline);
/** .automation-cron — the cron/event chip in the Configuration grid. */
const CHIP = mergeStylexClassName("", sx.roundedSm, sx.bgActive, sx.px175, sx.pyPx, typography.meta);

interface AutomationRun {
  at: string;
  sessionId: string;
  trigger: "cron" | "webhook" | "manual" | "event";
  status: "running" | "ok" | "error";
  error?: string;
  durationMs?: number;
}

type AutomationInput = {
  id: string;
  label?: string;
  window?: {
    mode?: "since_last_success" | "rolling";
    minutes?: number;
    overlapMinutes?: number;
  };
  reduce?: { model?: string; instructions?: string; maxOutputChars?: number };
  source:
    | {
        type: "slack_channel";
        channel: string;
        includeThreads?: boolean;
        includeBots?: boolean;
        limit?: number;
      }
    | { type: "reports"; automationId: string; limit?: number };
};

type AutomationOutput =
  | { id: string; type: "report"; enabled?: boolean; publish?: "always" | "on_findings" }
  | {
      id: string;
      type: "slack";
      enabled?: boolean;
      channel: string;
      minUrgency?: "low" | "medium" | "high" | "critical";
      minConfidence?: "low" | "medium" | "high";
    };

interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret?: string;
  webhookEnabled?: boolean;
  eventKey?: string;
  mcpServers?: string[];
  slackWatch?: { channel: string };
  inputs?: AutomationInput[];
  outputs?: AutomationOutput[];
  /** Who is accountable for it; absent means nobody has taken it. */
  owner?: string;
  /** Workspace it files under. */
  workspaceId?: string;
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  sandbox?: boolean;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
  nextRunAt: string | null;
  isRunning?: boolean;
  runs?: AutomationRun[];
}

interface Props {
  onOpenSession: (sessionId: string) => void;
  /** Selected automation — its id, or its name for sidebar deep-links
   *  (session rows only carry the automation's name). From the route. */
  selectedId?: string;
  /** Change the selection ("" closes the detail drawer). Routed by App. */
  onSelect: (id: string) => void;
}

const CUSTOM = "__custom__";

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily · 9:00 AM PT", cron: "0 16 * * *" },
  { label: "Daily · 9:00 AM CET", cron: "0 8 * * *" },
  { label: "Weekdays · 9:00 AM PT", cron: "0 16 * * 1-5" },
  { label: "Weekdays · 9:00 AM CET", cron: "0 8 * * 1-5" },
  { label: "Mondays · 9:00 AM CET", cron: "0 8 * * 1" },
  { label: "No schedule · webhook or manual only", cron: "" },
  { label: "Custom cron…", cron: CUSTOM },
];

const EVENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "plain:thread_created", label: "Plain · new support ticket created" },
  { key: "stripe:charge.dispute.created", label: "Stripe · dispute (chargeback) created" },
  { key: "github:pr_merged", label: "GitHub · PR merged" },
];

/** Claude and Codex accounts for provider-aware automation pins. */
function useProviderAccounts(): ProviderAccountOption[] {
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    fetchProviderAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, []);
  return accounts;
}

export function Automations({ onOpenSession, selectedId, onSelect }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const pendingToggles = React.useRef(
    new Map<string, { enabled: boolean; request: number }>(),
  );
  const toggleRequest = React.useRef(0);
  const [defaultModel, setDefaultModel] = useState("");
  const [loading, setLoading] = useState(true);
  const providerAccounts = useProviderAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch(() => {});
  }, []);
  // The modal is create-only; editing happens inline in the detail drawer.
  const [showModal, setShowModal] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaving/changing the selection always drops back to the read view.
  useEffect(() => setEditMode(false), [selectedId]);

  // Stable identity: only refs and setters are captured, so the polling
  // effect can list `load` without ever refiring from re-renders.
  const load = useCallback(async () => {
    await (async () => {
const next = (await fetchAutomations()) as Automation[];
      setAutomations(
        next.map((automation) =>
          pendingToggles.current.has(automation.id)
            ? {
                ...automation,
                enabled: pendingToggles.current.get(automation.id)!.enabled,
              }
            : automation,
        ),
      );
      setLoading(false);
})().catch(async () => {

});
  }, []);

  useEffect(() => {
    document.title = docTitle("Automations");
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  // The routed selection — matched by id, or by name for sidebar deep-links.
  const sel = (selectedId
        ? automations.find((a) => a.id === selectedId || a.name === selectedId) ||
          null
        : null);

  // Escape backs out one layer: inline edit → read view → closed. (The create
  // modal handles its own Escape — don't close both from one keypress.)
  const hasSelection = !!sel;
  useEffect(() => {
    if (!hasSelection || showModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (editMode) setEditMode(false);
      else onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection, showModal, editMode, onSelect]);

  async function handleToggle(a: Automation, enabled: boolean) {
    const previous = a.enabled;
    const request = ++toggleRequest.current;
    pendingToggles.current.set(a.id, { enabled, request });
    setError(null);
    setAutomations((current) =>
      current.map((automation) =>
        automation.id === a.id ? { ...automation, enabled } : automation,
      ),
    );

    await (async () => {
await updateAutomationApi(a.id, { enabled });
      // A second click may have superseded this request. Only the latest intent
      // gets to reconcile the optimistic state with the server response.
      if (pendingToggles.current.get(a.id)?.request !== request) return;
      await load();
      if (pendingToggles.current.get(a.id)?.request === request)
        pendingToggles.current.delete(a.id);
})().catch(async (e: any) => {
if (pendingToggles.current.get(a.id)?.request !== request) return;
      pendingToggles.current.delete(a.id);
      setAutomations((current) =>
        current.map((automation) =>
          automation.id === a.id && automation.enabled === enabled
            ? { ...automation, enabled: previous }
            : automation,
        ),
      );
      setError(e.message);
});
  }

  async function handleDelete(a: Automation) {
    if (!confirm(`Delete automation "${a.name}"?`)) return;
    await (async () => {
await deleteAutomationApi(a.id);
      if (sel?.id === a.id) onSelect("");
      load();
})().catch(async (e: any) => {
setError(e.message);
});
  }

  async function handleRunNow(a: Automation) {
    await (async () => {
await runAutomationApi(a.id);
      setTimeout(load, 800);
})().catch(async (e: any) => {
setError(e.message);
});
  }

  async function handleRetrigger(sessionId: string) {
    await (async () => {
await retriggerAutomationApi(sessionId);
      setTimeout(load, 800);
})().catch(async (e: any) => {
setError(e.message);
});
  }

  return (
    <div {...stylex.props(sx.relative, sx.flex, sx.minH0, sx.minW0, sx.flex1)}>
    {/* Drawer open: the list compresses to a narrow rail (Reviews-style), and
        on phones it steps aside entirely — Back returns to it. */}
    <div
      className={cn(
        mergeStylexClassName("", sx.minW0, sx.overflowYAuto),
        sel
          ? mergeStylexClassName("", sx.flex00340px, sx.borderR, sx.borderLine, sx.px35, sx.pt4, sx.pb10, sx.max900pxHidden)
          : mergeStylexClassName("", sx.flex1, sx.px6, sx.pt7, sx.pb15, sx.max560pxPx4, sx.max560pxPt5, sx.max560pxPb12),
      )}
    >
    <div className={cn(mergeStylexClassName("", sx.mxAuto), !sel && mergeStylexClassName("", sx.maxW860px))}>
      <PageHeader
        className={[mergeStylexClassName("", sx.max560pxMb5, sx.max560pxFlexCol, sx.max560pxItemsStart, sx.max560pxGap35), sel ? mergeStylexClassName("", sx.mb35, sx.itemsCenter) : ""].filter(Boolean).join(" ")}
      >
        <div>
          <PageTitle className={sel ? mergeStylexClassName("", sx.textBase) : undefined}>Automations</PageTitle>
          <PageDescription className={sel ? mergeStylexClassName("", sx.hidden) : undefined}>
            Scheduled {AGENT_NAME} sessions. Cron runs in UTC (server time).
          </PageDescription>
        </div>
        <Button
					variant="primary"
					size="lg"
					icon={<IconPlus size={20} />}
					className={mergeStylexOverrideClassName("", sx.fontMedium, typography.controlLabel)}
					onClick={() => setShowModal(true)}
				>
					New automation
				</Button>
      </PageHeader>

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {loading ? (
        <LoadingState>Loading…</LoadingState>
      ) : automations.length === 0 && !showModal ? (
        <EmptyState title="No automations yet.">
          Schedule recurring work: daily PR-review sweeps, dependency checks, weekly
          changelog drafts, flaky-test hunts…
        </EmptyState>
      ) : (
        <div {...stylex.props(sx.flex, sx.flexCol, sx.borderT, sx.borderLine)}>
          {automations.map((a) => {
            const running = a.isRunning || a.lastRunStatus === "running";
            return (
              <div
                key={a.id}
                className={cn(
                  mergeStylexClassName("", sx.relative, sx.flex, sx.wFull, sx.minW0, sx.itemsCenter, sx.gap3, sx.borderB, sx.borderLine, sx.px25, sx.py275, sx.textLeft, typography.itemTitle, sx.textFg),
                  mergeStylexClassName("", sx.max560pxGap25, sx.max560pxPx1, sx.max560pxPy3),
                  sel?.id === a.id ? mergeStylexClassName("", sx.bgActive) : mergeStylexClassName("", sx.hoverBgHover),
                )}
              >
                {/* Two controls in one row: opening the automation, and
                    turning it on. So the row can't be a button around the
                    switch. The open target is a button stretched under the
                    content instead, which keeps the whole row clickable and
                    keyboard-reachable without nesting one inside the other.
                    Content above it is inert unless it has its own tooltip. */}
                <button {...mergeStylexProps("", sx.focusVisibleRing2, sx.focusVisibleRingInset, sx.focusVisibleRingAccent50, sx.absolute, sx.inset0, sx.roundedSm, sx.outlineNone)}
                  onClick={() => onSelect(a.id)}
                >
                  <span {...stylex.props(sx.srOnly)}>Open {a.name}</span>
                </button>
                <TriggerIcon automation={a} />
                <span
                  className={cn(
                    mergeStylexClassName("", sx.pointerEventsNone, sx.relative, sx.flex, sx.minW0, sx.flex1, sx.flexCol, sx.gap075),
                    !a.enabled && mergeStylexClassName("", sx.opacity55),
                  )}
                >
                  <span {...stylex.props(sx.truncate, sx.fontSemibold, sx.leading5, typography.itemTitle)}>{a.name}</span>
                  <span {...stylex.props(sx.truncate, sx.textFaint, typography.meta)}>{triggerSummary(a)}</span>
                </span>
                {running ? (
                  <WorkingPill {...mergeStylexProps("", sx.max560pxMaxW92px, sx.max560pxOverflowHidden, sx.max560pxTextEllipsis, sx.pointerEventsNone, sx.relative)} />
                ) : a.lastRunStatus === "ok" || a.lastRunStatus === "error" ? (
                  // Its own click target rather than an inert glyph: keeping
                  // pointer events is what keeps the tooltip, and the click
                  // does what the row does.
                  <span
                    className={cn(
                      mergeStylexClassName("[&_svg]:size-3.5", sx.relative, sx.flex, sx.size5, sx.shrink0, sx.selfStart, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter),
                      a.lastRunStatus === "ok" ? mergeStylexClassName("", sx.textGreen) : mergeStylexClassName("", sx.textRed),
                    )}
                    onClick={() => onSelect(a.id)}
                    title={
                      a.lastRunStatus === "ok"
                        ? `Last run ok${a.lastRunAt ? ` · ${relativeTime(a.lastRunAt)}` : ""}`
                        : a.lastRunError || "Last run failed"
                    }
                  >
                    <CheckStatusIcon kind={a.lastRunStatus === "ok" ? "success" : "failure"} />
                  </span>
                ) : null}
                {/* The graph and the next-run column are the first things to
                    go when width is scarce: the drawer's rail and phones. */}
                <span
                  className={cn(
                    mergeStylexClassName("", sx.relative, sx.shrink0, sx.cursorPointer),
                    sel ? mergeStylexClassName("", sx.hidden) : mergeStylexClassName("", sx.flex, sx.max560pxHidden),
                  )}
                  onClick={() => onSelect(a.id)}
                >
                  {(a.runs?.length ?? 0) > 0 && <TriggerGraph runs={a.runs!} compact />}
                </span>
                <span
                  className={cn(
                    mergeStylexClassName("", sx.pointerEventsNone, sx.relative, sx.w21, sx.shrink0, sx.textRight, typography.meta, sx.textFaint),
                    sel ? mergeStylexClassName("", sx.hidden) : mergeStylexClassName("", sx.max560pxHidden),
                  )}
                >
                  {/* No "off" here any more: it used to be the only state a
                      row carried at this end, and now it sits beside a switch
                      that already says it. */}
                  {a.enabled && a.nextRunAt ? `next ${formatNext(a.nextRunAt)}` : ""}
                </span>
                {/* Last in the row: the switch is the one thing you act on
                    here, so it sits on the edge, in a column of its own. */}
                <Switch
                  size="sm"
                  className={mergeStylexOverrideClassName("", sx.relative)}
                  checked={a.enabled}
                  onCheckedChange={(enabled) => handleToggle(a, enabled)}
                  aria-label={`${a.name} · ${a.enabled ? "on" : "off"}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
    </div>

      {sel && (
        <aside {...mergeStylexProps("", sx.max900pxBorderL0, sx.flex, sx.minH0, sx.minW0, sx.flexAuto, sx.flexCol, sx.borderL, sx.borderLine, sx.bgPanel)}>
          <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap25, sx.borderB, sx.borderDivider, sx.px4, sx.py3)}>
            {/* Phones get Back instead of Close: there the drawer is the page. */}
            <button {...mergeStylexProps("", sx.max900pxInlineFlex, sx.My1, sx.Ml05, sx.hidden, sx.shrink0, sx.itemsCenter, sx.gap175, sx.px15, sx.py1, sx.fontMedium, sx.textFg, typography.itemTitle)}
              onClick={() => onSelect("")}
              title="Back to automations"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" {...stylex.props(sx.textDim)} aria-hidden>
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Automations
            </button>
            <span {...stylex.props(sx.minW0, sx.truncate, sx.fontSemibold, typography.label)}>
              {editMode ? `Edit ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div {...stylex.props(sx.mlAuto, sx.flex, sx.shrink0, sx.gap15)}>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => handleRunNow(sel)}
                  disabled={sel.isRunning}
                >
                  Run now
                </Button>
                <Button size="sm" variant="soft" onClick={() => setEditMode(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="soft"
                  className={mergeStylexOverrideClassName("", sx.hoverBgRedSoft, sx.hoverTextRed)}
                  onClick={() => handleDelete(sel)}
                >
                  Delete
                </Button>
              </div>
            )}
            <button {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.max900pxHidden, sx.flex, sx.size7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.textDim)}
              onClick={() => onSelect("")}
              title="Close"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
          <div {...stylex.props(sx.flex, sx.minH0, sx.flex1, sx.flexCol, sx.gap35, sx.overflowYAuto, sx.px5, sx.pt45, sx.pb10)}>
            {editMode ? (
              <div className={FORM_INLINE}>
                <AutomationForm
                  key={sel.id}
                  kind={sel.slackWatch?.channel ? "watch" : "classic"}
                  initial={sel}
                  prefill={null}
                  onBack={null}
                  onClose={() => setEditMode(false)}
                  onSaved={() => {
                    setEditMode(false);
                    load();
                  }}
                />
              </div>
            ) : (
              <>
                <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
                  <Switch
                    checked={sel.enabled}
                    onCheckedChange={(enabled) => handleToggle(sel, enabled)}
                    aria-label={`${sel.name} · ${sel.enabled ? "on" : "off"}`}
                  />
                  <span {...stylex.props(sx.textDim, typography.label)}>
                    {sel.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {(sel.isRunning || sel.lastRunStatus === "running") && (
                    <WorkingPill />
                  )}
                  {sel.enabled && sel.nextRunAt && (
                    <span {...stylex.props(sx.textFaint, sx.mlAuto, sx.shrink0, typography.label)}>
                      next run {formatNext(sel.nextRunAt)}
                    </span>
                  )}
                </div>

                <div>
                  <div className={SECTION_LABEL}>Instructions</div>
                  <div {...stylex.props(sx.bgSurface, sx.roundedPanel, sx.px35, sx.py3, sx.leadingRelaxed, sx.textDim, sx.whitespacePreWrap, typography.label)}>
                    {sel.prompt}
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Configuration</div>
                  <div {...stylex.props(sx.grid, sx.gridColsMaxContent1fr, sx.itemsBaseline, sx.gapX5, sx.gapY2, typography.label)}>
                    <DetailKey>Trigger</DetailKey>
                    <span {...stylex.props(sx.textDim, sx.minW0)}>
                      {sel.slackWatch?.channel ? (
                        <>
                          watches{" "}
                          <span className={[CHIP, mergeStylexClassName("", sx.textYellow)].filter(Boolean).join(" ")}>
                            #{sel.slackWatch.channel}
                          </span>{" "}
                          · one run per top-level message
                        </>
                      ) : (
                        <>
                          {sel.schedule && (
                            <>
                              {scheduleLabel(sel.schedule) &&
                                `${scheduleLabel(sel.schedule)} · `}
                              <span className={CHIP} title="Cron, UTC">
                                {sel.schedule}
                              </span>
                            </>
                          )}
                          {sel.schedule && sel.eventKey && " · "}
                          {sel.eventKey && <>on {eventLabel(sel.eventKey)}</>}
                          {!sel.schedule && !sel.eventKey &&
                            (sel.webhookEnabled === false ? "manual only" : "webhook / manual only")}
                        </>
                      )}
                    </span>

                    <DetailKey>Mode</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.mode === "ask"
                        ? sel.sandbox
                          ? "Ask · isolated MicroVM workspace"
                          : "Ask · read-only on the main checkout"
                        : sel.sandbox
                          ? "Code · isolated MicroVM workspace, can open PRs"
                          : "Code · isolated worktree, can open PRs"}
                    </span>

                    <DetailKey>Environment</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.sandbox
                        ? "MicroVM · pinned credentials and restricted egress"
                        : "Host worktree"}
                    </span>

                    <DetailKey>Model</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.model || `${defaultModel || "default"} (default)`}
                      {sel.fallbackModel && sel.fallbackModel !== "none" && (
                        <span
                          {...stylex.props(sx.textFaint)}
                          title="Used only when every account for the primary model has hit its usage limit"
                        >
                          {" "}· falls back to {sel.fallbackModel}
                        </span>
                      )}
                    </span>

                    {sel.accountId && (
                      <>
                        <DetailKey>Account</DetailKey>
                        <span {...stylex.props(sx.textDim)}>
                          {providerAccountLabel(
                            providerAccounts.find((x) => x.id === sel.accountId) ?? {
                              name: "pinned account",
                            },
                          )}
                          <span {...stylex.props(sx.textFaint)}>
                            {sel.accountStrict === false
                              ? " · preferred, falls back to the shared pool"
                              : " · hard pin (cost cap)"}
                            {sel.usageCredits ? " · paid usage-credits allowed" : ""}
                          </span>
                        </span>
                      </>
                    )}

                    <DetailKey>MCPs</DetailKey>
                    <span {...stylex.props(sx.textDim, sx.minW0)}>
                      {sel.mcpServers === undefined
                        ? "all connectors"
                        : sel.mcpServers.length === 0
                          ? "none"
                          : sel.mcpServers.join(", ")}
                    </span>

                    {sel.inputs?.length ? (
                      <>
                        <DetailKey>Inputs</DetailKey>
                        <span {...stylex.props(sx.textDim, sx.minW0)}>
                          {sel.inputs.map((input) =>
                            input.label ||
                            (input.source.type === "slack_channel"
                              ? `Slack ${input.source.channel}`
                              : input.source.automationId === "self"
                                ? "previous reports"
                                : `reports ${input.source.automationId}`),
                          ).join(", ")}
                        </span>
                      </>
                    ) : null}

                    {sel.outputs?.length ? (
                      <>
                        <DetailKey>Outputs</DetailKey>
                        <span {...stylex.props(sx.textDim, sx.minW0)}>
                          {sel.outputs.map((output) => {
                            if (output.type === "report")
                              return `Reports · ${output.publish || "always"}`;
                            return `Slack ${output.channel} · ${output.enabled === false ? "disabled" : `${output.minUrgency || "high"}/${output.minConfidence || "high"}`}`;
                          }).join(", ")}
                        </span>
                      </>
                    ) : null}

                    {sel.webhookEnabled !== false && sel.webhookSecret && (
                      <>
                        <DetailKey>Webhook</DetailKey>
                        <WebhookUrl id={sel.id} secret={sel.webhookSecret} />
                      </>
                    )}

                    <DetailKey>Created</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      by {sel.createdBy}
                      {sel.createdAt &&
                        ` · ${new Date(sel.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}`}
                    </span>
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Activity</div>
                  {sel.lastRunAt ? (
                    <div {...stylex.props(sx.textDim, typography.supporting)}>
                      last run {relativeTime(sel.lastRunAt)}
                      {sel.lastTrigger ? ` via ${sel.lastTrigger}` : ""}
                      {sel.lastRunStatus === "ok" && <span {...stylex.props(sx.textGreen)}> ✓</span>}
                      {sel.lastRunStatus === "error" && (
                        <span {...stylex.props(sx.textRed)} title={sel.lastRunError}> ✗</span>
                      )}
                      {sel.lastRunSessionId && (
                        <>
                          {" · "}
                          <a
                            className={LINK}
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenSession(sel.lastRunSessionId!);
                            }}
                            href={`${BASE_PATH}/session/${sel.lastRunSessionId}`}
                          >
                            view session
                          </a>
                        </>
                      )}
                    </div>
                  ) : (
                    <div {...stylex.props(sx.textFaint, typography.supporting)}>No runs yet.</div>
                  )}
                  {(sel.runs?.length ?? 0) > 0 && (
                    <>
                      <TriggerGraph runs={sel.runs!} />
                      <RunLedger runs={sel.runs!} onOpenSession={onOpenSession} onRetrigger={handleRetrigger} />
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
      )}

      {showModal && (
        <CreateAutomationModal
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The row's leading glyph: what makes this automation run. Most of them are
 * the clock, which is the point. The few that aren't (an event, a webhook, a
 * watched channel) are what you scan for, and they now show up without
 * reading the line under the name.
 */
function TriggerIcon({ automation }: { automation: Automation }) {
  // Normalize each glyph's drawn height, not just its SVG box. These icons
  // occupy different proportions of the shared 24px viewBox.
  const { Icon, scale } = automation.slackWatch
    ? { Icon: IconHash, scale: "scale-[1.15]" }
    : automation.schedule
      ? { Icon: IconClock, scale: "scale-[1.15]" }
      : automation.eventKey
        ? { Icon: IconBolt, scale: "scale-[1.15]" }
        : automation.webhookEnabled === false
          ? { Icon: IconPlayOutline, scale: "scale-110" }
          : { Icon: IconPlug, scale: "scale-[1.15]" };
  return (
    <span
      className={cn(
        mergeStylexClassName("", sx.pointerEventsNone, sx.relative, sx.flex, sx.size5, sx.shrink0, sx.selfStart, sx.itemsCenter, sx.justifyCenter, sx.textFaint),
        !automation.enabled && mergeStylexClassName("", sx.opacity55),
      )}
    >
      <Icon size={20} className={cn(mergeStylexClassName("", sx.maxWNone), scale)} />
    </span>
  );
}

/** One-line trigger summary for the list rows. */
function triggerSummary(a: Automation): string {
  if (a.slackWatch) return `watching #${a.slackWatch.channel}`;
  const parts: string[] = [];
  if (a.schedule) parts.push(a.schedule);
  if (a.eventKey) parts.push(`on ${a.eventKey}`);
  if (!parts.length)
    parts.push(a.webhookEnabled === false ? "manual only" : "webhook / manual");
  return parts.join(" · ");
}

/** The preset's human label for a cron, when it matches one ("Daily · 9:00 AM PT"). */
function scheduleLabel(cron: string): string | null {
  const p = PRESETS.find((p) => p.cron === cron && p.cron && p.cron !== CUSTOM);
  return p ? p.label : null;
}

function eventLabel(key: string): string {
  return EVENT_OPTIONS.find((o) => o.key === key)?.label || key;
}

/** Left column of the drawer's Configuration grid. */
function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span {...stylex.props(sx.textFaint, sx.leading17, sx.whitespaceNowrap, typography.label)}>{children}</span>
  );
}

// ── Trigger history graph ────────────────────────────────────

const GRAPH_DAYS = 30;
const SLOT = 9; // 7px bar + 2px gap
const PLOT_H = 26;

/** Runs-per-day bar strip for the last 30 days. Status is state, so it uses
 *  the reserved status tokens (green/yellow/red); per-bar tooltips carry the
 *  counts in text and the expanded run ledger is the table view. */
function TriggerGraph({ runs, compact }: { runs: AutomationRun[]; compact?: boolean }) {
  const buckets = (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out = Array.from({ length: GRAPH_DAYS }, (_, i) => {
      const date = new Date(today.getTime() - (GRAPH_DAYS - 1 - i) * 86_400_000);
      return { date, ok: 0, error: 0, running: 0 };
    });
    for (const r of runs) {
      const d = new Date(r.at);
      d.setHours(0, 0, 0, 0);
      const idx = Math.round((d.getTime() - out[0].date.getTime()) / 86_400_000);
      if (idx >= 0 && idx < out.length) out[idx][r.status]++;
    }
    return out;
  })();

  const max = Math.max(1, ...buckets.map((b) => b.ok + b.error + b.running));
  const total = buckets.reduce((n, b) => n + b.ok + b.error + b.running, 0);
  if (total === 0) return null;

  return (
    <div className={[mergeStylexClassName("", sx.flex, sx.itemsEnd, sx.gap2), compact ? "" : mergeStylexClassName("", sx.mt2)].filter(Boolean).join(" ")}>
      <svg
        width={GRAPH_DAYS * SLOT - 2}
        height={PLOT_H + 1}
        role="img"
        aria-label={`Trigger history: ${total} runs in the last ${GRAPH_DAYS} days`}
        {...stylex.props(sx.shrink0)}
      >
        {/* baseline */}
        <rect x={0} y={PLOT_H} width={GRAPH_DAYS * SLOT - 2} height={1} fill="var(--border)" />
        {buckets.map((b, i) => {
          const count = b.ok + b.error + b.running;
          const label = b.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          if (count === 0) {
            return (
              <rect key={i} x={i * SLOT} y={PLOT_H - 2} width={SLOT - 2} height={2} rx={1} fill="var(--border)">
                <title>{`${label} · no runs`}</title>
              </rect>
            );
          }
          const h = Math.max(4, Math.round((count / max) * PLOT_H));
          const fill = b.error > 0 ? "var(--red)" : b.running > 0 ? "var(--yellow)" : "var(--green)";
          const parts = [
            b.ok ? `${b.ok} ok` : "",
            b.error ? `${b.error} failed` : "",
            b.running ? `${b.running} running` : "",
          ].filter(Boolean);
          // rx 3 of a 7px bar rounds the cap without closing it into a
          // capsule, so a tall bar still shows a straight side to read a
          // height off. Short ones pill anyway: ry clamps to half the height.
          return (
            <rect key={i} x={i * SLOT} y={PLOT_H - h} width={SLOT - 2} height={h} rx={3} fill={fill}>
              <title>{`${label} · ${count} run${count === 1 ? "" : "s"} (${parts.join(", ")})`}</title>
            </rect>
          );
        })}
      </svg>
      {!compact && (
        <span {...stylex.props(sx.pbPx, sx.leadingNone, sx.textFaint, typography.meta)}>
          {total} run{total === 1 ? "" : "s"} · last {GRAPH_DAYS}d
        </span>
      )}
    </div>
  );
}

/** Expandable run-history ledger for one automation (newest first). */
function RunLedger({
  runs,
  onOpenSession,
  onRetrigger,
}: {
  runs: AutomationRun[];
  onOpenSession: (sessionId: string) => void;
  onRetrigger: (sessionId: string) => void;
}) {
  return (
    <div {...stylex.props(sx.mt25, sx.borderT, sx.borderLine, sx.pt2, sx.flex, sx.flexCol, sx.gap1)}>
      {runs.map((r) => (
        <div key={r.sessionId + r.at} {...stylex.props(sx.flex, sx.itemsBaseline, sx.gap2, sx.textDim, sx.minW0, typography.label)}>
          {r.status === "running" ? (
            <span {...stylex.props(sx.textYellow, sx.shrink0)}>●</span>
          ) : r.status === "ok" ? (
            <span {...stylex.props(sx.textGreen, sx.shrink0)}>✓</span>
          ) : (
            <span {...stylex.props(sx.textRed, sx.shrink0)} title={r.error}>✗</span>
          )}
          <span {...stylex.props(sx.shrink0)} title={new Date(r.at).toLocaleString()}>
            {relativeTime(r.at)}
          </span>
          <span {...stylex.props(sx.textFaint, sx.shrink0)}>via {r.trigger}</span>
          {r.durationMs != null && (
            <span {...stylex.props(sx.textFaint, sx.shrink0)}>{formatDuration(r.durationMs)}</span>
          )}
          {r.error && (
            <span {...stylex.props(sx.textRed, sx.truncate)} title={r.error}>
              {r.error}
            </span>
          )}
          <a
            className={cn(LINK, mergeStylexClassName("", sx.mlAuto, sx.shrink0))}
            href={`${BASE_PATH}/session/${r.sessionId}`}
            onClick={(e) => {
              e.preventDefault();
              onOpenSession(r.sessionId);
            }}
          >
            view session
          </a>
          {r.status !== "running" && (
            <button
              className={cn(LINK, mergeStylexClassName("", sx.shrink0, typography.label))}
              title={
                r.trigger === "event" || r.trigger === "webhook"
                  ? "Start a fresh run replaying this run's triggering event"
                  : "Start a fresh run of this automation"
              }
              onClick={() => onRetrigger(r.sessionId)}
            >
              retrigger
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Secret webhook URL as a Configuration-grid value: truncated URL + copy. */
function WebhookUrl({ id, secret }: { id: string; secret: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${WEBHOOK_BASE_URL}/automations/${id}/${secret}`;

  return (
    <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2, sx.minW0)}>
      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.textDim, typography.meta)} title={url}>
        POST {url.replace(secret, secret.slice(0, 6) + "…")}
      </span>
      <Button
        size="sm"
        variant="soft"
        className={mergeStylexOverrideClassName("", sx.shrink0)}
        onClick={() => {
          navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied ✓" : "Copy URL"}
      </Button>
    </span>
  );
}

function formatNext(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

// ── Create / edit modal ──────────────────────────────────────

type Step = "type" | "classic" | "watch";

const CATEGORY_LABELS: Record<AutomationTemplate["category"], string> = {
  sweep: "Sweep",
  digest: "Digest",
  investigator: "Investigator",
  triage: "Triage",
  hygiene: "Hygiene",
};

/** Create-only: editing renders AutomationForm in the detail drawer instead. */
function CreateAutomationModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("type");
  const [prefill, setPrefill] = useState<AutomationDraft | null>(null);
  // The page mounts this only while it should be open, so the enter animation
  // needs one frame at open={false} first (see ui/modal.tsx).
  const open = useEnterOnMount();
  // Describing it is the first path on offer, so the caret starts there rather
  // than on the close button Base UI would otherwise pick.
  const describeRef = React.useRef<HTMLTextAreaElement>(null);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content
        widthClassName={mergeStylexClassName("", sharedClassStyles.maxW40rem)}
        initialFocus={step === "type" ? describeRef : undefined}
      >
        {step === "type" ? (
          <TypeChooser
            describeRef={describeRef}
            onPick={(draft, s) => {
              setPrefill(draft);
              setStep(s);
            }}
          />
        ) : (
          <>
            <Modal.Header
              title={step === "watch" ? "Watch a Slack channel" : "New automation"}
              description={
                step === "watch"
                  ? `${AGENT_NAME} triages every new message in the channel.`
                  : "Runs on a schedule, an internal event, or a webhook."
              }
            />
            <div className={FORM_INLINE}>
              <AutomationForm
                kind={step}
                initial={null}
                prefill={prefill}
                onBack={() => setStep("type")}
                onClose={onClose}
                onSaved={onSaved}
              />
            </div>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * One starting point: a blank type, or a template. Same anatomy as a row in
 * the list this creates — trigger glyph, name, one line about it — so the
 * choice looks like the thing it makes.
 */
function ChooserRow({
  icon: Icon,
  title,
  description,
  meta,
  onClick,
}: {
  icon: (props: { size?: number; className?: string }) => React.ReactElement;
  title: string;
  description: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button" {...mergeStylexProps("", sx.hoverBgHover, sx.flex, sx.wFull, sx.cursorPointer, sx.itemsStart, sx.gap3, sx.roundedRow, sx.px25, sx.py225, sx.textLeft, sx.transitionColors)}
      onClick={onClick}
    >
      {/* Normalize the drawn height, not the SVG box, the way the list rows do. */}
      <span {...stylex.props(sx.flex, sx.size5, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textFaint)}>
        <Icon size={20} className={mergeStylexOverrideClassName("", sx.maxWNone, sx.scale115)} />
      </span>
      <span {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.flexCol, sx.gap075)}>
        <span {...stylex.props(sx.fontSemibold, sx.leading5, sx.textFg, typography.itemTitle)}>{title}</span>
        <span {...stylex.props(sx.leadingNormal, sx.textFaint, typography.supporting)}>{description}</span>
      </span>
      {meta && <span {...stylex.props(sx.mt05, sx.shrink0, sx.textFaint, typography.meta)}>{meta}</span>}
    </button>
  );
}

/** Step 1: describe it, start blank, or start from a template. */
function TypeChooser({
  describeRef,
  onPick,
}: {
  describeRef: React.RefObject<HTMLTextAreaElement | null>;
  onPick: (prefill: AutomationDraft | null, step: Exclude<Step, "type">) => void;
}) {
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [description, setDescription] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAutomationTemplates().then(setTemplates).catch(() => {});
  }, []);

  async function handleDraft() {
    if (description.trim().length < 10 || drafting) return;
    setDrafting(true);
    setError(null);
    await (async () => {
onPick(await draftAutomationApi(description), "classic");
})().catch(async (e: any) => {
setError(e.message);
      setDrafting(false);
});
  }

  return (
    <>
      <Modal.Header
        title="New automation"
        description="Describe what you want, or start from a template. Everything stays editable."
      />

      <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
        <Textarea
          ref={describeRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDraft();
          }}
          rows={2}
          aria-label="Describe the automation"
          placeholder="Every weekday morning, check Sentry for new errors and rank them by impact"
        />
        {error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
        <div {...stylex.props(sx.flex, sx.justifyEnd)}>
          <Button
            variant="primary"
            onClick={handleDraft}
            disabled={drafting || description.trim().length < 10}
          >
            {drafting ? "Drafting…" : "Draft it"}
          </Button>
        </div>
      </div>

      {/* Outdented by the rows' own padding, so each group's label shares an x
          with the rows under it (see src/frontend/AGENTS.md). */}
      <div {...stylex.props(sx.Mx25)}>
        <div className={cn(SECTION_LABEL, mergeStylexClassName("", sx.px25))}>Start from scratch</div>
        <ChooserRow
          icon={IconClock}
          title="Schedule, event or webhook"
          description={`${AGENT_NAME} runs once each time the trigger fires.`}
          onClick={() => onPick(null, "classic")}
        />
        <ChooserRow
          icon={IconHash}
          title="Slack channel watch"
          description={`${AGENT_NAME} triages every new message, with the channel's memory as context.`}
          onClick={() => onPick(null, "watch")}
        />
      </div>

      {templates.length > 0 && (
        <div {...stylex.props(sx.Mx25, sx.flex, sx.minH0, sx.flexCol)}>
          <div className={cn(SECTION_LABEL, mergeStylexClassName("", sx.px25))}>Templates</div>
          {/* The gallery scrolls inside the dialog rather than growing it, so
              the describe field and the two blank starts stay on screen. */}
          <div {...mergeStylexProps("", sx.phoneMaxHNone, sx.desktopMaxH32dvh, sx.minH0, sx.overflowYAuto, sx.overscrollContain)}>
            {templates.map((t) => (
              <ChooserRow
                key={t.id}
                icon={t.schedule ? IconClock : t.eventKey ? IconBolt : IconPlug}
                title={t.name}
                description={t.description}
                meta={CATEGORY_LABELS[t.category] || t.category}
                onClick={() => onPick(t, "classic")}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ── MCP multi-select picker ──────────────────────────────────

/** Devin-style connector picker. `value` semantics match the server:
 *  undefined = all servers, [] = none, else the named allowlist. */
function McpPicker({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
}) {
  const [servers, setServers] = useState<Array<{ name: string; status: string }>>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchConnections()
      .then((c) =>
        setServers(
          (c.mcpServers || []).map((s: any) => ({ name: s.name, status: s.status })),
        ),
      )
      .catch(() => {});
  }, []);

  const all = value === undefined;
  const selected = value || [];
  const shown = servers.filter((s) =>
    s.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function toggle(name: string) {
    if (all) {
      // Leaving "all" mode by picking: start an explicit list with just this one
      onChange([name]);
      return;
    }
    onChange(
      selected.includes(name)
        ? selected.filter((n) => n !== name)
        : [...selected, name],
    );
  }

  return (
    <div {...stylex.props(sx.flex, sx.flexCol, sx.gap15)}>
      <div {...stylex.props(sx.flex, sx.itemsBaseline, sx.gap2)}>
        <span {...stylex.props(sx.textFg, sx.fontMedium, typography.label)}>MCPs</span>
        <span {...stylex.props(sx.textDim, typography.label)}>
          Select which connectors this automation's runs can use
        </span>
        <a
          {...stylex.props(sx.textDim, sx.underline, sx.mlAuto, sx.shrink0, typography.label)}
          href={`${BASE_PATH}/settings`}
        >
          Manage MCPs
        </a>
      </div>
      <div {...stylex.props(sx.bgSurface, sx.roundedPanel, sx.overflowHidden)}>
        <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2, sx.borderB, sx.borderDivider, sx.px3, sx.py2)}>
          {/* Chrome-less on purpose: the picker's own panel is the surface, so
              a second well inside it would read as a box in a box. */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MCPs…" {...mergeStylexProps("", sx.placeholderTextFaint, sx.flex1, sx.bgTransparent, sx.border0, sx.outlineNone, sx.textFg, typography.label)}
            style={{ border: "none", padding: 0, background: "transparent" }}
          />
          <span {...stylex.props(sx.textFaint, sx.shrink0, typography.meta)}>
            {all ? "all connectors" : `${selected.length} selected`}
          </span>
        </div>
        <label {...mergeStylexProps("", sx.hoverBgHover, sx.flex, sx.itemsCenter, sx.gap25, sx.borderB, sx.borderLine, sx.px3, sx.py2, sx.cursorPointer, typography.label)}
        >
          <Checkbox checked={all} onCheckedChange={() => onChange(all ? [] : undefined)} />
          <span {...stylex.props(sx.textFg)}>All connectors</span>
          <span {...stylex.props(sx.textFaint, typography.meta)}>
            every configured server (pre-least-privilege default)
          </span>
        </label>
        <div {...stylex.props(sx.maxH180px, sx.overflowYAuto)}>
          {shown.map((s) => (
            <label
              key={s.name} {...mergeStylexProps("", sx.hoverBgHover, sx.flex, sx.itemsCenter, sx.gap25, sx.px3, sx.py15, sx.cursorPointer, typography.label)}
            >
              <Checkbox
                checked={all || selected.includes(s.name)}
                onCheckedChange={() => toggle(s.name)}
              />
              <span {...stylex.props(sx.textFg)}>{s.name}</span>
              {s.status !== "connected" && s.status !== "ready" && (
                <span {...stylex.props(sx.textYellow, typography.meta)}>{s.status}</span>
              )}
            </label>
          ))}
          {shown.length === 0 && (
            <div {...stylex.props(sx.px3, sx.py2, sx.textFaint, typography.label)}>No connectors match.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Classic / watch form (step 2) ────────────────────────────

/** " (Claude)" / " (OpenAI Codex)" by the model's ACCOUNT POOL — the engine
 *  provider ("pi"/"pi") says nothing about whose subscription pays, and
 *  keying off it labeled every engine entry "(Claude)". Pool-less models get
 *  no suffix. */
function accountPoolSuffix(m: ModelOption): string {
  if (m.accountProvider === "codex") return " (OpenAI Codex)";
  if (m.accountProvider === "claude") return " (Claude)";
  return "";
}

function uniqueFlowId(prefix: string, used: string[]): string {
  let candidate = prefix;
  let index = 2;
  while (used.includes(candidate)) candidate = `${prefix}-${index++}`;
  return candidate;
}

function DataFlowEditor({
  inputs,
  outputs,
  onInputsChange,
  onOutputsChange,
}: {
  inputs: AutomationInput[];
  outputs: AutomationOutput[];
  onInputsChange: (value: AutomationInput[]) => void;
  onOutputsChange: (value: AutomationOutput[]) => void;
}) {
  const updateInput = (index: number, value: AutomationInput) =>
    onInputsChange(inputs.map((input, at) => (at === index ? value : input)));
  const updateOutput = (index: number, value: AutomationOutput) =>
    onOutputsChange(outputs.map((output, at) => (at === index ? value : output)));

  return (
    <div {...stylex.props(sx.flex, sx.flexCol, sx.gap25)}>
      <div>
        <span {...stylex.props(sx.fontMedium, sx.textFg, typography.label)}>Data flow</span>
        <span {...stylex.props(sx.ml2, sx.textDim, typography.label)}>
          Gather and flatten inputs before each run, then publish the result
        </span>
      </div>

      <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
        <div {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap2)}>
          <span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>Inputs</span>
          <span {...stylex.props(sx.textFaint, typography.supporting)}>Each source is bounded and treated as untrusted data</span>
          <div {...stylex.props(sx.mlAuto, sx.flex, sx.gap15)}>
            <Button
              size="sm"
              onClick={() =>
                onInputsChange([
                  ...inputs,
                  {
                    id: uniqueFlowId("slack", inputs.map((input) => input.id)),
                    label: "Slack channel",
                    window: { mode: "since_last_success", minutes: 120, overlapMinutes: 10 },
                    reduce: { model: "claude-haiku-4-5", maxOutputChars: 8000 },
                    source: {
                      type: "slack_channel",
                      channel: "",
                      includeThreads: true,
                      includeBots: false,
                      limit: 200,
                    },
                  },
                ])
              }
            >
              + Slack
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onInputsChange([
                  ...inputs,
                  {
                    id: uniqueFlowId("reports", inputs.map((input) => input.id)),
                    label: "Previous reports",
                    source: { type: "reports", automationId: "self", limit: 3 },
                  },
                ])
              }
            >
              + Reports
            </Button>
          </div>
        </div>

        {inputs.length === 0 ? (
          <div {...stylex.props(sx.roundedPanel, sx.border, sx.borderDashed, sx.borderLine, sx.px3, sx.py3, sx.textFaint, typography.label)}>
            No collected inputs. The run receives only its instructions and trigger context.
          </div>
        ) : (
          inputs.map((input, index) => {
            const slack = input.source.type === "slack_channel" ? input.source : null;
            const reports = input.source.type === "reports" ? input.source : null;
            return (
              <div key={input.id} {...stylex.props(sx.roundedPanel, sx.bgSurface, sx.p3)}>
                <div {...stylex.props(sx.mb2, sx.flex, sx.minH10, sx.itemsCenter, sx.gap2)}>
                  <Select
                    className={mergeStylexOverrideClassName("", sx.maxW150px)}
                    value={input.source.type}
                    onChange={(e) => {
                      const source = e.target.value === "slack_channel"
                        ? {
                            type: "slack_channel" as const,
                            channel: "",
                            includeThreads: true,
                            includeBots: false,
                            limit: 200,
                          }
                        : { type: "reports" as const, automationId: "self", limit: 3 };
                      updateInput(index, { id: input.id, label: input.label, source });
                    }}
                  >
                    <option value="slack_channel">Slack channel</option>
                    <option value="reports">Report history</option>
                  </Select>
                  <Input
                    value={input.label || ""}
                    onChange={(e) => updateInput(index, { ...input, label: e.target.value })}
                    placeholder="Label"
                  />
                  <Button
                    size="sm" {...mergeStylexProps("", sx.hoverTextRed, sx.shrink0, sx.textDim)}
                    onClick={() => onInputsChange(inputs.filter((_, at) => at !== index))}
                  >
                    Remove
                  </Button>
                </div>

                {slack && (
                  <>
                    <div className={FORM_ROW}>
                      <label className={FIELD_LABEL}>
                        Channel ID
                        <Input
                          value={slack.channel}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, channel: e.target.value.toUpperCase() },
                            })
                          }
                          placeholder="C0123456789"
                        />
                      </label>
                      <label className={FIELD_LABEL}>
                        Initial lookback
                        <Input
                          type="number"
                          min={15}
                          max={10080}
                          value={input.window?.minutes ?? 120}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              window: { ...input.window, minutes: Number(e.target.value) },
                            })
                          }
                        />
                      </label>
                      <label className={FIELD_LABEL}>
                        Reducer model
                        <Input
                          value={input.reduce?.model || ""}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              reduce: { ...input.reduce, model: e.target.value },
                            })
                          }
                          placeholder="Default Haiku"
                        />
                      </label>
                    </div>
                    <div {...stylex.props(sx.mt2, sx.flex, sx.flexWrap, sx.gapX5, sx.gapY1, sx.textDim, typography.label)}>
                      <label {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap2)}>
                        <Checkbox
                          checked={slack.includeThreads !== false}
                          onCheckedChange={(checked) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, includeThreads: checked },
                            })
                          }
                        />
                        Include thread replies
                      </label>
                      <label {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap2)}>
                        <Checkbox
                          checked={slack.includeBots === true}
                          onCheckedChange={(checked) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, includeBots: checked },
                            })
                          }
                        />
                        Include bot messages
                      </label>
                    </div>
                  </>
                )}

                {reports && (
                  <div className={FORM_ROW}>
                    <label className={FIELD_LABEL}>
                      Automation ID
                      <Input
                        value={reports.automationId}
                        onChange={(e) =>
                          updateInput(index, {
                            ...input,
                            source: { ...reports, automationId: e.target.value },
                          })
                        }
                        placeholder="self"
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      Reports to include
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={reports.limit ?? 3}
                        onChange={(e) =>
                          updateInput(index, {
                            ...input,
                            source: { ...reports, limit: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div {...stylex.props(sx.mt1, sx.flex, sx.flexCol, sx.gap2)}>
        <div {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap2)}>
          <span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>Outputs</span>
          <span {...stylex.props(sx.textFaint, typography.supporting)}>Reports are durable; Slack delivery is optional</span>
          <div {...stylex.props(sx.mlAuto, sx.flex, sx.gap15)}>
            {!outputs.some((output) => output.type === "report") && (
              <Button
                size="sm"
                onClick={() =>
                  onOutputsChange([
                    ...outputs,
                    {
                      id: uniqueFlowId("report", outputs.map((output) => output.id)),
                      type: "report",
                      enabled: true,
                      publish: "always",
                    },
                  ])
                }
              >
                + Report
              </Button>
            )}
            <Button
              size="sm"
              onClick={() =>
                onOutputsChange([
                  ...outputs,
                  {
                    id: uniqueFlowId("slack", outputs.map((output) => output.id)),
                    type: "slack",
                    enabled: false,
                    channel: "",
                    minUrgency: "high",
                    minConfidence: "high",
                  },
                ])
              }
            >
              + Slack
            </Button>
          </div>
        </div>

        {outputs.length === 0 ? (
          <div {...stylex.props(sx.roundedPanel, sx.border, sx.borderDashed, sx.borderLine, sx.px3, sx.py3, sx.textFaint, typography.label)}>
            No required output. The run behaves like a normal automation session.
          </div>
        ) : (
          outputs.map((output, index) => (
            <div key={output.id} {...stylex.props(sx.roundedPanel, sx.bgSurface, sx.p3)}>
              <div {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap2)}>
                <span {...stylex.props(sx.w110px, sx.shrink0, sx.fontMedium, sx.textFg, typography.label)}>
                  {output.type === "report" ? "Report" : "Slack"}
                </span>
                {output.type === "report" ? (
                  <Select
                    value={output.publish || "always"}
                    onChange={(e) =>
                      updateOutput(index, {
                        ...output,
                        publish: e.target.value as "always" | "on_findings",
                      })
                    }
                  >
                    <option value="always">Publish every run</option>
                    <option value="on_findings">Only with findings</option>
                  </Select>
                ) : (
                  <>
                    <Input
                      value={output.channel}
                      onChange={(e) =>
                        updateOutput(index, { ...output, channel: e.target.value.toUpperCase() })
                      }
                      placeholder="C0123456789"
                    />
                    <label {...stylex.props(sx.flex, sx.minH10, sx.shrink0, sx.itemsCenter, sx.gap2, sx.textDim, typography.label)}>
                      <Checkbox
                        checked={output.enabled !== false}
                        onCheckedChange={(checked) =>
                          updateOutput(index, { ...output, enabled: checked })
                        }
                      />
                      Send
                    </label>
                  </>
                )}
                <Button
                  size="sm" {...mergeStylexProps("", sx.hoverTextRed, sx.shrink0, sx.textDim)}
                  onClick={() => onOutputsChange(outputs.filter((_, at) => at !== index))}
                >
                  Remove
                </Button>
              </div>
              {output.type === "slack" && (
                <div {...mergeStylexProps("", sx.phoneGridCols1, sx.mt2, sx.grid, sx.gridCols2, sx.gap3)}>
                  <label className={FIELD_LABEL}>
                    Minimum urgency
                    <Select
                      value={output.minUrgency || "high"}
                      onChange={(e) =>
                        updateOutput(index, {
                          ...output,
                          minUrgency: e.target.value as
                            | "low"
                            | "medium"
                            | "high"
                            | "critical",
                        })
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </Select>
                  </label>
                  <label className={FIELD_LABEL}>
                    Minimum confidence
                    <Select
                      value={output.minConfidence || "high"}
                      onChange={(e) =>
                        updateOutput(index, {
                          ...output,
                          minConfidence: e.target.value as "low" | "medium" | "high",
                        })
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </Select>
                  </label>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** The fields themselves. Both hosts (the detail drawer and the create dialog)
 *  already name the surface, so the form carries no heading of its own. It only
 *  adds Back to its actions when there is a step to go back to. */
function AutomationForm({
  kind,
  initial,
  prefill,
  onBack,
  onClose,
  onSaved,
}: {
  kind: "classic" | "watch";
  initial: Automation | null;
  prefill?: AutomationDraft | null;
  onBack: (() => void) | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const startSchedule = initial ? initial.schedule : (prefill?.schedule ?? PRESETS[2].cron);
  const matchesPreset = PRESETS.some((p) => p.cron === startSchedule && p.cron !== CUSTOM);
  const initialPreset = matchesPreset ? startSchedule : CUSTOM;

  const [name, setName] = useState(initial?.name || prefill?.name || "");
  const [prompt, setPrompt] = useState(initial?.prompt || prefill?.prompt || "");
  const [preset, setPreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(!matchesPreset ? startSchedule : "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || prefill?.mode || "ask");
  const [eventKey, setEventKey] = useState(initial?.eventKey || prefill?.eventKey || "");
  const [watchChannel, setWatchChannel] = useState(initial?.slackWatch?.channel || "");
  const [webhookEnabled, setWebhookEnabled] = useState(
    initial ? initial.webhookEnabled !== false : false,
  );
  const [inputs, setInputs] = useState<AutomationInput[]>(() =>
    initial?.inputs ? structuredClone(initial.inputs) : [],
  );
  const [outputs, setOutputs] = useState<AutomationOutput[]>(() =>
    initial?.outputs ? structuredClone(initial.outputs) : [],
  );
  const [mcpServers, setMcpServers] = useState<string[] | undefined>(
    initial ? initial.mcpServers : (prefill?.mcpServers ?? (kind === "watch" ? ["slack"] : undefined)),
  );
  // Who is accountable for what this automation does to the codebase. Empty
  // means nobody has taken it, which is what every automation written before
  // owners existed still says.
  const [owner, setOwner] = useState(initial?.owner || "");
  const [workspaceId, setWorkspaceId] = useState(initial?.workspaceId || "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(initial?.fallbackModel || "");
  const [accountId, setAccountId] = useState(initial?.accountId || "");
  const [accountStrict, setAccountStrict] = useState(initial?.accountStrict !== false);
  const [usageCredits, setUsageCredits] = useState(!!initial?.usageCredits);
  const [sandbox, setSandbox] = useState(!!initial?.sandbox);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const providerAccounts = useProviderAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
    // Only to name the workspace an automation files under; a failure leaves
    // the picker on "No workspace" rather than blocking the form.
    fetchWorkspaces()
      .then(setWorkspaces)
      .catch(() => {});
  }, []);
  const effectiveModel = model || defaultModel;
  const accountProvider = models.find((item) => item.id === effectiveModel)?.accountProvider;
  const eligibleAccounts = providerAccounts.filter((account) => account.provider === accountProvider);
  useEffect(() => {
    const account = providerAccounts.find((item) => item.id === accountId);
    if (account && account.provider !== accountProvider) setAccountId("");
  }, [accountId, accountProvider, providerAccounts]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWatch = kind === "watch";
  const schedule = isWatch ? "" : preset === CUSTOM ? customCron.trim() : preset;
  const scheduleValid = isWatch || preset !== CUSTOM || customCron.trim().length > 0;
  const watchValid = !isWatch || /^[CG][A-Z0-9]{6,}$/i.test(watchChannel.trim());

  async function handleSave() {
    setSaving(true);
    setError(null);
    await (async () => {
const slackWatch = isWatch
        ? { channel: watchChannel.trim().toUpperCase() }
        : initial?.slackWatch
          ? { channel: "" } // editing a watch automation into a classic one clears it
          : undefined;
      if (initial) {
        await updateAutomationApi(initial.id, {
          name,
          prompt,
          schedule,
          mode,
          eventKey: isWatch ? "" : eventKey,
          model,
          fallbackModel,
          accountId,
          accountStrict,
          usageCredits,
          sandbox,
          mcpServers: mcpServers ?? null,
          slackWatch,
          webhookEnabled: isWatch ? false : webhookEnabled,
          inputs: isWatch ? [] : inputs,
          outputs: isWatch ? [] : outputs,
          owner: owner.trim(),
          workspaceId,
        });
      } else {
        await createAutomationApi({
          name,
          prompt,
          schedule,
          mode,
          eventKey: (!isWatch && eventKey) || undefined,
          model: model || undefined,
          fallbackModel: fallbackModel || undefined,
          accountId: accountId || undefined,
          accountStrict: accountId && !accountStrict ? false : undefined,
          usageCredits: usageCredits || undefined,
          sandbox: sandbox || undefined,
          mcpServers,
          slackWatch,
          webhookEnabled: isWatch ? false : webhookEnabled,
          inputs: isWatch ? undefined : inputs,
          outputs: isWatch ? undefined : outputs,
          owner: owner.trim() || undefined,
          workspaceId: workspaceId || undefined,
          createdBy: getCurrentUser(),
        });
      }
      onSaved();
})().catch(async (e: any) => {
setError(e.message);
      setSaving(false);
});
  }

  return (
    <>
      <label className={FIELD_LABEL}>
        Automation name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isWatch ? "Support channel triage" : "Daily PR review sweep"}
        />
      </label>

      <div {...stylex.props(sx.flex, sx.gap3)}>
        <label className={FIELD_LABEL}>
          Owner
          <Input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder={getCurrentUser() || "Kent"}
          />
          <span {...stylex.props(sx.mt1, sx.leadingSnug, sx.textFaint, typography.supporting)}>
            Who reviews what it does. It appears in their sidebar.
          </span>
        </label>
        <label className={FIELD_LABEL}>
          Workspace
          <Select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            <option value="">No workspace</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <span {...stylex.props(sx.mt1, sx.leadingSnug, sx.textFaint, typography.supporting)}>
            Files the automation under a workspace. Its runs stay in the
            Automations section.
          </span>
        </label>
      </div>

      {isWatch ? (
        <label className={FIELD_LABEL}>
          Slack channel: what channel should {AGENT_NAME} watch?
          <Input
            value={watchChannel}
            onChange={(e) => setWatchChannel(e.target.value)}
            placeholder="C0123456789 (channel id)"
          />
          <span {...stylex.props(sx.mt1, sx.leadingSnug, sx.textFaint, typography.supporting)}>
            Invite @{AGENT_NAME} to the channel first. The bot only receives messages
            for channels it's a member of. One run per top-level message; thread
            replies don't re-trigger. Channel id is in the channel's “About” tab.
          </span>
        </label>
      ) : (
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap15)}>
          <div>
            <span {...stylex.props(sx.textFg, sx.fontMedium, typography.label)}>Triggers</span>
            <span {...stylex.props(sx.textDim, sx.ml2, typography.label)}>
              Run the automation when any of these conditions are met
            </span>
          </div>
          <div {...stylex.props(sx.bgSurface, sx.roundedPanel, sx.px3, sx.py25, sx.flex, sx.flexCol, sx.gap25)}>
            <label className={FIELD_LABEL}>
              Schedule
              <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </label>
            {preset === CUSTOM && (
              <label className={FIELD_LABEL}>
                Cron expression (UTC)
                <Input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 16 * * 1-5"
                      />
              </label>
            )}
            <label className={FIELD_LABEL}>
              Internal event
              <Select value={eventKey} onChange={(e) => setEventKey(e.target.value)}>
                <option value="">None</option>
                {EVENT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <div {...stylex.props(sx.textFaint, typography.supporting)}>
              Schedules and events can be combined. Manual “Run now” is always available.
            </div>
            <label {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap25, sx.textDim, typography.label)}>
              <Checkbox checked={webhookEnabled} onCheckedChange={setWebhookEnabled} />
              <span>
                Accept webhook triggers
                <span {...stylex.props(sx.ml15, sx.textFaint)}>Creates a secret external POST URL</span>
              </span>
            </label>
          </div>
        </div>
      )}

      <label className={FIELD_LABEL}>
        Instructions: what {AGENT_NAME} does {isWatch ? "with each message" : "when triggers activate"}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder={
            isWatch
              ? `Tell ${AGENT_NAME} how to handle messages in this channel. e.g. “triage each report: reproduce, check Sentry, file a Linear issue, reply in the thread with what you found.”`
              : `What should ${AGENT_NAME} do on each run?`
          }
        />
      </label>

      <McpPicker value={mcpServers} onChange={setMcpServers} />

      {!isWatch && (
        <DataFlowEditor
          inputs={inputs}
          outputs={outputs}
          onInputsChange={setInputs}
          onOutputsChange={setOutputs}
        />
      )}

      <div>
        <Button
          size="sm"
          variant="soft"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </Button>
      </div>

      {showAdvanced && (
        <div className={FORM_ROW}>
          <label className={FIELD_LABEL}>
            Mode
            <Select value={mode} onChange={(e) => setMode(e.target.value as "ask" | "code")}>
              <option value="ask">Ask · read-only on main</option>
              <option value="code">Code · fresh worktree per run</option>
            </Select>
          </label>

          <label {...stylex.props(sx.flex, sx.minH10, sx.flex1, sx.itemsCenter, sx.justifyBetween, sx.gap3, sx.fontMedium, sx.textDim, typography.label)}>
            <span {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
              <span>Run in a MicroVM</span>
              <span {...stylex.props(sx.fontNormal, sx.textFaint)}>
                Pinned credentials, explicit MCP access, restricted network
              </span>
            </span>
            <Switch
              checked={sandbox}
              onCheckedChange={(checked) => {
                setSandbox(checked);
                if (checked) {
                  setAccountStrict(true);
                  setFallbackModel("");
                  setMcpServers((current) => current ?? []);
                }
              }}
              aria-label="Run this automation in a MicroVM"
            />
          </label>

          <label className={FIELD_LABEL}>
            Model
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default{defaultModel ? ` · ${defaultModel}` : ""}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {accountPoolSuffix(m)}
                </option>
              ))}
            </Select>
          </label>

          <label className={FIELD_LABEL}>
            Fallback (when all accounts hit usage limits)
            <Select
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
              disabled={sandbox}
            >
              <option value="">None · fail instead of falling back</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {accountPoolSuffix(m)}
                </option>
              ))}
            </Select>
          </label>

          <label className={FIELD_LABEL} title="Pin runs to one account from the selected model's provider pool.">
            Provider account
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Auto · shared pool rotation</option>
              {eligibleAccounts.map((x) => (
                <option key={x.id} value={x.id}>
                  {providerAccountLabel(x)}
                  {x.owner ? ` · ${x.owner}'s` : ""}
                </option>
              ))}
            </Select>
          </label>

          {accountId && (
            <label className={FIELD_LABEL} title="Out of usage, runs switch to the fallback model rather than the shared pool, so this account's limits cap the cost. Prefer it rotates into the pool instead.">
              When the pinned account is out of usage
              <Select
                value={accountStrict ? "strict" : "pool"}
                onChange={(e) => setAccountStrict(e.target.value === "strict")}
                disabled={sandbox}
              >
                <option value="strict">This account only · fall back by model (cost cap)</option>
                <option value="pool">Prefer it · fall back to the shared pool</option>
              </Select>
            </label>
          )}

          <label className={FIELD_LABEL} title="Pay-as-you-go spend past the subscription's included limits. Only applies to accounts with extra usage enabled at claude.ai, bounded by their monthly credit cap.">
            Usage credits
            <Select
              value={usageCredits ? "allow" : "never"}
              onChange={(e) => setUsageCredits(e.target.value === "allow")}
            >
              <option value="never">Never · stop or fall back at the limit</option>
              <option value="allow">Allowed · keep going on paid credits</option>
            </Select>
          </label>
        </div>
      )}

      {error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

      <div className={FORM_ACTIONS}>
        {onBack && (
          <Button
            variant="ghost"
            className={mergeStylexOverrideClassName("", sx.mrAuto)}
            icon={<IconChevronLeft size={20} />}
            onClick={onBack}
            disabled={saving}
          >
            Back
          </Button>
        )}
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={
            saving ||
            !name.trim() ||
            !prompt.trim() ||
            !scheduleValid ||
            !watchValid ||
            (sandbox && !accountId)
          }
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create automation"}
        </Button>
      </div>
    </>
  );
}
