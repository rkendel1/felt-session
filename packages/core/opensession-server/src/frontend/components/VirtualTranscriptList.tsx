import { utilityClassName } from "../ui/cn";
import {
	Virtualizer,
	defaultRangeExtractor,
	elementScroll,
	observeElementOffset,
	observeElementRect,
	type VirtualItem,
	type VirtualizerOptions,
} from "@tanstack/react-virtual";
import React from "react";
import { flushSync } from "react-dom";
import {
	loadTranscriptSizes,
	recordTranscriptSizes,
	seededBlockEstimate,
	type TranscriptSizes,
} from "../lib/transcript-sizes";
import { newTailBlockKeys } from "../lib/transcript-block-identity";
import {
	registerTranscriptVirtualNavigation,
	type TranscriptVirtualNavigation,
} from "../lib/transcript-virtual-navigation";
import { cn } from "../ui/cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	wFull: {
			width: "100%"
	},
});

export interface VirtualTranscriptItem {
	key: string;
	anchorId: string;
	entryIds: string[];
	estimateSize: number;
	/** Keep the estimate until sparse payload content is available to measure. */
	measure?: boolean;
	className?: string;
	content: React.ReactNode;
}

interface Props {
	items: VirtualTranscriptItem[];
	/** Keep the live-edge tail mounted inside the same virtual coordinate space. */
	trailingMounted: number;
	onVisibleItems?: (items: VirtualTranscriptItem[]) => void;
	/** Fired when the reader climbs near the top of what is mounted, so a
	 * caller loading history incrementally can hydrate the next page. */
	onTopApproach?: () => void;
	/** Re-evaluate top demand after the caller enables or retries loading. */
	topApproachGeneration?: number;
	/** Head of the incrementally hydrated range window. */
	topGrowthKey?: string | null;
	/** Loaded-row count while the head range is partial. */
	topGrowthVersion?: number;
	/** Range children reuse the renderer without nesting another virtualizer. */
	enabled?: boolean;
	/** Session identity for the measured-height cache. */
	sizeCacheKey?: string;
}

/** A block that just arrived at the live edge fades up into place instead of
 *  popping. One-shot: callers only set `enter` on keys their previous build had
 *  not mounted, and the class stays on across re-renders (a finished CSS
 *  animation does not restart when its element re-renders). The transform
 *  lives on this inner wrapper because the virtualized row itself positions
 *  with an inline translateY that the keyframe must not fight. */
const ENTER_CLASS = "[animation:transcript-enter_var(--dur)_var(--ease)]";

function EnterRow({ enter, children }: { enter?: boolean; children: React.ReactNode }) {
	return <div className={enter ? ENTER_CLASS : undefined}>{children}</div>;
}

/**
 * Loaded transcript blocks, windowed against their nearest message scroller.
 *
 * TanStack's React hook is intentionally marked incompatible with the React
 * Compiler. The small class adapter below owns that imperative integration;
 * this function component remains compiler-managed and chooses only between
 * the browser virtualizer and the semantic static fallback.
 */
export function VirtualTranscriptList({ enabled = true, ...props }: Props) {
	const canVirtualize =
		enabled && typeof ResizeObserver !== "undefined" && props.items.length > 0;
	if (!canVirtualize) return <>{props.items.map(renderStaticItem)}</>;
	return <TranscriptVirtualizer {...props} />;
}

type AdapterState = { revision: number };

/** Imperative adapter for TanStack Virtual core. Class components are outside
 * the React Compiler's function-component transform, so no compiler bailout or
 * opt-out is involved. Its lifecycle mirrors TanStack's official React hook. */
class TranscriptVirtualizer extends React.Component<Omit<Props, "enabled">, AdapterState> {
	state: AdapterState = { revision: 0 };
	private root: HTMLDivElement | null = null;
	private mounted = false;
	private rendering = false;
	private mountCleanup: (() => void) | undefined;
	private navigationCleanup: (() => void) | undefined;
	private navigationContainer: HTMLDivElement | null = null;
	private navigationItems: VirtualTranscriptItem[] | null = null;
	private visibleTimer: number | undefined;
	private containerFor: HTMLDivElement | null = null;
	private container: HTMLDivElement | null = null;
	private topApproachContainer: HTMLDivElement | null = null;
	private topApproachCallback: (() => void) | undefined;
	private topApproachGeneration: number | undefined;
	private topApproachItemsLength = -1;
	private topApproachFirstKey: string | undefined;
	private topApproachTimer: number | undefined;
	private topApproachLastFire = Number.NEGATIVE_INFINITY;
	private rowObserver: ResizeObserver | null = null;
	private rowRefs = new Map<string, (node: HTMLDivElement | null) => void>();
	/** Every block key this adapter instance has ever mounted. The first build
	 *  seeds it (opening a session is not an arrival); afterwards, a tail key
	 *  missing from the set just arrived live and plays the entrance fade. Keys
	 *  stay in the set once seen, so a virtualizer remount never replays it. */
	private mountedKeys: Set<string> | null = null;
	private seeded: { session: string; sizes?: TranscriptSizes } | null = null;
	private virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;

