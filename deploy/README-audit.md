# Open Session audit events

Open Session stores security, agent-run, and operational audit events in the
managed FeltDB namespace configured for the server. Each event has an ISO UTC
timestamp and `service: "opensession"`; remaining fields depend on the emitter.
The server retains 400 days.

Legacy `audit-YYYY-MM-DD.jsonl` files are imported once during the managed
FeltDB boot migration and removed after the import commits. They are never used
as a fallback authority.

The read-only viewer is at **Settings → Audit log**. The authenticated
`GET <base-path>/api/audit/digest` endpoint returns a compact daily roll-up;
pass `?date=YYYY-MM-DD` and optionally `&section=name,name`.

Audit writes remain best-effort: a managed write failure is reported to
journald but does not fail the operation being observed. Export or external log
shipping should consume managed FeltDB records rather than tailing local files.
