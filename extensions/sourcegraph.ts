// Sourcegraph: public code search across open-source repositories (free, no API key)
//
// Backed by Sourcegraph's documented streaming search API
// (https://sourcegraph.com/docs/api/stream-api). Set SRC_ENDPOINT /
// SRC_ACCESS_TOKEN to search a self-hosted instance or a private code host.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_ENDPOINT = "https://sourcegraph.com";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MAX_SHOWN = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MAX_RESPONSE_CHARS = 4_000_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const ok = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
});

const fail = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	isError: true,
});

export interface SseFrame {
	event: string;
	data: string;
}

export interface SgMatch {
	type?: string;
	repository?: string;
	path?: string;
	language?: string;
	repoStars?: number;
	lineMatches?: { line?: string; lineNumber?: number }[];
	symbols?: { name?: string; kind?: string; containerName?: string; line?: number }[];
	message?: string;
	oid?: string;
	authorName?: string;
	authorDate?: string;
	description?: string;
	[key: string]: unknown;
}

export interface SgAlert {
	title?: string;
	description?: string;
	proposedQueries?: unknown;
}

export interface SgResults {
	matches: SgMatch[];
	alerts: SgAlert[];
	skipped: Map<string, number>;
	matchCount?: number;
	repositoriesCount?: number;
	parseErrors: number;
}

/**
 * Split a Sourcegraph SSE body into frames. Per the SSE spec a single event may
 * spread its payload over several `data:` lines; those are joined with "\n" so
 * a pretty-printed JSON payload is still parsed instead of being dropped.
 */
export function parseSse(body: string): SseFrame[] {
	const frames: SseFrame[] = [];
	for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
		let event = "";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length === 0) continue;
		frames.push({ event: event || "message", data: data.join("\n") });
	}
	return frames;
}

/**
 * Turn the raw stream into matches, alerts and the `progress.skipped` report.
 * Sourcegraph answers HTTP 200 even for fatal query errors, so alerts and
 * skipped reasons must be read from the stream or they are silently lost.
 */
export function collectResults(body: string): SgResults {
	const out: SgResults = { matches: [], alerts: [], skipped: new Map(), parseErrors: 0 };
	for (const frame of parseSse(body)) {
		let data: unknown;
		try {
			data = JSON.parse(frame.data);
		} catch {
			out.parseErrors++;
			continue;
		}
		if (frame.event === "matches") {
			if (Array.isArray(data)) out.matches.push(...(data as SgMatch[]));
		} else if (frame.event === "alert") {
			if (data && typeof data === "object") out.alerts.push(data as SgAlert);
		} else if (frame.event === "progress" && data && typeof data === "object") {
			const progress = data as { matchCount?: number; repositoriesCount?: number; skipped?: { reason?: string }[] };
			if (typeof progress.matchCount === "number") out.matchCount = progress.matchCount;
			if (typeof progress.repositoriesCount === "number") out.repositoriesCount = progress.repositoriesCount;
			for (const entry of progress.skipped ?? []) {
				const reason = String(entry?.reason ?? "unknown");
				out.skipped.set(reason, (out.skipped.get(reason) ?? 0) + 1);
			}
		}
	}
	return out;
}

export function normalizeCount(value: number | undefined): { count: number; note?: string } {
	if (value === undefined) return { count: DEFAULT_COUNT };
	if (!Number.isFinite(value)) return { count: DEFAULT_COUNT, note: `count was not a valid number; falling back to ${DEFAULT_COUNT}.` };
	const clamped = Math.min(Math.max(Math.trunc(value), 1), MAX_COUNT);
	return clamped === value ? { count: clamped } : { count: clamped, note: `count:${value} adjusted to count:${clamped} (allowed range 1-${MAX_COUNT}).` };
}

