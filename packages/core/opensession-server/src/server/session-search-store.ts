/** Shared managed session-search record types. */

export interface SearchRecord {
	id: string;
	source: string;
	question: string;
	summary: string;
	resolution: string;
	files: string;
	repo?: string;
	user?: string;
	pr?: string;
	ts: number;
	activityTs: number;
	distilled: "llm" | "mech";
}

export interface SearchHit extends SearchRecord {
	score: number;
}
