// Context7: up-to-date library/framework documentation via the official HTTP API
// (https://context7.com/api/v2). Wire format and error messages follow the
// official @upstash/context7-pi extension so results stay in lockstep with MCP.
//
// Environment variables:
//   CONTEXT7_API_KEY optional — without it Context7 applies IP-based free-tier
//   rate limits. Generate a key at https://context7.com/dashboard

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE_URL = "https://context7.com/api";

const ok = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
});

const fail = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	isError: true,
});

// --- Official wire types ---

export interface Ctx7SearchResult {
	id: string;
	title: string;
	description: string;
	totalSnippets?: number;
	trustScore?: number;
	benchmarkScore?: number;
	versions?: string[];
	source?: string;
}

export interface Ctx7SearchResponse {
	error?: string;
	results: Ctx7SearchResult[];
	searchFilterApplied?: boolean;
}

/** Success carries a value; failure carries a message ready to show the caller. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

// --- Formatting (identical to the official extension) ---

function reputationLabel(score?: number): "High" | "Medium" | "Low" | "Unknown" {
	if (score === undefined || score < 0) return "Unknown";
	if (score >= 7) return "High";
	if (score >= 4) return "Medium";
	return "Low";
}

export function formatSearchResult(result: Ctx7SearchResult): string {
	const lines = [
		`- Title: ${result.title}`,
		`- Context7-compatible library ID: ${result.id}`,
		`- Description: ${result.description}`,
	];
	if (result.totalSnippets !== undefined && result.totalSnippets !== -1) {
		lines.push(`- Code Snippets: ${result.totalSnippets}`);
	}
	lines.push(`- Source Reputation: ${reputationLabel(result.trustScore)}`);
	if (result.benchmarkScore !== undefined && result.benchmarkScore > 0) {
		lines.push(`- Benchmark Score: ${result.benchmarkScore}`);
	}
	if (result.versions?.length) {
		lines.push(`- Versions: ${result.versions.join(", ")}`);
	}
	if (result.source) {
		lines.push(`- Source: ${result.source}`);
	}
	return lines.join("\n");
}

export function formatSearchResults(response: Ctx7SearchResponse): string {
	if (!response.results || response.results.length === 0) {
		return "No documentation libraries found matching your query.";
	}
	const parts: string[] = [];
	if (response.searchFilterApplied) {
		parts.push(
			"**Note:** Your results only include libraries matching your teamspace's library filters. To adjust quality thresholds or blocked libraries, update your filters at https://context7.com/dashboard?tab=policies"
		);
	}
	parts.push(response.results.map(formatSearchResult).join("\n----------\n"));
	return parts.join("\n\n");
}

// --- HTTP client ---

function authHeaders(): Record<string, string> {
	const apiKey = process.env.CONTEXT7_API_KEY;
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export async function errorMessage(response: Response): Promise<string> {
	try {
		const json = (await response.json()) as { message?: string };
		if (json.message) return json.message;
	} catch {
		// Not JSON; fall through to a status-based message.
	}

	if (response.status === 429) {
		return process.env.CONTEXT7_API_KEY
			? "Rate limited or quota exceeded. Upgrade your plan at https://context7.com/plans for higher limits."
			: "Rate limited or quota exceeded. Create a free API key at https://context7.com/dashboard for higher limits.";
	}
	if (response.status === 404) {
		return "The library you are trying to access does not exist. Please try with a different library ID.";
	}
	if (response.status === 401) {
		return "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.";
	}
	return `Request failed with status ${response.status}. Please try again later.`;
}

/** Wrap a transport failure (DNS/TLS/abort) into the same shape as an API error. */
function transportError(err: unknown, signal?: AbortSignal): ApiResult<never> {
	if (signal?.aborted) return { ok: false, error: "Context7 request cancelled." };
	const message = err instanceof Error ? err.message : String(err);
	return { ok: false, error: `Context7 request failed: ${message}` };
}

