import { useCallback, useEffect, useRef, useState } from "react";
import { recordSessionPerf } from "../lib/session-performance";

// Scroll engineering for the transcript. The guiding rule: never move the reader
// against their intent. The reader's own scroll position is the source of truth
// for whether we keep them glued to the live edge ("following"). We only stick to
// the bottom while they're actually there; the moment they scroll up — or select
// text, which is also intent — we leave them where they are and surface a
// "Jump to latest" affordance instead.
//
// New turns are pinned near the top of the viewport so their reply can stream into
// the space below while earlier context stays visible (principles 4–6). That needs
// a bottom spacer: a freshly-sent message is the last element, so without reserved
// space below it the browser can't scroll it up to the top. The spacer is sized to
// exactly the room the latest turn needs and shrinks to nothing as the reply fills
// it — so once the answer is long enough the spacer vanishes and scrolling is normal.
//
// The load-bearing subtlety: the browser fires scroll events for layout causes too
// (the pin's own anchor animation, clamps when stream text swaps for the final
// entry) and those always land "at the edge" — the pinned position IS the padded
// scroll max. So following only ever RE-engages from gesture-backed scrolls
// (wheel/touch/scrollbar drag) or explicit actions (jump button); position alone
// is never proof of intent.

// Distance from the bottom (px) that still counts as "at the live edge".
const STICK_THRESHOLD = 90;
// Gap left above a pinned turn so a little previous context stays visible.
const TOP_GAP = 20;
// Touch devices get instant pin scrolls: iOS Safari drops smooth programmatic
// scrolls during keyboard/visual-viewport animation, leaving the pin stranded
// at an intermediate position.
const COARSE_POINTER =
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

export interface SessionScroll {
  /** Attach to the scrollable transcript container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to a zero-content div rendered as the last child of the container. */
  spacerRef: React.RefObject<HTMLDivElement | null>;
  /** True while the reader is pinned to the live edge and we may auto-advance. */
  following: boolean;
  /** Live ref of `following` for rAF loops that outrun React renders. */
  followingLive: React.RefObject<boolean>;
  /** True when content has streamed in below the fold while not following. */
  newBelow: boolean;
  /** True when the latest message is out of view and the return control should show. */
  showScrollToBottom: boolean;
  /** Bring the reader back to the latest reply and resume following. */
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  /** Stop following because the reader is intentionally moving into history. */
  leaveLatest: () => void;
  /** Pin a turn near the top of the viewport (used for reopening at the last turn). */
  anchorToTop: (target: HTMLElement | null, behavior?: ScrollBehavior) => void;
  /** Mark that the local reader just sent a turn — pin it to the top next paint. */
  beginTurn: () => void;
  /** The turn finished; release the spacer so the layout settles. */
  endTurn: () => void;
  /** Call after each content change (run in a layout effect) to keep things in place. */
  relayout: () => void;
  /** Wire to the container's onScroll to track the live edge. */
  onScroll: () => void;
}

