import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  addMcpServer,
  initializeManagedMcpConfig,
  readMcpConfig,
  removeMcpServer,
  setMcpAllowedUsers,
} from "./connections";

describe("managed MCP configuration", () => {
  test("creates, restricts, and removes server records through FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedMcpConfig(db, `/tmp/missing-mcp-config-${crypto.randomUUID()}`);
    expect(await addMcpServer({
      name: "docs",
      transport: "http",
      url: "https://example.com/mcp",
    })).toEqual({ ok: true });
    expect(readMcpConfig().mcpServers.docs.url).toBe("https://example.com/mcp");
    expect(await setMcpAllowedUsers("docs", [" Alice ", "Alice"])).toEqual({
      ok: true,
      allowedUsers: ["Alice"],
    });
    expect(await removeMcpServer("docs")).toEqual({ ok: true });
    expect(readMcpConfig().mcpServers.docs).toBeUndefined();
  });
});