/**
 * `count:` is a well-known Sourcegraph filter, so a model will often write its
 * own. Sourcegraph rejects a query containing it twice ("Field count may not be
 * used more than once"), which would turn an otherwise valid query into a
 * silent empty result. Strip the top-level filter and let the tool own it.
 * Quoted regions are skipped, so a literal `count:` inside a quoted pattern
 * survives, and whitespace is only collapsed outside quotes.
 */
export function stripCount(query: string, notes: string[] = []): string {
	const stripped: string[] = [];
	let out = "";
	let quote: string | null = null;
	let pendingSpace = false;
	const push = (chunk: string) => {
		if (pendingSpace && out.length > 0) out += " ";
		pendingSpace = false;
		out += chunk;
	};
	for (let i = 0; i < query.length; i++) {
		const ch = query[i];
		if (quote) {
			out += ch;
			if (ch === "\\" && i + 1 < query.length) {
				out += query[i + 1];
				i++;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			push(ch);
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			pendingSpace = out.length > 0;
			continue;
		}
		if ((i === 0 || /\s/.test(query[i - 1])) && query.slice(i, i + 6).toLowerCase() === "count:") {
			const value = (query.slice(i + 6).match(/^\S+/) ?? [""])[0];
			if (value) {
				stripped.push(value);
				i += 6 + value.length - 1;
				continue;
			}
		}
		push(ch);
	}
	if (stripped.length > 0) {
		notes.push(
			`count: filter(s) in the query (${stripped.map((v) => `\`count:${v}\``).join(" / ")}) are managed by the tool; using the clamped count instead.`
		);
	}
	return out.trim();
}

/** Reject filter values that would inject extra query operators. */
export function checkFilterValue(value: string): string | null {
	if (/[\s\u0000-\u001f\u007f]/.test(value)) {
		return "must not contain whitespace or control characters (they would be parsed as extra query operators)";
	}
	return null;
}

export function buildQuery(
	params: { query: string; lang?: string; repo?: string; count?: number },
): { ok: true; query: string; notes: string[]; count: number } | { ok: false; error: string } {
	const notes: string[] = [];
	const parts: string[] = [];
	const base = stripCount(params.query ?? "", notes);
	if (base) parts.push(base);
	for (const [name, value] of [["lang", params.lang], ["repo", params.repo]] as const) {
		if (value === undefined || value.trim() === "") continue;
		const problem = checkFilterValue(value);
		if (problem) {
			return {
				ok: false,
				error: `invalid \`${name}\` value: ${problem}. Pass the bare value (e.g. "Go", "gin-gonic/gin") and put query operators in \`query\`.`,
			};
		}
		parts.push(`${name}:${value.trim()}`);
	}
	const { count, note } = normalizeCount(params.count);
	if (note) notes.push(note);
	parts.push(`count:${count}`);
	return { ok: true, query: parts.join(" "), notes, count };
}

const SKIP_NOTES: Record<string, string> = {
	"shard-match-limit": "shard match limit reached; results were truncated",
	"document-match-limit": "per-file match limit reached; results were truncated",
	"repo-match-limit": "per-repo match limit reached; results were truncated",
	"excluded-archive": "archived repositories are excluded by default; add `archived:yes` to include them",
	"excluded-fork": "forked repositories are excluded by default; add `fork:yes` to include them",
	"repository-fork": "forked repositories are excluded by default; add `fork:yes` to include them",
};

/**
 * Reasons that only mean "the search stopped", not "the index truncated".
 * Sourcegraph emits `shard-match-limit` on every query that fills the requested
 * `count:`, so reporting it as truncation flags each successful search — the
 * caller already asked for exactly that many matches.
 */
const COUNT_BOUND_REASONS = new Set(["shard-match-limit"]);

/**
 * Reasons that only matter when they could explain a miss. With matches in hand
 * the archived/forked hints repeat on every query and drown out the real notes;
 * on an empty result they are exactly what keeps the model from concluding that
 * the code does not exist.
 */
