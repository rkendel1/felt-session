import type { UnifiedSession, TranscriptEntry } from "../../lib/types";
import { mergeTranscriptEntries, orderTranscriptEntries } from "../../lib/transcript-state";
import { switchDividerText } from "./model-labels";

export function withModelSwitches(
	entries: TranscriptEntry[],
	history: UnifiedSession["modelHistory"],
): TranscriptEntry[] {
	const switches: TranscriptEntry[] = (history || []).map((h) => ({
		id: `model-switch-${h.at}`,
		type: "system" as const,
		content: switchDividerText(h.model, h.from, h.by),
		timestamp: h.at,
	}));
	if (switches.length === 0) return entries;
	const persistedContent = new Set(switches.map((entry) => entry.content));
	const base = entries.filter(
		(entry) =>
			!entry.id.startsWith("model-switch-live-") ||
			!persistedContent.has(entry.content),
	);
	const current = new Map(base.map((entry) => [entry.id, entry] as const));
	if (
		base.length === entries.length &&
		switches.every((entry) => {
			const existing = current.get(entry.id);
			return (
				existing?.content === entry.content &&
				existing.timestamp === entry.timestamp
			);
		})
	)
		return entries;
	return orderTranscriptEntries(mergeTranscriptEntries(base, switches));
}
