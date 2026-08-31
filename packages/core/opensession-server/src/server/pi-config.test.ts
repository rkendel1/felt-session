import { afterEach, describe, expect, it } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addPiPickerModel,
  isPiModelId,
  initializeManagedPiConfig,
  normalizePiConfig,
  piAnthropicTransport,
  piEngineEnabled,
  piPickerModels,
  readPiEngineConfig,
  removePiPickerModel,
  setPiEnabled,
  setPiPickerModels,
} from "./pi-config";

const savedConfig = process.env.OPENSESSION_PI_CONFIG;
afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = savedConfig;
});

/** Point the test seam at a throwaway file holding `raw` (or nothing). */
function withConfigFile(raw?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-"));
  const path = join(dir, "pi.json");
  if (raw !== undefined) {
    writeFileSync(path, typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  process.env.OPENSESSION_PI_CONFIG = path;
  return dir;
}

describe("normalizePiConfig", () => {
  it("normalizes anything that isn't a JSON object to the disabled config", () => {
    for (const raw of [null, undefined, 42, "yes", [], true]) {
      expect(normalizePiConfig(raw)).toEqual({ enabled: false, pickerModels: [] });
    }
  });

  it("treats only a literal true as enabled", () => {
    expect(normalizePiConfig({ enabled: true }).enabled).toBe(true);
    for (const v of [1, "true", "yes", {}, undefined]) {
      expect(normalizePiConfig({ enabled: v }).enabled).toBe(false);
    }
  });

  it("keeps only full pi/<provider>/<model> picker ids", () => {
    expect(
      normalizePiConfig({
        enabled: true,
        pickerModels: [
          "pi/anthropic/claude-opus-5",
          "pi/anthropic", // no model segment
          "pi/", // empty remainder
          "other/anthropic/claude-opus-5", // wrong engine
          "claude-opus-5", // bare native id
          42,
          null,
        ],
      }).pickerModels
    ).toEqual(["pi/anthropic/claude-opus-5"]);
  });

  it("tolerates a missing or malformed pickerModels field", () => {
    expect(normalizePiConfig({ enabled: true }).pickerModels).toEqual([]);
    expect(normalizePiConfig({ enabled: true, pickerModels: "pi/a/b" }).pickerModels).toEqual([]);
  });

  it("ignores the retired bridgeAccounts field (pi picks from the pool)", () => {
    const cfg = normalizePiConfig({ enabled: true, bridgeAccounts: ["acc-1"] });
    expect("bridgeAccounts" in cfg).toBe(false);
    expect(cfg).toEqual({ enabled: true, pickerModels: [] });
  });

  it("keeps anthropicTransport only as the literal non-default \"bridge\"", () => {
    // Absent = the "inprocess" default; only the exact rollback value
    // survives normalization (present-implies-non-default).
    expect(normalizePiConfig({ enabled: true }).anthropicTransport).toBeUndefined();
    expect(
      normalizePiConfig({ enabled: true, anthropicTransport: "bridge" }).anthropicTransport
    ).toBe("bridge");
    for (const junk of ["inprocess", "Bridge", "loopback", 42, null, true, {}]) {
      expect(
        normalizePiConfig({ enabled: true, anthropicTransport: junk }).anthropicTransport
      ).toBeUndefined();
    }
  });
});

describe("isPiModelId", () => {
  it("accepts only full pi/<provider>/<model> ids", () => {
    expect(isPiModelId("pi/anthropic/claude-opus-5")).toBe(true);
    expect(isPiModelId("pi/openai/gpt-5.2-codex")).toBe(true);
    for (const bad of [
      "pi/anthropic", // no model segment
      "pi/", // empty remainder
      "other/anthropic/claude-opus-5", // wrong engine
      "claude-opus-5", // bare native id
      42,
      null,
      undefined,
    ]) {
      expect(isPiModelId(bad)).toBe(false);
    }
  });
});

async function managed(raw?: unknown) {
  const dir = withConfigFile(raw);
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await initializeManagedPiConfig(db);
  return { dir, db };
}

describe("managed Pi config", () => {
  it("imports legacy JSON once and removes it", async () => {
    const { dir } = await managed({ enabled: true, pickerModels: ["pi/anthropic/claude-opus-5", "bogus"] });
    expect(existsSync(join(dir, "pi.json"))).toBe(false);
    expect(readPiEngineConfig()).toEqual({ enabled: true, pickerModels: ["pi/anthropic/claude-opus-5"] });
    rmSync(dir, { recursive: true, force: true });
  });

  it("version-fences settings mutations", async () => {
    const { dir } = await managed({ enabled: false, anthropicTransport: "bridge" });
    await setPiEnabled(true);
    expect(piEngineEnabled()).toBe(true);
    expect(piAnthropicTransport()).toBe("bridge");
    expect(await addPiPickerModel("pi/anthropic/claude-opus-5")).toEqual(["pi/anthropic/claude-opus-5"]);
    expect(await removePiPickerModel("pi/anthropic/claude-opus-5")).toEqual([]);
    expect(await setPiPickerModels(["pi/openai/gpt-5.6-sol"])).toEqual(["pi/openai/gpt-5.6-sol"]);
    expect(piPickerModels()).toEqual(["pi/openai/gpt-5.6-sol"]);
    await expect(addPiPickerModel("pi/anthropic")).rejects.toThrow(/Invalid pi model id/);
    rmSync(dir, { recursive: true, force: true });
  });
});
