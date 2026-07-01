import React, { useEffect, useState } from "react";

/**
 * Self-ticking "how long has this been going" label (CLI-spinner style).
 * Isolated so the once-a-second tick re-renders only this span, not the
 * component that embeds it.
 */
export function Elapsed({
	since,
	className,
}: {
	since: number;
	className?: string;
}) {
	const [, bump] = useState(0);
	useEffect(() => {
		const id = setInterval(() => bump((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);

	const label = formatElapsed(Date.now() - since);
	if (label === null) return null;
	return <span className={className ?? "elapsed-time"}>{label}</span>;
}

export function formatElapsed(ms: number): string | null {
	if (!isFinite(ms)) return null;
	const secs = Math.max(0, Math.floor(ms / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ${secs % 60}s`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m`;
}
