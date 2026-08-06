import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { InlineAlert } from "../ui/state";
import { IconTile } from "./BrandTile";
import { IconPlus, IconTrash } from "./icons";
import { SectionHeading } from "./Connections";
import { SettingCard, rowMenuTriggerClasses } from "../ui/settings";
import type { FeedDescriptor, Project } from "../lib/types";

/**
 * Connections → Projects. A *project* is a source of work with its own sidebar
 * band; a registered git repo is one kind, an MCP-backed feed (Plain, videos,
 * …) the other. Either way its branches/items become workspaces — see
 * CONCEPTS.md.
 *
 * Both kinds are listed here (`/api/projects`), but only feeds are authored
 * here: a repo project is instance config, so it is shown read-only and
 * registered under Setup → Repositories. The New-project modal walks: pick a
 * connected MCP server
 * → pick its list-tool (live catalog) → fetch a sample call → the field
 * mapping is auto-suggested from the result and stays editable → optional
 * web-panel template → Save. Zero code per new project.
 */

// ── mapping suggester ────────────────────────────────────────────────────────

function findItemsPath(obj: unknown): { path: string; sample: any } | null {
	const queue: Array<{ node: any; path: string }> = [{ node: obj, path: "" }];
	let guard = 0;
	while (queue.length && guard++ < 500) {
		const { node, path } = queue.shift()!;
		if (Array.isArray(node)) {
			if (node.length && node[0] && typeof node[0] === "object")
				return { path, sample: node[0] };
			continue;
		}
		if (node && typeof node === "object")
			for (const [k, v] of Object.entries(node))
				queue.push({ node: v, path: path ? `${path}.${k}` : k });
	}
	return null;
}

/** Keys of `sample` (one nesting level deep, dot-joined) whose value is a string. */
function stringPaths(sample: Record<string, any>): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(sample)) {
		if (typeof v === "string" || typeof v === "number") out.push(k);
		else if (v && typeof v === "object" && !Array.isArray(v))
			for (const [k2, v2] of Object.entries(v))
				if (typeof v2 === "string") out.push(`${k}.${k2}`);
	}
	return out;
}

function pick(paths: string[], patterns: RegExp[]): string {
	for (const p of patterns) {
		const hit = paths.find((k) => p.test(k.split(".").pop() || k));
		if (hit) return hit;
	}
	return "";
}

function suggestMap(sample: Record<string, any>) {
	const paths = stringPaths(sample);
	return {
		id: pick(paths, [/^id$/i, /Id$/, /^key$/i, /^slug$/i]),
		title: pick(paths, [/^(name|title|subject|label)$/i]),
		preview: pick(paths, [/^(description|preview|summary|excerpt|text)$/i]),
		ts: pick(paths, [/^(updatedAt|updated_at|modifiedAt)$/i, /^(createdAt|created_at|date|ts)$/i]),
		url: paths.find((k) => /^https?:\/\//.test(String(sample[k.split(".")[0]]?.[k.split(".")[1]] ?? sample[k]))) || "",
		thumbnail: pick(paths, [/thumb/i, /image/i, /avatar/i]),
	};
}

// ── component ────────────────────────────────────────────────────────────────

const inputCls =
	"w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-control-label text-fg outline-none focus:border-faint";
const labelCls = "mb-1 mt-3 block text-meta font-semibold text-faint";

export function ProjectsSection() {
	const [feeds, setFeeds] = useState<FeedDescriptor[] | null>(null);
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`${BASE_PATH}/api/feeds`);
			if (res.ok) setFeeds((await res.json()).feeds || []);
		} catch {}
		try {
			// The union view: repo projects come from the registry, feed
			// projects from the same descriptors above. Only feeds are
			// editable here, but both belong in the list — a project is a
			// project regardless of what backs it.
			const res = await fetch(`${BASE_PATH}/api/projects`);
			if (res.ok) setProjects((await res.json()).projects || []);
		} catch {}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	async function remove(id: string) {
		if (!confirm(`Remove project "${id}"? Its sidebar band disappears; existing workspaces keep working.`)) return;
		const res = await fetch(`${BASE_PATH}/api/feeds/${encodeURIComponent(id)}`, { method: "DELETE" });
		if (!res.ok) setError((await res.json()).error || `Failed: ${res.status}`);
		void load();
	}

	const repoProjects = (projects || []).filter((p) => p.kind === "repo");

	return (
		<>
			<SectionHeading>
				Projects — every source of work, one band each
			</SectionHeading>
			{error && (
				<InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
			)}
			{!!repoProjects.length && (
				<SettingCard>
					{repoProjects.map((p) => (
						<div key={p.key} className="flex items-center gap-3 px-4 py-3">
							<IconTile name={p.id} size={30} />
							<div className="min-w-0 flex-1">
								<div className="text-body font-medium text-fg">{p.label}</div>
								<div className="truncate text-label text-dim">
									Repository · {p.repo?.ghRepo}
									{p.repo?.defaultBranch ? ` · ${p.repo.defaultBranch}` : ""}
									{p.repo?.sharedCheckout ? " · shared checkout" : ""}
									{p.repo?.isDefault ? " · default" : ""}
								</div>
							</div>
						</div>
					))}
				</SettingCard>
			)}
			<SettingCard>
				{(feeds || []).map((f) => (
					<div
						key={f.id}
						className="group flex items-center gap-3 px-4 py-3"
					>
						<IconTile name={f.id} size={30} />
						<div className="min-w-0 flex-1">
							<div className="text-body font-medium text-fg">{f.title}</div>
							<div className="truncate text-label text-dim">
								{f.fromConfig ? "Config project" : "Built-in"} · ref {f.refKind}
								{f.mcpServers?.length ? ` · MCP: ${f.mcpServers.join(", ")}` : ""}
							</div>
						</div>
						{f.fromConfig && (
							<button
								className={cn(
									rowMenuTriggerClasses,
									"opacity-0 transition-[color,opacity,background] hover:text-red group-hover:opacity-100",
								)}
								onClick={() => remove(f.id)}
								aria-label={`Remove ${f.title}`}
							>
								<IconTrash size={16} />
							</button>
						)}
					</div>
				))}
				<button
					className="flex w-full items-center gap-2 px-4 py-3 text-control-label font-medium text-dim transition-colors hover:bg-hover hover:text-fg"
					onClick={() => setOpen(true)}
				>
					<IconPlus size={16} /> New project
				</button>
			</SettingCard>
			<NewProjectModal
				open={open}
				onClose={() => setOpen(false)}
				onSaved={() => {
					setOpen(false);
					void load();
				}}
			/>
		</>
	);
}