function selectionWithin(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

function lastUserEl(container: HTMLElement): HTMLElement | null {
  const els = container.querySelectorAll<HTMLElement>(".msg-user");
  return els[els.length - 1] ?? null;
}

// The container's top edge as the reader actually sees it. On iOS the on-screen
// keyboard doesn't shrink the layout viewport — Safari pans the *visual*
// viewport down to keep the focused composer visible — so client-rect
// coordinates (and clientHeight) describe a window partly above/behind what's
// on screen. Anchoring a pinned turn to the raw container top then parks it
// above the visible area and the reader sees only the spacer: empty space.
// All pin math measures from this clipped top instead. In the standalone PWA
// visualViewport stays inert (offsetTop 0), which degrades to the raw top.
function visibleTop(el: HTMLElement): number {
  const rectTop = el.getBoundingClientRect().top;
  const vv = window.visualViewport;
  if (!vv) return rectTop;
  return Math.max(rectTop, vv.offsetTop);
}

function latestMessageVisible(container: HTMLElement): boolean {
  const els = container.querySelectorAll<HTMLElement>(".msg");
  const latest = els[els.length - 1];
  if (!latest) return true;
  const containerRect = container.getBoundingClientRect();
  const latestRect = latest.getBoundingClientRect();
  return latestRect.bottom > containerRect.top && latestRect.top < containerRect.bottom;
}

export function useSessionScroll(initialFollowing = true): SessionScroll {
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // followingRef is the live value read inside handlers; `following` mirrors it for
  // rendering. Default true so a fresh, running session tracks the stream.
  const followingRef = useRef(initialFollowing);
  const [following, setFollowingState] = useState(initialFollowing);
  const [newBelow, setNewBelow] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Whether the latest turn is currently pinned to the top (spacer active).
  const pinnedRef = useRef(false);
  // Set on send; consumed once to perform the one-time scroll-to-top.
  const needAnchorRef = useRef(false);
  // Where the pin parked the reader (scrollTop). While they're still there,
  // relayout actively holds the pinned turn at TOP_GAP through DOM swaps —
  // the pending bubble → real entry replacement shifts/clamps scrollTop, and
  // at scroll-max the browser's scroll anchoring keeps the BOTTOM edge stable
  // instead, dragging the reader from the pinned turn to the live edge.
  const pinTopRef = useRef<number | null>(null);
  // Expiry (performance.now()) of an in-flight programmatic smooth scroll.
  // Its intermediate scroll events pass through "not at the edge" positions;
  // reading those as reader intent turned following off mid-animation, so a
  // jump-to-latest during a fast stream landed short of the grown bottom and
  // never stuck. While in flight we only ever re-engage (on arrival); a real
  // gesture (wheel/touch) or the deadline cancels the flight.
  const autoFlightRef = useRef(0);
  // Timestamps of the last real reader gestures. Scroll events without a
  // recent gesture are layout-driven — the pin's anchor animation, or the
  // clamp when stream text swaps for the final transcript entry — and must
  // never RE-engage following: the pinned position sits exactly at the padded
  // scroll max, so those events always read as "at the edge" and used to
  // dissolve the pin (on send) or yank the view to the bottom (on turn end).
  // Touch gets a long window of its own: iOS momentum keeps scrolling for
  // seconds after the last touch event, with no scrollend support to lean on.
  const lastGestureRef = useRef(0);
  const lastTouchRef = useRef(0);
  // True while the pointer is dragging the scrollbar (classic scrollbars hit
  // the container itself past clientWidth; overlay scrollbars aren't
  // detectable — those readers re-engage via wheel/touch or the jump button).
  const scrollbarDragRef = useRef(false);
  // A cached session can mount while intentionally reading history. Its first
  // relayout describes restored content, not content that arrived below it.
  const hasRelayoutRef = useRef(false);
  const scrollPerfRef = useRef({ raf: 0, startedAt: 0, frames: 0 });

  const distanceFromBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const clearSpacer = useCallback(() => {
    pinnedRef.current = false;
    needAnchorRef.current = false;
    pinTopRef.current = null;
    if (spacerRef.current) spacerRef.current.style.height = "0px";
    // Hand scroll anchoring back to the browser (disabled while pinned).
    if (containerRef.current) containerRef.current.style.overflowAnchor = "";
  }, []);

  const setFollowing = useCallback((v: boolean) => {
    followingRef.current = v;
    setFollowingState(v);
    if (v) {
      // Returning to the live edge ends any pinned turn and clears the unread flag.
      setNewBelow(false);
      setShowScrollToBottom(false);
      clearSpacer();
    }
  }, [clearSpacer]);

  const updateScrollToBottomVisibility = useCallback((isFollowing = followingRef.current) => {
    const el = containerRef.current;
    setShowScrollToBottom(Boolean(el && !isFollowing && !latestMessageVisible(el)));
  }, []);

  const leaveLatest = useCallback(() => {
    autoFlightRef.current = 0;
    lastGestureRef.current = 0;
    lastTouchRef.current = 0;
    scrollbarDragRef.current = false;
    setFollowing(false);
    updateScrollToBottomVisibility(false);
  }, [setFollowing, updateScrollToBottomVisibility]);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = containerRef.current;
      if (!el) return;
      clearSpacer();
      if (behavior === "smooth") autoFlightRef.current = performance.now() + 1200;
      el.scrollTo({ top: el.scrollHeight, behavior });
      setFollowing(true);
    },
    [clearSpacer, setFollowing]
  );

  const anchorToTop = useCallback((target: HTMLElement | null, behavior?: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el || !target) return;
    // Callers may force "auto" when an instant reopen-anchor jump is preferable
    // to an animation that can be disturbed by transcript layout changes.
    const resolved: ScrollBehavior =
      behavior ?? (COARSE_POINTER ? "auto" : "smooth");
    const instant = resolved !== "smooth";
    const delta = target.getBoundingClientRect().top - visibleTop(el) - TOP_GAP;
    if (delta <= 0) {
      // Already at or above the target — don't scroll up. For a pinned turn
      // this IS the pin position; remember it so relayout holds it.
      if (pinnedRef.current) pinTopRef.current = el.scrollTop;
      return;
    }
    const finalFromBottom = el.scrollHeight - (el.scrollTop + delta) - el.clientHeight;
    if (pinnedRef.current) pinTopRef.current = el.scrollTop + delta;
    el.scrollTo({ top: el.scrollTop + delta, behavior: resolved });
    // An instant scroll can land clamped (sub-pixel or scroll-max rounding);
    // record where it actually parked so relayout's hold engages.
    if (instant && pinnedRef.current) pinTopRef.current = el.scrollTop;
    // A reopen-anchor that lands at the live edge anyway keeps following (with
    // a flight so the animation's mid positions don't disengage it). A pinned
    // turn must stop following instead: its padded "edge" is fake, and the
    // reply streams into the reserved space below.
    if (!pinnedRef.current && finalFromBottom < STICK_THRESHOLD) {
      if (!instant) autoFlightRef.current = performance.now() + 1200;
      return;
    }
    // Leaving the live edge to read from the top is intent: stop following so the
    // streaming reply fills the space below instead of yanking us back down.
    setFollowing(false);
    updateScrollToBottomVisibility(false);
  }, [setFollowing, updateScrollToBottomVisibility]);

  // Size the bottom spacer to exactly the room the pinned turn needs to sit near the
  // top. Resizing a spacer that's below the fold doesn't move what the reader sees.
  const sizeSpacer = useCallback(() => {
    const el = containerRef.current;
    const sp = spacerRef.current;
    if (!el || !sp) return;
    if (!pinnedRef.current) { sp.style.height = "0px"; return; }
    const target = lastUserEl(el);
    if (!target) { sp.style.height = "0px"; return; }
    const current = sp.offsetHeight;
    const contentHeight = el.scrollHeight - current; // exclude the spacer itself
    const targetTop =
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const below = contentHeight - targetTop; // content height beneath the pinned turn
    // Shrink by the visual-viewport pan (iOS keyboard) so scroll-max sits
    // exactly at the pan-aware pin position — no more, or the anchor clamps
    // short; no less, or empty spacer stays visible once the keyboard closes.
    const topCut = visibleTop(el) - el.getBoundingClientRect().top;
    sp.style.height = `${Math.max(0, el.clientHeight - topCut - below - TOP_GAP)}px`;
  }, []);

  const beginTurn = useCallback(() => {
    pinnedRef.current = true;
    needAnchorRef.current = true;
  }, []);

  const endTurn = useCallback(() => { clearSpacer(); }, [clearSpacer]);

  // Run from a layout effect after content changes. Two jobs: keep a following
  // reader glued to the live edge, and maintain the pinned-turn spacer.
  const relayout = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const hadLayout = hasRelayoutRef.current;
    hasRelayoutRef.current = true;
    if (pinnedRef.current) {
      // Own the position for the duration of the pin: at scroll-max the
      // browser's scroll anchoring keeps the bottom edge stable across content
      // swaps, which would teleport the reader from the pinned turn to the
      // live edge when the final entry lands.
      el.style.overflowAnchor = "none";
      sizeSpacer();
      if (needAnchorRef.current) {
        // First paint after a send: now that the spacer reserves room, scroll the
        // new turn to the top. Re-measure afterwards so the spacer is exact.
        const target = lastUserEl(el);
        if (target) {
          anchorToTop(target);
          needAnchorRef.current = false;
          sizeSpacer();
        }
      } else if (
        pinTopRef.current !== null &&
        Math.abs(el.scrollTop - pinTopRef.current) < 4
      ) {
        // The reader is still parked at the pin: hold the turn at TOP_GAP
        // through DOM swaps that shift or clamp scrollTop. Skipped the moment
        // they scroll away — their position is theirs.
        const target = lastUserEl(el);
        if (target) {
          const desired = Math.max(
            0,
            Math.round(
              target.getBoundingClientRect().top -
                visibleTop(el) +
                el.scrollTop -
                TOP_GAP,
            ),
          );
          if (Math.abs(desired - el.scrollTop) > 1) el.scrollTop = desired;
          pinTopRef.current = el.scrollTop;
        }
      }
      updateScrollToBottomVisibility(false);
      return;
    }
    // Stick to the bottom only while following — and never mid-selection, since a
    // selection is the reader actively working with the text (principle 3).
    if (followingRef.current && !selectionWithin(el)) {
      el.scrollTop = el.scrollHeight; // instant: a smooth animation per token janks
    } else if (
      hadLayout &&
      !followingRef.current &&
      distanceFromBottom() > STICK_THRESHOLD
    ) {
      setNewBelow(true); // content arrived out of view — let the UI announce it
    }
    updateScrollToBottomVisibility();
  }, [sizeSpacer, anchorToTop, distanceFromBottom, updateScrollToBottomVisibility]);

  // The reader's scroll is the source of truth for following. Reaching the live
  // edge re-engages it; scrolling away disengages it.
  const onScroll = useCallback(() => {
    const scrollPerf = scrollPerfRef.current;
    if (!scrollPerf.startedAt) scrollPerf.startedAt = performance.now();
    if (!scrollPerf.raf) {
      scrollPerf.raf = requestAnimationFrame(() => {
        scrollPerf.raf = 0;
        scrollPerf.frames++;
        const elapsed = performance.now() - scrollPerf.startedAt;
        if (elapsed >= 500) {
          recordSessionPerf("scroll_fps", (scrollPerf.frames * 1_000) / elapsed);
          scrollPerf.startedAt = performance.now();
          scrollPerf.frames = 0;
        }
      });
    }
    const atEdge = distanceFromBottom() < STICK_THRESHOLD;
    const now = performance.now();
    if (autoFlightRef.current) {
      if (now > autoFlightRef.current) {
        autoFlightRef.current = 0; // overdue — treat the event as the reader's
      } else if (atEdge) {
        autoFlightRef.current = 0; // arrived
        if (!followingRef.current) setFollowing(true);
        updateScrollToBottomVisibility(true);
        return;
      } else {
        return; // mid-flight positions carry no reader intent
      }
    }
    // Leaving the edge always disengages, but only a gesture-backed scroll may
    // RE-engage: layout-driven events (see lastGestureRef) always land "at the
    // edge" and carry no intent. Non-gesture readers at the true bottom still
    // have the jump button.
    const gestured =
      scrollbarDragRef.current ||
      now - lastGestureRef.current < 1000 ||
      now - lastTouchRef.current < 6000;
    if (!atEdge && followingRef.current) setFollowing(false);
    else if (atEdge && !followingRef.current && gestured) setFollowing(true);
    updateScrollToBottomVisibility(followingRef.current);
  }, [distanceFromBottom, setFollowing, updateScrollToBottomVisibility]);

  // Two container-level listeners: a real gesture cancels a programmatic
  // flight immediately (so the reader can grab the transcript mid-animation),
  // and capture-phase load events re-run the glue — an image finishing to load
  // grows the content with no React state change, which otherwise left a
  // following reader silently stranded above the bottom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const gesture = () => {
      autoFlightRef.current = 0;
      lastGestureRef.current = performance.now();
    };
    const touch = () => {
      gesture();
      lastTouchRef.current = performance.now();
    };
    const onPointerDown = (e: PointerEvent) => {
      // Classic scrollbar drags hit the container itself past the content box.
      if (
        e.target === el &&
        (e.offsetX >= el.clientWidth || e.offsetY >= el.clientHeight)
      )
        scrollbarDragRef.current = true;
    };
    const endDrag = () => {
      if (!scrollbarDragRef.current) return;
      scrollbarDragRef.current = false;
      lastGestureRef.current = performance.now();
    };
    const onLoad = () => relayout();
    el.addEventListener("wheel", gesture, { passive: true });
    el.addEventListener("touchstart", touch, { passive: true });
    el.addEventListener("touchmove", touch, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    el.addEventListener("load", onLoad, true);
    return () => {
      el.removeEventListener("wheel", gesture);
      el.removeEventListener("touchstart", touch);
      el.removeEventListener("touchmove", touch);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      el.removeEventListener("load", onLoad, true);
    };
  }, [relayout]);

  // While a turn is pinned, keyboard open/close (visual-viewport pan/resize on
  // iOS) moves the visible window without any content change — re-seat the pin
  // so the turn stays at TOP_GAP below what the reader actually sees.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      if (pinnedRef.current) relayout();
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, [relayout]);

  return {
    containerRef,
    spacerRef,
    following,
    followingLive: followingRef,
    newBelow,
    showScrollToBottom,
    scrollToLatest,
    leaveLatest,
    anchorToTop,
    beginTurn,
    endTurn,
    relayout,
    onScroll,
  };
}
