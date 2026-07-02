import React, { useCallback, useEffect, useState } from "react";

interface LightboxState {
	images: string[];
	index: number;
}

/**
 * Fullscreen viewer for inline transcript images. Mounted once at the app
 * root: a capture-phase document click handler hijacks clicks on any
 * `img.md-image` — message attachments, markdown images, tool-result
 * screenshots — and opens it in an overlay with prev/next browsing across
 * the clicked image's group, instead of the old dead-end `data:` new-tab
 * navigation (which browsers block anyway).
 */
export function ImageLightbox() {
	const [state, setState] = useState<LightboxState | null>(null);

	useEffect(() => {
		const onClick = (e: MouseEvent) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
				return;
			const target = e.target as Element | null;
			const img = target?.closest?.("img.md-image");
			if (!(img instanceof HTMLImageElement)) return;
			e.preventDefault();
			e.stopPropagation();

			// Browse within the clicked image's own group (one message's
			// attachments, one markdown body, one tool result) — not every
			// image in the transcript.
			const group =
				img.closest(".msg-images, .tool-result-images, .markdown") ??
				document.body;
			const siblings = Array.from(
				group.querySelectorAll<HTMLImageElement>("img.md-image"),
			);
			setState({
				images: siblings.map((el) => el.currentSrc || el.src),
				index: Math.max(0, siblings.indexOf(img)),
			});
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	const close = useCallback(() => setState(null), []);
	const step = useCallback((delta: number) => {
		setState(
			(s) =>
				s && { ...s, index: (s.index + delta + s.images.length) % s.images.length },
		);
	}, []);

	const open = state !== null;
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				close();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				step(-1);
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				step(1);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, close, step]);

	if (!state) return null;
	const { images, index } = state;
	const many = images.length > 1;

	return (
		<div className="lightbox" onClick={close} role="dialog" aria-modal="true">
			<button
				type="button"
				className="lightbox-close"
				onClick={close}
				title="Close (Esc)"
			>
				×
			</button>
			{many && (
				<button
					type="button"
					className="lightbox-nav lightbox-prev"
					onClick={(e) => {
						e.stopPropagation();
						step(-1);
					}}
					title="Previous (←)"
				>
					‹
				</button>
			)}
			<img
				className="lightbox-img"
				src={images[index]}
				alt=""
				onClick={(e) => e.stopPropagation()}
			/>
			{many && (
				<button
					type="button"
					className="lightbox-nav lightbox-next"
					onClick={(e) => {
						e.stopPropagation();
						step(1);
					}}
					title="Next (→)"
				>
					›
				</button>
			)}
			{many && (
				<div className="lightbox-counter">
					{index + 1} / {images.length}
				</div>
			)}
		</div>
	);
}
