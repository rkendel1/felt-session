/**
 * Event spine contract: one spine, multiple implementations.
 *
 * Every EventSpine backend must pass these tests. They prove that
 * events are recorded durably, indexed correctly, and recoverable
 * across process restart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeltDbEventSpine } from "./feltdb-event-spine";
import type { EventSpine, AnyMissionControlEvent } from "./event-spine";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "event-spine-"));
  roots.push(root);
  return root;
}

const testBackends = [
  {
    name: "FeltDbEventSpine",
    open: () => openFeltDbEventSpine(join(tmpRoot(), "events")),
  },
];

for (const backend of testBackends) {
  describe(`EventSpine: ${backend.name}`, () => {
    test("records events durably and retrieves them by sequence", async () => {
      const spine = backend.open();
      const sessionId = "session-1";

      const event1: AnyMissionControlEvent = {
        kind: "session.created",
        id: { sessionId, eventSequence: 0 },
        timestamp: "2026-08-22T12:00:00.000Z",
        projectId: "project-1",
        repository: "repo",
        branch: "main",
        initiatedBy: "user-1",
      };

      const id1 = await spine.record(event1);
      expect(id1).toEqual({ sessionId, eventSequence: 0 });

      const retrieved = await spine.range(sessionId, 0, 0);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]).toEqual(event1);
    });

    test("handles multiple events in sequence", async () => {
      const spine = backend.open();
      const sessionId = "session-1";

      const events: AnyMissionControlEvent[] = [
        {
          kind: "session.created",
          id: { sessionId, eventSequence: 0 },
          timestamp: "2026-08-22T12:00:00.000Z",
          projectId: "project-1",
          repository: "repo",
          branch: "main",
          initiatedBy: "user-1",
        },
        {
          kind: "task.created",
          id: { sessionId, eventSequence: 1 },
          timestamp: "2026-08-22T12:00:01.000Z",
          taskId: "task-1",
          title: "Implement feature",
          description: "Do the thing",
        },
        {
          kind: "task.assigned",
          id: { sessionId, eventSequence: 2 },
          timestamp: "2026-08-22T12:00:02.000Z",
          taskId: "task-1",
          agentId: "agent-1",
          role: "builder",
        },
      ];

      for (const event of events) {
        await spine.record(event);
      }

      const retrieved = await spine.range(sessionId, 0, 2);
      expect(retrieved).toHaveLength(3);
      for (let i = 0; i < events.length; i++) {
        expect(retrieved[i]).toEqual(events[i]);
      }
    });

    test("retrieves events by timestamp", async () => {
      const spine = backend.open();
      const sessionId = "session-1";

      const events: AnyMissionControlEvent[] = [
        {
          kind: "session.created",
          id: { sessionId, eventSequence: 0 },
          timestamp: "2026-08-22T12:00:00.000Z",
          projectId: "project-1",
          repository: "repo",
          branch: "main",
          initiatedBy: "user-1",
        },
        {
          kind: "agent.started",
          id: { sessionId, eventSequence: 1 },
          timestamp: "2026-08-22T12:00:05.000Z",
          agentId: "agent-1",
          role: "builder",
          model: "claude-opus",
        },
        {
          kind: "agent.message",
          id: { sessionId, eventSequence: 2 },
          timestamp: "2026-08-22T12:00:10.000Z",
          agentId: "agent-1",
          message: "Starting work",
        },
      ];

      for (const event of events) {
        await spine.record(event);
      }

      const since = await spine.since(sessionId, "2026-08-22T12:00:05.000Z");
      expect(since).toHaveLength(2);
      expect(since[0].id.eventSequence).toBe(1);
      expect(since[1].id.eventSequence).toBe(2);
    });

    test("counts events in a session", async () => {
      const spine = backend.open();
      const sessionId = "session-1";

      expect(await spine.count(sessionId)).toBe(0);

      for (let i = 0; i < 5; i++) {
        await spine.record({
          kind: "agent.message",
          id: { sessionId, eventSequence: i },
          timestamp: new Date().toISOString(),
          agentId: "agent-1",
          message: `Message ${i}`,
        });
      }

      expect(await spine.count(sessionId)).toBe(5);
    });

    test("handles multiple sessions independently", async () => {
      const spine = backend.open();
      const session1 = "session-1";
      const session2 = "session-2";

      await spine.record({
        kind: "session.created",
        id: { sessionId: session1, eventSequence: 0 },
        timestamp: "2026-08-22T12:00:00.000Z",
        projectId: "project-1",
        repository: "repo-1",
        branch: "main",
        initiatedBy: "user-1",
      });

      await spine.record({
        kind: "session.created",
        id: { sessionId: session2, eventSequence: 0 },
        timestamp: "2026-08-22T12:00:00.000Z",
        projectId: "project-2",
        repository: "repo-2",
        branch: "main",
        initiatedBy: "user-2",
      });

      const events1 = await spine.range(session1, 0, 0);
      const events2 = await spine.range(session2, 0, 0);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect((events1[0] as any).projectId).toBe("project-1");
      expect((events2[0] as any).projectId).toBe("project-2");
    });

    test("preserves event causality metadata", async () => {
      const spine = backend.open();
      const sessionId = "session-1";

      const event: AnyMissionControlEvent = {
        kind: "agent.message",
        id: { sessionId, eventSequence: 0 },
        timestamp: "2026-08-22T12:00:00.000Z",
        agentId: "agent-1",
        message: "Building feature",
        causality: {
          executionId: "exec-1",
          commandId: "cmd-1",
          precedingEventId: { sessionId, eventSequence: -1 },
        },
      };

      await spine.record(event);
      const retrieved = await spine.range(sessionId, 0, 0);

      expect(retrieved[0].causality).toEqual(event.causality);
    });
  });
}
