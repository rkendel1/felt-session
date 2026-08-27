import React, { useCallback, useEffect, useState } from "react";
import { Popover } from "../ui/popover";
import {
	fetchSessionSandbox,
	sandboxAction,
	type SessionSandboxStatus,
} from "../lib/api/sandboxes";
import { IconBox, IconConnections } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH10: {
			minHeight: "40px"
	},
	flexNone: {
			flex: "none"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	px2: {
			paddingInline: "8px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	w300px: {
			width: "300px"
	},
	p25: {
			padding: "10px"
	},
	pb2: {
			paddingBottom: "8px"
	},
	pt1: {
			paddingTop: "4px"
	},
	gap2: {
			gap: "8px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	mt1: {
			marginTop: "4px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	py15: {
			paddingBlock: "6px"
	},
	textRed: {
			color: "var(--red)"
	},
	px25: {
			paddingInline: "10px"
	},
	py2: {
			paddingBlock: "8px"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	mt2: {
			marginTop: "8px"
	},
	maxH48: {
			maxHeight: "192px"
	},
	overflowAuto: {
			overflow: "auto"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
  leadingRelaxed: { lineHeight: "var(--leading-relaxed)" },
  dot: { width: "8px", height: "8px", borderRadius: "50%",
		cornerShape: "var(--cs)",},
  bgGreen: { backgroundColor: "var(--green)" },
  bgYellow: { backgroundColor: "var(--yellow)" },
  bgFaint: { backgroundColor: "var(--text-faint)" },
  action: {
    display: "flex",
    minHeight: "40px",
    width: "100%",
    alignItems: "center",
    borderRadius: "calc(7px * var(--rf))",
    paddingInline: "10px",
    textAlign: "left",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--text-dim)",
    outlineStyle: "none",
    transitionProperty: "color, background-color, scale",
    ":hover": { "@media (hover: hover)": { backgroundColor: "var(--hover)", color: "var(--text)" } },
    ":focusVisible": { backgroundColor: "var(--hover)", color: "var(--text)" },
    ":active": { scale: 0.96 },
    ":disabled": { pointerEvents: "none", opacity: 0.45 },

		cornerShape: "var(--cs)",},

	transitionColorBackgroundColorBorderColorScale: {
		"transitionProperty": "color,background-color,border-color,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverBorderLineStrong: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--border-strong)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	focusVisibleBorderLineStrong: {
		":focusVisible": {
			"borderColor": "var(--border-strong)"
		}
	},
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
});

type SandboxRef = {
	provider: string;
	sandboxId?: string;
	workspace?: "bind" | "volume";
};

type RunnerRef = {
	id: string;
	name: string;
	workspacePath: string;
	lifecycle?: "preparing" | "awake" | "offline" | "needs_attention";
	lastLifecycleError?: string;
};

/** Live sandbox status + lifecycle controls. The compact trigger remains the
 * old provider badge; opening it resolves provider state without polling every
 * session row in the background. */
