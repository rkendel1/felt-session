import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDefaultModel,
  getModelFallbackAuto,
  initializeManagedModelDefaults,
  interactiveDefaultModel,
  setDefaultModel,
  setInteractiveDefaultModel,
  setModelFallbackAuto,
} from "./models";

let dir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "managed-model-defaults-"));
  previousStateDir = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = dir;
  await initializeManagedModelDefaults(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("managed model defaults", () => {
  test("persists defaults and fallback policy in FeltDB", async () => {
    expect(await setDefaultModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(await setInteractiveDefaultModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(await setModelFallbackAuto(false)).toBe(false);
    expect(getDefaultModel()).toBe("gpt-5.6-sol");
    expect(interactiveDefaultModel()).toBe("pi/openai/gpt-5.6-luna");
    expect(getModelFallbackAuto()).toBe(false);
    expect(await Bun.file(join(dir, "default-model.json")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "model-fallback.json")).exists()).toBe(false);
  });
});
