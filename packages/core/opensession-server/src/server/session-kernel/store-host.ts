import { dirname } from "node:path";
import {
  SessionKernelStore,
  sessionKernelDbPath,
  sessionKernelSessionDbPath,
  type DurableOutboxItem,
  type DurableRunState,
  type DurableSessionQuarantine,
  type DurableTimer,
  type SessionKernelStoreApi,
} from "./store";

const GLOBAL_METHODS = new Set([
  "askMigrationComplete",
  "markAskMigrationComplete",
  "deliveryMigrationComplete",
  "markDeliveryMigrationComplete",
  "askEntries",
  "clearAskRecords",
  "deliveryEntries",
  "clearDeliverySlot",
  "settlePendingSteers",
  "runStates",
  "quarantinedSessions",
  "dueTimers",
  "pendingOutbox",
  "stats",
  "compact",
  "maintain",
  "deadLetters",
  "retryCompatibleCreationBranchDeadLetters",
]);

const SESSION_FIRST_METHODS = new Set([
  "command",
  "quarantinedSession",
  "quarantineSession",
  "releaseQuarantine",
  "markProcessing",
  "completeCommand",
  "failCommand",
  "creationState",
  "runState",
  "appendChange",
  "changesSince",
  "isTombstoned",
  "tombstoneSession",
  "clearSession",
  "askSnapshot",
  "setAskRecord",
  "answerAskRecord",
  "deleteAskRecord",
  "turnSnapshot",
  "deliverySnapshot",
  "setDeliverySlot",
  "deleteDeliverySlot",
  "prepareSteerDelivery",
  "acceptSteerDelivery",
  "rejectSteerDelivery",
  "requeueSteerDeliveries",
  "ackDeliveryDispatch",
  "failDeliveryDispatch",
  "timer",
  "cancelTimer",
  "settleTimerSuccess",
  "noteTimerFailure",
  "acknowledgeCommand",
  "discardDeadTimer",
  "retryDeadTimer",
  "enqueueOutbox",
  "enqueueOutboxMany",
]);

const SESSION_INPUT_METHODS = new Set([
  "acceptCommand",
  "completeCommandDecision",
  "setRunState",
  "scheduleTimer",
  "requestGatewayCommand",
  "completeGatewayCommand",
  "failGatewayCommand",
  "requestSubmitPromptCommand",
  "completeSubmitPromptCommand",
  "failSubmitPromptCommand",
  "requestTurnCancelCommand",
  "completeTurnCancelCommand",
  "failTurnCancelCommand",
  "prepareTurnCancel",
  "beginTurnCancelEffect",
  "settleTurnCancel",
  "prepareTurnOutcomeProjection",
  "beginTurnOutcomeProjection",
  "settleTurnOutcomeProjection",
  "prepareDeliveryInterrupt",
  "beginDeliveryInterruptEffect",
  "settleDeliveryInterrupt",
  "claimNextDeliveryDispatch",
  "claimDeliveryDispatch",
  "beginTimerExecution",
  "completeTimerExecution",
  "failTimerExecution",
  "recordTimerRuntimeFailure",
]);

const OUTBOX_ID_METHODS = new Set([
  "outboxSessionId",
  "ackOutbox",
  "deferOutbox",
  "noteOutboxFailure",
  "discardDeadOutbox",
  "retryDeadOutbox",
]);

function minDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

/**
 * Routes one session to exactly one authoritative SQLite store.
 *
 * Existing sessions remain in the schema-21 central store until an explicit
 * migration moves them. A session with no central durable rows is claimed in
 * the placement catalog before its first mutation and writes only its own DB.
 * The durable dirty bit is committed before every isolated mutation, making
 * the global wake index conservative and repairable after a crash.
 */
export class SessionKernelStoreHost {
  readonly central: SessionKernelStore;
  private readonly isolated = new Map<string, SessionKernelStore>();
  private runtimeCursor = "";
  private outboxRouteMaintenanceCursor = 0;

  constructor(
    private readonly centralPath = sessionKernelDbPath(),
    private readonly isolatedRoot = `${dirname(centralPath)}/session-kernel-sessions`,
  ) {
    this.central = new SessionKernelStore(centralPath);
  }

  close(): void {
    for (const store of this.isolated.values()) store.close();
    this.isolated.clear();
    this.central.close();
  }

  isIsolated(sessionId: string): boolean {
    return this.central.sessionPlacement(sessionId)?.placement === "isolated";
  }

  quarantinedSession(sessionId: string): DurableSessionQuarantine | undefined {
    const infrastructure = this.central.quarantinedSession(sessionId);
    if (infrastructure) return infrastructure;
    return this.isIsolated(sessionId)
      ? this.openIsolated(sessionId).quarantinedSession(sessionId)
      : undefined;
  }

