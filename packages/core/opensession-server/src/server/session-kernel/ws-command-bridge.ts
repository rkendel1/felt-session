/** True only for a recursive command owned by the active outer dispatch. */
export function isInternalKernelDispatch(
  activeTokens: ReadonlySet<string>,
  token: unknown,
): token is string {
  return typeof token === "string" && activeTokens.has(token);
}
