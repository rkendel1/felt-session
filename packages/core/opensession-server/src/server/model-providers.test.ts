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
});
