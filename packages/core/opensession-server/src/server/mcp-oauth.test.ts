import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  hasMcpOauthGrant,
  initializeManagedMcpOauth,
  removeMcpOauthGrant,
  startMcpOauthFlow,
} from "./mcp-oauth";

describe("MCP OAuth client registration", () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await initializeManagedMcpOauth(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("explains Figma's catalog restriction instead of reporting invalid JSON", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.figma.com/mcp",
          authorization_servers: ["https://api.figma.com"],
          scopes_supported: ["mcp:connect"],
        });
      }
      if (url === "https://api.figma.com/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: "https://www.figma.com/oauth/mcp",
          token_endpoint: "https://api.figma.com/v1/oauth/token",
          registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        });
      }
      if (url === "https://api.figma.com/v1/oauth/mcp/register") {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      startMcpOauthFlow("Figma test", "https://mcp.figma.com/mcp"),
    ).rejects.toThrow(
      "Its remote MCP server accepts only clients listed in the Figma MCP Catalog",
    );
  });

  test("hydrates and removes grants from FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await db.collection("opensession_mcp_oauth").insert({
      id: "grants",
      value: {
        slack: {
          serverUrl: "https://slack.example.test",
          endpoints: { authorize: "", token: "" },
          clientInfo: { clientId: "test" },
          shared: { tokens: { accessToken: "secret" }, updatedAt: new Date().toISOString() },
        },
      },
    }, "grants");
    await initializeManagedMcpOauth(db);
    expect(hasMcpOauthGrant("slack")).toBe(true);
    expect(await removeMcpOauthGrant("slack")).toBe(true);
    await initializeManagedMcpOauth(db);
    expect(hasMcpOauthGrant("slack")).toBe(false);
  });
});
