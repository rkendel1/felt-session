export interface SessionPerfSample {
	name: string;
	value: number;
	at: number;
	meta?: Record<string, string | number | boolean>;
}

const samples: SessionPerfSample[] = [];
const counters = new Map<string, number>();
const MAX_SAMPLES = 2_000;
let observersStarted = false;

export function recordSessionPerf(
	name: string,
	value: number,
	meta?: SessionPerfSample["meta"],
) {
	samples.push({ name, value, at: performance.now(), meta });
	if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function countSessionPerf(name: string, by = 1) {
	counters.set(name, (counters.get(name) ?? 0) + by);
}

export function measureSessionPerf(name: string, start: number) {
	recordSessionPerf(name, performance.now() - start);
}

export function sessionPerfSnapshot() {
	const grouped = new Map<string, number[]>();
	for (const sample of samples) {
		const list = grouped.get(sample.name) ?? [];
		list.push(sample.value);
		grouped.set(sample.name, list);
	}
	const metrics = Object.fromEntries(
		[...grouped].map(([name, values]) => {
			const sorted = [...values].sort((a, b) => a - b);
			const at = (p: number) =>
				sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
			return [
				name,
				{
					count: sorted.length,
					p50: at(0.5),
					p95: at(0.95),
					max: sorted[sorted.length - 1] ?? 0,
				},
			];
		}),
	);
	return {
		metrics,
		counters: Object.fromEntries(counters),
		recent: samples.slice(-100),
	};
}

export function startSessionPerfObservers() {
	if (
		observersStarted ||
		typeof window === "undefined" ||
		typeof PerformanceObserver === "undefined"
	)
		return;
	observersStarted = true;
	try {
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				recordSessionPerf("long_task_ms", entry.duration);
			}
		});
		observer.observe({ type: "longtask", buffered: true });
	} catch {
		// Safari and older WebViews do not expose long-task entries.
	}
	try {
		const events = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (entry.duration >= 16) recordSessionPerf("input_event_ms", entry.duration);
			}
		});
		events.observe({ type: "event", buffered: true });
	} catch {
		// Event Timing is progressive telemetry.
	}
	(window as typeof window & { __sessionPerf?: typeof sessionPerfSnapshot }).__sessionPerf =
		sessionPerfSnapshot;
}