	constructor(props: Omit<Props, "enabled">) {
		super(props);
		this.syncSeeded(props.sizeCacheKey);
		this.virtualizer = new Virtualizer(this.options(props));
	}

	componentDidMount() {
		this.mounted = true;
		this.mountCleanup = this.virtualizer._didMount();
		this.virtualizer._willUpdate();
		this.syncTopApproach();
		this.syncNavigation();
		this.scheduleVisibleItems();
	}

	/** Pre-mutation scroller height, captured only for commits that prepend
	 * history above the reader (growth key handoff or a partial head range
	 * completing). Detecting those from props alone keeps ordinary commits free
	 * of forced layout: the unconditional scrollHeight read that used to live in
	 * every componentDidUpdate was the largest non-idle self-time entry in
	 * history-scroll profiles. */
	getSnapshotBeforeUpdate(prevProps: Omit<Props, "enabled">): number | null {
		const growthKey = this.props.topGrowthKey ?? this.props.items[0]?.key ?? "";
		if (!growthKey) return null;
		const previousKey = prevProps.topGrowthKey ?? prevProps.items[0]?.key ?? "";
		const prependedRange =
			growthKey !== previousKey &&
			this.props.items.some((item) => item.key === previousKey);
		const completedPartialRange =
			growthKey === previousKey &&
			prevProps.topGrowthVersion !== undefined &&
			this.props.topGrowthVersion !== prevProps.topGrowthVersion;
		if (!prependedRange && !completedPartialRange) return null;
		return this.scrollContainer()?.scrollHeight ?? null;
	}

	componentDidUpdate(
		_prevProps: Omit<Props, "enabled">,
		_prevState: AdapterState,
		snapshot: number | null,
	) {
		this.virtualizer._willUpdate();
		if (snapshot !== null) {
			// Height gained by this commit's own mutation goes back on scrollTop
			// before paint, holding the reader's place while history grows above.
			const container = this.scrollContainer();
			if (container) {
				const delta = container.scrollHeight - snapshot;
				if (delta > 0) container.scrollTop += delta;
			}
		}
		this.syncTopApproach();
		this.syncNavigation();
		this.scheduleVisibleItems();
	}

	componentWillUnmount() {
		this.mounted = false;
		this.mountCleanup?.();
		this.navigationCleanup?.();
		this.clearTopApproach();
		if (this.visibleTimer !== undefined) window.clearTimeout(this.visibleTimer);
		this.rowObserver?.disconnect();
	}

	private syncSeeded(sizeCacheKey?: string) {
		if (!sizeCacheKey) {
			this.seeded = null;
			return;
		}
		if (this.seeded?.session === sizeCacheKey) return;
		this.seeded = {
			session: sizeCacheKey,
			sizes: loadTranscriptSizes(sizeCacheKey),
		};
	}

	private requestRender = (_instance: Virtualizer<HTMLDivElement, HTMLDivElement>, sync: boolean) => {
		if (!this.mounted) return;
		const update = () => {
			if (this.mounted)
				this.setState(({ revision }) => ({ revision: revision + 1 }));
		};
		// setOptions can notify while render is deriving the next range. Hooks can
		// queue a render-phase update; classes cannot, so finish this render first.
		if (this.rendering) queueMicrotask(update);
		else if (sync) flushSync(update);
		else update();
	};

	private options(
		props: Omit<Props, "enabled">,
	): VirtualizerOptions<HTMLDivElement, HTMLDivElement> {
		return {
			count: props.items.length,
			getScrollElement: () => this.scrollContainer(),
			estimateSize: (index) => {
				const item = props.items[index];
				if (!item) return 96;
				return seededBlockEstimate(item.estimateSize, this.seeded?.sizes, item.key);
			},
			getItemKey: (index) => props.items[index]?.key ?? index,
			overscan: 8,
			rangeExtractor: (range) =>
				virtualTranscriptRange(
					defaultRangeExtractor(range),
					range.count,
					props.trailingMounted,
				),
			observeElementRect,
			observeElementOffset,
			scrollToFn: elementScroll,
			useAnimationFrameWithResizeObserver: true,
			onChange: this.requestRender,
		};
	}

	private setRoot = (node: HTMLDivElement | null) => {
		this.root = node;
	};

