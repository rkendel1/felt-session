import type {
  ExecutorCapability,
  ExecutorGrant,
} from "@tellahq/opensession-protocol/executor";
import {
  openCommandLedger,
  type OpenCommandLedger,
} from "../../runner-executor/open-command-ledger";
import { ExecutorFailure, type ExecutorContext } from "./contract";
import { ExecutorBroker } from "./broker";
import {
  ExecutorGrantAuthority,
  executorOperationDigest,
  type ExecutorGrantScope,
} from "./grants";
import {
  ExecutorIngress,
  type ExecutorAuthority,
  type ExecutorIngressOptions,
} from "./ingress";
import { RemoteExecutorRegistry } from "./remote-registry";
import { FeltDbRunnerExecutorClaims } from "./feltdb-claims";
import { ExecutorEnrollmentAuthority } from "../managed-executors/enrollment";
import {
  ExecutorManager,
  type DurableWorkspaceCheckpoint,
} from "../managed-executors/manager";
import type { ExecutorProvider } from "../managed-executors/provider";
import { ExecutorProviderRegistry } from "../managed-executors/registry";
import { FeltDbExecutorStateStore } from "../managed-executors/feltdb-state";
import type { ExecutorRecord } from "../managed-executors/state";

export interface ExecutorRuntimePaths {
  /** Boot should derive these from stateDir() and keep each database distinct. */
  runnerLedgerDb: string;
  managedStateDb: string;
  instanceClaimsDb: string;
}

export interface RunnerExecutorAuthorization {
  generation: number;
  capabilities: readonly ExecutorCapability[];
}

export interface ExecutorRuntimeOptions {
  paths: ExecutorRuntimePaths;
  providers: readonly ExecutorProvider[];
  runner: {
    /** Atomically verifies pairing and exact durable generation/connectability. */
    authenticateRunner(input: {
      runnerId: string;
      token: string;
      generation: number;
    }):
      | RunnerExecutorAuthorization
      | undefined
      | Promise<RunnerExecutorAuthorization | undefined>;
    /** Must inspect the socket peer supplied by boot. Forwarded headers are not peer identity. */
    isTrustedPeer(remoteAddress: string): boolean | Promise<boolean>;
  };
  managed: {
    capabilities(record: ExecutorRecord): readonly ExecutorCapability[];
    checkpointWorkspace(
      record: ExecutorRecord,
    ): Promise<DurableWorkspaceCheckpoint>;
    /** Revokes any authority outside this composition, after its durable local fence is raised. */
    revokeExecutionAuthority(input: {
      executorId: string;
      throughGeneration: number;
    }): Promise<void>;
  };
  ingress: Pick<
    ExecutorIngressOptions,
    "createId" | "now" | "rateLimit" | "timers" | "connectionPolicy"
  >;
  maxGrantTtlMs?: number;
  managedEnrollmentTtlMs?: number;
  runnerLedger?: {
    capacity?: number;
    maxRecordBytes?: number;
    maxStringBytes?: number;
    maxEvents?: number;
  };
  feltdbPath?: string;
  /** Explicit provider-client shutdown, called only after manager drain. Use a deliberate no-op when appropriate. */
  closeProviders: () => void | Promise<void>;
}

/**
 * Explicit, import-inert composition root for the next Executor runtime.
 *
 * Boot integration is deliberately not included here. Boot must derive private state paths,
 * provide the real paired-token and socket-peer callbacks, route the exact ingress path with
 * the kernel-reported peer address, attach `ingress.websocket` to Bun.serve, and call start()
 * before exposing routes. It must call close() during shutdown. Provider SDK construction and
 * credentials remain outside this module. Until those obligations and the grant-validation
 * transport are wired by boot, this is scaffolding, not an active production security boundary.
 */
export function createExecutorRuntime(
  options: ExecutorRuntimeOptions,
): ExecutorRuntime {
  return new ExecutorRuntime(options);
}

