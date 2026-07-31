/**
 * Second Bun.serve() instance for webhook routes (port 3848).
 * Bound to loopback; a TLS-terminating reverse proxy on a public hostname puts
 * it where providers can reach it.
 * Agents register their routes via the AgentModule interface.
 */
import type { AgentModule } from "../agents/types";

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3848");
const WEBHOOK_HOST = "127.0.0.1";

/** Combined route table: "POST /slack/events" → handler */
let routeTable = new Map<string, (req: Request, url: URL) => Promise<Response>>();

/** Active agent modules for health reporting */
let activeAgents: AgentModule[] = [];

export function startWebhookServer(
  agents: AgentModule[],
  extraRoutes?: Map<string, (req: Request, url: URL) => Promise<Response>>
) {
  activeAgents = agents;

  // Build combined route table from all agents
  routeTable = new Map();
  for (const agent of agents) {
    for (const [key, handler] of agent.getRoutes()) {
      if (routeTable.has(key)) {
        console.warn(`[webhook] Route collision: ${key} (agent: ${agent.name})`);
      }
      routeTable.set(key, handler);
    }
  }
  for (const [key, handler] of extraRoutes || []) {
    if (routeTable.has(key)) {
      console.warn(`[webhook] Route collision: ${key} (extra)`);
    }
    routeTable.set(key, handler);
  }

  const server = Bun.serve({
    port: WEBHOOK_PORT,
    hostname: WEBHOOK_HOST,

    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Look up route: "POST /slack/events"
      const routeKey = `${req.method} ${path}`;
      const handler = routeTable.get(routeKey);
      if (handler) {
        try {
          return await handler(req, url);
        } catch (e: any) {
          console.error(`[webhook] Error handling ${routeKey}:`, e);
          return Response.json(
            { error: "Internal server error" },
            { status: 500 }
          );
        }
      }

      // Fallback: try wildcard matching for paths with dynamic segments
      for (const [key, wildcardHandler] of routeTable) {
        if (key.endsWith("/*")) {
          const prefix = key.slice(0, -1); // "POST /some/path/"  → "POST /some/path"
          const [method, pathPrefix] = prefix.split(" ", 2);
          // Fix: the prefix includes method, so split properly
          if (req.method === method && path.startsWith(pathPrefix!)) {
            try {
              return await wildcardHandler(req, url);
            } catch (e: any) {
              console.error(`[webhook] Error handling ${key}:`, e);
              return Response.json(
                { error: "Internal server error" },
                { status: 500 }
              );
            }
          }
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  console.log(
    `[webhook] Webhook server running on ${WEBHOOK_HOST}:${WEBHOOK_PORT} ` +
      `(agents: ${agents.map((a) => a.name).join(", ") || "none"})`
  );

  return server;
}