	/** The nearest message scroller, cached per root node: `closest` walks the
	 * whole ancestor chain and used to run several times on every commit. */
	private scrollContainer(): HTMLDivElement | null {
		if (this.root !== this.containerFor) {
			this.containerFor = this.root;
			this.container =
				this.root?.closest<HTMLDivElement>(".viewer-messages") ?? null;
		}
		return this.container;
	}

	private observeRowNode(key: string, node: HTMLElement) {
		node.dataset.transcriptKey = key;
		if (!this.rowObserver) {
			this.rowObserver = new ResizeObserver((entries) => {
				const cache = this.seeded?.sizes;
				if (!cache || entries.length === 0) return;
				const measured: Array<readonly [string, number]> = [];
				let width = 0;
				for (const entry of entries) {
					const target = entry.target as HTMLElement;
					const entryKey = target.dataset.transcriptKey;
					const height =
						entry.borderBoxSize?.[0]?.blockSize ??
						target.getBoundingClientRect().height;
					if (entryKey && Number.isFinite(height) && height > 0)
						measured.push([entryKey, height]);
					width ||= entry.borderBoxSize?.[0]?.inlineSize ?? target.offsetWidth;
				}
				recordTranscriptSizes(cache, width, measured);
			});
		}
		this.rowObserver.observe(node);
	}

	private rowRef(key: string) {
		let callback = this.rowRefs.get(key);
		if (!callback) {
			callback = (node) => {
				this.virtualizer.measureElement(node);
				if (this.props.sizeCacheKey && node) this.observeRowNode(key, node);
			};
			if (this.rowRefs.size > 1_000) this.rowRefs.clear();
			this.rowRefs.set(key, callback);
		}
		return callback;
	}

	private syncNavigation() {
		const container = this.scrollContainer();
		if (
			container === this.navigationContainer &&
			this.props.items === this.navigationItems &&
			this.navigationCleanup
		)
			return;
		this.navigationCleanup?.();
		this.navigationCleanup = undefined;
		this.navigationContainer = container;
		this.navigationItems = this.props.items;
		if (!container || this.props.items.length === 0) return;
		const indexByEntry = new Map<string, number>();
		for (let index = 0; index < this.props.items.length; index++) {
			for (const entryId of this.props.items[index]?.entryIds ?? [])
				if (!indexByEntry.has(entryId)) indexByEntry.set(entryId, index);
		}
		const navigation: TranscriptVirtualNavigation = {
			scrollToEntry: (entryId) => {
				const index = indexByEntry.get(entryId);
				if (index === undefined) return false;
				this.virtualizer.scrollToIndex(index, { align: "start" });
				return true;
			},
		};
		this.navigationCleanup = registerTranscriptVirtualNavigation(container, navigation);
	}

	private evaluateTopApproach = () => {
		const container = this.topApproachContainer;
		const callback = this.topApproachCallback;
		if (!container || !callback || container.scrollTop > container.clientHeight) return;
		const now = performance.now();
		if (now - this.topApproachLastFire < 900) return;
		this.topApproachLastFire = now;
		callback();
	};

	private onTopApproachScroll = () => {
		if (this.topApproachTimer !== undefined) return;
		this.topApproachTimer = window.setTimeout(() => {
			this.topApproachTimer = undefined;
			this.evaluateTopApproach();
		}, 100);
	};

	private onTopApproachWheel = (event: WheelEvent) => {
		if (event.deltaY < 0) this.onTopApproachScroll();
	};

	private clearTopApproach() {
		this.topApproachContainer?.removeEventListener("scroll", this.onTopApproachScroll);
		this.topApproachContainer?.removeEventListener("wheel", this.onTopApproachWheel);
		this.topApproachContainer = null;
		if (this.topApproachTimer !== undefined) {
			window.clearTimeout(this.topApproachTimer);
			this.topApproachTimer = undefined;
		}
	}

	private syncTopApproach() {
		const container = this.scrollContainer();
		const callback = this.props.onTopApproach;
		const containerChanged = container !== this.topApproachContainer;
		const wiringChanged =
			containerChanged || callback !== this.topApproachCallback;
		const firstKey = this.props.items[0]?.key;
		if (
			!wiringChanged &&
			this.props.topApproachGeneration === this.topApproachGeneration &&
			this.props.items.length === this.topApproachItemsLength &&
			firstKey === this.topApproachFirstKey
		)
			return;
		this.clearTopApproach();
		this.topApproachCallback = callback;
		this.topApproachGeneration = this.props.topApproachGeneration;
		this.topApproachItemsLength = this.props.items.length;
		this.topApproachFirstKey = firstKey;
		// Range completions change the generation, length, and first key together.
		// Preserve the cooldown across those commits so a fast response cannot
		// immediately chain another batch. A continued upward wheel gesture still
		// re-evaluates demand even while native scrolling is pinned at scrollTop 0.
		if (containerChanged) this.topApproachLastFire = Number.NEGATIVE_INFINITY;
		if (!container || !callback) return;
		this.topApproachContainer = container;
		container.addEventListener("scroll", this.onTopApproachScroll, { passive: true });
		container.addEventListener("wheel", this.onTopApproachWheel, { passive: true });
		this.evaluateTopApproach();
	}