export class ExecutorRuntime {
  readonly registry = new RemoteExecutorRegistry();
  readonly brokerGrants: ExecutorGrantAuthority;
  readonly broker: ExecutorBroker;
  readonly #enrollment: ExecutorEnrollmentAuthority;
  readonly #providers = new ExecutorProviderRegistry();
  readonly #options: ExecutorRuntimeOptions;
  readonly #executionGrants = new ExecutorGrantAuthority();
  readonly #issuedByExecutor = new Map<string, Map<ExecutorGrant, number>>();
  readonly #maxGrantTtlMs: number;
  readonly #managedEnrollmentTtlMs: number;
  #claims?: FeltDbRunnerExecutorClaims;
  #managedStore?: FeltDbExecutorStateStore;
  #ledger?: OpenCommandLedger;
  #manager?: ExecutorManager;
  #ingress?: ExecutorIngress;
  #started = false;
  #closed = false;
  #startPromise?: Promise<this>;
  #closePromise?: Promise<void>;

  constructor(options: ExecutorRuntimeOptions) {
    assertOptions(options);
    this.#options = options;
    this.#maxGrantTtlMs = options.maxGrantTtlMs ?? 30_000;
    this.#managedEnrollmentTtlMs = options.managedEnrollmentTtlMs ?? 60_000;
    this.#enrollment = new ExecutorEnrollmentAuthority({
      now: options.ingress.now,
    });
    this.brokerGrants = new ExecutorGrantAuthority({
      now: options.ingress.now,
    });
    this.broker = new ExecutorBroker(this.brokerGrants, {
      now: options.ingress.now,
    });
    for (const provider of options.providers)
      this.#providers.register(provider);
  }

  start(): Promise<this> {
    if (this.#closed)
      return Promise.reject(new Error("Executor runtime is closed"));
    if (this.#started) return Promise.resolve(this);
    if (!this.#startPromise) {
      this.#startPromise = this.#initialize().catch((error) => {
        this.#startPromise = undefined;
        throw error;
      });
    }
    return this.#startPromise;
  }

  async #initialize(): Promise<this> {
    let ledger: OpenCommandLedger | undefined;
    let managedStore: SqliteExecutorStateStore | undefined;
    let claims: SqliteRunnerExecutorClaims | undefined;
    try {
      ledger = openCommandLedger({
        dbPath: this.#options.paths.runnerLedgerDb,
        feltdbPath: this.#options.feltdbPath,
        ...this.#options.runnerLedger,
      });
      await ledger.recover();
      if (this.#closed) throw new Error("Executor runtime closed during start");
      managedStore = new FeltDbExecutorStateStore(
        this.#options.paths.managedStateDb,
      );
      claims = new FeltDbRunnerExecutorClaims(
        this.#options.paths.instanceClaimsDb,
      );

      const manager = new ExecutorManager({
        store: managedStore,
        providers: this.#providers,
        now: this.#options.ingress.now,
        checkpointWorkspace: this.#options.managed.checkpointWorkspace,
        revokeExecutionAuthority: async (input) => {
          this.registry.disconnect(
            input.executorId,
            "Executor generation was revoked",
          );
          this.#revokeExecutorGrants("managed", input.executorId);
          await this.#enrollment.revokeThrough(
            input.executorId,
            input.throughGeneration,
          );
          await this.#options.managed.revokeExecutionAuthority(input);
        },
      });
      const ingress = new ExecutorIngress({
        ...this.#options.ingress,
        registry: this.registry,
        authenticateRunner: async ({
          runnerId,
          generation,
          token,
          remoteAddress,
        }) => {
          if (!remoteAddress) return { ok: false, status: 403 };
          const authorization = await this.#options.runner.authenticateRunner({
            runnerId,
            token,
            generation,
          });
          if (!authorization) return { ok: false, status: 401 };
          if (authorization.generation !== generation)
            return { ok: false, status: 403 };
          if (!(await this.#options.runner.isTrustedPeer(remoteAddress)))
            return { ok: false, status: 403 };
          return {
            ok: true,
            authority: this.#authority(
              "runner",
              runnerId,
              generation,
              authorization.capabilities,
            ),
          };
        },
        consumeManagedEnrollment: (token, fence) =>
          this.#enrollment.consume(token, fence),
        authorizeManaged: async ({ executorId, generation }) => {
          const record = await managedStore!.getByExecutorId(executorId);
          if (
            !record ||
            record.instanceGeneration !== generation ||
            record.lifecycle !== "awake"
          )
            return undefined;
          return this.#authority(
            "managed",
            executorId,
            generation,
            this.#options.managed.capabilities(record),
            (claim) => managedStore!.claimConnectableInstance(claim),
            record.sessionId,
          );
        },
      });
      this.#ledger = ledger;
      this.#managedStore = managedStore;
      this.#claims = claims;
      this.#manager = manager;
      this.#ingress = ingress;
      this.#started = true;
      return this;
    } catch (error) {
      claims?.close();
      managedStore?.close();
      ledger?.close();
      throw error;
    }
  }

  get ingress(): ExecutorIngress {
    return this.#requireStarted(this.#ingress);
  }

  get manager(): ExecutorManager {
    return this.#requireStarted(this.#manager);
  }

  get runnerLedger(): OpenCommandLedger {
    return this.#requireStarted(this.#ledger);
  }

  issueManagedEnrollment(executorId: string): Promise<string> {
    const manager = this.#requireStarted(this.#manager);
    return manager.withAwakeExecutor(executorId, (record) =>
      this.#enrollment.issue({
        executorId: record.executorId,
        generation: record.instanceGeneration,
        expiresAtMs: this.#options.ingress.now() + this.#managedEnrollmentTtlMs,
      }),
    );
  }

  /** Durable unpair/disable seam. Boot must call this before retiring a generation. */
  async revokeRunnerAuthority(
    runnerId: string,
    throughGeneration: number,
  ): Promise<void> {
    const claims = this.#requireStarted(this.#claims);
    await claims.revokeThrough(runnerId, throughGeneration);
    this.registry.disconnect(runnerId, "Runner Executor authority was revoked");
    this.#revokeExecutorGrants("runner", runnerId);
  }

  /** Validation seam for a future scoped grant route. Full expected scope is mandatory. */
  validateExecutionGrant(
    grant: ExecutorGrant,
    expected: ExecutorGrantScope,
  ): boolean {
    try {
      this.#executionGrants.validate(grant, expected);
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#ingress?.shutdown();
    this.registry.shutdown("Executor runtime closed");
    this.#closePromise = (async () => {
      try {
        await this.#manager?.drain();
        await this.#options.closeProviders();
      } finally {
        this.#issuedByExecutor.clear();
        this.#executionGrants.revokeAll();
        this.brokerGrants.revokeAll();
        await Promise.resolve(this.#claims?.close());
        await Promise.resolve(this.#managedStore?.close());
        await Promise.resolve(this.#ledger?.close());
        this.#started = false;
      }
    })();
    return this.#closePromise;
  }

  #authority(
    source: "runner" | "managed",
    executorId: string,
    generation: number,
    capabilities: readonly ExecutorCapability[],
    claimInstance?: ExecutorAuthority["claimInstance"],
    boundSessionId?: string,
  ): ExecutorAuthority {
    const assertSession = (context: ExecutorContext) => {
      // Managed state owns a session identity but has no durable root ownership field yet.
      if (boundSessionId && context.sessionId !== boundSessionId)
        throw new ExecutorFailure(
          "invalid_grant",
          "managed Executor does not own this session",
        );
    };
    return {
      executorId,
      generation,
      capabilities: [...capabilities],
      claimInstance:
        claimInstance ??
        ((claim) =>
          source === "runner" &&
          this.#claims!.claim({
            executorId: claim.executorId,
            generation: claim.generation,
            instanceId: claim.instanceId,
          })),
      resolveGrant: (context, operation, deadlineMs) => {
        assertSession(context);
        return this.#issueGrant(source, executorId, context, deadlineMs, {
          purpose: "operation",
          requestId: context.requestId,
          operationDigest: executorOperationDigest(operation),
        });
      },
      resolveCleanupGrant: (input) => {
        assertSession(input.context);
        return this.#issueGrant(
          source,
          executorId,
          input.context,
          input.deadlineMs,
          {
            purpose: "cleanup",
            requestId: input.requestId,
            targetRequestId: input.targetRequestId,
            streamId: input.streamId,
          },
        );
      },
    };
  }

  #issueGrant(
    source: "runner" | "managed",
    executorId: string,
    context: ExecutorContext,
    deadlineMs: number,
    action: ExecutorGrantScope["action"],
  ): ExecutorGrant {
    const now = this.#options.ingress.now();
    if (deadlineMs > now + this.#maxGrantTtlMs)
      throw new ExecutorFailure(
        "invalid_request",
        "executor grant deadline exceeds runtime policy",
      );
    const grant = this.#executionGrants.issue({
      source,
      executorId,
      rootId: context.rootId,
      sessionId: context.sessionId,
      runId: context.runId,
      generation: context.generation,
      deadlineMs,
      action,
    });
    const key = `${source}:${executorId}`;
    const issued =
      this.#issuedByExecutor.get(key) ?? new Map<ExecutorGrant, number>();
    for (const [prior, expiry] of issued)
      if (expiry <= now) issued.delete(prior);
    issued.set(grant, deadlineMs);
    this.#issuedByExecutor.set(key, issued);
    return grant;
  }

  #revokeExecutorGrants(
    source: "runner" | "managed",
    executorId: string,
  ): void {
    const key = `${source}:${executorId}`;
    const grants = this.#issuedByExecutor.get(key);
    if (!grants) return;
    for (const grant of grants.keys()) this.#executionGrants.revoke(grant);
    this.#issuedByExecutor.delete(key);
  }

  #requireStarted<T>(value: T | undefined): T {
    if (this.#closed || !this.#started || !value)
      throw new Error("Executor runtime is not started");
    return value;
  }
}