export function SandboxBadge({
	sessionId,
	sandbox,
	runner,
}: {
	sessionId: string;
	sandbox?: SandboxRef;
	runner?: RunnerRef;
}) {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<SessionSandboxStatus | null>(null);
	const [working, setWorking] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		await (async () => {
setStatus(await fetchSessionSandbox(sessionId));
			setError(null);
})().catch(async (cause: any) => {
setError(cause?.message || "Sandbox status unavailable");
});
	}, [sessionId]);

	useEffect(() => {
		if (runner) return;
		if (!open) return;
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => clearInterval(timer);
	}, [open, load, runner]);

	if (runner) {
    const label =
      runner.lifecycle === "awake"
        ? "Ready"
        : runner.lifecycle === "offline"
          ? "Offline"
          : runner.lifecycle === "needs_attention"
            ? "Needs attention"
            : "Preparing";
    const dot =
      runner.lifecycle === "awake"
        ? sx.bgGreen
        : runner.lifecycle === "offline" ||
            runner.lifecycle === "needs_attention"
          ? sx.bgFaint
          : sx.bgYellow;
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          {...mergeStylexProps("", sx.transitionColorBackgroundColorBorderColorScale, sx.hoverBorderLineStrong, sx.hoverTextFg, sx.focusVisibleBorderLineStrong, sx.activeScale096, sx.flex, sx.minH10, sx.flexNone, sx.itemsCenter, sx.gap15, sx.roundedMd, sx.border, sx.borderLine, sx.bgSurface, sx.px2, sx.fontMedium, sx.textDim, sx.outlineNone, typography.meta)}
          aria-label={`Runner · ${runner.name} · ${label}`}
        >
          <span {...stylex.props(sx.dot, dot)} aria-hidden="true" />
          <IconConnections size={20} className={mergeStylexOverrideClassName("", sx.textFaint)} />
          <span>{runner.name}</span>
			</Popover.Trigger>
        <Popover.Popup
          side="bottom"
          align="start"
          initialFocus
          className={mergeStylexOverrideClassName("", sx.w300px, sx.p25)}
        >
          <div {...stylex.props(sx.px2, sx.pb2, sx.pt1)}>
            <div
              {...stylex.props(
                sx.flex,
                sx.itemsCenter,
                sx.gap2,
                sx.textXs,
                sx.fontSemibold,
                sx.textFg,
              )}
            >
              <span {...stylex.props(sx.dot, dot)} />
              <span>{label}</span>
              <span {...stylex.props(sx.mlAuto, sx.fontMedium, sx.textFaint)}>
                Runtime
              </span>
            </div>
            <div {...stylex.props(sx.mt1, sx.textDim, typography.meta)}>
              Runner · trusted machine
            </div>
            <div
              {...stylex.props(
                sx.mt1,
                sx.truncate,
                sx.fontMono,
                sx.textFaint,
                typography.meta,
              )}
              title={runner.workspacePath}
            >
              {runner.workspacePath}
            </div>
          </div>
          {runner.lastLifecycleError ? (
            <div
              {...stylex.props(
                sx.px2,
                sx.py15,
                sx.fontMedium,
                sx.textRed,
                typography.meta,
              )}
            >
              {runner.lastLifecycleError}
            </div>
          ) : null}
			</Popover.Popup>
      </Popover.Root>
    );
	}

	if (!sandbox?.provider || sandbox.provider === "local") return null;
	const state = status?.status || (sandbox.sandboxId ? "running" : "gone");
  const lifecycle =
    status?.lifecycle ||
    (state === "running"
      ? "awake"
      : state === "stopped"
        ? "sleeping"
        : "needs_attention");
	const lifecycleLabel: Record<typeof lifecycle, string> = {
    preparing: "Preparing",
    awake: "Awake",
    sleeping: "Sleeping",
    waking: "Waking",
    needs_attention: "Needs attention",
	};
	const dot =
		lifecycle === "awake"
      ? sx.bgGreen
			: lifecycle === "sleeping" || lifecycle === "waking"
        ? sx.bgYellow
        : sx.bgFaint;

	async function act(action: "pause" | "resume" | "recreate") {
		if (
			action === "recreate" &&
			!window.confirm(
				"Recreate this sandbox? Unpushed files that exist only inside it will be deleted.",
			)
		)
			return;
		setWorking(action);
		setError(null);
		await (async () => {
setStatus(await sandboxAction(sessionId, action));
    })()
      .catch(async (cause: any) => {
setError(cause?.message || `Could not ${action} sandbox`);
      })
      .finally(async () => {
setWorking(null);
});
	}

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
        {...mergeStylexProps("", sx.transitionColorBackgroundColorBorderColorScale, sx.hoverBorderLineStrong, sx.hoverTextFg, sx.focusVisibleBorderLineStrong, sx.activeScale096, sx.flex, sx.minH10, sx.flexNone, sx.itemsCenter, sx.gap15, sx.roundedMd, sx.border, sx.borderLine, sx.bgSurface, sx.px2, sx.fontMedium, sx.textDim, sx.outlineNone, typography.meta)}
				data-testid="sandbox-badge"
				aria-label={`Sandbox · ${lifecycleLabel}`}
			>
        <span {...stylex.props(sx.dot, dot)} aria-hidden="true" />
				<IconBox size={20} className={mergeStylexOverrideClassName("", sx.textFaint)} />
				<span>Sandbox</span>
			</Popover.Trigger>
			<Popover.Popup
				side="bottom"
				align="start"
				initialFocus
				className={mergeStylexOverrideClassName("", sx.w300px, sx.p25)}
			>
				<div {...stylex.props(sx.px2, sx.pb2, sx.pt1)}>
          <div
            {...stylex.props(
              sx.flex,
              sx.itemsCenter,
              sx.gap2,
              sx.textXs,
              sx.fontSemibold,
              sx.textFg,
            )}
          >
            <span {...stylex.props(sx.dot, dot)} />
						<span>{lifecycleLabel[lifecycle]}</span>
            <span {...stylex.props(sx.mlAuto, sx.fontMedium, sx.textFaint)}>
              Runtime
            </span>
					</div>
          <div {...stylex.props(sx.mt1, sx.textDim, typography.meta)}>
            {sandbox.provider} · session workspace
          </div>
					{status?.cwd ? (
            <div
              {...stylex.props(
                sx.mt1,
                sx.truncate,
                sx.fontMono,
                sx.textFaint,
                typography.meta,
              )}
              title={status.cwd}
            >
							{status.cwd}
						</div>
					) : null}
				</div>
				{lifecycle === "awake" && status?.canPause ? (
					<button
            {...stylex.props(sx.action, typography.meta)}
						disabled={Boolean(working || status.busy)}
						onClick={() => void act("pause")}
					>
						{working === "pause" ? "Sleeping…" : "Sleep sandbox"}
					</button>
				) : null}
        {(lifecycle === "sleeping" || lifecycle === "needs_attention") &&
        status?.canResume ? (
					<button
            {...stylex.props(sx.action, typography.meta)}
						disabled={Boolean(working)}
						onClick={() => void act("resume")}
					>
						{working === "resume" ? "Waking…" : "Wake sandbox"}
					</button>
				) : null}
				<button
          {...stylex.props(sx.action, sx.textRed, typography.meta)}
					disabled={Boolean(working || status?.busy)}
					onClick={() => void act("recreate")}
				>
					{working === "recreate" ? "Recreating…" : "Recreate from clean image"}
				</button>
				{status?.logs?.setup || status?.logs?.resume ? (
          <details
            {...stylex.props(
              sx.mt1,
              sx.roundedMd,
              sx.bgSurface,
              sx.px25,
              sx.py2,
              sx.textDim,
              typography.meta,
            )}
          >
            <summary
              {...stylex.props(sx.cursorPointer, sx.fontSemibold, sx.textFg)}
            >
              Lifecycle logs
            </summary>
            <pre
              {...stylex.props(
                sx.mt2,
                sx.maxH48,
                sx.overflowAuto,
                sx.whitespacePreWrap,
                sx.fontMono,
                sx.leadingRelaxed,
                typography.meta,
              )}
            >
							{status.logs.setup ? `setup\n${status.logs.setup}` : ""}
							{status.logs.resume ? `\nresume\n${status.logs.resume}` : ""}
						</pre>
					</details>
				) : null}
        {status?.lastLifecycleError || error ? (
          <div
            {...stylex.props(
              sx.px2,
              sx.py15,
              sx.fontMedium,
              sx.textRed,
              typography.meta,
            )}
          >
            {status?.lastLifecycleError || error}
          </div>
        ) : null}
			</Popover.Popup>
		</Popover.Root>
	);
}
