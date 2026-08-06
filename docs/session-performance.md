# Session performance contract

The session renderer exposes `window.__sessionPerf()` in development and production.
It returns recent samples, counters, and p50/p95/max summaries.

Budgets:

- input event p95: under 50 ms
- stream delta to paint p95: under 50 ms
- transcript React commit p95 while streaming: under 8 ms
- send to optimistic bubble paint p95: under 50 ms
- no long task over 100 ms during a 100-delta/s fixture

Deterministic fixtures live in
`src/frontend/lib/session-performance-fixtures.ts` for 200, 2,000, and 10,000
entries plus a configurable delta stream. Compare `stream_frames_received`
with `stream_paints`; paints should remain bounded by the display frame rate.