function assertOptions(options: ExecutorRuntimeOptions): void {
  if (
    !options ||
    !options.paths ||
    !options.runner ||
    !options.managed ||
    !options.ingress
  )
    throw new TypeError("Executor runtime dependencies are required");
  const paths = Object.values(options.paths);
  if (
    paths.some(
      (path) => typeof path !== "string" || !path || path === ":memory:",
    )
  )
    throw new TypeError(
      "Executor runtime database paths must be explicit filesystem paths",
    );
  if (new Set(paths).size !== paths.length)
    throw new TypeError("Executor runtime database paths must be distinct");
  for (const callback of [
    options.runner.authenticateRunner,
    options.runner.isTrustedPeer,
    options.managed.capabilities,
    options.managed.checkpointWorkspace,
    options.managed.revokeExecutionAuthority,
    options.ingress.createId,
    options.ingress.now,
    options.ingress.rateLimit,
    options.closeProviders,
  ]) {
    if (typeof callback !== "function")
      throw new TypeError("Executor runtime callback is required");
  }
  if (
    !options.ingress.timers ||
    typeof options.ingress.timers.setTimeout !== "function" ||
    typeof options.ingress.timers.clearTimeout !== "function"
  )
    throw new TypeError("Executor runtime timers are required");
  const grantTtl = options.maxGrantTtlMs ?? 30_000;
  const enrollmentTtl = options.managedEnrollmentTtlMs ?? 60_000;
  if (!Number.isSafeInteger(grantTtl) || grantTtl < 1 || grantTtl > 5 * 60_000)
    throw new TypeError(
      "Executor runtime grant TTL must be between 1ms and 5 minutes",
    );
  if (
    !Number.isSafeInteger(enrollmentTtl) ||
    enrollmentTtl < 1 ||
    enrollmentTtl > 5 * 60_000
  )
    throw new TypeError(
      "managed enrollment TTL must be between 1ms and 5 minutes",
    );
}
