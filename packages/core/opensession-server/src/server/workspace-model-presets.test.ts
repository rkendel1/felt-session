import { describe, expect, test } from "bun:test";
import {
	portableWorkspacePresetRun,
	type ResolvedWorkspaceModelPreset,
} from "./workspace-model-presets";
import { DEFAULT_WORKSPACE_MODEL_SETTINGS } from "./workspaces";

function preset(
	overrides: Partial<ResolvedWorkspaceModelPreset> = {},
): ResolvedWorkspaceModelPreset {
	return {
		id: "pi/workspace-preset/ws-test/lead",
		label: "Lead preset",
		model: "pi/anthropic/claude-opus-5",
		note: "Lead this task.",
		...overrides,
	};
}

describe("portableWorkspacePresetRun", () => {
	test("ships every standard role with Ollama as the coding model", () => {
		const presets = DEFAULT_WORKSPACE_MODEL_SETTINGS.presets || [];
		expect(presets.filter((item) => item.group === "roles").map((item) => item.label)).toEqual([
			"Architect",
			"Researcher",
			"Planner",
			"Coder · Ollama",
			"Reviewer",
			"Tester · Ollama",
			"Release",
			"GitHub agent",
		]);
		expect(presets.find((item) => item.id === "role-coder")?.lead.model).toBe(
			"pi/ollama/qwen3-coder:latest",
		);
		expect(
			presets
				.filter((item) => item.group === "roles")
				.every((item) => item.lead.model === "pi/ollama/qwen3-coder:latest"),
		).toBe(true);
	});

	test("carries matching built-in preset wiring across a detached boundary", () => {
		expect(
			portableWorkspacePresetRun(
				preset({ enginePresetId: "dial/opus-fable", effort: "xhigh" }),
			),
		).toEqual({
			model: "pi/dial/opus-fable",
			selectedModel: "pi/workspace-preset/ws-test/lead",
			effort: "xhigh",
		});
	});

	test("uses the concrete lead when the preset has no built-in wiring", () => {
		expect(portableWorkspacePresetRun(preset())).toEqual({
			model: "pi/anthropic/claude-opus-5",
			selectedModel: "pi/workspace-preset/ws-test/lead",
		});
	});
});