const EXCLUSION_REASONS = new Set(["excluded-archive", "excluded-fork", "repository-fork"]);

export interface WarningOptions {
	/** The `count:` the tool asked for — separates "stopped at count" from "really truncated". */
	count?: number;
}

export function formatWarnings(results: SgResults, notes: string[], options: WarningOptions = {}): string[] {
	const warnings = [...notes];
	const countSatisfied = options.count != null && (results.matchCount ?? 0) >= options.count;
	const hasMatches = results.matches.length > 0;
	// Reasons repeat across progress events; list each one once.
	for (const reason of results.skipped.keys()) {
		if (countSatisfied && COUNT_BOUND_REASONS.has(reason)) continue;
		if (hasMatches && EXCLUSION_REASONS.has(reason)) continue;
		warnings.push(SKIP_NOTES[reason] ?? `Sourcegraph skipped some results (${reason})`);
	}
	if (results.parseErrors > 0) {
		warnings.push(`${results.parseErrors} stream event(s) could not be parsed; results may be incomplete`);
	}
	return warnings;
}

export function formatMatch(item: SgMatch, index: number): string {
	const repo = String(item.repository ?? "unknown");
	const stars = item.repoStars ? ` ⭐${item.repoStars}` : "";
	switch (item.type) {
		case "content": {
			const lang = item.language ? ` (${item.language})` : "";
			const header = `${index}. **${repo}** — \`${item.path ?? ""}\`${lang}${stars}`;
			const lines = (item.lineMatches ?? []).map((match) => {
				// Sourcegraph reports 0-based line numbers (verified against GitHub
				// raw); +1 so they line up with editors and `sed -n`.
				const line = (match.lineNumber ?? 0) + 1;
				return `   L${line}: ${String(match.line ?? "").trim()}`;
			});
			return lines.length > 0 ? `${header}\n${lines.join("\n")}` : `${header}\n   (content match; no line info returned)`;
		}
		case "path":
			return `${index}. **${repo}** — \`${item.path ?? ""}\`${item.language ? ` (${item.language})` : ""}${stars}\n   (path match)`;
		case "symbol": {
			const header = `${index}. **${repo}** — \`${item.path ?? ""}\`${item.language ? ` (${item.language})` : ""}${stars}`;
			// Symbol lines are 1-based (unlike content lineMatches).
			const symbols = (item.symbols ?? []).map(
				(symbol) =>
					`   ${symbol.kind ?? "symbol"} ${symbol.name ?? "?"}${symbol.containerName ? ` (${symbol.containerName})` : ""} @ L${symbol.line}`,
			);
			return symbols.length > 0 ? `${header}\n${symbols.join("\n")}` : header;
		}
		case "commit": {
			const oid = String(item.oid ?? "").slice(0, 7);
			const author = item.authorName ? ` by ${item.authorName}` : "";
			const date = item.authorDate ? ` (${String(item.authorDate).slice(0, 10)})` : "";
			const message = String(item.message ?? "").split("\n")[0];
			return `${index}. **${repo}** — commit \`${oid}\`${author}${date}${stars}\n   ${message}`;
		}
		case "repo":
			return `${index}. **${repo}**${stars}${item.description ? ` — ${String(item.description).split("\n")[0]}` : ""}`;
		default:
			return `${index}. ${JSON.stringify(item).slice(0, 200)}`;
	}
}