  quarantineSession(
    sessionId: string,
    reason: string,
    commandKind: string,
    infrastructure = false,
  ): DurableSessionQuarantine {
    if (infrastructure && this.isIsolated(sessionId))
      return this.central.quarantineSession(sessionId, reason, commandKind);
    return this.storeForSession(sessionId, true).quarantineSession(
      sessionId,
      reason,
      commandKind,
    );
  }

  storeForSession(sessionId: string, mutation = false): SessionKernelStore {
    const placement = this.central.sessionPlacement(sessionId);
    if (placement) {
      if (mutation) this.central.markIsolatedSessionDirty(sessionId);
      return this.openIsolated(sessionId);
    }
    if (!mutation || this.central.hasSessionDurableState(sessionId))
      return this.central;
    this.central.claimIsolatedSession(sessionId);
    return this.openIsolated(sessionId);
  }

  storeForOutbox(id: number, mutation = false): SessionKernelStore {
    const centralSession = this.central.outboxSessionId(id);
    if (centralSession) return this.central;
    const sessionId = this.central.isolatedOutboxSessionId(id);
    if (!sessionId) return this.central;
    return this.storeForSession(sessionId, mutation);
  }

  outboxSessionId(id: number): string | undefined {
    return this.central.outboxSessionId(id) ?? this.central.isolatedOutboxSessionId(id);
  }

