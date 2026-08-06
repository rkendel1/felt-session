import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
  capturePreviewShot,
  type PreviewStatus,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { CopyCheck, useCopy } from "../ui/copy";
import { Menu } from "../ui/menu";
import { Popover } from "../ui/popover";
import {
  IconArrowUpRight,
  IconCamera,
  IconChevronDown,
  IconLink,
  IconPlay,
  IconPlayOutline,
} from "./icons";

// Any worktree session gets the control; whether a repo can actually boot a
// preview comes back on the status itself (`bootable` — repo-committed
// .opensession/start.sh → configured previewCommand).
// Repos with no mechanism show a disabled button explaining what to add.
function isPreviewable(session: UnifiedSession): boolean {
  return !!session.worktreeDir;
}

const headerIconBase =
  "inline-flex cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent px-[5px] py-[3px] text-faint no-underline";

const splitSegmentBase =
  "inline-flex items-center justify-center border border-line-strong bg-transparent text-dim";

const spinnerClass =
  "size-[10px] shrink-0 rounded-full border-[1.5px] border-line-strong border-t-accent animate-[preview-spin_0.7s_linear_infinite]";

const popoverActionClass =
  "w-full rounded-sm border border-[rgba(248,81,73,0.4)] bg-transparent px-2.5 py-[5px] text-xs font-semibold text-red disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent hover:bg-[rgba(248,81,73,0.12)]";

/**
 * Header control for a session's local dev server ("Preview"). When the
 * webapp is up it links to it (`https://<host>:<httpsPort>` — a Caddy-fronted
 * secure origin over the tailnet); when it's off, a ▶ play button starts it
 * (runs the repo's preview boot script in the worktree), showing a
 * "Starting…" state until the server is listening. A caret popover lists the
 * dev services and can stop them. Renders for any session with a worktree;
 * repos without a boot mechanism get a disabled state pointing at the docs.
 */
