/**
 * OpenCode plugin: tag in-process (michael-* / opensession-*) MCP tool calls
 * with the opencode session id, so the run-rpc layer can route each call to
 * the RIGHT opensession session on a SHARED opencode server (one `opencode
 * serve` hosting many sessions — see opencode-runner.ts "Server lifecycle").
 *
 * Why: the stdio proxies (src/runner-host/mcp-proxy.ts) carry ONE rpc token
 * per server process, so on a shared server the token alone no longer
 * identifies the calling session. This hook injects `__bks_oc_session` into
 * the tool arguments; the proxy strips it back out of the args and forwards
 * it as a sibling `ocSession` field; run-rpc resolves it via the registry
 * opencode-runner maintains for active runs (ocSessionId → {bksSessionId,
 * user}), validated against the same rpc token.
 *
 * The injection happens AFTER the model produced the arguments
 * (tool.execute.before mutates them), so a model-forged value is always
 * overwritten for the tagged tools. Verified live 2026-07-09 against
 * opencode 1.17.15.
 *
 * Task-tool subagents run as CHILD opencode sessions whose ids the run-rpc
 * registry has never seen (opencode-runner registers only the root session
 * of each run). Tagging a call with the child id made run-rpc fall back to
 * the shared token's most recent run — an UNRELATED session of the same
 * user: on 2026-07-24 a subagent's create_session calls parented review
 * sessions onto another workspace's session and delivered their task
 * notifications there. So resolve every session id to its root ancestor
 * (session.get → parentID walk, memoized) before tagging; on lookup failure
 * fall back to the raw id, which preserves the old behavior.
 *
 * MUST stay a plain .js file — opencode's plugin loader failed to load a .ts
 * sibling in live testing.
 */
const TAGGED_PREFIXES = ["michael", "opensession-"];

export const SessionTagPlugin = async ({ client } = {}) => {
  // child session id → root ancestor id. Sessions never re-parent, so
  // entries are stable; size is bounded by the sessions on this server.
  const rootCache = new Map();
  const resolveRoot = async (sid) => {
    if (!sid || !client) return sid;
    if (rootCache.has(sid)) return rootCache.get(sid);
    let id = sid;
    const walked = new Set();
    for (let hops = 0; hops < 8 && id && !walked.has(id); hops++) {
      walked.add(id);
      const cached = rootCache.get(id);
      if (cached) {
        id = cached;
        break;
      }
      let parent;
      try {
        const res = await client.session.get({ path: { id } });
        parent = res && res.data && res.data.parentID;
      } catch {
        break;
      }
      if (!parent) break;
      id = parent;
    }
    for (const s of walked) rootCache.set(s, id);
    return id;
  };
  return {
    "tool.execute.before": async (input, output) => {
      const tool = String((input && input.tool) || "");
      if (!TAGGED_PREFIXES.some((p) => tool.startsWith(p))) return;
      const sid = (input && input.sessionID) || "";
      let root = sid;
      try {
        root = (await resolveRoot(sid)) || sid;
      } catch {}
      if (output && output.args && typeof output.args === "object") {
        output.args.__bks_oc_session = root;
      } else if (output) {
        output.args = { __bks_oc_session: root };
      }
    },
  };
};
