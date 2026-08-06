import React, { useEffect, useRef, useState } from "react";
import { effectiveTheme, onThemeChanged, type EffectiveTheme } from "../lib/theme";

/**
 * Rendered-markdown container that upgrades ```lang fences after mount:
 * ```mermaid fences render as inline diagrams, every other tagged fence gets
 * shiki highlighting. Both libraries are multi-MB, so each is only dynamically
 * imported when a message actually carries a matching fence — plain messages
 * render the marked output untouched. Fences with no (or an unshipped)
 * language keep the stock .markdown <pre> styling.
 */
export function MarkdownBody({
	html,
	className,
}: {
	html: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [theme, setTheme] = useState<EffectiveTheme>(effectiveTheme);
	const [visible, setVisible] = useState(false);
	useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);
	useEffect(() => {
		const node = ref.current;
		if (!node || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const root = node.closest(".viewer-messages");
		const observer = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry?.isIntersecting)),
			{ root, rootMargin: "800px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		// marked emits <code class="language-x"> only for tagged fences.
		if (!visible || !html.includes('<code class="language-')) return;
		const el = ref.current;
		if (!el) return;
		let alive = true;
		(async () => {
			// Restore the pristine marked output first: a theme flip re-runs this
			// effect, and both upgrades must start from the original fences, not
			// from the previous pass's shiki/mermaid markup.
			el.innerHTML = html;
			const fences = Array.from(
				el.querySelectorAll('pre > code[class*="language-"]'),
			).map((code) => ({
				code,
				lang: /language-([^\s"]+)/.exec(code.className)?.[1],
			}));

			// ```mermaid fences become inline diagrams; source that doesn't parse
			// (still streaming, or just wrong) keeps the plain code fence.
			if (fences.some((f) => f.lang === "mermaid")) {
				const m = await import("../lib/mermaid").catch(() => null);
				for (const { code, lang } of fences) {
					if (!m || lang !== "mermaid") continue;
					const svg = await m
						.renderMermaidSvg(code.textContent ?? "")
						.catch(() => null);
					const pre = code.parentElement;
					if (!alive || !svg || !pre || !el.contains(pre)) continue;
					const wrap = document.createElement("div");
					wrap.className = "md-mermaid";
					wrap.innerHTML = svg;
					pre.replaceWith(wrap);
				}
			}

			if (!fences.some((f) => f.lang && f.lang !== "mermaid")) return;
			const m = await import("./CodeHighlight").catch(() => null);
			if (!m || !alive) return;
			for (const { code, lang } of fences) {
				if (!lang || lang === "mermaid" || !el.contains(code)) continue;
				const raw = code.textContent ?? "";
				// Giant generated files stay a permanent plain <pre>; highlighting
				// them is expensive and adds little reading value.
				if (raw.length > 20_000) continue;
				const out = await m.highlightToHtml(raw, lang);
				const pre = code.parentElement;
				if (!alive || !out || !pre || !el.contains(pre)) continue;
				const tpl = document.createElement("template");
				tpl.innerHTML = out;
				const shikiPre = tpl.content.firstElementChild;
				if (shikiPre) {
					shikiPre.classList.add("md-code");
					pre.replaceWith(shikiPre);
				}
			}
		})().catch(() => {}); // both upgrades are progressive enhancement — plain pre stays
		return () => {
			alive = false;
		};
	}, [html, theme, visible]);

	return (
		<div
			ref={ref}
			className={className}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
