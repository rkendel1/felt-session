import { expect, test } from "bun:test";
import { scanModuleSideEffects } from "../../../../../../scripts/check-module-side-effects";

const MODULES = [
  "packages/core/opensession-server/src/server/managed-executors/enrollment.ts",
  "packages/core/opensession-server/src/server/managed-executors/lifecycle.ts",
  "packages/core/opensession-server/src/server/managed-executors/manager.ts",
  "packages/core/opensession-server/src/server/managed-executors/provider.ts",
  "packages/core/opensession-server/src/server/managed-executors/registry.ts",
  "packages/core/opensession-server/src/server/managed-executors/state.ts",
  "packages/core/opensession-server/src/runner-executor/agent.ts",
  "packages/core/opensession-server/src/server/executors/runtime.ts",
];

test("Executor lifecycle and composition modules are import-inert", async () => {
  const scan = await scanModuleSideEffects(MODULES);
  expect(scan.failed).toEqual([]);
  expect(scan.hits).toEqual([]);
  expect(scan.scanned).toBe(MODULES.length);
});
