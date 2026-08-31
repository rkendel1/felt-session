import { createFeltDB, type StateFirstDB } from "@feltdb/core";

const authorities = new Map<string, StateFirstDB>();

export function testFeltDb(key: string): StateFirstDB {
  let db = authorities.get(key);
  if (!db) {
    db = createFeltDB({
      namespace: `runner-test-${crypto.randomUUID()}`,
      memory: true,
    });
    authorities.set(key, db);
  }
  return db;
}
