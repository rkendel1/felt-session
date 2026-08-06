import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import markUrl from "../os1-mac/build/icon-512.png";
import {
	IconCheck,
	IconCopy,
	IconRepo,
	IconTerminal,
} from "../src/frontend/components/icons";
import "./site.css";
import { ProductDemo } from "./ProductDemo";
import { TellaBackground } from "./TellaBackground";

const installCommand =
	"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash";

const Agentation = lazy(() =>
	import("agentation").then((module) => ({ default: module.Agentation })),
);

function Mark({ small = false }: { small?: boolean }) {
	return (
		<span className={small ? "mark mark-small" : "mark"}>
			<img src={markUrl} alt="" />
		</span>
	);
}

const features = [
	{
		number: "01",
		title: "Run agents in parallel",
		body: "Fan work out across models and focused child sessions. Each task keeps its own context and progress, then reports back to the main thread.",
	},
	{
		number: "02",
		title: "Collaborate in every session",
		body: "Teammates can watch live, answer questions, steer runs, and review agent output together from the web, desktop, or phone.",
	},
	{
		number: "03",
		title: "Ship from your own stack",
		body: "Run in git worktrees or isolated sandboxes on machines you control, using your existing model accounts, tools, and integrations.",
	},
];

function CopyCommand() {
	const [copied, setCopied] = useState(false);
	async function copy() {
		await navigator.clipboard.writeText(installCommand);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1800);
	}

	return (
		<div className="command-line">
			<code>
				<span>$</span> {installCommand}
			</code>
			<button type="button" onClick={copy} aria-label="Copy install command">
				{copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
				<span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
			</button>
		</div>
	);
}

function LandingPage() {
	const [activeFeature, setActiveFeature] = useState(0);
	const featureRefs = useRef<Array<HTMLElement | null>>([]);

	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const index = Number((entry.target as HTMLElement).dataset.feature);
					if (Number.isInteger(index)) setActiveFeature(index);
				}
			},
			{ rootMargin: "-45% 0px -45%", threshold: 0 },
		);
		for (const node of featureRefs.current) if (node) observer.observe(node);
		return () => observer.disconnect();
	}, []);

	return (
		<>
			<section className="hero">
				<div className="gradient-fallback" aria-hidden="true" />
				<TellaBackground />
				<div className="hero-wash" aria-hidden="true" />

				<header className="site-header page-width">
					<a className="brand" href="#top" aria-label="Open Session home">
						<Mark />
						<span>Open Session</span>
					</a>
					<nav aria-label="Main navigation">
						<a href="#why">How it works</a>
						<a href="https://github.com/tellahq/opensession">GitHub</a>
						<a className="nav-cta" href="#install">
							Get started
						</a>
					</nav>
				</header>

			<div className="hero-content page-width" id="top">
				<div className="hero-story">
					<div className="hero-copy">
						<h1>Run your coding agents. Together.</h1>
						<p className="hero-description">
							Run Claude, Codex, and other coding agents side by side. Work in
							parallel and bring your team into every session.
						</p>
						<div className="hero-actions">
							<a className="button button-primary" href="#install">
								Get started
							</a>
							<a
								className="button button-secondary"
								href="https://github.com/tellahq/opensession"
							>
								View on GitHub <span aria-hidden="true">↗</span>
							</a>
						</div>
						<div className="proof-line">
							<span>MIT</span>
							<i />
							<span>Use your existing subscriptions</span>
							<i />
							<span>Worktrees and sandboxes</span>
						</div>
					</div>

					<div className="hero-scroll-notes" id="why">
						{features.map((feature, index) => (
							<article
								className="hero-scroll-note"
								data-active={activeFeature === index}
								data-feature={index}
								key={feature.number}
								ref={(node) => {
									featureRefs.current[index] = node;
								}}
							>
								<span>{feature.number}</span>
								<h2>{feature.title}</h2>
								<p>{feature.body}</p>
							</article>
						))}
					</div>
				</div>
				<div className="hero-stage">
					<ProductDemo feature={activeFeature} />
				</div>
			</div>
		</section>

		<main>
			<section className="install-section page-width" id="install">
					<div className="install-card">
						<div className="install-copy">
							<p className="section-kicker section-kicker-dark">
								Start on your own machine
							</p>
							<h2>Start with one command.</h2>
							<p>
								The installer adds Bun and OpenCode when needed, then connects
								the model subscriptions and integrations you already use.
							</p>
						</div>
						<CopyCommand />
						<div className="install-meta">
							<span>
								<IconTerminal size={20} /> Linux and macOS
							</span>
							<span>
								<IconCheck size={20} /> Setup in under a minute
							</span>
						</div>
						<div className="trust-note">
							<IconRepo size={20} />
							<p>
								<strong>Private by design.</strong> Open Session trusts everyone
								who can reach it. Keep your instance on Tailscale, behind a VPN,
								or behind an SSH tunnel.
							</p>
						</div>
					</div>
				</section>
			</main>

			<footer className="site-footer page-width">
				<a className="brand brand-footer" href="#top">
					<Mark small />
					<span>Open Session</span>
				</a>
				<p>The open-source workspace for teams building with agents.</p>
				<nav aria-label="Footer navigation">
					<a href="https://github.com/tellahq/opensession">GitHub</a>
					<a href="https://github.com/tellahq/opensession/tree/main/docs/setup">
						Docs
					</a>
					<a href="https://github.com/tellahq/opensession/blob/main/SECURITY.md">
						Security
					</a>
				</nav>
			</footer>
		</>
	);
}

const feedbackHost =
	["localhost", "127.0.0.1"].includes(window.location.hostname) ||
	window.location.hostname.endsWith(".ts.net");

const root = document.getElementById("root");
if (!root) throw new Error("Missing landing page root");

createRoot(root).render(
	<>
		<LandingPage />
		{feedbackHost && (
			<Suspense fallback={null}>
				<Agentation />
			</Suspense>
		)}
	</>,
);
