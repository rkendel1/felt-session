import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type WorkspaceMediaItem } from "../lib/api";
import { IconChevronLeft, IconChevronRight, IconX } from "./icons";

/**
 * Full-screen lightbox for all in-app media: workspace-media thumbnails (the
 * sidebar hover card, the mobile sheet, and the WorkspaceInfo panel) and any
 * session media (markdown images, pasted-image attachments, tool-result
 * screenshots and recordings), with prev/next browsing instead of jumping to
 * the raw file in a new tab — which for data:/blob URLs browsers block,
 * leaving an empty window.
 *
 * Images are zoomable: pinch on touch (iOS PWA included — pointer events +
 * touch-action:none, no native gesture dependence), double-tap/double-click
 * to toggle, wheel/trackpad on desktop, one-finger pan while zoomed.
 *
 * Global singleton: the thumbnails live inside transient popovers — the
 * hover card unmounts on mouseleave/scroll — so the modal is hosted once in
 * App and opened imperatively via openLightbox(), surviving its opener.
 * Session media is wired through a delegated capture-phase click listener here
 * (rather than per-component onClicks) because markdown images are injected
 * via dangerouslySetInnerHTML and can't carry React handlers.
 */

export interface LightboxItem {
	kind: "image" | "video";
	src: string;
	sessionTitle?: string;
	at?: string;
}

interface LightboxState {
	items: LightboxItem[];
	index: number;
	id: number;
	origin?: HTMLElement;
	originIndex: number;
	useHeroTransition: boolean;
}

interface LightboxRequest {
	items: LightboxItem[];
	index: number;
	origin?: HTMLElement;
}

interface ViewTransitionHandle {
	finished: Promise<void>;
	skipTransition(): void;
}

/** `focusVisible` is honoured by Chromium/Firefox but not yet in TypeScript's
 * DOM lib; browsers without it just fall back to their own heuristic. */
type FocusOptionsWithVisible = FocusOptions & { focusVisible?: boolean };

type ViewTransitionDocument = Document & {
	startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

const HERO_TRANSITION_NAME = "lightbox-media";
let nextLightboxId = 0;
let host: ((request: LightboxRequest) => void) | null = null;

const LIGHTBOX_TRANSITION_CSS = `
html[data-lightbox-transition="opening"]::view-transition-old(root),
html[data-lightbox-transition="closing"]::view-transition-new(root) {
  animation: none;
}

html[data-lightbox-transition="opening"]::view-transition-new(root) {
  animation: lightbox-root-in 180ms cubic-bezier(0.23, 1, 0.32, 1) both;
}

html[data-lightbox-transition="closing"]::view-transition-old(root) {
  animation: lightbox-root-out 150ms cubic-bezier(0.23, 1, 0.32, 1) both;
}

::view-transition-group(${HERO_TRANSITION_NAME}) {
  z-index: 401;
  animation-duration: 360ms;
  animation-timing-function: cubic-bezier(0.32, 0.72, 0, 1);
}

::view-transition-old(${HERO_TRANSITION_NAME}),
::view-transition-new(${HERO_TRANSITION_NAME}) {
  mix-blend-mode: normal;
}

@keyframes lightbox-root-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes lightbox-root-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
`;

function mediaElement(origin?: Element | null): HTMLElement | undefined {
	if (!(origin instanceof HTMLElement)) return undefined;
	if (origin.matches("img, video")) return origin;
	return origin.querySelector<HTMLElement>("img, video") || origin;
}

function canMorphFrom(origin?: HTMLElement): origin is HTMLElement {
	if (!origin?.isConnected) return false;
	const rect = origin.getBoundingClientRect();
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.right > 0 &&
		rect.bottom > 0 &&
		rect.left < window.innerWidth &&
		rect.top < window.innerHeight
	);
}

function setTransitionName(element: HTMLElement, name: string): () => void {
	const previous = element.style.viewTransitionName;
	let restored = false;
	element.style.viewTransitionName = name;
	return () => {
		if (restored) return;
		restored = true;
		element.style.viewTransitionName = previous;
	};
}

function markTransition(phase: "opening" | "closing", id: number): () => void {
	const root = document.documentElement;
	const token = String(id);
	root.dataset.lightboxTransition = phase;
	root.dataset.lightboxTransitionId = token;
	return () => {
		if (root.dataset.lightboxTransitionId !== token) return;
		delete root.dataset.lightboxTransition;
		delete root.dataset.lightboxTransitionId;
	};
}