export async function searchLibraries(
	query: string,
	libraryName: string,
	signal?: AbortSignal
): Promise<ApiResult<Ctx7SearchResponse>> {
	const url = new URL(`${BASE_URL}/v2/libs/search`);
	url.searchParams.set("query", query);
	url.searchParams.set("libraryName", libraryName);

	let response: Response;
	try {
		response = await fetch(url, { headers: authHeaders(), signal });
	} catch (err) {
		return transportError(err, signal);
	}
	if (!response.ok) return { ok: false, error: await errorMessage(response) };
	try {
		return { ok: true, value: (await response.json()) as Ctx7SearchResponse };
	} catch (err) {
		return transportError(err, signal);
	}
}

export async function fetchLibraryContext(
	query: string,
	libraryId: string,
	signal?: AbortSignal
): Promise<ApiResult<string>> {
	const url = new URL(`${BASE_URL}/v2/context`);
	url.searchParams.set("query", query);
	url.searchParams.set("libraryId", libraryId);

	let response: Response;
	try {
		response = await fetch(url, { headers: authHeaders(), signal });
	} catch (err) {
		return transportError(err, signal);
	}
	if (!response.ok) return { ok: false, error: await errorMessage(response) };
	try {
		return { ok: true, value: await response.text() };
	} catch (err) {
		return transportError(err, signal);
	}
}

// --- Tools ---

const LIBRARY_ID_HINT = "format '/org/project' or '/org/project/version'";

const QUERY_DESCRIPTION =
	"What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query.";

export default function (pi: ExtensionAPI) {
	// Resolve a package/product name to a Context7-compatible library ID.
	pi.registerTool({
		name: "ctx7_library",
		label: "Context7 Library Search",
		description: `Resolves a package/product name to a Context7-compatible library ID and returns matching libraries.

You MUST call this tool before 'ctx7_docs' to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in ${LIBRARY_ID_HINT} in their query.

For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case.

Response format: return the selected library ID in a clearly marked section and a brief explanation for why it was chosen; if no good matches exist, say so and suggest query refinements.

IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.`,
		promptSnippet: "Resolve a library name to a Context7 documentation ID",
		promptGuidelines: [
			"Use ctx7_library before ctx7_docs to resolve a library name to a Context7 ID (format: /org/project).",
			"Skip ctx7_library when the user already gave a Context7 ID in /org/project or /org/project/version form.",
			"Prefer Context7 (ctx7_library + ctx7_docs) over exa_search for official, version-specific library API documentation.",
		],
		parameters: Type.Object({
			libraryName: Type.String({
				description:
					"Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'.",
			}),
			query: Type.String({ description: QUERY_DESCRIPTION }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await searchLibraries(params.query, params.libraryName, signal);
			if (!result.ok) return fail(result.error);
			const { results, error } = result.value;
			if (!results || results.length === 0) {
				return fail(error ?? "No libraries found matching the provided name.");
			}
			return ok(`Available Libraries:\n\n${formatSearchResults(result.value)}`);
		},
	});

	// Fetch documentation and code examples for a resolved library ID.
	pi.registerTool({
		name: "ctx7_docs",
		label: "Context7 Docs",
		description: `Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework.

You must call 'ctx7_library' first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in ${LIBRARY_ID_HINT} in their query.

Do not call this tool more than 3 times per question.`,
		promptSnippet: "Fetch library documentation from Context7",
		promptGuidelines: [
			"Use ctx7_docs with a Context7 library ID to get official code examples and API references.",
			"Keep each ctx7_docs query scoped to a single concept; call it once per concept instead of combining unrelated topics.",
			"Prefer ctx7_docs over exa_search when you need accurate, version-specific library API documentation.",
		],
		parameters: Type.Object({
			libraryId: Type.String({
				description: `Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'ctx7_library' or directly from the user query in ${LIBRARY_ID_HINT}.`,
			}),
			query: Type.String({ description: QUERY_DESCRIPTION }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await fetchLibraryContext(params.query, params.libraryId, signal);
			if (!result.ok) return fail(result.error);
			if (!result.value) {
				return fail(
					"Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid ID, call 'ctx7_library' with the package name you wish to retrieve documentation for."
				);
			}
			return ok(result.value);
		},
	});
}
