import { describe, expect, test } from "bun:test";
import {
  defaultPickerModelsForProvider,
  normalizeModelProviderConfig,
  piProviderCatalog,
} from "./model-providers";

describe("model provider config", () => {
  test("normalizes keys, picker models, and account restrictions", () => {
    expect(normalizeModelProviderConfig({
      enabled: true,
      pickerModels: ["pi/wafer/glm-5.2", 42],
      bridge: { accounts: ["claude-1"], openaiAccounts: ["chatgpt-1"] },
      providers: { wafer: { apiKey: "secret", baseURL: "https://pass.wafer.ai/v1" } },
    })).toMatchObject({
      enabled: true,
      pickerModels: ["pi/wafer/glm-5.2"],
      bridgeAccountIds: ["claude-1"],
      openaiAccounts: ["chatgpt-1"],
      providers: { wafer: { apiKey: "secret", baseURL: "https://pass.wafer.ai/v1" } },
    });
  });

  test("registers Ollama as an OpenAI-compatible local provider", () => {
    expect(defaultPickerModelsForProvider("ollama")).toEqual([
      "qwen3-coder:latest",
    ]);
    expect(piProviderCatalog("ollama")).toMatchObject({
      name: "Ollama",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
  });

	test("keeps OpenAI API billing separate from Codex subscriptions", () => {
		expect(defaultPickerModelsForProvider("openai-api")).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
		const catalog = piProviderCatalog("openai-api");
		expect(catalog).toMatchObject({
			name: "OpenAI API",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
		});
		expect(catalog?.models.map(({ id, reasoning }) => ({ id, reasoning }))).toEqual([
			{ id: "gpt-5.6-sol", reasoning: true },
			{ id: "gpt-5.6-terra", reasoning: true },
			{ id: "gpt-5.6-luna", reasoning: true },
		]);
	});
});
