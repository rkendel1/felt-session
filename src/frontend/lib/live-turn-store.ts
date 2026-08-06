import {
	countSessionPerf,
	recordSessionPerf,
	startSessionPerfObservers,
} from "./session-performance";

export interface LiveTurnSnapshot {
	text: string;
	live: boolean;
	rapid: boolean;
	by: string | null;
	runId: string | null;
	revision: number;
}

const EMPTY: LiveTurnSnapshot = {
	text: "",
	live: false,
	rapid: false,
	by: null,
	runId: null,
	revision: 0,
};

const scheduleFrame = (callback: FrameRequestCallback): number =>
	typeof requestAnimationFrame === "function"
		? requestAnimationFrame(callback)
		: (setTimeout(() => callback(performance.now()), 16) as unknown as number);
const cancelFrame = (id: number) => {
	if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
	else clearTimeout(id);
};

export class LiveTurnStore {
	private snapshot: LiveTurnSnapshot = EMPTY;
	private listeners = new Set<() => void>();
	private pending = "";
	private landed: string[] = [];
	private frame: number | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private clearTimer: ReturnType<typeof setTimeout> | null = null;
	private firstDeltaAt: number | null = null;

	constructor() {
		startSessionPerfObservers();
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = () => this.snapshot;
	getServerSnapshot = () => EMPTY;
	hasText = () => Boolean(this.snapshot.text || this.pending);
	textLength = () => this.snapshot.text.length + this.pending.length;

	start(by?: string | null, runId?: string) {
		this.cancelTimers();
		this.pending = "";
		this.landed = [];
		this.firstDeltaAt = null;
		this.snapshot = {
			text: "",
			live: true,
			rapid: false,
			by: by ?? null,
			runId: runId ?? crypto.randomUUID(),
			revision: this.snapshot.revision + 1,
		};
		this.emit();
	}

	append(text: string) {
		const landedIdx = this.landed.indexOf(text);
		if (landedIdx !== -1) {
			this.landed.splice(landedIdx, 1);
			return;
		}
		if (!text) return;
		countSessionPerf("stream_frames_received");
		if (this.firstDeltaAt === null) this.firstDeltaAt = performance.now();
		this.pending += text;
		if (this.frame === null) {
			this.frame = scheduleFrame(() => this.flush());
		}
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			if (!this.snapshot.rapid) return;
			this.snapshot = {
				...this.snapshot,
				rapid: false,
				revision: this.snapshot.revision + 1,
			};
			this.emit();
		}, 130);
	}

	land(contents: string[]) {
		for (const content of contents) {
			const before = this.snapshot.text + this.pending;
			const after = before.replace(content, "");
			if (after === before) this.landed.push(content);
			this.snapshot = { ...this.snapshot, text: after };
			this.pending = "";
		}
		this.landed = this.landed.slice(-30);
		this.snapshot = {
			...this.snapshot,
			revision: this.snapshot.revision + 1,
		};
		this.emit();
	}

	finish() {
		this.flush();
		this.snapshot = {
			...this.snapshot,
			live: false,
			rapid: false,
			by: null,
			revision: this.snapshot.revision + 1,
		};
		this.emit();
		if (this.clearTimer !== null) clearTimeout(this.clearTimer);
		const runId = this.snapshot.runId;
		this.clearTimer = setTimeout(() => {
			if (this.snapshot.runId === runId && !this.snapshot.live) this.clear();
		}, 5_000);
	}

	clear() {
		this.cancelTimers();
		this.pending = "";
		this.landed = [];
		this.snapshot = {
			...EMPTY,
			revision: this.snapshot.revision + 1,
		};
		this.emit();
	}

	private flush() {
		if (this.frame !== null) cancelFrame(this.frame);
		this.frame = null;
		if (!this.pending) return;
		const receivedAt = this.firstDeltaAt;
		this.firstDeltaAt = null;
		this.snapshot = {
			...this.snapshot,
			text: this.snapshot.text + this.pending,
			rapid: true,
			revision: this.snapshot.revision + 1,
		};
		this.pending = "";
		countSessionPerf("stream_paints");
		if (receivedAt !== null) {
			recordSessionPerf("first_delta_to_paint_ms", performance.now() - receivedAt);
		}
		this.emit();
	}

	private emit() {
		for (const listener of this.listeners) listener();
	}

	private cancelTimers() {
		if (this.frame !== null) cancelFrame(this.frame);
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		if (this.clearTimer !== null) clearTimeout(this.clearTimer);
		this.frame = null;
		this.settleTimer = null;
		this.clearTimer = null;
	}
}