  call(method: string, args: unknown[]): unknown {
    if (method === "quarantinedSession")
      return this.quarantinedSession(String(args[0] ?? ""));
    if (method === "quarantineSession")
      return this.quarantineSession(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? "unknown"),
      );
    if (method === "releaseQuarantine") {
      const sessionId = String(args[0] ?? "");
      let isolatedStore: SessionKernelStore | undefined;
      if (this.isIsolated(sessionId)) isolatedStore = this.openIsolated(sessionId);
      const isolatedReleased = isolatedStore?.releaseQuarantine(sessionId) ?? false;
      const centralReleased = this.central.releaseQuarantine(sessionId);
      return centralReleased || isolatedReleased;
    }
    if (GLOBAL_METHODS.has(method)) return this.callGlobal(method, args);
    if (OUTBOX_ID_METHODS.has(method)) {
      const id = Number(args[0]);
      if (method === "outboxSessionId") return this.outboxSessionId(id);
      const store = this.storeForOutbox(id, true);
      const result = this.invoke(store, method, args);
      if (
        (method === "ackOutbox" ||
          (method === "discardDeadOutbox" && result === true)) &&
        this.central.isolatedOutboxSessionId(id)
      ) this.central.forgetIsolatedOutboxRoute(id);
      return result;
    }
    if (SESSION_FIRST_METHODS.has(method)) {
      const sessionId = String(args[0] ?? "");
      return this.invoke(
        this.storeForSession(sessionId, this.isMutation(method)),
        method,
        args,
      );
    }
    if (SESSION_INPUT_METHODS.has(method)) {
      const input = args[0] as { sessionId?: unknown } | undefined;
      if (typeof input?.sessionId !== "string")
        throw new Error(`Store method ${method} requires a session id`);
      return this.invoke(this.storeForSession(input.sessionId, true), method, args);
    }
    throw new Error(`Unrouted session kernel store method ${method}`);
  }

  allRunStates(): Array<DurableRunState & { sessionId: string }> {
    return this.allStores().flatMap((store) => store.runStates());
  }

  allAskEntries(): Array<[string, unknown]> {
    return this.allStores().flatMap((store) => store.askEntries());
  }

  allDeliveryEntries(slot: Parameters<SessionKernelStoreApi["deliveryEntries"]>[0]) {
    return this.allStores().flatMap((store) => store.deliveryEntries(slot));
  }

  allQuarantinedSessions(limit = 100, offset = 0): DurableSessionQuarantine[] {
    return this.allStores()
      .flatMap((store) => store.quarantinedSessions(Number.MAX_SAFE_INTEGER, 0))
      .sort((a, b) => b.quarantinedAt - a.quarantinedAt)
      .slice(offset, offset + limit);
  }

  runtimeWork(
    now: number,
    timerKinds: string[],
    effectKinds: string[],
    limit: number,
  ): { timers: DurableTimer[]; outbox: DurableOutboxItem[] } {
    const candidateLimit = Math.max(100, limit * 4);
    let candidates = this.central.isolatedWakeCandidates(
      now,
      candidateLimit,
      this.runtimeCursor,
    );
    if (candidates.length < candidateLimit && this.runtimeCursor) {
      const wrapped = this.central.isolatedWakeCandidates(
        now,
        candidateLimit - candidates.length,
      );
      const seen = new Set(candidates);
      candidates = [...candidates, ...wrapped.filter((sessionId) => !seen.has(sessionId))];
    }
    if (candidates.length > 0) this.runtimeCursor = candidates.at(-1)!;
    const isolatedStores: Array<{ sessionId: string; store: SessionKernelStore }> = [];
    for (const sessionId of candidates) {
      try {
        isolatedStores.push({ sessionId, store: this.openIsolated(sessionId) });
      } catch (error) {
        this.central.quarantineSession(
          sessionId,
          error instanceof Error ? error.message : String(error),
          "storage:open",
        );
      }
    }
    const stores = [this.central, ...isolatedStores.map((entry) => entry.store)];
    const quota = Math.max(1, Math.ceil(limit / stores.length));
    const timers: DurableTimer[] = [];
    const outbox: DurableOutboxItem[] = [];
    for (let index = 0; index < stores.length; index += 1) {
      const store = stores[index];
      const sessionId = index === 0 ? undefined : isolatedStores[index - 1]?.sessionId;
      if (timers.length < limit)
        timers.push(...store.dueTimers(now, Math.min(quota, limit - timers.length), timerKinds));
      if (outbox.length < limit)
        outbox.push(...store.pendingOutbox(now, Math.min(quota, limit - outbox.length), effectKinds));
      if (sessionId)
        this.central.settleIsolatedSessionWake(
          sessionId,
          store.nextTimerWakeAt(),
          store.nextOutboxWakeAt(),
        );
      if (timers.length >= limit && outbox.length >= limit) break;
    }
    return { timers, outbox };
  }

  stats(): ReturnType<SessionKernelStoreApi["stats"]> {
    const parts = this.allStores().map((store) => store.stats());
    const sum = (key: keyof ReturnType<SessionKernelStoreApi["stats"]>) =>
      parts.reduce((total, part) => total + Number(part[key] ?? 0), 0);
    return {
      sessions: sum("sessions"),
      quarantinedSessions: sum("quarantinedSessions"),
      pendingCommands: sum("pendingCommands"),
      indeterminateCommands: sum("indeterminateCommands"),
      pendingTimers: sum("pendingTimers"),
      pendingOutbox: sum("pendingOutbox"),
      deadLetteredOutbox: sum("deadLetteredOutbox"),
      deadLetteredTimers: sum("deadLetteredTimers"),
      oldestPendingCommandAt: minDefined(parts.map((part) => part.oldestPendingCommandAt)),
      oldestIndeterminateCommandAt: minDefined(parts.map((part) => part.oldestIndeterminateCommandAt)),
      oldestPendingTimerAt: minDefined(parts.map((part) => part.oldestPendingTimerAt)),
      oldestPendingOutboxAt: minDefined(parts.map((part) => part.oldestPendingOutboxAt)),
      dbBytes: sum("dbBytes"),
      walBytes: sum("walBytes"),
      pageCount: sum("pageCount"),
      freePages: sum("freePages"),
      schemaVersion: this.central.stats().schemaVersion,
    };
  }

  maintain(): boolean {
    let routes = this.central.isolatedOutboxRoutes(
      50,
      this.outboxRouteMaintenanceCursor,
    );
    if (routes.length === 0 && this.outboxRouteMaintenanceCursor !== 0) {
      this.outboxRouteMaintenanceCursor = 0;
      routes = this.central.isolatedOutboxRoutes(50, 0);
    }
    for (const route of routes) {
      this.outboxRouteMaintenanceCursor = route.id;
      if (this.central.quarantinedSession(route.sessionId)) continue;
      try {
        if (this.openIsolated(route.sessionId).outboxSessionId(route.id) !== route.sessionId)
          this.central.forgetIsolatedOutboxRoute(route.id);
      } catch (error) {
        this.central.quarantineSession(
          route.sessionId,
          error instanceof Error ? error.message : String(error),
          "storage:open",
        );
      }
    }
    let pending = routes.length === 50;
    for (const store of this.allStores()) pending = store.maintain() || pending;
    return pending;
  }

  private openIsolated(sessionId: string): SessionKernelStore {
    let store = this.isolated.get(sessionId);
    if (store) return store;
    store = new SessionKernelStore(
      this.centralPath === ":memory:"
        ? ":memory:"
        : sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
      { allocateOutboxId: (owner) => this.central.allocateIsolatedOutboxId(owner) },
    );
    this.isolated.set(sessionId, store);
    return store;
  }

  private allStores(): SessionKernelStore[] {
    for (const placement of this.central.isolatedSessionPlacements()) {
      if (this.central.quarantinedSession(placement.sessionId)) continue;
      try {
        this.openIsolated(placement.sessionId);
      } catch (error) {
        this.central.quarantineSession(
          placement.sessionId,
          error instanceof Error ? error.message : String(error),
          "storage:open",
        );
      }
    }
    return [
      this.central,
      ...[...this.isolated].flatMap(([sessionId, store]) =>
        this.central.quarantinedSession(sessionId) ? [] : [store],
      ),
    ];
  }

  private isMutation(method: string): boolean {
    return ![
      "command",
      "quarantinedSession",
      "creationState",
      "runState",
      "changesSince",
      "isTombstoned",
      "askSnapshot",
      "turnSnapshot",
      "deliverySnapshot",
      "timer",
    ].includes(method);
  }

  private invoke(store: SessionKernelStore, method: string, args: unknown[]): unknown {
    const fn = (store as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
    if (typeof fn !== "function") throw new Error(`Unknown store method ${method}`);
    return fn.apply(store, args);
  }

  private callGlobal(method: string, args: unknown[]): unknown {
    if (method === "askMigrationComplete") return this.central.askMigrationComplete();
    if (method === "markAskMigrationComplete") return this.central.markAskMigrationComplete();
    if (method === "deliveryMigrationComplete") return this.central.deliveryMigrationComplete();
    if (method === "markDeliveryMigrationComplete") return this.central.markDeliveryMigrationComplete();
    if (method === "askEntries") return this.allAskEntries();
    if (method === "deliveryEntries")
      return this.allDeliveryEntries(args[0] as Parameters<SessionKernelStoreApi["deliveryEntries"]>[0]);
    if (method === "runStates") return this.allRunStates();
    if (method === "quarantinedSessions")
      return this.allQuarantinedSessions(Number(args[0] ?? 100), Number(args[1] ?? 0));
    if (method === "dueTimers")
      return this.allStores().flatMap((store) => store.dueTimers(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as readonly string[] | undefined,
      )).slice(0, Number(args[1] ?? 100));
    if (method === "pendingOutbox")
      return this.allStores().flatMap((store) => store.pendingOutbox(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as readonly string[] | undefined,
      )).slice(0, Number(args[1] ?? 100));
    if (method === "stats") return this.stats();
    if (method === "maintain") return this.maintain();
    if (method === "compact") {
      for (const store of this.allStores()) store.compact(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as number | undefined,
      );
      return;
    }
    if (method === "clearAskRecords") {
      for (const store of this.allStores()) store.clearAskRecords();
      return;
    }
    if (method === "clearDeliverySlot") {
      for (const store of this.allStores())
        store.clearDeliverySlot(args[0] as Parameters<SessionKernelStoreApi["clearDeliverySlot"]>[0]);
      return;
    }
    if (method === "settlePendingSteers")
      return this.allStores().reduce((total, store) => total + store.settlePendingSteers(), 0);
    if (method === "retryCompatibleCreationBranchDeadLetters")
      return this.allStores().flatMap((store) =>
        store.retryCompatibleCreationBranchDeadLetters(
          args[0] as Parameters<SessionKernelStoreApi["retryCompatibleCreationBranchDeadLetters"]>[0],
          args[1] as number | undefined,
        ),
      );
    if (method === "deadLetters") {
      const limit = Number(args[0] ?? 100);
      const offset = Number(args[1] ?? 0);
      const parts = this.allStores().map((store) => store.deadLetters(Number.MAX_SAFE_INTEGER, 0));
      const byDeadLetter = (a: { deadLetteredAt: number }, b: { deadLetteredAt: number }) =>
        b.deadLetteredAt - a.deadLetteredAt;
      const quarantines = parts.flatMap((part) => part.quarantines)
        .sort((a, b) => b.quarantinedAt - a.quarantinedAt);
      const timers = parts.flatMap((part) => part.timers).sort(byDeadLetter);
      const outbox = parts.flatMap((part) => part.outbox).sort(byDeadLetter);
      return {
        quarantines: quarantines.slice(offset, offset + limit),
        timers: timers.slice(offset, offset + limit),
        outbox: outbox.slice(offset, offset + limit),
        totals: {
          quarantines: quarantines.length,
          timers: timers.length,
          outbox: outbox.length,
        },
        nextOffset:
          Math.max(quarantines.length, timers.length, outbox.length) > offset + limit
            ? offset + limit
            : undefined,
      };
    }
    throw new Error(`Unsupported global store method ${method}`);
  }
}