function supportsHeroTransition(): boolean {
	return (
		typeof (document as ViewTransitionDocument).startViewTransition === "function" &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export function openLightbox(
	items: (LightboxItem | WorkspaceMediaItem)[],
	index: number,
	origin?: Element | null,
) {
	host?.({ items, index, origin: mediaElement(origin) });
}

/** Every piece of session media currently in the DOM, in document order —
 * markdown images/videos, pasted attachments, tool-result screenshots. */
const GALLERY_SELECTOR = "img.md-image, video.md-video";

/** Open the lightbox on `el`, with prev/next browsing across all session media
 * currently on screen (a conversation-wide gallery). */
export function openGalleryFrom(el: Element) {
	const nodes = Array.from(document.querySelectorAll(GALLERY_SELECTOR));
	const items: LightboxItem[] = nodes.map((n) => ({
		kind: n.tagName === "VIDEO" ? "video" : "image",
		src: (n as HTMLImageElement | HTMLVideoElement).src,
	}));
	if (items.length === 0) return;
	openLightbox(items, Math.max(0, nodes.indexOf(el)), el);
}

export function MediaLightboxHost() {
	const [state, setState] = useState<LightboxState | null>(null);
	const activeTransition = useRef<ViewTransitionHandle | null>(null);
	const activeSourceCleanup = useRef<(() => void) | null>(null);
	useEffect(() => {
		const open = (request: LightboxRequest) => {
			const id = ++nextLightboxId;
			const origin = mediaElement(request.origin);
			const next: LightboxState = {
				...request,
				id,
				origin,
				originIndex: request.index,
				useHeroTransition: false,
			};
			const item = request.items[request.index];
			if (item?.kind !== "image" || !canMorphFrom(origin) || !supportsHeroTransition()) {
				setState(next);
				return;
			}

			activeTransition.current?.skipTransition();
			activeSourceCleanup.current?.();
			const restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
			activeSourceCleanup.current = restoreOrigin;
			const clearTransitionMark = markTransition("opening", id);
			try {
				const transition = (document as ViewTransitionDocument).startViewTransition!(() => {
					// The source belongs only to the old snapshot. Removing its name before
					// React mounts the destination avoids duplicate named elements.
					restoreOrigin();
					if (activeSourceCleanup.current === restoreOrigin) {
						activeSourceCleanup.current = null;
					}
					flushSync(() => setState({ ...next, useHeroTransition: true }));
				});
				activeTransition.current = transition;
				const finish = () => {
					if (activeTransition.current === transition) activeTransition.current = null;
					clearTransitionMark();
				};
				void transition.finished.then(finish, finish);
			} catch {
				restoreOrigin();
				if (activeSourceCleanup.current === restoreOrigin) {
					activeSourceCleanup.current = null;
				}
				clearTransitionMark();
				setState(next);
			}
		};
		host = open;
		return () => {
			if (host === open) host = null;
			activeTransition.current?.skipTransition();
			activeSourceCleanup.current?.();
		};
	}, []);
	// Delegated capture-phase listener: intercept plain left-clicks on any
	// session image and open the gallery instead of following the wrapping
	// <a target="_blank"> (kept for cmd/middle-click open-in-tab). Videos are
	// not intercepted — clicks there drive the native controls.
	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (
				e.defaultPrevented ||
				e.button !== 0 ||
				e.metaKey ||
				e.ctrlKey ||
				e.shiftKey ||
				e.altKey
			)
				return;
			const target = e.target as HTMLElement;
			// Enter on the focused link dispatches a click whose target is the
			// wrapping <a>, not the <img> inside it — match both, or keyboard
			// activation falls through to the raw file in a new tab.
			const img =
				target.closest?.("img.md-image") ||
				target.closest?.("a.md-image-link")?.querySelector("img.md-image");
			if (!img) return;
			e.preventDefault();
			e.stopPropagation();
			openGalleryFrom(img);
		}
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	function close(current: LightboxState, allowHeroTransition = true) {
		const item = current.items[current.index];
		const origin = current.origin;
		const canReturn =
			allowHeroTransition &&
			current.useHeroTransition &&
			current.index === current.originIndex &&
			item?.kind === "image" &&
			canMorphFrom(origin) &&
			supportsHeroTransition();

		if (!canReturn) {
			// Native transitions don't need Motion's lifecycle. If the source has
			// disappeared (for example, a hover card closed), opt back into the
			// fallback for one frame so the viewer still leaves gracefully.
			activeTransition.current?.skipTransition();
			activeTransition.current = null;
			activeSourceCleanup.current?.();
			activeSourceCleanup.current = null;
			if (document.documentElement.dataset.lightboxTransitionId === String(current.id)) {
				delete document.documentElement.dataset.lightboxTransition;
				delete document.documentElement.dataset.lightboxTransitionId;
			}
			setState({ ...current, useHeroTransition: false });
			requestAnimationFrame(() => {
				setState((latest) => (latest?.id === current.id ? null : latest));
			});
			return;
		}

		activeTransition.current?.skipTransition();
		activeSourceCleanup.current?.();
		activeSourceCleanup.current = null;
		const clearTransitionMark = markTransition("closing", current.id);
		let restoreOrigin: (() => void) | undefined;
		try {
			const transition = (document as ViewTransitionDocument).startViewTransition!(() => {
				// The target belongs only to the old snapshot; name the source after
				// that capture so it becomes the destination in the new snapshot.
				restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
				activeSourceCleanup.current = restoreOrigin;
				flushSync(() => setState(null));
			});
			activeTransition.current = transition;
			const finish = () => {
				restoreOrigin?.();
				if (activeSourceCleanup.current === restoreOrigin) {
					activeSourceCleanup.current = null;
				}
				if (activeTransition.current === transition) activeTransition.current = null;
				clearTransitionMark();
			};
			void transition.finished.then(finish, finish);
		} catch {
			restoreOrigin?.();
			if (activeSourceCleanup.current === restoreOrigin) {
				activeSourceCleanup.current = null;
			}
			clearTransitionMark();
			setState(null);
		}
	}

	const lightbox = state ? (
		<MediaLightbox
			key={state.id}
			items={state.items}
			index={state.index}
			onIndex={(index) =>
				setState((latest) =>
					latest?.id === state.id ? { ...latest, index } : latest,
				)
			}
			onClose={(allowHeroTransition) => close(state, allowHeroTransition)}
			useHeroTransition={state.useHeroTransition}
			heroTransitionName={
				state.useHeroTransition && state.index === state.originIndex
					? HERO_TRANSITION_NAME
					: undefined
			}
		/>
	) : null;

	return (
		<>
			<style>{LIGHTBOX_TRANSITION_CSS}</style>
			{state?.useHeroTransition ? (
				lightbox
			) : (
				<AnimatePresence initial={false}>{lightbox}</AnimatePresence>
			)}
		</>
	);
}

function extFromMime(mime: string): string {
	const sub = mime.split("/")[1]?.split(";")[0] || "";
	const special: Record<string, string> = {
		jpeg: "jpg",
		"svg+xml": "svg",
		quicktime: "mov",
		"x-matroska": "mkv",
	};
	return special[sub] || sub || "bin";
}

function suggestedName(item: LightboxItem, mime: string): string {
	// Prefer the URL's own basename when it carries an extension.
	if (!item.src.startsWith("data:") && !item.src.startsWith("blob:")) {
		try {
			const base = decodeURIComponent(
				new URL(item.src, location.href).pathname.split("/").pop() || "",
			);
			if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
		} catch {}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const ext = mime
		? extFromMime(mime)
		: item.kind === "video"
			? "mp4"
			: "png";
	return `${item.kind}-${stamp}.${ext}`;
}

/**
 * Save the current item to the device. fetch→blob→ObjectURL so it works for
 * data:/blob:/same-origin URLs alike (a plain <a download> on a cross-origin
 * URL is silently ignored); a cross-origin file without CORS falls back to
 * opening it in a new tab, where the browser's own save UI takes over.
 */
async function downloadItem(item: LightboxItem) {
	try {
		const res = await fetch(item.src);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = suggestedName(item, blob.type);
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch {
		window.open(item.src, "_blank", "noopener");
	}
}

const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Pinch/pan/zoom surface for one image. The wrapper (not the letterboxed img)
 * owns the gesture so pinches starting beside the photo still work; transforms
 * are written straight to the img style (no per-move re-render). A clean tap
 * on the backdrop area of the wrapper closes — unless it's the first half of a
 * double-tap on the image, which zooms instead.
 */
function ZoomableImage({
	src,
	onTapBackdrop,
	onZoomChange,
	viewTransitionName,
}: {
	src: string;
	onTapBackdrop: () => void;
	onZoomChange: (zoomed: boolean) => void;
	viewTransitionName?: string;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const t = useRef({ s: 1, tx: 0, ty: 0 });
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const gesture = useRef<{
		moved: boolean;
		downTarget: EventTarget | null;
		downAt: number;
		p0: { x: number; y: number };
		t0: { s: number; tx: number; ty: number };
		d0: number;
		m0: { x: number; y: number };
		pinched: boolean;
	} | null>(null);
	const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
	const [zoomed, setZoomed] = useState(false);
	const zoomedRef = useRef(false);

	function apply(animate = false) {
		const img = imgRef.current;
		if (!img) return;
		const { s, tx, ty } = t.current;
		img.style.transition = animate ? "transform 0.18s ease-out" : "none";
		img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
		const nextZoomed = s > 1;
		if (nextZoomed !== zoomedRef.current) {
			zoomedRef.current = nextZoomed;
			setZoomed(nextZoomed);
			onZoomChange(nextZoomed);
		}
	}

	/** The img's layout (untransformed) viewport rect — transform-origin is 0 0,
	 * so the rendered top-left is layout top-left + current translation. */
	function layoutOrigin() {
		const img = imgRef.current!;
		const r = img.getBoundingClientRect();
		const { s, tx, ty } = t.current;
		return { x: r.left - tx, y: r.top - ty, w: r.width / s, h: r.height / s };
	}

	/** Keep the scaled image covering the viewport (or centered when smaller).
	 * Bounds are the full screen, not the letterboxed wrapper — a zoomed photo
	 * should spread under the floating chrome like a native photo viewer, not
	 * clip at the wrapper edges. */
	function clamp(next: { s: number; tx: number; ty: number }) {
		const img = imgRef.current;
		if (!img) return next;
		const C = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
		const o = layoutOrigin();
		const clampAxis = (
			pos: number, // desired translation on this axis
			origin: number,
			size: number,
			cStart: number,
			cSize: number,
		) => {
			const scaled = size * next.s;
			if (scaled <= cSize) return cStart + (cSize - scaled) / 2 - origin;
			const min = cStart + cSize - scaled - origin;
			const max = cStart - origin;
			return Math.min(max, Math.max(min, pos));
		};
		return {
			s: next.s,
			tx: clampAxis(next.tx, o.x, o.w, C.left, C.width),
			ty: clampAxis(next.ty, o.y, o.h, C.top, C.height),
		};
	}

	/** Rescale to `sNew` keeping the viewport point `p` fixed on the image. */
	function zoomAt(p: { x: number; y: number }, sNew: number, animate = false) {
		const o = layoutOrigin();
		const { s, tx, ty } = t.current;
		const ux = (p.x - o.x - tx) / s;
		const uy = (p.y - o.y - ty) / s;
		t.current = clamp({ s: sNew, tx: p.x - o.x - ux * sNew, ty: p.y - o.y - uy * sNew });
		if (t.current.s <= 1.02) t.current = { s: 1, tx: 0, ty: 0 };
		apply(animate);
	}

	function onPointerDown(e: React.PointerEvent) {
		wrapRef.current?.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const pts = [...pointers.current.values()];
		if (pts.length === 2) {
			gesture.current = {
				...(gesture.current || {
					moved: false,
					downTarget: e.target,
					downAt: performance.now(),
				}),
				moved: gesture.current?.moved || false,
				downTarget: gesture.current?.downTarget ?? e.target,
				downAt: gesture.current?.downAt ?? performance.now(),
				p0: pts[0],
				t0: { ...t.current },
				d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
				m0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
				pinched: true,
			};
		} else if (pts.length === 1) {
			gesture.current = {
				moved: false,
				downTarget: e.target,
				downAt: performance.now(),
				p0: pts[0],
				t0: { ...t.current },
				d0: 0,
				m0: pts[0],
				pinched: false,
			};
		}
	}

	function onPointerMove(e: React.PointerEvent) {
		if (!pointers.current.has(e.pointerId) || !gesture.current) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const g = gesture.current;
		const pts = [...pointers.current.values()];
		if (g.pinched && pts.length >= 2) {
			const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
			// No clamping mid-pinch — fighting the fingers makes the image slide
			// away from the focal point. Bounds are re-imposed on release.
			const sNew = Math.min(MAX_SCALE, Math.max(0.5, (g.t0.s * d) / (g.d0 || 1)));
			const o = layoutOrigin();
			const ux = (g.m0.x - o.x - g.t0.tx) / g.t0.s;
			const uy = (g.m0.y - o.y - g.t0.ty) / g.t0.s;
			t.current = { s: sNew, tx: m.x - o.x - ux * sNew, ty: m.y - o.y - uy * sNew };
			apply();
			g.moved = true;
		} else if (pts.length === 1) {
			const p = pts[0];
			const dx = p.x - g.p0.x;
			const dy = p.y - g.p0.y;
			if (Math.hypot(dx, dy) > 6) g.moved = true;
			if (t.current.s > 1 && !g.pinched) {
				t.current = clamp({ s: g.t0.s, tx: g.t0.tx + dx, ty: g.t0.ty + dy });
				apply();
			}
		}
	}

	function onPointerEnd(e: React.PointerEvent) {
		if (!pointers.current.has(e.pointerId)) return;
		const p = { x: e.clientX, y: e.clientY };
		pointers.current.delete(e.pointerId);
		const g = gesture.current;
		if (!g) return;
		const remaining = [...pointers.current.values()];
		if (remaining.length === 1) {
			// Pinch → one finger left: re-anchor so it pans from here.
			g.p0 = remaining[0];
			g.t0 = { ...t.current };
			g.pinched = false;
			g.moved = true;
			return;
		}
		if (remaining.length > 0) return;
		// Last pointer up — settle back inside bounds (animated) and check taps.
		if (t.current.s <= 1.05) {
			t.current = { s: 1, tx: 0, ty: 0 };
			apply(true);
		} else {
			t.current = clamp({ ...t.current });
			apply(true);
		}
		const isTap =
			!g.moved && e.pointerType !== "mouse"
				? performance.now() - g.downAt < 400
				: !g.moved; // mouse: any clean click counts
		gesture.current = null;
		if (!isTap) return;
		const prevTap = lastTap.current;
		lastTap.current = { at: performance.now(), x: p.x, y: p.y };
		const isDouble =
			prevTap &&
			performance.now() - prevTap.at < 300 &&
			Math.hypot(p.x - prevTap.x, p.y - prevTap.y) < 40;
		if (isDouble) {
			lastTap.current = null;
			zoomAt(p, t.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, true);
			return;
		}
		// Single tap on the backdrop (not the photo itself) closes, like the
		// rest of the modal chrome. On the photo it's a no-op (double-tap arms).
		if (g.downTarget === wrapRef.current && t.current.s === 1) onTapBackdrop();
	}

	// Wheel/trackpad zoom. Native non-passive listener — React's onWheel can be
	// passive, and preventDefault must win or the page behind rubber-bands.
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const sNew = Math.min(
				MAX_SCALE,
				Math.max(1, t.current.s * Math.exp(-e.deltaY * 0.0022)),
			);
			zoomAt({ x: e.clientX, y: e.clientY }, sNew);
		}
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, []);

	return (
		<div
			ref={wrapRef}
			className={`flex min-h-0 min-w-0 flex-1 touch-none select-none items-center justify-center self-stretch ${
				zoomed ? "cursor-grab" : "cursor-zoom-in"
			}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
		>
			<img
				ref={imgRef}
				src={src}
				alt=""
				draggable={false}
				className="min-h-0 min-w-0 max-h-full max-w-full rounded-md object-contain [transform-origin:0_0]"
				style={{ viewTransitionName }}
			/>
		</div>
	);
}

function MediaLightbox({
	items,
	index,
	onIndex,
	onClose,
	useHeroTransition,
	heroTransitionName,
}: {
	items: LightboxItem[];
	index: number;
	onIndex: (i: number) => void;
	onClose: (allowHeroTransition?: boolean) => void;
	useHeroTransition: boolean;
	heroTransitionName?: string;
}) {
	const item = items[index];
	const many = items.length > 1;
	const [imageZoomed, setImageZoomed] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const reduceMotion = useReducedMotion();
	const prev = () => {
		setImageZoomed(false);
		onIndex((index - 1 + items.length) % items.length);
	};
	const next = () => {
		setImageZoomed(false);
		onIndex((index + 1) % items.length);
	};
	const requestClose = () => onClose(!imageZoomed);

	useEffect(() => {
		const previousFocus = document.activeElement as HTMLElement | null;
		// Focus returns to whatever opened the viewer, but the ring only comes
		// back if it was there to begin with: a mouse click on a session image
		// focuses its wrapping <a> silently, and closing with Escape puts the
		// browser in keyboard modality, so a plain focus() would leave an
		// outline around an image nobody deliberately focused.
		const restore: FocusOptionsWithVisible = {
			preventScroll: true,
			focusVisible: !!previousFocus?.matches?.(":focus-visible"),
		};
		const frame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
		return () => {
			cancelAnimationFrame(frame);
			if (previousFocus?.isConnected) previousFocus.focus(restore);
		};
	}, []);

	// Capture-phase so the arrows/Escape don't also drive whatever is behind
	// the modal (composer, session viewer shortcuts).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				requestClose();
			} else if (e.key === "ArrowLeft" && many) {
				e.stopPropagation();
				e.preventDefault();
				prev();
			} else if (e.key === "ArrowRight" && many) {
				e.stopPropagation();
				e.preventDefault();
				next();
			} else if (e.key === "Tab") {
				const focusable = Array.from(
					dialogRef.current?.querySelectorAll<HTMLElement>(
						'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
					) || [],
				).filter((element) => element.getClientRects().length > 0);
				if (focusable.length === 0) {
					e.preventDefault();
					return;
				}
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				const active = document.activeElement;
				if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
					e.preventDefault();
					first.focus();
				}
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	if (!item) return null;
	const caption = [
		item.sessionTitle,
		item.at ? new Date(item.at).toLocaleString() : null,
	]
		.filter(Boolean)
		.join(" · ");
	// z-10 keeps the chrome floating above a zoomed image, which is free to
	// spread under it across the whole viewport (z-index applies to flex items
	// without needing position).
	const navBtn =
		"z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border-0 bg-white/10 p-0 text-white hover:bg-white/20";

	return (
		<motion.div
			ref={dialogRef}
			className="fixed inset-0 z-[400] flex flex-col bg-black/85"
			role="dialog"
			aria-modal="true"
			aria-label={item.kind === "image" ? "Image preview" : "Video preview"}
			initial={useHeroTransition ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={useHeroTransition ? { opacity: 1 } : { opacity: 0 }}
			transition={useHeroTransition ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) requestClose();
			}}
		>
			<button
				ref={closeRef}
				type="button"
				className={`${navBtn} absolute right-3 top-3`}
				onClick={requestClose}
				aria-label="Close"
			>
				<IconX size={22} />
			</button>

			<div
				className="flex min-h-0 flex-1 items-center justify-center gap-3 px-3 pb-2 pt-14 sm:px-4"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) requestClose();
				}}
			>
				{many && (
					<button
						type="button"
						className={navBtn}
						onClick={prev}
						aria-label="Previous"
					>
						<IconChevronLeft size={24} />
					</button>
				)}
				<motion.div
					className="flex min-h-0 min-w-0 flex-1 self-stretch"
					initial={
						useHeroTransition
							? false
							: { opacity: 0, scale: reduceMotion ? 1 : 0.96 }
					}
					animate={{ opacity: 1, scale: 1 }}
					exit={
						useHeroTransition
							? { opacity: 1, scale: 1 }
							: { opacity: 0, scale: reduceMotion ? 1 : 0.985 }
					}
					transition={
						useHeroTransition
							? { duration: 0 }
							: reduceMotion
								? { duration: 0.14, ease: "easeOut" }
								: { type: "spring", duration: 0.28, bounce: 0 }
					}
				>
					{item.kind === "image" ? (
						<ZoomableImage
							key={item.src}
							src={item.src}
							onTapBackdrop={requestClose}
							onZoomChange={setImageZoomed}
							viewTransitionName={heroTransitionName}
						/>
					) : (
						<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch">
							<video
								key={item.src}
								src={item.src}
								controls
								autoPlay
								muted
								playsInline
								className="min-h-0 min-w-0 max-h-full max-w-full rounded-md"
							/>
						</div>
					)}
				</motion.div>
				{many && (
					<button
						type="button"
						className={navBtn}
						onClick={next}
						aria-label="Next"
					>
						<IconChevronRight size={24} />
					</button>
				)}
			</div>

			<div
				className="z-10 flex items-center justify-center gap-3 px-4 pb-4 pt-1 text-xs text-white/70"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) requestClose();
				}}
			>
				{many && (
					<span className="tabular-nums">
						{index + 1} / {items.length}
					</span>
				)}
				{caption && <span className="min-w-0 truncate">{caption}</span>}
				<button
					type="button"
					onClick={() => void downloadItem(item)}
					className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-white/70 hover:text-white hover:underline"
				>
					Download
				</button>
				{!item.src.startsWith("data:") && (
					<a
						href={item.src}
						target="_blank"
						rel="noopener noreferrer"
						className="shrink-0 text-white/70 hover:text-white hover:underline"
					>
						Open ↗
					</a>
				)}
			</div>
		</motion.div>
	);
}
