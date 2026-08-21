import React, { useSyncExternalStore } from "react";
import { LiveTurnStore } from "../../lib/live-turn-store";
import { renderMarkdown } from "../../lib/markdown";
import { MarkdownBody, useMarkdownRepo } from "../MarkdownBody";
import { useOpenAssetPaths } from "../../lib/open-asset";
import { cn } from "../../ui/cn";
import { msgRow, msgStreamingRow, msgBodyStreaming } from "../../lib/msg-classes";

export function StreamingMessage({
	store,
	sessionId,
}: {
	store: LiveTurnStore;
	sessionId: string;
}) {
	const snapshot = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getServerSnapshot,
	);
	const repo = useMarkdownRepo();
	const assetPaths = useOpenAssetPaths();
	const html = React.useMemo(
		() =>
			snapshot.text
				? renderMarkdown(snapshot.text, { repo, sessionId, assetPaths })
				: "",
		[snapshot.text, repo, sessionId, assetPaths],
	);
	if (!snapshot.text) return null;

	// Always rendered, never raw source: the server cuts frames at block
	// boundaries (safeFlushLength), so what arrives here is markdown that
	// stands on its own rather than a paragraph caught mid-construct.
	return (
		/* .msg-streaming + .msg-body-assistant stay as hooks: the streaming caret
		   is a ::after on that pair, and base.css's reduced-motion exception
		   keeps it blinking by naming the same selector. */
		<div className={cn(msgRow, msgStreamingRow)}>
			<MarkdownBody className={cn(msgBodyStreaming, "markdown")} html={html} />
		</div>
	);
}
