import type { StateFirstDB } from "@feltdb/core";
import { createHash } from "node:crypto";
import type { SearchHit, SearchRecord } from "./session-search-store";

const COLLECTION = "opensession_session_search";
const HALF_LIFE_DAYS = 90;
const documentId = (id: string) => createHash("sha256").update(id).digest("hex");

function terms(value: string): string[] {
	return (value.toLocaleLowerCase().match(/[\p{L}\p{N}_./:@#$-]+/gu) ?? [])
		.map((term) => term.replace(/^[./:@#$-]+|[./:@#$-]+$/g, ""))
		.filter(Boolean)
		.slice(0, 24);
}

function relevance(record: SearchRecord, queryTerms: string[]): number {
	const fields: Array<[string, number]> = [
		[record.question, 4],
		[record.summary, 2],
		[record.resolution, 3],
		[record.files, 1.5],
	];
	let score = 0;
	for (const term of queryTerms) {
		for (const [field, weight] of fields) {
			const haystack = terms(field);
			if (haystack.includes(term)) score += weight;
		}
	}
	return score;
}

export class ManagedSessionSearchStore {
	private readonly records = new Map<string, SearchRecord>();

	constructor(private readonly db: StateFirstDB) {}

	async initialize(): Promise<void> {
		this.records.clear();
		for (const record of await this.db.collection<SearchRecord>(COLLECTION).all()) {
			this.records.set(record.id, record);
		}
	}

	async upsert(record: SearchRecord): Promise<void> {
		await this.db.transaction((tx) => {
			tx.collection<SearchRecord>(COLLECTION).set(documentId(record.id), record);
		}, { transactionId: `opensession:session-search:upsert:${crypto.randomUUID()}` });
		this.records.set(record.id, structuredClone(record));
	}

	async upsertMany(records: SearchRecord[]): Promise<void> {
		for (let index = 0; index < records.length; index += 100) {
			const chunk = records.slice(index, index + 100);
			await this.db.transaction((tx) => {
				const collection = tx.collection<SearchRecord>(COLLECTION);
				for (const record of chunk) collection.set(documentId(record.id), record);
			}, { transactionId: `opensession:session-search:upsert-many:${crypto.randomUUID()}` });
			for (const record of chunk) this.records.set(record.id, structuredClone(record));
		}
	}

	async remove(id: string): Promise<void> {
		await this.db.transaction((tx) => { tx.collection<SearchRecord>(COLLECTION).delete(documentId(id)); },
			{ transactionId: `opensession:session-search:remove:${crypto.randomUUID()}` });
		this.records.delete(id);
	}

	indexState(): Map<string, { activityTs: number; distilled: string }> {
		return new Map([...this.records.values()].map((record) => [record.id, {
			activityTs: record.activityTs,
			distilled: record.distilled,
		}]));
	}

	count(): number { return this.records.size; }

	search(query: string, opts: { repo?: string; limit?: number; sinceTs?: number; now?: number } = {}): SearchHit[] {
		const queryTerms = terms(query);
		if (!queryTerms.length) return [];
		const candidates = [...this.records.values()].filter((record) =>
			(!opts.repo || record.repo === opts.repo) && (!opts.sinceTs || record.ts >= opts.sinceTs));
		const matchingAll = candidates.filter((record) => {
			const text = terms(`${record.question} ${record.summary} ${record.resolution} ${record.files}`);
			return queryTerms.every((term) => text.includes(term));
		});
		const pool = matchingAll.length ? matchingAll : candidates.filter((record) => {
			const text = terms(`${record.question} ${record.summary} ${record.resolution} ${record.files}`);
			return queryTerms.some((term) => text.includes(term));
		});
		const now = opts.now ?? Date.now();
		return pool.map((record) => {
			const ageDays = Math.max(now - record.ts, 0) / 86_400_000;
			return { ...structuredClone(record), score: relevance(record, queryTerms) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS) };
		}).sort((left, right) => right.score - left.score)
			.slice(0, Math.min(Math.max(opts.limit ?? 8, 1), 100));
	}

	close(): void {}
}
