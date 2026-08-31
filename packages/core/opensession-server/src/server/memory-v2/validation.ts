import { createHash, randomUUID } from "node:crypto";
import {
	MEMORY_KINDS,
	MEMORY_SOURCE_TYPES,
	MEMORY_TIERS,
	type CreateMemoryInput,
	type MemoryKind,
	type MemoryRecord,
	type MemorySource,
	type MemoryState,
} from "./types";

const SUMMARY_MAX_CHARS = 400;
const DETAILS_MAX_BYTES = 20_000;
const TAG_MAX_CHARS = 80;
const TAG_MAX_COUNT = 12;
const MAX_PAGE_SIZE = 100;

export class DuplicateMemoryError extends Error {
	constructor(public readonly scopeKey: string, public readonly existingId: string) {
		super(`An identical memory already exists in scope "${scopeKey}" (${existingId}).`);
		this.name = "DuplicateMemoryError";
	}
}

export class MemoryNotFoundError extends Error {
	constructor(public readonly id: string) {
		super(`No memory record with id "${id}".`);
		this.name = "MemoryNotFoundError";
	}
}

export function prepareCreate(input: CreateMemoryInput, now: Date): MemoryRecord {
	const scopeKey = input.scopeKey.trim();
	if (!scopeKey) throw new Error("scopeKey is required.");
	const summary = validateSummary(input.summary);
	const details = cleanDetails(input.details);
	const createdAt = validateDate(input.createdAt ?? now.toISOString(), "createdAt");
	const expiresAt = validateOptionalDate(input.expiresAt);
	const kind = validateEnum(input.kind, MEMORY_KINDS, "kind");
	validateKindExpiry(kind, expiresAt);
	const state: MemoryState = expiresAt && Date.parse(expiresAt) <= now.getTime() ? "expired" : "active";
	return {
		id: input.id?.trim() || randomUUID(), scopeKey, summary, details, kind,
		tier: validateEnum(input.tier, MEMORY_TIERS, "tier"), state,
		source: validateSource(input.source), createdAt,
		updatedAt: validateDate(input.updatedAt ?? input.createdAt ?? now.toISOString(), "updatedAt"),
		lastConfirmedAt: validateOptionalDate(input.lastConfirmedAt), expiresAt,
		supersedes: uniqueStrings(input.supersedes ?? []),
		fingerprint: memoryFingerprint(summary, details),
		tags: normalizeTags(input.tags ?? []), retrievalCount: 0,
	};
}

export function memoryFingerprint(summary: string, details?: string): string {
	const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
	return createHash("sha256").update(`${normalize(summary)}\0${normalize(details ?? "")}`).digest("hex");
}

export function validateSummary(summary: string): string {
	const clean = summary.trim().replace(/\s+/g, " ");
	const length = Array.from(clean).length;
	if (!length) throw new Error("summary is required.");
	if (length > SUMMARY_MAX_CHARS) throw new Error(`summary must be ${SUMMARY_MAX_CHARS} characters or fewer.`);
	if (clean.split(/[.!?]+(?:\s+|$)/).filter((part) => part.trim()).length > 2)
		throw new Error("summary must be one or two sentences.");
	return clean;
}

const cleanOptional = (value: string | null | undefined): string | undefined => {
	if (value == null) return undefined;
	return value.trim() || undefined;
};

export function cleanDetails(value: string | null | undefined): string | undefined {
	if (value == null || !value.trim()) return undefined;
	if (Buffer.byteLength(value, "utf8") > DETAILS_MAX_BYTES)
		throw new Error(`details must be ${DETAILS_MAX_BYTES} bytes or fewer.`);
	return value;
}

export function validateSource(source: MemorySource): MemorySource {
	const type = validateEnum(source.type, MEMORY_SOURCE_TYPES, "source.type");
	return {
		type,
		...(cleanOptional(source.sessionId) ? { sessionId: cleanOptional(source.sessionId) } : {}),
		...(cleanOptional(source.turnId) ? { turnId: cleanOptional(source.turnId) } : {}),
		...(cleanOptional(source.repoPath) ? { repoPath: cleanOptional(source.repoPath) } : {}),
		...(cleanOptional(source.actor) ? { actor: cleanOptional(source.actor)?.slice(0, 200) } : {}),
		...(cleanOptional(source.channelId) ? { channelId: cleanOptional(source.channelId)?.slice(0, 200) } : {}),
	};
}

function validateEnum<T extends string>(value: T, values: readonly T[], label: string): T {
	if (!values.includes(value)) throw new Error(`Invalid ${label}: ${String(value)}.`);
	return value;
}

function validateDate(value: string, label: string): string {
	if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid ISO date.`);
	return new Date(value).toISOString();
}

export function validateOptionalDate(value: string | null | undefined): string | undefined {
	return value == null || value === "" ? undefined : validateDate(value, "date");
}

export function validateKindExpiry(kind: MemoryKind, expiresAt: string | undefined): void {
	if (kind === "status" && !expiresAt) throw new Error("status memories require expiresAt.");
}

export function normalizeTags(tags: string[]): string[] {
	if (tags.length > TAG_MAX_COUNT) throw new Error(`tags must contain ${TAG_MAX_COUNT} items or fewer.`);
	const normalized = uniqueStrings(tags.map((tag) => tag.trim().toLocaleLowerCase("en-US")).filter(Boolean));
	if (normalized.some((tag) => Array.from(tag).length > TAG_MAX_CHARS))
		throw new Error(`tags must be ${TAG_MAX_CHARS} characters or fewer.`);
	return normalized;
}

export function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function pageLimit(limit?: number): number {
	return Math.min(Math.max(limit ?? 25, 1), MAX_PAGE_SIZE);
}

export function legacySummary(text: string): string {
	const compact = text.trim().replace(/\s+/g, " ");
	const sentenceEnds = [...compact.matchAll(/[.!?]+(?:\s+|$)/g)];
	const bounded = sentenceEnds.length > 2
		? compact.slice(0, sentenceEnds[1].index! + sentenceEnds[1][0].trimEnd().length)
		: compact;
	const chars = Array.from(bounded);
	return chars.length <= 400 ? bounded : `${chars.slice(0, 399).join("").trimEnd()}…`;
}
