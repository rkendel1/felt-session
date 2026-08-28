export const ROLE_DESCRIPTIONS: Record<string, string> = {
	"role-architect": "Plans architecture and evaluates technical risk.",
	"role-researcher": "Investigates questions and returns sourced findings.",
	"role-planner": "Turns outcomes and constraints into an actionable plan.",
	"role-coder": "Implements and tests changes.",
	"role-reviewer": "Reviews diffs independently before release.",
	"role-tester": "Reproduces behavior and verifies edge cases.",
	"role-release": "Verifies and promotes tested revisions.",
	"role-github": "Handles issues, pull requests, reviews, and checks.",
};

export function modelRoleAssignment(model: string): { icon: string; label: string } {
	const [, provider = "model", ...modelParts] = model.split("/");
	const providerLabel = provider === "ollama"
		? "Ollama"
		: provider === "anthropic"
			? "Claude"
			: provider === "openai"
				? "Codex account"
				: provider === "openai-api"
					? "OpenAI API"
				: provider;
	return {
		icon: provider === "anthropic" ? "claude" : provider === "openai" || provider === "openai-api" ? "codex" : provider,
		label: `${providerLabel} · ${modelParts.join("/") || model}`,
	};
}
