import React, { useEffect, useState, useCallback } from "react";

interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "unreachable" | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (absent = everyone). */
  allowedUsers?: string[];
}

interface AgentHealth {
  status?: string;
  activeSessions?: number;
  [key: string]: unknown;
}

interface ConnectionsData {
  mcpServers: McpConnection[];
  agents: Record<string, AgentHealth>;
}

const STATUS_META: Record<McpConnection["status"], { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "green" },
  ready: { label: "Ready", tone: "green" },
  "needs-env": { label: "Needs env", tone: "yellow" },
  unreachable: { label: "Unreachable", tone: "red" },
  missing: { label: "Missing", tone: "red" },
};

const MCP_BLURBS: Record<string, string> = {
  linear: "Issues & projects — sessions can read and update Linear",
  plain: "Customer support threads from Plain",
  sentry: "Errors and performance issues",
  workos: "User & organization admin",
  tinybird: "Analytics queries over product events",
};

const AGENT_BLURBS: Record<string, string> = {
  slack: "Mentions & worktree channels in Slack",
  linear: "Delegated Linear issues become sessions",
  plain: "Support escalations from Plain",
};

export function Connections() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`/backstage/api/connections${force ? "?refresh=1" : ""}`);
      if (res.ok) setData(await res.json());
    } catch {}
    setRefreshing(false);
  }, []);

  useEffect(() => {
    document.title = "Connections — Michael";
    load();
    return () => {
      document.title = "Michael — Tella";
    };
  }, [load]);

  async function handleRemove(name: string) {
    if (!confirm(`Remove MCP server "${name}"? New sessions will no longer get its tools.`)) return;
    try {
      const res = await fetch(`/backstage/api/connections/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load(true);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  async function handleRestrict(s: McpConnection) {
    const current = (s.allowedUsers || []).join(", ");
    const answer = prompt(
      `Restrict "${s.name}" to these people (comma-separated names, e.g. "Michiel, Grant").\n` +
        `Leave blank to make it available to everyone.`,
      current,
    );
    if (answer === null) return; // cancelled
    const allowedUsers = answer
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`/backstage/api/connections/mcp/${encodeURIComponent(s.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedUsers }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load(true);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  return (
    <div className="connections">
      <div className="page-header">
        <div>
          <h2 className="page-title">Connections</h2>
          <div className="page-sub">
            What Michael is wired into — inbound agents and the MCP tools every session can use.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-small" onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? "Checking…" : "↻ Re-check"}
          </button>
          <button className="btn-new-session" style={{ marginTop: 0, padding: "6px 14px" }} onClick={() => setShowAdd(true)}>
            + Add MCP server
          </button>
        </div>
      </div>

      {removeError && (
        <div className="form-error" onClick={() => setRemoveError(null)}>{removeError}</div>
      )}

      {showAdd && (
        <AddMcpForm
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load(true);
          }}
        />
      )}

      {!data ? (
        <div className="loading">Checking connections…</div>
      ) : (
        <>
          <div className="conn-section-title">Agents — how work reaches Michael</div>
          <div className="conn-grid">
            {Object.entries(data.agents).map(([name, health]) => {
              const ok = health?.status === "operational";
              return (
                <div key={name} className="conn-card">
                  <div className="conn-card-top">
                    <span className={`conn-logo conn-logo-${name}`}>{name.charAt(0).toUpperCase()}</span>
                    <span className="conn-name">{name}</span>
                    <span className={`status-pill status-${ok ? "green" : "red"}`}>
                      {ok ? "Operational" : String(health?.status || "down")}
                    </span>
                  </div>
                  <div className="conn-blurb">{AGENT_BLURBS[name] || "Inbound agent"}</div>
                  {typeof health?.activeSessions === "number" && (
                    <div className="conn-detail">{health.activeSessions} active session{health.activeSessions === 1 ? "" : "s"}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="conn-section-title">MCP servers — tools inside every session</div>
          <div className="conn-grid">
            {data.mcpServers.map((s) => {
              const meta = STATUS_META[s.status];
              return (
                <div key={s.name} className="conn-card">
                  <div className="conn-card-top">
                    <span className={`conn-logo conn-logo-${s.name}`}>{s.name.charAt(0).toUpperCase()}</span>
                    <span className="conn-name">{s.name}</span>
                    <span className={`status-pill status-${meta.tone}`} title={s.detail}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="conn-blurb">{MCP_BLURBS[s.name] || "MCP server"}</div>
                  <div className="conn-detail">
                    <span className="conn-transport">{s.transport}</span>
                    <span className="conn-target" title={s.target}>{s.target}</span>
                  </div>
                  <div className="conn-detail">
                    {s.allowedUsers?.length ? (
                      <span
                        className="conn-transport"
                        title={`Only these people's sessions get this server: ${s.allowedUsers.join(", ")}`}
                      >
                        🔒 {s.allowedUsers.join(", ")}
                      </span>
                    ) : (
                      <span className="conn-target">Available to everyone</span>
                    )}
                  </div>
                  {s.status !== "connected" && s.status !== "ready" && s.detail && (
                    <div className="conn-error">{s.detail}</div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="conn-remove"
                      onClick={() => handleRestrict(s)}
                      title="Restrict this MCP server to specific users"
                    >
                      {s.allowedUsers?.length ? "Edit access" : "Restrict"}
                    </button>
                    <button
                      className="conn-remove"
                      onClick={() => handleRemove(s.name)}
                      title="Remove this MCP server"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <ClaudeAccounts />

          <CodexAccounts />

          <div className="conn-footnote">
            Changes apply to new session runs immediately (config is read per run). In a session
            transcript, MCP tool calls show up tagged with their server name.
          </div>
        </>
      )}
    </div>
  );
}

interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

interface ClaudeAccountInfo {
  id: string;
  name: string;
  tokenMasked: string;
  email?: string;
  plan?: string;
  usage: {
    fetchedAt: string;
    fiveHour: UsageWindow | null;
    sevenDay: UsageWindow | null;
    error?: string;
    errorStatus?: number;
  } | null;
  noUsageScope: boolean;
  exhaustedUntil: string | null;
  usable: boolean;
}

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  if (isNaN(d.getTime())) return "";
  return `resets ${d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

function UsageBar({ label, window: w }: { label: string; window: UsageWindow | null }) {
  const pct = w?.utilization ?? null;
  const tone = pct === null ? "gray" : pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
  return (
    <div className="acct-usage-row">
      <span className="acct-usage-label">{label}</span>
      <div className="acct-usage-bar">
        <div
          className={`acct-usage-fill acct-usage-${tone}`}
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      </div>
      <span className="acct-usage-pct">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
      <span className="acct-usage-reset">{formatReset(w?.resetsAt ?? null)}</span>
    </div>
  );
}

interface ModelInfo {
  id: string;
  provider: "claude" | "codex";
  label: string;
  aliases: string[];
}

export function DefaultModel() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/backstage/api/models");
      if (res.ok) {
        const body = await res.json();
        setModels(body.models);
        setCurrent(body.default);
      }
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Optimistic: highlight the clicked row immediately, revert if the save fails.
  async function handleChange(id: string) {
    if (id === current || saving) return;
    const prev = current;
    setCurrent(id);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/backstage/api/models/default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setCurrent(body.default);
    } catch (e: any) {
      setError(e.message);
      setCurrent(prev);
    }
    setSaving(false);
  }

  const groups = [
    { label: "Claude", items: (models || []).filter((m) => m.provider === "claude") },
    { label: "Codex", items: (models || []).filter((m) => m.provider === "codex") },
  ].filter((g) => g.items.length > 0);

  return (
    <>
      {error && (
        <div className="form-error" onClick={() => setError(null)}>{error}</div>
      )}
      <div className="setting-card model-picker" role="radiogroup" aria-label="Default model">
        {!models && <div className="model-picker-empty">Loading models…</div>}
        {models && groups.length === 0 && (
          <div className="model-picker-empty">No models available.</div>
        )}
        {groups.map((g) => (
          <div className="model-group" key={g.label}>
            <div className="model-group-label">{g.label}</div>
            {g.items.map((m) => {
              const active = m.id === current;
              return (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={active}
                  className={`model-row ${active ? "active" : ""}`}
                  onClick={() => handleChange(m.id)}
                >
                  <span className="model-row-radio" aria-hidden="true" />
                  <span className="model-row-name">{m.label}</span>
                  {m.aliases[0] && <span className="model-row-alias">{m.aliases[0]}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="settings-hint">
        New sessions and agent runs (Slack, Linear, Plain, automations without their own model)
        start on this model. Per-session overrides still win. Applies to the next run — no
        restart needed.
      </div>
    </>
  );
}

function ClaudeAccounts() {
  const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceUsage = false) => {
    if (forceUsage) setRefreshing(true);
    try {
      const res = forceUsage
        ? await fetch("/backstage/api/claude-accounts/refresh", { method: "POST" })
        : await fetch("/backstage/api/claude-accounts");
      if (res.ok) setAccounts((await res.json()).accounts);
    } catch {}
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function handleRemove(a: ClaudeAccountInfo) {
    if (!confirm(`Remove Claude account "${a.name}"? Runs will stop using its token.`)) return;
    try {
      const res = await fetch(`/backstage/api/claude-accounts/${encodeURIComponent(a.id)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="conn-section-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>Claude accounts — usage pool for session runs</span>
        <button className="btn-small" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? "Checking…" : "↻ Refresh usage"}
        </button>
        <button className="btn-small" onClick={() => setShowAdd(true)}>
          + Add account
        </button>
      </div>

      {error && (
        <div className="form-error" onClick={() => setError(null)}>{error}</div>
      )}

      {showAdd && (
        <AddAccountForm
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {!accounts ? (
        <div className="loading">Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div className="conn-footnote">
          No accounts yet. Runs use the VPS's own Claude login. Add Max-account tokens
          (<code>claude setup-token</code> on a machine logged into that account) and runs will
          pick the least-used one, rotating automatically when one hits its usage limit.
        </div>
      ) : (
        <div className="conn-grid">
          {accounts.map((a) => (
            <div key={a.id} className="conn-card">
              <div className="conn-card-top">
                <span className="conn-logo conn-logo-claude">{a.name.charAt(0).toUpperCase()}</span>
                <span className="conn-name">{a.name}</span>
                {a.usage?.error && a.usage.errorStatus === 401 ? (
                  <span className="status-pill status-red" title={a.usage.error}>Token error</span>
                ) : a.exhaustedUntil ? (
                  <span className="status-pill status-red" title={`Sidelined until ${a.exhaustedUntil}`}>
                    Limit hit
                  </span>
                ) : a.usable ? (
                  <span className="status-pill status-green">In rotation</span>
                ) : (
                  <span className="status-pill status-yellow">Near limit</span>
                )}
                {a.noUsageScope && (
                  <span
                    className="status-pill status-gray"
                    title="This token can't read the usage endpoint (setup-tokens lack the user:profile scope). Runs work fine; usage isn't shown."
                  >
                    No usage data
                  </span>
                )}
              </div>
              <div className="conn-blurb">
                {a.email || "unknown email"}
                {a.plan ? ` · ${a.plan.replace("default_claude_", "")}` : ""}
              </div>
              <div className="conn-detail">
                <span className="conn-target">{a.tokenMasked}</span>
              </div>
              {!a.noUsageScope && (
                <>
                  <UsageBar label="5h" window={a.usage?.fiveHour ?? null} />
                  <UsageBar label="7d" window={a.usage?.sevenDay ?? null} />
                  {a.usage?.error && <div className="conn-error">{a.usage.error}</div>}
                </>
              )}
              <button className="conn-remove" onClick={() => handleRemove(a)} title="Remove this account">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface CodexAccountInfo {
  id: string;
  name: string;
  kind: "api_key" | "home";
  valueMasked: string;
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

function CodexAccounts() {
  const [accounts, setAccounts] = useState<CodexAccountInfo[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/backstage/api/codex-accounts");
      if (res.ok) setAccounts((await res.json()).accounts);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function handleRemove(a: CodexAccountInfo) {
    if (!confirm(`Remove Codex account "${a.name}"? Runs will stop using it.`)) return;
    try {
      const res = await fetch(`/backstage/api/codex-accounts/${encodeURIComponent(a.id)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="conn-section-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>Codex accounts — pool for GPT/Codex session runs</span>
        <button className="btn-small" onClick={() => setShowAdd(true)}>
          + Add account
        </button>
      </div>

      {error && (
        <div className="form-error" onClick={() => setError(null)}>{error}</div>
      )}

      {showAdd && (
        <AddCodexAccountForm
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {!accounts ? (
        <div className="loading">Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div className="conn-footnote">
          No accounts yet. Codex runs use the VPS's own <code>codex login</code> (~/.codex). Add an
          OpenAI API key, or a CODEX_HOME directory holding a ChatGPT-plan <code>auth.json</code>,
          and runs will rotate across the pool when one hits its usage limit.
        </div>
      ) : (
        <div className="conn-grid">
          {accounts.map((a) => (
            <div key={a.id} className="conn-card">
              <div className="conn-card-top">
                <span className="conn-logo conn-logo-codex">{a.name.charAt(0).toUpperCase()}</span>
                <span className="conn-name">{a.name}</span>
                {a.exhaustedUntil ? (
                  <span className="status-pill status-red" title={`Sidelined until ${a.exhaustedUntil}`}>
                    Limit hit
                  </span>
                ) : (
                  <span className="status-pill status-green">In rotation</span>
                )}
                <span className="status-pill status-gray">
                  {a.kind === "api_key" ? "API key" : "ChatGPT login"}
                </span>
              </div>
              <div className="conn-detail">
                <span className="conn-target">{a.valueMasked}</span>
              </div>
              <button className="conn-remove" onClick={() => handleRemove(a)} title="Remove this account">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AddCodexAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"api_key" | "home">("home");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/backstage/api/codex-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind, value: value.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      onAdded();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="automation-form" style={{ marginBottom: 18 }}>
      <div className="automation-form-title">Add Codex account</div>
      <div className="conn-footnote" style={{ marginTop: 0 }}>
        For a ChatGPT plan: on the VPS run <code>CODEX_HOME=~/.codex-accounts/&lt;name&gt; codex login</code>,
        then register that directory here. For platform billing, paste an OpenAI API key instead.
      </div>

      <div className="automation-form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="tella-dev" />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as "api_key" | "home")}>
            <option value="home">ChatGPT login — CODEX_HOME directory</option>
            <option value="api_key">OpenAI API key</option>
          </select>
        </label>
        <label>
          {kind === "api_key" ? "API key" : "CODEX_HOME path"}
          <input
            className="mono-input"
            type={kind === "api_key" ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={kind === "api_key" ? "sk-…" : "/home/ubuntu/.codex-accounts/tella-dev"}
          />
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleAdd}
          disabled={saving || !name.trim() || !value.trim()}
        >
          {saving ? "Adding…" : "Add account"}
        </button>
      </div>
    </div>
  );
}

function AddAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/backstage/api/claude-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), token: token.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      onAdded();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="automation-form" style={{ marginBottom: 18 }}>
      <div className="automation-form-title">Add Claude account</div>
      <div className="conn-footnote" style={{ marginTop: 0 }}>
        On any machine, log into the Max account with <code>claude</code>, run{" "}
        <code>claude setup-token</code>, and paste the one-year token here. It's stored on the VPS
        (0600) and only ever shown masked.
      </div>

      <div className="automation-form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="tella-dev" />
        </label>
        <label>
          Token
          <input
            className="mono-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sk-ant-oat01-…"
          />
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleAdd}
          disabled={saving || !name.trim() || !token.trim()}
        >
          {saving ? "Validating…" : "Add account"}
        </button>
      </div>
    </div>
  );
}

function AddMcpForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const envObj: Record<string, string> = {};
      for (const line of env.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) throw new Error(`Env line "${trimmed}" must be KEY=VALUE`);
        envObj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }

      const allowed = allowedUsers.split(",").map((u) => u.trim()).filter(Boolean);

      const res = await fetch("/backstage/api/connections/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
          env: transport === "stdio" ? envObj : undefined,
          allowedUsers: allowed.length ? allowed : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      onAdded();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  const valid =
    name.trim() && (transport === "http" ? url.trim() : command.trim());

  return (
    <div className="automation-form" style={{ marginBottom: 18 }}>
      <div className="automation-form-title">Add MCP server</div>

      <div className="automation-form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </label>
        <label>
          Transport
          <select value={transport} onChange={(e) => setTransport(e.target.value as any)}>
            <option value="http">http — remote MCP endpoint</option>
            <option value="stdio">stdio — local command</option>
          </select>
        </label>
      </div>

      {transport === "http" ? (
        <label>
          URL
          <input
            className="mono-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
          />
        </label>
      ) : (
        <>
          <div className="automation-form-row">
            <label>
              Command
              <input
                className="mono-input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="/home/ubuntu/bin/my-mcp"
              />
            </label>
            <label>
              Args (space-separated)
              <input
                className="mono-input"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="run /path/to/server.ts"
              />
            </label>
          </div>
          <label>
            Env (KEY=VALUE, one per line — stored in mcp-config.json)
            <textarea
              className="mono-input"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"API_KEY=${MY_API_KEY}"}
            />
          </label>
        </>
      )}

      <label>
        Allowed users (optional, comma-separated — leave blank for everyone)
        <input
          value={allowedUsers}
          onChange={(e) => setAllowedUsers(e.target.value)}
          placeholder="Michiel, Grant"
        />
      </label>

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleAdd}
          disabled={saving || !valid}
        >
          {saving ? "Adding…" : "Add server"}
        </button>
      </div>
    </div>
  );
}