export function renderResults(results: SgResults, notes: string[], options: WarningOptions = {}): string {
	const shown = results.matches.slice(0, MAX_SHOWN);
	// `count:` bounds matches, and one file match can carry several matched lines.
	const fileItems = results.matches.filter((m) => m.type === "content" || m.type === "path" || m.type === "symbol");
	const occurrences = results.matches.reduce(
		(sum, item) => sum + (item.type === "content" ? Math.max(1, item.lineMatches?.length ?? 0) : 1),
		0,
	);
	const files = new Set(fileItems.map((m) => `${m.repository ?? ""}|${m.path ?? ""}`)).size;
	const nonFileItems = results.matches.length - fileItems.length;
	const repos = new Set(results.matches.map((m) => m.repository ?? "")).size;
	const header = [
		`Found ${occurrences} match${occurrences === 1 ? "" : "es"}`,
		files > 0 ? `in ${files} file${files === 1 ? "" : "s"}` : "",
		nonFileItems > 0 ? `and ${nonFileItems} non-file match${nonFileItems === 1 ? "" : "es"}` : "",
		`across ${repos} repositor${repos === 1 ? "y" : "ies"}`,
		results.matches.length > shown.length ? `(showing the first ${shown.length} files)` : "",
	]
		.filter(Boolean)
		.join(" ");
	const sections = [header, ...shown.map((item, i) => formatMatch(item, i + 1))];
	if (typeof results.matchCount === "number" && results.matchCount > occurrences) {
		sections.push(`ℹ️ Sourcegraph reports ${results.matchCount} matches in total; returned ${occurrences}.`);
	}
	const warnings = formatWarnings(results, notes, options);
	if (warnings.length > 0) sections.push(["⚠️ Note:", ...warnings.map((w) => `- ${w}`)].join("\n"));
	return sections.join("\n\n");
}

function formatAlerts(alerts: SgAlert[]): string {
	const lines = alerts.map((alert) => {
		const title = alert.title ?? "Sourcegraph error";
		const detail = alert.description ? `: ${alert.description}` : "";
		const proposed = Array.isArray(alert.proposedQueries) && alert.proposedQueries.length > 0 ? ` (try: ${JSON.stringify(alert.proposedQueries)})` : "";
		return `${title}${detail}${proposed}`;
	});
	return `Sourcegraph rejected the query:\n${lines.join("\n")}`;
}

