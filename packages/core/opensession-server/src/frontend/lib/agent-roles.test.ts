import { describe, expect, test } from "bun:test";
import { modelRoleAssignment } from "./agent-roles";

describe("modelRoleAssignment", () => {
	test("shows the provider and model assigned to a role", () => {
		expect(modelRoleAssignment("pi/ollama/qwen3-coder:latest")).toEqual({
			icon: "ollama",
			label: "Ollama · qwen3-coder:latest",
		});
		expect(modelRoleAssignment("pi/anthropic/claude-fable-5")).toEqual({
			icon: "claude",
			label: "Claude · claude-fable-5",
		});
	});
});