	// Geometry reads and the near-visible filter run inside the debounce, not
	// at schedule time: scheduling happens on every commit, and reading
	// scrollTop/clientHeight there forced a layout per commit for a result the
	// timeout usually threw away. Firing late also reports the freshest window.
	private scheduleVisibleItems() {
		if (this.visibleTimer !== undefined) window.clearTimeout(this.visibleTimer);
		if (!this.props.onVisibleItems) return;
		this.visibleTimer = window.setTimeout(() => {
			this.visibleTimer = undefined;
			const { onVisibleItems, items } = this.props;
			const virtualItems = this.virtualizer.getVirtualItems();
			if (!onVisibleItems || virtualItems.length === 0) return;
			const container = this.scrollContainer();
			const top = container?.scrollTop ?? 0;
			const viewport = container?.clientHeight ?? 0;
			const bottom = top + viewport;
			onVisibleItems(
				virtualItems
					.filter(
						(item) =>
							!container ||
							(item.end >= top - viewport && item.start <= bottom + viewport),
					)
					.map((virtualItem) => items[virtualItem.index])
					.filter((item): item is VirtualTranscriptItem => Boolean(item)),
			);
		}, 120);
	}

	render() {
		this.rendering = true;
		this.syncSeeded(this.props.sizeCacheKey);
		this.virtualizer.setOptions(this.options(this.props));
		this.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
			item,
			_delta,
			instance,
		) => {
			// At the live edge the follow glue owns positioning: TanStack's
			// per-row compensation pairs every size change with an equal instant
			// scrollTop step, which turns a turn's end-of-stream restructure into
			// a one-frame teleport past the glide (measured 1716px). Readers away
			// from the edge keep the compensation — it holds their place while
			// history hydrates above them.
			const scrollEl = instance.scrollElement;
			if (scrollEl) {
				const fromBottom =
					scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
				if (fromBottom < 120) return false;
			}
			return shouldAdjustTranscriptScroll(item.end, instance.scrollOffset ?? 0);
		};
		const virtualItems = this.virtualizer.getVirtualItems();
		const totalSize = this.virtualizer.getTotalSize();
		// Tail-arrival detection runs here, in the imperative adapter, because
		// "mounted by the previous build" is virtualizer knowledge: the function
		// component above is compiler-managed and may re-render without a new
		// item list, and a ref-based previous-set there is a compile error.
		const entering = newTailBlockKeys(
			this.mountedKeys,
			this.props.items.map((item) => item.key),
		);
		if (this.mountedKeys === null) this.mountedKeys = new Set();
		for (const item of this.props.items) this.mountedKeys.add(item.key);
		const enteringSet = new Set(entering);
		const result = (
			<div
				ref={this.setRoot}
				{...stylex.props(sx.relative, sx.wFull)}
				style={{ height: totalSize }}
				data-virtual-transcript
				data-virtual-count={this.props.items.length}
				data-transcript-blocks={this.props.items.length}
			>
				{virtualItems.map((virtualItem: VirtualItem) => {
					const item = this.props.items[virtualItem.index];
					if (!item) return null;
					return (
						<div
							key={item.key}
							ref={item.measure === false ? undefined : this.rowRef(item.key)}
							data-index={virtualItem.index}
							data-eid={item.anchorId}
							className={cn(utilityClassName("absolute left-0 top-0 w-full"), item.className)}
							style={{ transform: `translateY(${virtualItem.start}px)` }}
						>
							<EnterRow enter={enteringSet.has(item.key)}>{item.content}</EnterRow>
						</div>
					);
				})}
			</div>
		);
		this.rendering = false;
		return result;
	}
}

export function shouldAdjustTranscriptScroll(
	itemEnd: number,
	scrollOffset: number,
): boolean {
	return itemEnd <= scrollOffset + 1;
}

export function virtualTranscriptRange(
	visible: number[],
	count: number,
	trailingMounted: number,
): number[] {
	const indexes = new Set(visible);
	const start = Math.max(0, count - Math.max(0, trailingMounted));
	for (let index = start; index < count; index++) indexes.add(index);
	return [...indexes].sort((a, b) => a - b);
}

function renderStaticItem(item: VirtualTranscriptItem) {
	return (
		<div key={item.key} data-eid={item.anchorId} className={item.className}>
			{item.content}
		</div>
	);
}
