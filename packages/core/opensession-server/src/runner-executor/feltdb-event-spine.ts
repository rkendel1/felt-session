/**
 * FeltDB-backed event spine implementation.
 *
 * Events are persisted durably through FeltDB, indexed by session and sequence,
 * enabling efficient replay and projection building.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import {
  type AnyMissionControlEvent,
  type EventId,
  type EventSpine,
} from "./event-spine";

interface StoredEventRow {
  id: string;
  sessionId: string;
  eventSequence: number;
  timestamp: string;
  payload: string;
}

const COLLECTION_NAME = "mission_control_events";

export function openFeltDbEventSpine(path: string): EventSpine {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-events",
  });

  return {
    async record(event: AnyMissionControlEvent): Promise<EventId> {
      const id = event.id;
      const key = `${id.sessionId}_${id.eventSequence}`;

      const row: StoredEventRow = {
        id: key,
        sessionId: id.sessionId,
        eventSequence: id.eventSequence,
        timestamp: event.timestamp,
        payload: JSON.stringify(event),
      };

      await db.transaction((tx) => {
        tx.collection<StoredEventRow>(COLLECTION_NAME).set(key, row);
      });

      return id;
    },

    async range(
      sessionId: string,
      fromSequence: number,
      toSequence?: number,
    ): Promise<AnyMissionControlEvent[]> {
      const upper = toSequence ?? fromSequence + 10_000;
      const events: AnyMissionControlEvent[] = [];

      for (let seq = fromSequence; seq <= upper; seq++) {
        const key = `${sessionId}_${seq}`;
        const row = await db.collection<StoredEventRow>(COLLECTION_NAME).get(key);

        if (!row) break;

        events.push(JSON.parse(row.payload));
      }

      return events;
    },

    async since(
      sessionId: string,
      timestamp: string,
    ): Promise<AnyMissionControlEvent[]> {
      const startTime = new Date(timestamp).getTime();
      const events: AnyMissionControlEvent[] = [];

      // Scan forward from sequence 0 until we hit events after the timestamp
      for (let seq = 0; seq < 1_000_000; seq++) {
        const key = `${sessionId}_${seq}`;
        const row = await db.collection<StoredEventRow>(COLLECTION_NAME).get(key);

        if (!row) break;

        const eventTime = new Date(row.timestamp).getTime();

        if (eventTime >= startTime) {
          events.push(JSON.parse(row.payload));
        }
      }

      return events;
    },

    async count(sessionId: string): Promise<number> {
      let count = 0;
      for (let seq = 0; seq < 1_000_000; seq++) {
        const key = `${sessionId}_${seq}`;
        const row = await db.collection<StoredEventRow>(COLLECTION_NAME).get(key);
        if (!row) break;
        count++;
      }
      return count;
    },
  };
}

export { EventSpine };
