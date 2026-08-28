/**
 * Tests for durable agent registry.
 *
 * Proves that agents can be created, retrieved, listed by role,
 * and that the standard role/provider combinations work correctly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDurableAgentRegistry,
  createStandardAgent,
} from "./durable-agent-registry";
import type { MissionControlAgent, AgentRole, AgentProvider } from "./mission-control-agent";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-registry-"));
  roots.push(root);
  return root;
}

describe("DurableAgentRegistry", () => {
  test("creates and retrieves agents", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const agent = createStandardAgent(
      "agent-1",
      "builder",
      "anthropic",
      "claude-opus",
    );

    await registry.upsertAgent(agent);
    const retrieved = await registry.getAgent("agent-1");

    expect(retrieved).toBeTruthy();
    expect(retrieved?.id).toBe("agent-1");
    expect(retrieved?.role).toBe("builder");
    expect(retrieved?.provider).toBe("anthropic");
    expect(retrieved?.model).toBe("claude-opus");
    expect(retrieved?.status).toBe("idle");
  });

  test("lists agents by role", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const builders = [
      createStandardAgent("builder-1", "builder", "anthropic", "claude-opus"),
      createStandardAgent("builder-2", "builder", "openai", "gpt-4"),
    ];

    const reviewers = [
      createStandardAgent("reviewer-1", "reviewer", "google", "gemini-pro"),
    ];

    for (const agent of [...builders, ...reviewers]) {
      await registry.upsertAgent(agent);
    }

    const listedBuilders = await registry.listAgentsByRole("builder");
    const listedReviewers = await registry.listAgentsByRole("reviewer");

    expect(listedBuilders).toHaveLength(2);
    expect(listedReviewers).toHaveLength(1);
    expect(listedBuilders[0]?.provider).toMatch(/anthropic|openai/);
  });

  test("lists all agents", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const roles: AgentRole[] = [
      "architect",
      "builder",
      "reviewer",
      "tester",
      "release",
    ];
    const providers: AgentProvider[] = ["anthropic", "openai", "google"];

    let id = 0;
    for (const role of roles) {
      for (const provider of providers) {
        const agent = createStandardAgent(
          `agent-${id++}`,
          role,
          provider,
          `model-${provider}`,
        );
        await registry.upsertAgent(agent);
      }
    }

    const all = await registry.listAllAgents();
    expect(all).toHaveLength(15);

    // Verify we have all 5 roles represented
    const rolesFound = new Set(all.map((a) => a.role));
    for (const role of roles) {
      expect(rolesFound.has(role)).toBe(true);
    }
  });

  test("updates agent status", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const agent = createStandardAgent(
      "agent-1",
      "builder",
      "anthropic",
      "claude-opus",
    );

    await registry.upsertAgent(agent);

    const updated = {
      ...agent,
      status: "active" as const,
      updatedAt: new Date().toISOString(),
    };

    await registry.upsertAgent(updated);
    const retrieved = await registry.getAgent("agent-1");

    expect(retrieved?.status).toBe("active");
    expect(retrieved?.updatedAt).toBe(updated.updatedAt);
  });

  test("deletes agents", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const agent = createStandardAgent(
      "agent-1",
      "builder",
      "anthropic",
      "claude-opus",
    );

    await registry.upsertAgent(agent);
    await registry.deleteAgent("agent-1");

    const retrieved = await registry.getAgent("agent-1");
    expect(retrieved).toBeNull();
  });

  test("handles non-existent agents gracefully", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const retrieved = await registry.getAgent("non-existent");
    expect(retrieved).toBeNull();

    const listed = await registry.listAgentsByRole("builder");
    expect(listed).toHaveLength(0);
  });

  test("standard agent has correct capabilities and system prompt", async () => {
    const agent = createStandardAgent(
      "agent-1",
      "architect",
      "anthropic",
      "claude-opus",
    );

    expect(agent.capabilities).toContain("code_exploration");
    expect(agent.capabilities).toContain("architecture_analysis");
    expect(agent.systemPrompt).toContain("architect");
  });

  test("preserves agent metadata through persistence", async () => {
    const registry = openDurableAgentRegistry(tmpRoot());

    const agent: MissionControlAgent = {
      id: "agent-1",
      name: "Senior Builder",
      role: "builder",
      provider: "anthropic",
      model: "claude-opus",
      capabilities: ["code_editing", "test_writing", "pr_opening"],
      systemPrompt: "Custom prompt for this agent",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    await registry.upsertAgent(agent);
    const retrieved = await registry.getAgent("agent-1");

    expect(retrieved).toEqual(agent);
  });
});
