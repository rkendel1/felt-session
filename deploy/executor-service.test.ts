import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

describe("executor deployment", () => {
  test("keeps the executor independent from the gateway lifecycle", async () => {
    const executor = await Bun.file(
      resolve(repoRoot, "opensession-executor.service"),
    ).text();
    const gateway = await Bun.file(resolve(repoRoot, "opensession.service")).text();

    expect(executor).toContain(
      "ExecStart=/home/ubuntu/.bun/bin/bun run packages/core/opensession-server/src/executor/main.ts",
    );
    expect(executor).not.toContain("PartOf=opensession.service");
    expect(gateway).toContain("Wants=opensession-executor.service");
    expect(gateway).not.toContain("Requires=opensession-executor.service");
    expect(gateway).toContain("# EXECUTOR_CREDENTIAL:");
    expect(gateway).not.toContain(
      "LoadCredential=executor-token:/etc/opensession/executor-token",
    );
  });

  test("supports executor-only deploys without a gateway restart", async () => {
    const deploy = await Bun.file(resolve(import.meta.dir, "deploy.sh")).text();
    expect(deploy).toContain(
      'packages/core/opensession-server/src/executor/*|opensession-executor.service',
    );
    expect(deploy).toContain('if [ "$RESTART_GATEWAY" = "0" ]');
    expect(deploy).toContain("executor deploy complete");
    expect(deploy).toContain("executor-credential.conf");
    expect(deploy).toContain(
      `sed -n 's/^EnvironmentFile=//p' "$REPO_DIR/opensession.service"`,
    );
    expect(deploy).toContain('if [ -z "$RUN_HOST_ENV_FILE" ]');
    expect(deploy).toContain('"$RUN_HOST_ENV_FILE"');
    expect(deploy).toContain('^# EXECUTOR_PATH_ENV$');
    expect(deploy).toContain('OPENSESSION_SESSIONS_DIR=');
  });

  test("self-deploy and rollback synchronize the executor before the gateway", async () => {
    const deploy = await Bun.file(resolve(import.meta.dir, "self-deploy.sh")).text();
    expect(deploy).toContain("refresh_executor");
    expect(deploy).toContain("if ! refresh_executor; then");
    expect(deploy).toContain("target executor failed readiness; attempting rollback to pin");
    expect(deploy).toContain("opensession-executor.service");
    expect(deploy).toContain("EXECUTOR_READY_FILE");
    expect(deploy).toContain("RUN_HOST_HELPER_VERSION=2");
    expect(deploy).toContain('check-version "$RUN_HOST_HELPER_VERSION"');
    expect(deploy).not.toContain("sudo -n cp");
    expect(deploy).not.toContain("sudo -n rm");
    expect(deploy).toContain("rollback_schema_compatible");
    expect(deploy).toContain("minimum-kernel-schema");
    expect(deploy).toContain("record_kernel_schema_floor");
  });

  test("installs a validating run-host helper instead of granting systemd-run", async () => {
    const installer = await Bun.file(
      resolve(repoRoot, "deploy/install-run-host-helper.sh"),
    ).text();
    const helper = await Bun.file(
      resolve(repoRoot, "deploy/opensession-run-host"),
    ).text();
    expect(installer).toContain("/etc/sudoers.d/opensession-run-host");
    expect(installer).toContain("visudo -cf");
    expect(installer).toContain("helper directory cannot be a symlink");
    expect(installer).not.toContain("NOPASSWD: /usr/bin/systemd-run");
    expect(helper).toContain("run-host directory is outside the configured state root");
    expect(helper).toContain("OPENSESSION_RUN_SPEC_HASH");
    expect(helper).toContain("OPENSESSION_RUN_JOURNAL=$dir/journal.json");
    expect(helper).toContain('if [ "$action" = "self-deploy" ]');
    expect(helper).toContain('if [ "$runner_mode" = "compiled" ]');
    expect(helper).toContain('"$runner_bin" runner-host "$dir/spec.json"');
    expect(helper).toContain('"$runner_bin" run "$repo_dir/packages/core/opensession-server/src/runner-host/host.ts"');
    expect(installer).toContain("runner mode must be source or compiled");
    expect(helper).toContain('set -- "$systemd_run"');
  });

  test("credential installation rejects link redirection", async () => {
    const installer = await Bun.file(
      resolve(repoRoot, "deploy/install-executor-credential.sh"),
    ).text();
    expect(installer).toContain("credential directory cannot be a symlink");
    expect(installer).toContain("credential cannot be a symlink");
    expect(installer).toContain("stat -c %h");
  });
});