function httpError(status: number, detail: string, endpoint: string): string {
	const tail = detail ? `: ${detail}` : "";
	if (status === 401 || status === 403) return `Sourcegraph access denied (HTTP ${status})${tail}. ${endpoint} requires authentication; set SRC_ACCESS_TOKEN.`;
	if (status === 429) return `Sourcegraph rate limited (HTTP 429)${tail}. Retry later, or set SRC_ACCESS_TOKEN to raise the limit.`;
	if (status >= 500) return `Sourcegraph server error (HTTP ${status})${tail}. Retried ${MAX_RETRIES} times.`;
	return `Sourcegraph request rejected (HTTP ${status})${tail}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the body with a hard cap so a runaway response cannot exhaust memory. */
async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
	if (!res.body) {
		const text = await res.text();
		return { text: text.slice(0, MAX_RESPONSE_CHARS), truncated: text.length > MAX_RESPONSE_CHARS };
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			if (text.length > MAX_RESPONSE_CHARS) {
				await reader.cancel().catch(() => {});
				return { text: text.slice(0, MAX_RESPONSE_CHARS), truncated: true };
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: text + decoder.decode(), truncated: false };
}

type SearchOutcome =
	| { kind: "ok"; text: string; truncated: boolean }
	| { kind: "http"; status: number; detail: string }
	| { kind: "aborted" }
	| { kind: "error"; message: string; timedOut: boolean };

/** Fetch with a per-attempt timeout (covering the body read) and retries. */
async function fetchSearch(url: string, headers: Record<string, string>, outer?: AbortSignal): Promise<SearchOutcome> {
	let lastError = "unknown error";
	let lastTimedOut = false;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, REQUEST_TIMEOUT_MS);
		const forwardAbort = () => controller.abort();
		outer?.addEventListener("abort", forwardAbort, { once: true });
		try {
			const res = await fetch(url, { headers, signal: controller.signal });
			if (!res.ok) {
				const detail = await res
					.text()
					.then((body) => body.slice(0, 300).replace(/\s+/g, " ").trim())
					.catch(() => "");
				if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
					lastError = `HTTP ${res.status}`;
					lastTimedOut = false;
					continue;
				}
				return { kind: "http", status: res.status, detail };
			}
			return { kind: "ok", ...(await readCapped(res)) };
		} catch (err) {
			if (outer?.aborted) return { kind: "aborted" };
			lastError = timedOut ? `request timed out (${REQUEST_TIMEOUT_MS / 1000}s)` : ((err as Error)?.message ?? String(err));
			lastTimedOut = timedOut;
		} finally {
			clearTimeout(timer);
			outer?.removeEventListener("abort", forwardAbort);
		}
	}
	return { kind: "error", message: lastError, timedOut: lastTimedOut };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "code_search",
		label: "Sourcegraph Code Search",
		description:
			"Search code across millions of public open-source repositories (Sourcegraph index). Returns repository, file path and matching lines; also renders path/commit/repo/symbol matches when the query asks for them (type:path, type:commit, type:repo, type:symbol).",
		promptSnippet: "Search public open-source code with Sourcegraph",
		promptGuidelines: [
			"Use code_search to find real-world usage examples, idioms and implementations across public repositories.",
			"Queries use Sourcegraph syntax: `patternType:regexp` for regex, plus `lang:`, `repo:`, `file:` and `type:` filters.",
			"Do not add `count:` to the query — the tool manages it (default 5, max 20).",
			"code_search needs no API key; a self-hosted instance can be targeted with SRC_ENDPOINT / SRC_ACCESS_TOKEN.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Sourcegraph query, e.g. 'func NewRouter(' or 'patternType:regexp http\\.HandleFunc\\('" }),
			lang: Type.Optional(Type.String({ description: "Language filter value only, e.g. 'Go', 'TypeScript'" })),
			repo: Type.Optional(Type.String({ description: "Repository filter value only, e.g. 'gin-gonic/gin'" })),
			count: Type.Optional(Type.Number({ description: `Number of matches (default 5, max ${MAX_COUNT})` })),
		}),
		async execute(_toolCallId, params, signal) {
			const endpoint = (process.env.SRC_ENDPOINT?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
			const token = process.env.SRC_ACCESS_TOKEN?.trim();

			const built = buildQuery({ query: params.query, lang: params.lang, repo: params.repo, count: params.count });
			if (!built.ok) return fail(built.error);

			const url = `${endpoint}/.api/search/stream?q=${encodeURIComponent(built.query)}&v=V3`;
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			if (token) headers.Authorization = `token ${token}`;

			const outcome = await fetchSearch(url, headers, signal);
			if (outcome.kind === "aborted") return fail("code_search was cancelled.");
			if (outcome.kind === "http") return fail(httpError(outcome.status, outcome.detail, endpoint));
			if (outcome.kind === "error") {
				// A DNS/TLS/proxy failure is not something a token fixes, so only mention
				// rate limiting when the request actually timed out on the public index.
				const hint =
					!token && outcome.timedOut
						? " The public index rate-limits anonymous traffic; retry later or set SRC_ACCESS_TOKEN."
						: "";
				return fail(`Sourcegraph request failed: ${outcome.message}${hint}`);
			}

			const results = collectResults(outcome.text);
			if (outcome.truncated) {
				built.notes.push(`response exceeded ${MAX_RESPONSE_CHARS / 1_000_000}MB and was truncated; results are incomplete`);
			}
			if (results.matches.length === 0) {
				// Surface the real reason (bad query, no such repo, ...) instead of
				// pretending the code does not exist.
				if (results.alerts.length > 0) return fail(formatAlerts(results.alerts));
				const warnings = formatWarnings(results, built.notes, { count: built.count });
				return ok(warnings.length > 0 ? `No results found.\n\n⚠️ Note:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "No results found.");
			}
			return ok(renderResults(results, built.notes, { count: built.count }));
		},
	});
}
