const state = globalThis as typeof globalThis & {
  __sessionMutationTails?: Map<string, Promise<void>>;
};

/**
 * Serialize physical gateway projections for one session. Durable admission and
 * settlement stay actor-owned; this mutex only prevents the single gateway
 * process from interleaving filesystem/WebSocket continuations.
 */
export function withSessionMutationLock<T>(
  sessionId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const tails = (state.__sessionMutationTails ??= new Map());
  const prior = tails.get(sessionId) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(sessionId, tail);
  void tail.finally(() => {
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  });
  return result;
}
