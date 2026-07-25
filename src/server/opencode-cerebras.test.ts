import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  CEREBRAS_PICKER_MODELS,
  defaultPickerModelsForProvider,
  opencodeProviderOptions,
} from "./opencode-config";
import {
  modelEfforts,
  opencodeModelLabel,
  orchestratorWorkerForBridge,
} from "./models";

const originalConfig = process.env.OPENSESSION_OPENCODE_CONFIG;
const tempDir = join(
  process.env.TMPDIR || "/tmp",
  `opensession-cerebras-test-${process.pid}`,
);

afterEach(() => {
  if (originalConfig === undefined)
    delete process.env.OPENSESSION_OPENCODE_CONFIG;
  else process.env.OPENSESSION_OPENCODE_CONFIG = originalConfig;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Cerebras provider", () => {
  test("seeds the current public open-weight models", () => {
    expect(defaultPickerModelsForProvider("cerebras")).toEqual([
      "gpt-oss-120b",
      "gemma-4-31b",
      "zai-glm-4.7",
    ]);
    expect(CEREBRAS_PICKER_MODELS).toHaveLength(3);
    expect(defaultPickerModelsForProvider("xai")).toEqual([]);
  });

  test("injects an OpenAI-compatible provider for OpenCode 1.17", () => {
    mkdirSync(tempDir, { recursive: true });
    const config = join(tempDir, "opencode.json");
    writeFileSync(
      config,
      JSON.stringify({
        enabled: true,
        providers: { cerebras: { apiKey: "csk-test" } },
      }),
    );
    process.env.OPENSESSION_OPENCODE_CONFIG = config;

    const provider = opencodeProviderOptions().cerebras;
    expect(provider).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      name: "Cerebras",
      options: {
        apiKey: "csk-test",
        baseURL: "https://api.cerebras.ai/v1",
      },
      models: {
        "gpt-oss-120b": {
          name: "GPT OSS 120B",
          tool_call: true,
          interleaved: { field: "reasoning" },
        },
        "gemma-4-31b": { name: "Gemma 4 31B", tool_call: true },
        "zai-glm-4.7": {
          name: "Z.ai GLM 4.7",
          tool_call: true,
          interleaved: { field: "reasoning" },
        },
      },
    });
    expect(
      Object.values(
        provider.models as Record<string, { limit: { output: number } }>,
      ).map((model) => model.limit.output),
    ).toEqual([8_192, 8_192, 8_192]);
  });

  test("uses GPT OSS for fast workers only when Cerebras is available", () => {
    expect(
      orchestratorWorkerForBridge(
        "worker-fast",
        "anthropic",
        new Set(["cerebras"]),
      ),
    ).toMatchObject({ model: "cerebras/gpt-oss-120b", label: "GPT OSS 120B" });
    expect(
      orchestratorWorkerForBridge("worker-fast", "anthropic", new Set()),
    ).toMatchObject({ model: "anthropic/claude-haiku-4-5" });
    expect(
      orchestratorWorkerForBridge("worker", "openai", new Set(["cerebras"])),
    ).toMatchObject({ model: "openai/gpt-5.6-terra" });
  });

  test("exposes friendly labels and GPT OSS reasoning efforts", () => {
    expect(opencodeModelLabel("opencode/cerebras/gpt-oss-120b")).toBe(
      "GPT OSS 120B",
    );
    expect(opencodeModelLabel("opencode/cerebras/gemma-4-31b")).toBe(
      "Gemma 4 31B",
    );
    expect(opencodeModelLabel("opencode/cerebras/zai-glm-4.7")).toBe(
      "Z.ai GLM 4.7",
    );
    expect(modelEfforts("opencode/cerebras/gpt-oss-120b")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
