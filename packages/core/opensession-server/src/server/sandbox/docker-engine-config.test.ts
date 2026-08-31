/**
 * The engine-config projection seam for docker sandboxes: engineConfigMounts
 * no longer mounts engine JSON. Pi and model-provider settings travel as
 * FeltDB-derived runtime projections instead of host JSON mounts. A missing
 * docker bind of a missing path creates a directory in its place).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { engineConfigMounts } from "./docker";
import { REMOTE_HOME } from "./adapters/bootstrap";

const scratch = mkdtempSync(join(tmpdir(), "engine-config-mounts-"));
const providerPath = join(scratch, "model-providers.json");
const piPath = join(scratch, "pi.json");
writeFileSync(providerPath, "{}\n");
writeFileSync(piPath, JSON.stringify({ enabled: true }) + "\n");

const savedProviders = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
const savedPi = process.env.OPENSESSION_PI_CONFIG;

afterEach(() => {
  if (savedProviders === undefined) delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
  else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = savedProviders;
  if (savedPi === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = savedPi;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("engineConfigMounts", () => {
  test("does not mount engine JSON", () => {
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providerPath;
    process.env.OPENSESSION_PI_CONFIG = piPath;
    expect(engineConfigMounts("/home/ubuntu")).toEqual([]);
  });

  test("destinations match the remote adapters' upload paths (one contract)", () => {
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providerPath;
    process.env.OPENSESSION_PI_CONFIG = piPath;
    const dests = engineConfigMounts(REMOTE_HOME).map(([, dest]) => dest);
    expect(dests).toEqual([]);
  });

  test("omits a missing source instead of mounting it", () => {
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providerPath;
    process.env.OPENSESSION_PI_CONFIG = join(scratch, "missing-pi.json");
    expect(engineConfigMounts("/home/ubuntu")).toEqual([]);
  });
});
