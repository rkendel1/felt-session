import { describe, expect, it } from "bun:test";
import { branchNameFromPrompt } from "./suggest-branch";

describe("branchNameFromPrompt", () => {
  it("uses the descriptive suggestion when available", async () => {
    expect(
      await branchNameFromPrompt("Fix Desk branch generation", {
        suggest: async () => "fix-desk-branch-generation",
      }),
    ).toBe("fix-desk-branch-generation");
  });

  it("slugifies the prompt when suggestion fails", async () => {
    expect(
      await branchNameFromPrompt("Fix Desk branch generation!\nMore details", {
        suggest: async () => null,
      }),
    ).toBe("fix-desk-branch-generation");
  });

  it("falls back to a stable session-shaped name when the prompt has no slug", async () => {
    expect(
      await branchNameFromPrompt("...", {
        suggest: async () => null,
        now: () => 12345,
      }),
    ).toBe("session-9ix");
  });
});