function NewProjectModal({
	open,
	onClose,
	onSaved,
}: {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [title, setTitle] = useState("");
	const [servers, setServers] = useState<string[]>([]);
	const [server, setServer] = useState("");
	const [tools, setTools] = useState<{ name: string; description?: string }[]>([]);
	const [tool, setTool] = useState("");
	const [argsText, setArgsText] = useState("{}");
	const [path, setPath] = useState("");
	const [map, setMap] = useState({ id: "", title: "", preview: "", ts: "", url: "", thumbnail: "" });
	const [sampleItem, setSampleItem] = useState<string | null>(null);
	const [panelLabel, setPanelLabel] = useState("");
	const [panelEmbed, setPanelEmbed] = useState("");
	const [panelLinkLabel, setPanelLinkLabel] = useState("");
	const [panelLinkHref, setPanelLinkHref] = useState("");
	const [tileBg, setTileBg] = useState("#64748b");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Connected HTTP servers for the picker.
	useEffect(() => {
		if (!open) return;
		void (async () => {
			try {
				const res = await fetch(`${BASE_PATH}/api/connections`);
				if (!res.ok) return;
				const body = await res.json();
				setServers(
					(body.mcpServers || [])
						.filter((s: { transport: string }) => s.transport === "http")
						.map((s: { name: string }) => s.name),
				);
			} catch {}
		})();
	}, [open]);

	// Tool catalog on server change.
	useEffect(() => {
		setTools([]);
		setTool("");
		if (!server) return;
		void (async () => {
			setBusy("Loading tool catalog…");
			try {
				const res = await fetch(
					`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(server)}/tools`,
				);
				const body = await res.json();
				if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
				const all = body.tools || [];
				// list-ish tools first — they're what feeds are built from.
				all.sort((a: { name: string }, b: { name: string }) => {
					const la = /^(list|search|get_all)/.test(a.name) ? 0 : 1;
					const lb = /^(list|search|get_all)/.test(b.name) ? 0 : 1;
					return la - lb || a.name.localeCompare(b.name);
				});
				setTools(all);
			} catch (e: any) {
				setError(e.message);
			} finally {
				setBusy(null);
			}
		})();
	}, [server]);

	async function fetchSample() {
		setError(null);
		setBusy("Calling the tool…");
		try {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(argsText || "{}");
			} catch {
				throw new Error("Args must be valid JSON");
			}
			const res = await fetch(`${BASE_PATH}/api/feeds/preview`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ server, tool, args }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			const raw = body.result ?? JSON.parse(body.sample || "null");
			const found = findItemsPath(raw);
			if (!found) throw new Error("No array of items found in the tool result — try different args or another tool");
			setPath(found.path);
			setMap(suggestMap(found.sample));
			setSampleItem(JSON.stringify(found.sample, null, 1).slice(0, 600));
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(null);
		}
	}

	async function save() {
		setError(null);
		setBusy("Saving…");
		try {
			const id = title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 30);
			if (!id) throw new Error("Give the project a name");
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(argsText || "{}");
			} catch {
				throw new Error("Args must be valid JSON");
			}
			const body = {
				id,
				title: title.trim(),
				refKind: id,
				tileBg,
				mcpServers: [server],
				items: {
					server,
					tool,
					args,
					...(path ? { path } : {}),
					map: Object.fromEntries(
						Object.entries(map).filter(([, v]) => v),
					),
				},
				...(panelLabel && panelEmbed
					? {
							panel: {
								label: panelLabel,
								embedUrlTemplate: panelEmbed,
								...(panelLinkLabel && panelLinkHref
									? { links: [{ label: panelLinkLabel, hrefTemplate: panelLinkHref }] }
									: {}),
							},
						}
					: {}),
			};
			const res = await fetch(`${BASE_PATH}/api/feeds`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const out = await res.json();
			if (!res.ok) throw new Error(out.error || `Failed: ${res.status}`);
			onSaved();
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(null);
		}
	}

	const canSave = !!title.trim() && !!server && !!tool && !!map.id && !!map.title;

	return (
		<Modal.Root open={open} onOpenChange={(v) => !v && onClose()}>
			<Modal.Content widthClassName="max-w-[34rem]">
				<Modal.Header
					title="New project"
					description="A sidebar feed built from one MCP tool call — pick a server and its list-tool, fetch a sample, adjust the mapping."
				/>
				<div className="max-h-[60vh] overflow-y-auto px-1">
					<label className={labelCls}>Name</label>
					<input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Videos, Tickets, Posts…" />

					<div className="grid grid-cols-2 gap-3">
						<div>
							<label className={labelCls}>MCP server</label>
							<select className={inputCls} value={server} onChange={(e) => setServer(e.target.value)}>
								<option value="">Pick…</option>
								{servers.map((s) => (
									<option key={s} value={s}>{s}</option>
								))}
							</select>
						</div>
						<div>
							<label className={labelCls}>List tool</label>
							<select className={inputCls} value={tool} onChange={(e) => setTool(e.target.value)} disabled={!tools.length}>
								<option value="">{tools.length ? "Pick…" : "Pick a server first"}</option>
								{tools.map((t) => (
									<option key={t.name} value={t.name} title={t.description}>{t.name}</option>
								))}
							</select>
						</div>
					</div>

					<label className={labelCls}>Tool args (JSON)</label>
					<div className="flex gap-2">
						<input className={inputCls} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
						<Button
							variant="primary"
							className="flex-shrink-0 text-control-label"
							onClick={fetchSample}
							disabled={!server || !tool || !!busy}
						>
							Fetch sample
						</Button>
					</div>

					{sampleItem && (
						<>
							<label className={labelCls}>Sample item (items path: “{path || "(root)"}”)</label>
							<pre className="max-h-28 overflow-auto rounded-md border border-line bg-surface p-2 text-meta leading-snug text-dim">{sampleItem}</pre>
						</>
					)}

					<div className="grid grid-cols-3 gap-3">
						{(["id", "title", "preview", "ts", "url", "thumbnail"] as const).map((k) => (
							<div key={k}>
								<label className={labelCls}>
									{k}
									{k === "id" || k === "title" ? " *" : ""}
								</label>
								<input
									className={inputCls}
									value={map[k]}
									onChange={(e) => setMap((m) => ({ ...m, [k]: e.target.value }))}
									placeholder="field path"
								/>
							</div>
						))}
					</div>

					<label className={labelCls}>Panel (optional) — tab label + {"{id}"}-templated embed URL</label>
					<div className="grid grid-cols-[1fr_2fr] gap-3">
						<input className={inputCls} value={panelLabel} onChange={(e) => setPanelLabel(e.target.value)} placeholder="Video" />
						<input className={inputCls} value={panelEmbed} onChange={(e) => setPanelEmbed(e.target.value)} placeholder="https://…/{id}/embed" />
					</div>
					<div className="mt-2 grid grid-cols-[1fr_2fr] gap-3">
						<input className={inputCls} value={panelLinkLabel} onChange={(e) => setPanelLinkLabel(e.target.value)} placeholder="Open" />
						<input className={inputCls} value={panelLinkHref} onChange={(e) => setPanelLinkHref(e.target.value)} placeholder="https://…/{id}" />
					</div>

					<label className={labelCls}>Tile color</label>
					<input className={inputCls} value={tileBg} onChange={(e) => setTileBg(e.target.value)} />

					{error && <InlineAlert className="mt-3">{error}</InlineAlert>}
					{busy && <div className="mt-3 text-label text-faint">{busy}</div>}
				</div>
				<Modal.Footer>
					<div className="flex-1" />
					<Modal.Close
						render={
							<Button variant="ghost">
								Cancel
							</Button>
						}
					/>
					<Button
						variant="primary"
						className="px-5"
						onClick={save}
						disabled={!canSave || !!busy}
					>
						Create project
					</Button>
				</Modal.Footer>
			</Modal.Content>
		</Modal.Root>
	);
}
