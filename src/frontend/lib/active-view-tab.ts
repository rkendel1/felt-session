// The foregrounded non-session tab in each workspace. This is a per-device
// working preference, like tab order, so switching workspaces or reloading the
// app returns each workspace to the surface that was last in front.
const KEY = "opensession-active-view-tabs";

const VIEW_TABS = [
	"review",
	"conversation",
	// The feed web-panel tab (Tella video embed — the feeds design).
	"video",
	"staging",
	"assets",
	"preview",
	// A sub-agent drill-in opened from a session's transcript. Transient: its
	// breadcrumb stack only lives in memory, so this one is never persisted
	// (saveActiveViewTab drops it) — a reload would restore an empty tab.
	"subagent",
] as const;

export type ActiveViewTab = (typeof VIEW_TABS)[number] | null;
type ActiveViewTabMap = Record<string, ActiveViewTab>;

function read(): ActiveViewTabMap {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, ActiveViewTab] =>
					entry[1] === null ||
					(typeof entry[1] === "string" &&
						(VIEW_TABS as readonly string[]).includes(entry[1])),
			),
		);
	} catch {
		return {};
	}
}

/** `undefined` means the workspace has never had an explicit selection. */
export function getActiveViewTab(workspaceId: string): ActiveViewTab | undefined {
	return read()[workspaceId];
}

export function saveActiveViewTab(
	workspaceId: string,
	tab: ActiveViewTab,
): void {
	if (!workspaceId) return;
	// Sub-agent tabs are transient — leave the workspace's remembered pane
	// alone rather than restoring a tab whose stack is gone.
	if (tab === "subagent") return;
	const map = read();
	map[workspaceId] = tab;
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* private mode / quota: the in-memory selection still works */
	}
}

/** Workspaces whose remembered selection requires that view tab to be open. */
export function getActiveViewTabKeys(tab: Exclude<ActiveViewTab, null>): string[] {
	return Object.entries(read())
		.filter(([, selected]) => selected === tab)
		.map(([workspaceId]) => workspaceId);
}