export function PreviewButton({
  session,
  onAttachImage,
  onStatusChange,
  onOpenTab,
  variant = "bar",
}: {
  session: UnifiedSession;
  /** Open the in-app Preview view-tab instead of a new window/interstitial —
   *  the default wherever App provides it (the Mac shell turned window.opens
   *  into stray Electron windows). The interstitial flow stays for contexts
   *  without a tab (phones, PreviewWait deep links). */
  onOpenTab?: () => void;
  /** When set, the snapshot modal offers "Attach to session" (stages the PNG as a
   *  composer image, like a paste). */
  onAttachImage?: (dataUrl: string) => void;
  /** Mirrors the polled status to the parent so other preview affordances can
   *  appear and disappear with the dev server without polling it twice. */
  onStatusChange?: (status: PreviewStatus | null) => void;
  /** "bar" = the full segmented split button (right panel's action row);
   *  "header" = a single state-colored ▶ icon for the session header, sized to
   *  match the panel-toggle icon it sits beside. "action" = a compact cell for
   *  the mobile workspace Actions grid. "menu" = a single overflow-menu row. */
  variant?: "bar" | "header" | "action" | "menu";
}) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  const previewable = isPreviewable(session);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  // Poll the dev-server status while this session is open. Poll faster while a
  // bring-up is in flight so the button flips to the live link promptly; `ss`
  // is cheap and only the active SessionViewer is mounted.
  const busy = starting || (status?.starting ?? false);
  useEffect(() => {
    if (!previewable) {
      setStatus(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPreview(session.id)
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, busy ? 3000 : 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session.id, previewable, busy]);

  // Once the webapp is actually up, drop the optimistic "starting" flag.
  useEffect(() => {
    if (status?.running) setStarting(false);
  }, [status?.running]);

  // Dismissal (outside press, Escape) comes from ui/popover — the popup is
  // portalled, so a hand-rolled "outside click" test against wrapRef would
  // read every press inside the popup as outside and close it.

  if (!previewable || !status) return null;

  // The webapp is only openable once Caddy has fronted it with an HTTPS origin
  // (previewUrl). A secure origin is required for the app to load fully.
  const running = status.running && status.previewUrl != null;
  // Deep-link to the route the agent flagged (set_preview_path), so the human
  // lands on the feature under test instead of the app root.
  const url = status.previewUrl
    ? withPreviewPath(status.previewUrl, session.previewPath)
    : "#";
  const anyRunning = status.services.some((s) => s.running);
  const isStarting = busy && !running;
  // Absent on pre-field servers — treat as bootable so the button still works
  // against a not-yet-restarted backend.
  const bootable = status.bootable !== false;
  const notBootableHint = `No preview boot mechanism for this repo — commit an .opensession/start.sh to the repo, or set previewCommand on its repos config entry`;

  // Same-origin interstitial that waits for the boot and then redirects itself
  // to the preview (PreviewWait.tsx). The agent-flagged deep link rides along
  // so the redirect lands where a click on the live link would.
  const waitUrl =
    `${BASE_PATH}/preview-wait/${encodeURIComponent(session.id)}` +
    (session.previewPath ? `?path=${encodeURIComponent(session.previewPath)}` : "");

  async function start() {
    // In-app tab flow: opening the tab both starts the preview (the pane
    // kicks the claim) and shows its progress — no popup, no interstitial.
    if (onOpenTab) {
      onOpenTab();
      return;
    }
    // Poll lag can leave a Start affordance up when the server is already
    // running — nothing to wait for, open the app directly. (Out-of-scope
    // origin, so installed PWAs hand this to a normal browser context.)
    if (status?.running && status.previewUrl) {
      window.open(url, `preview-${session.id}`, "noopener");
      return;
    }
    // Popup-blocker-safe "open when ready": window.open must fire synchronously
    // inside the click gesture, but the preview URL doesn't exist yet — so open
    // the interstitial NOW and let it redirect itself once the status endpoint
    // reports running. On the iOS PWA this opens the in-app browser view — a
    // new context, never replacing the app window. A blocked open returns null
    // and simply degrades to today's inline starting state.
    // Per-session window NAME (not _blank): reopening the same session's
    // preview reuses its own tab instead of spawning duplicates, and — the
    // real reason — a coalesced/reused browser view (iOS PWA in-app sheet)
    // can never end up showing ANOTHER session's interstitial (seen live
    // 2026-07-23: several sessions all presented preview-wait/<other-id>).
    const wait = window.open(waitUrl, `preview-${session.id}`);
    setStarting(true);
    try {
      const s = await startPreviewApi(session.id);
      setStatus(s);
      // Nothing actually started (repo not bootable, sandbox gate off) — don't
      // leave the interstitial spinning toward a boot that will never come.
      if (!s.running && !s.starting) wait?.close();
    } catch {
      setStarting(false);
      wait?.close();
    }
  }

  async function stop() {
    setStopping(true);
    try {
      setStatus(await stopPreviewApi(session.id));
      setStarting(false);
    } catch {
    } finally {
      setStopping(false);
    }
  }

  async function snap() {
    if (snapping) return;
    setSnapping(true);
    setShotError(null);
    try {
      setShot(await capturePreviewShot(session.id));
    } catch (e: any) {
      setShotError(e.message);
      setShot(null);
    }
    setSnapping(false);
    // Hand over to the snapshot modal. The popup keeps its "Capturing…" label
    // until the result lands, then steps aside — it is portalled at the popover
    // layer, above this modal, so leaving it open would cover the screenshot.
    setOpen(false);
  }

  // Shared snapshot preview modal — rendered by both layouts.
  const snapshotModal = (shot || shotError) && (
    <div
      className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          setShot(null);
          setShotError(null);
        }
      }}
    >
      <div className="bg-raised border border-line rounded-panel shadow-2xl p-3 max-w-[90vw] max-h-[90vh] flex flex-col gap-2.5">
        {shotError ? (
          <div className="text-red text-[13px] px-2 py-4">{shotError}</div>
        ) : (
          <img
            src={shot!}
            alt="Preview screenshot"
            className="max-w-full max-h-[75vh] object-contain rounded-md border border-line"
          />
        )}
        <div className="flex items-center gap-2 justify-end">
          {shot && onAttachImage && (
            <Button
              variant="primary"
              size="sm"
              className="px-[14px] py-1"
              onClick={() => {
                onAttachImage(shot);
                setShot(null);
              }}
            >
              Attach to session
            </Button>
          )}
          {shot && (
            <a
              className="inline-flex min-h-[26px] items-center justify-center whitespace-nowrap rounded-xs border border-line bg-control px-2.5 text-xs font-[550] text-dim shadow-control transition hover:border-line-strong hover:text-fg active:scale-[0.97]"
              href={shot}
              download={`preview-${session.id}.png`}
            >
              Download
            </a>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              setShot(null);
              setShotError(null);
            }}
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );

  // Shared dev-services popover — the stop/start control and per-service list.
  // In header mode it also carries the snapshot action (there's no caret for it).
  // Anchored to the whole control cluster rather than to one trigger, because
  // every variant can open it from more than one place (caret, right-click, the
  // disabled button) — `align="end"` then reproduces the old `right-0` edge.
  const servicesPopup = (
    <Popover.Popup
      anchor={wrapRef}
      side="bottom"
      align="end"
      sideOffset={6}
      // Holds real controls, so let the keyboard in (the hover cards on this
      // primitive deliberately don't take focus).
      initialFocus
      className="min-w-[240px] p-2.5"
    >
      <div className="mb-2 text-[11px] font-bold tracking-[-0.01em] text-faint">Dev services</div>
      {status.services.length === 0 ? (
        <div className="px-0 py-1 text-xs text-faint">
          {isStarting ? "Starting up…" : "Not started yet"}
        </div>
      ) : (
        <ul className="mb-2 flex list-none flex-col gap-[5px] p-0">
          {status.services.map((s) => (
            <li key={s.key} className="flex items-center gap-[7px] text-xs text-dim">
              <span
                className={cn(
                  "size-[7px] shrink-0 rounded-full",
                  s.running
                    ? "bg-green shadow-[0_0_0_2px_rgba(63,185,80,0.18)]"
                    : "bg-[var(--text-faint)] shadow-none",
                )}
              />
              <span className="font-semibold">{s.name}</span>
              <span className="text-faint">:{s.port}</span>
              <span className={cn("ml-auto text-[11px] text-faint", s.running && "text-green")}>
                {s.running ? "running" : "stopped"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {running || anyRunning ? (
        <button className={popoverActionClass} onClick={stop} disabled={!anyRunning || stopping}>
          {stopping ? "Stopping…" : "Stop dev server"}
        </button>
      ) : isStarting ? (
        <button className={popoverActionClass} onClick={stop} disabled={stopping}>
          {stopping ? "Cancelling…" : "Cancel startup"}
        </button>
      ) : bootable ? (
        <button className={popoverActionClass} onClick={start}>
          Start dev server
        </button>
      ) : (
        <div className="px-0 py-1 text-xs text-faint">{notBootableHint}.</div>
      )}
      {variant !== "bar" && running && (
        <button className={cn(popoverActionClass, "mt-1.5")} onClick={snap} disabled={snapping}>
          {snapping ? "Capturing…" : "Snapshot preview"}
        </button>
      )}
      {/* Compact modes have no room for dedicated snapshot/copy segments, so
          those actions live here. The bar layout keeps its split controls. */}
      {variant !== "bar" && running && (
        <button
          className={cn(popoverActionClass, "mt-1.5")}
          onClick={() => copy(url, { toast: "Preview link copied" })}
        >
          Copy preview link
        </button>
      )}
      <div className="mt-1.5 text-center text-meta text-faint">
        {running || anyRunning ? (
          "Stops this worktree's dev process group only."
        ) : bootable ? (
          "Runs the repo's preview boot script in this worktree (first build ~1 min)."
        ) : (
          "Add .opensession/start.sh or configure previewCommand."
        )}
      </div>
    </Popover.Popup>
  );

  // Right-click and disabled-state paths only OPEN the popup: the caret is a
  // real Popover.Trigger and owns toggling, so a second toggling opener would
  // race Base UI's outside-press dismissal (which fires on the press first,
  // then our handler would reopen what it just closed).
  const openServices = (e?: React.MouseEvent) => {
    e?.preventDefault();
    setOpen(true);
  };

  if (variant === "menu") {
    return (
      <Menu.Item
        disabled={!bootable && !isStarting}
        onClick={() => {
          if (isStarting) void stop();
          else void start();
        }}
        title={bootable ? "Open or start the local preview" : notBootableHint}
      >
        {isStarting ? (
          <span className={spinnerClass} />
        ) : (
          <IconPlayOutline size={20} className={running ? "text-green" : "text-faint"} />
        )}
        <span className="grow">
          {isStarting ? "Cancel preview startup" : running ? "Open preview" : "Preview"}
        </span>
      </Menu.Item>
    );
  }

  if (variant === "action") {
    const mainClass =
      "flex min-w-0 flex-1 items-center gap-2 rounded-md rounded-r-none px-2.5 py-2 text-left text-supporting font-semibold text-fg no-underline outline-none transition-colors hover:bg-hover focus-visible:bg-hover disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50";
    const mainContent = (
      <>
        <span className="inline-flex size-5 shrink-0 items-center justify-center text-faint">
          {isStarting ? <span className={spinnerClass} /> : <IconPlay size={17} />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {isStarting ? (stopping ? "Cancelling…" : "Starting…") : "Preview"}
        </span>
      </>
    );

    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div className="relative flex min-w-0" ref={wrapRef}>
          {running ? (
            <a
              className={mainClass}
              href={url}
              target="_blank"
              rel="noopener"
              title={`Open the webapp — ${url}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  copy(url, { toast: "Preview link copied" });
                } else if (onOpenTab) {
                  e.preventDefault();
                  onOpenTab();
                }
              }}
            >
              {mainContent}
            </a>
          ) : isStarting ? (
            <button className={mainClass} onClick={stop} disabled={stopping}>
              {mainContent}
            </button>
          ) : !bootable ? (
            <button className={mainClass} onClick={openServices} aria-disabled="true">
              {mainContent}
            </button>
          ) : (
            <button className={mainClass} onClick={start}>
              {mainContent}
            </button>
          )}
          <Popover.Trigger
            render={
              <button
                className="flex w-8 shrink-0 items-center justify-center rounded-md rounded-l-none text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg"
                title="Dev services"
                aria-label="Dev services"
              >
                <IconChevronDown size={16} />
              </button>
            }
          />
          {snapshotModal}
        </div>
        {servicesPopup}
      </Popover.Root>
    );
  }

  // Header mode: a single ▶ icon, color-coded by state (dim=off, amber=starting,
  // green=live), sized to sit next to the panel-toggle icon. Left-click does the
  // primary action; right-click opens the services popover (stop / snapshot).
  // While the server is up (or starting) a small caret rides beside the icon —
  // the popover's stop action was right-click-only and nobody found it
  // (seen live, 2026-07-09).
  if (variant === "header") {
    const menuCaret = (running || anyRunning || isStarting) && (
      <Tooltip label="Dev services — stop the server, snapshot" side="bottom">
        <Popover.Trigger
          render={
            <button
              className={cn(
                headerIconBase,
                "-ml-[3px] px-px py-[3px]",
                open
                  ? "text-green hover:bg-hover hover:text-green"
                  : "text-faint hover:bg-hover hover:text-dim",
              )}
              aria-label="Dev services"
            >
              <IconChevronDown size={16} />
            </button>
          }
        />
      </Tooltip>
    );
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div className="relative inline-flex items-center" ref={wrapRef}>
          {running ? (
            <Tooltip
              label={
                copied
                  ? "Link copied"
                  : "Open the running app — ⌘-click to copy the link, right-click for dev services"
              }
              side="bottom"
            >
              <a
                className={cn(headerIconBase, "text-green hover:bg-hover hover:text-green")}
                href={url}
                target="_blank"
                rel="noopener"
                onContextMenu={openServices}
                onClick={(e) => {
                  // ⌘/Ctrl-click copies instead of opening (the same modifier
                  // semantics as StagingLink's globe).
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    copy(url, { toast: "Preview link copied" });
                    return;
                  }
                  // In-app tab everywhere it exists — the tab's toolbar owns
                  // the break-out; a bare anchor here opened the browser and
                  // made the button feel random (tab sometimes, window others).
                  if (onOpenTab) {
                    e.preventDefault();
                    onOpenTab();
                  }
                }}
              >
                <CopyCheck copied={copied} size={22} idle={<IconPlayOutline size={22} />} />
              </a>
            </Tooltip>
          ) : isStarting ? (
            <Tooltip
              label={stopping ? "Cancelling…" : "Starting the dev server — click to cancel"}
              side="bottom"
            >
              <button
                className={cn(headerIconBase, "text-yellow hover:bg-hover hover:text-yellow")}
                onClick={stop}
                onContextMenu={openServices}
                disabled={stopping}
              >
                <span className="relative inline-flex items-center justify-center">
                  <span
                    className="pointer-events-none absolute left-1/2 top-1/2 size-[25px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-transparent border-t-current opacity-90 animate-[preview-spin_0.7s_linear_infinite]"
                    aria-hidden="true"
                  />
                  <IconPlayOutline size={22} />
                </span>
              </button>
            </Tooltip>
          ) : !bootable ? (
            <Tooltip label={`${notBootableHint} — right-click for details`} side="bottom" multiline>
              <button
                className={cn(
                  headerIconBase,
                  "cursor-not-allowed text-faint opacity-45 hover:bg-hover hover:text-dim",
                )}
                onClick={openServices}
                onContextMenu={openServices}
                aria-disabled="true"
              >
                <IconPlayOutline size={22} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Run — start the dev server (right-click for dev services)" side="bottom">
              <button
                className={cn(headerIconBase, "text-faint hover:bg-hover hover:text-dim")}
                onClick={start}
                onContextMenu={openServices}
              >
                <IconPlayOutline size={22} />
              </button>
            </Tooltip>
          )}
          {menuCaret}
          {snapshotModal}
        </div>
        {servicesPopup}
      </Popover.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="relative inline-flex items-stretch" ref={wrapRef}>
        {running ? (
          <a
            className={cn(
              splitSegmentBase,
              "gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-[13px] font-semibold text-green no-underline",
              "hover:relative hover:z-[1] hover:border-[rgba(63,185,80,0.5)] hover:bg-[rgba(63,185,80,0.12)] hover:text-green",
            )}
            href={url}
            target="_blank"
            rel="noopener"
            title={`Open the webapp — ${url}`}
            onClick={(e) => {
              if (onOpenTab && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                onOpenTab();
              }
            }}
          >
            <IconPlay size={15} className="opacity-90" />
            Preview
            <IconArrowUpRight size={15} className="-ml-px opacity-80" />
          </a>
        ) : isStarting ? (
          <button
            className={cn(
              splitSegmentBase,
              "group gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-[13px] font-semibold text-dim",
              "cursor-pointer hover:relative hover:z-[1] hover:border-[rgba(248,81,73,0.4)] hover:bg-[rgba(248,81,73,0.1)] hover:text-red",
            )}
            onClick={stop}
            disabled={stopping}
            title="Starting the dev server (first build can take a minute) — click to cancel"
          >
            <span className={spinnerClass} />
            <span className="inline group-hover:hidden">
              {stopping ? "Cancelling…" : "Starting…"}
            </span>
            <span className="hidden group-hover:inline">Cancel</span>
          </button>
        ) : !bootable ? (
          <button
            className={cn(
              splitSegmentBase,
              "gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-[13px] font-semibold text-dim opacity-45",
              "cursor-not-allowed",
            )}
            onClick={openServices}
            aria-disabled="true"
            title={`${notBootableHint}.`}
          >
            <IconPlay size={15} className="text-accent" />
            Preview
          </button>
        ) : (
          <button
            className={cn(
              splitSegmentBase,
              "gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-[13px] font-semibold text-dim",
              "cursor-pointer hover:relative hover:z-[1] hover:border-accent hover:bg-accent-soft hover:text-fg",
            )}
            onClick={start}
            title="Start the dev server and preview this session"
          >
            <IconPlay size={15} className="text-accent" />
            Preview
          </button>
        )}
        {/* Copy segment — the split's secondary action. Enabled once a previewUrl
            exists (server up + Caddy fronting it); before that there's no stable
            URL to hand out, so it sits disabled with a hint. */}
        <button
          className={cn(
            splitSegmentBase,
            "-ml-px px-2 py-1",
            running
              ? "text-[color:color-mix(in_srgb,var(--green)_72%,var(--text-dim))] hover:relative hover:z-[1] hover:border-[rgba(63,185,80,0.5)] hover:bg-[rgba(63,185,80,0.12)] hover:text-green"
              : "hover:relative hover:z-[1] hover:border-accent hover:bg-accent-soft hover:text-accent",
            "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:border-line-strong aria-disabled:hover:bg-transparent aria-disabled:hover:text-dim",
          )}
          onClick={() => {
            if (running) copy(url, { toast: "Preview link copied" });
          }}
          aria-disabled={!running || undefined}
          title={running ? `Copy the preview link — ${url}` : "Start the preview first"}
        >
          <CopyCheck copied={copied} size={18} idle={<IconLink size={18} />} />
        </button>
        {running && (
          <button
            className={cn(
              splitSegmentBase,
              "-ml-px px-2 py-1 text-[color:color-mix(in_srgb,var(--green)_72%,var(--text-dim))]",
              "hover:relative hover:z-[1] hover:border-[rgba(63,185,80,0.5)] hover:bg-[rgba(63,185,80,0.12)] hover:text-green",
            )}
            onClick={snap}
            disabled={snapping}
            title="Snapshot the preview (headless Chrome screenshot)"
          >
            {snapping ? <span className={spinnerClass} /> : <IconCamera size={18} />}
          </button>
        )}
        <Popover.Trigger
          render={
            <button
              className={cn(
                splitSegmentBase,
                "-ml-px rounded-r-[calc(5px*var(--rf))] px-2 py-1",
                running
                  ? "text-[color:color-mix(in_srgb,var(--green)_72%,var(--text-dim))]"
                  : "text-dim",
                open || running
                  ? "relative z-[1] border-[rgba(63,185,80,0.5)] bg-[rgba(63,185,80,0.12)] text-green"
                  : "",
                !running && "hover:relative hover:z-[1] hover:border-accent hover:bg-accent-soft hover:text-accent",
                running && !open &&
                  "hover:relative hover:z-[1] hover:border-[rgba(63,185,80,0.5)] hover:bg-[rgba(63,185,80,0.12)] hover:text-green",
              )}
              title="Dev server processes"
            >
              <IconChevronDown size={16} />
            </button>
          }
        />

        {snapshotModal}
      </div>
      {servicesPopup}
    </Popover.Root>
  );
}
