// pi-web-toolkit — Context7 library docs + Exa web search + Sourcegraph code search
//
// Tools registered:
//   ctx7_library / ctx7_docs — official library documentation (Context7, via npx ctx7)
//   exa_search / exa_fetch   — web search & page contents (requires EXA_API_KEY)
//   code_search              — public GitHub code search (Sourcegraph, free)
//
// Environment variables:
//   EXA_API_KEY      optional — without it the exa_* tools are not registered
//   CONTEXT7_API_KEY optional — without it Context7 free-tier rate limits apply

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const ok = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
});

const fail = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	isError: true,
});

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// Context7: official library docs (npx ctx7, no install required)
	// ------------------------------------------------------------------
	const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
	const ctx7Env = { ...process.env, ...(CONTEXT7_API_KEY ? { CONTEXT7_API_KEY } : {}) };

	pi.registerTool({
		name: "ctx7_library",
		label: "Context7 Library Search",
		description:
			"Search for a library/framework in Context7 to find its documentation ID. Use this before ctx7_docs to get the correct library ID.",
		promptSnippet: "Search library documentation index in Context7",
		promptGuidelines: [
			"Use ctx7_library when you need to look up specific library/framework API documentation, method signatures, or official code examples.",
			"Use ctx7_library before ctx7_docs to resolve the correct library ID (format: /org/project).",
			"Prefer ctx7 over exa_search for official library API references — ctx7 returns structured code snippets from official docs.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Library name and what you're trying to do, e.g. 'gin middleware' or 'react useEffect cleanup'",
			}),
		}),
		async execute(toolCallId, params, signal) {
			try {
				const cmd = `npx ctx7 library ${JSON.stringify(params.query)} --json`;
				const { stdout } = await execAsync(cmd, { timeout: 15000, signal, env: ctx7Env });

				const results = JSON.parse(stdout);
				if (!Array.isArray(results) || results.length === 0) {
					return ok("No libraries found for this query.");
				}

				const formatted = results
					.slice(0, 5)
					.map((r: any, i: number) => {
						const versions = r.versions?.length > 0 ? `\n   Versions: ${r.versions.join(", ")}` : "";
						return `${i + 1}. **${r.title || r.id}**
   ID: ${r.id}
   Snippets: ${r.snippets ?? "N/A"} | Score: ${r.benchmarkScore ?? "N/A"}${versions}`;
					})
					.join("\n\n");

				return ok(formatted);
			} catch (err: any) {
				return fail(`ctx7 library search failed: ${err.message}`);
			}
		},
	});

	pi.registerTool({
		name: "ctx7_docs",
		label: "Context7 Docs",
		description:
			"Fetch up-to-date documentation for a specific library using its Context7 ID. Returns code snippets and explanations from official docs.",
		promptSnippet: "Fetch library documentation from Context7",
		promptGuidelines: [
			"Use ctx7_docs with a library ID (from ctx7_library) to get official code examples and API references.",
			"Prefer ctx7_docs over exa_search when you need accurate, version-specific library API documentation.",
		],
		parameters: Type.Object({
			libraryId: Type.String({ description: "Library ID from ctx7_library (format: /org/project, e.g. /gin-gonic/gin)" }),
			query: Type.String({ description: "What you want to know, e.g. 'How to implement rate limiting middleware'" }),
		}),
		async execute(toolCallId, params, signal) {
			try {
				const cmd = `npx ctx7 docs ${JSON.stringify(params.libraryId)} ${JSON.stringify(params.query)}`;
				const { stdout } = await execAsync(cmd, { timeout: 15000, signal, env: ctx7Env });

				if (!stdout.trim()) {
					return ok("No documentation found for this query.");
				}

				return ok(stdout.trim());
			} catch (err: any) {
				return fail(`ctx7 docs failed: ${err.message}`);
			}
		},
	});

	// ------------------------------------------------------------------
	// Exa: web search + page contents (requires EXA_API_KEY)
	// ------------------------------------------------------------------
	const EXA_API_KEY = process.env.EXA_API_KEY;

	if (EXA_API_KEY) {
		pi.registerTool({
			name: "exa_search",
			label: "Exa Search",
			description:
				"Search the web using Exa AI search engine. Supports neural/keyword search with optional filters for category, date range, and domains.",
			promptSnippet: "Search the web for current information using Exa",
			promptGuidelines: [
				"Use exa_search for web searches — it provides higher quality results than basic web search.",
				"Use exa_search with category/date/domain filters when the user needs filtered or recent results.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				numResults: Type.Optional(Type.Number({ description: "Number of results (default 5)" })),
				type: Type.Optional(
					Type.String({ description: "Search type: 'neural', 'keyword', or 'auto' (default auto)" })
				),
				category: Type.Optional(
					Type.String({
						description:
							"Category filter: company, research paper, news, github, linkedin, tweet, movie, song, personal site, pdf",
					})
				),
				startPublishedDate: Type.Optional(
					Type.String({ description: "Filter results published after this date (ISO format, e.g. 2024-01-01)" })
				),
				endPublishedDate: Type.Optional(
					Type.String({ description: "Filter results published before this date (ISO format)" })
				),
				includeDomains: Type.Optional(
					Type.Array(Type.String(), { description: "Only include results from these domains" })
				),
				excludeDomains: Type.Optional(
					Type.Array(Type.String(), { description: "Exclude results from these domains" })
				),
			}),
			async execute(toolCallId, params, signal) {
				const body: Record<string, any> = {
					query: params.query,
					numResults: params.numResults ?? 5,
					type: params.type ?? "auto",
					contents: { text: true },
				};
				if (params.category) body.category = params.category;
				if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
				if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;
				if (params.includeDomains) body.includeDomains = params.includeDomains;
				if (params.excludeDomains) body.excludeDomains = params.excludeDomains;

				try {
					const res = await fetch("https://api.exa.ai/search", {
						method: "POST",
						headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
						body: JSON.stringify(body),
						signal,
					});

					if (!res.ok) {
						return fail(`Exa search failed (${res.status}): ${await res.text()}`);
					}

					const data = await res.json();
					const results =
						data.results
							?.map(
								(r: any, i: number) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.text?.slice(0, 500) ?? ""}`
							)
							.join("\n\n") || "No results found";

					return ok(results);
				} catch (err: any) {
					return fail(`Exa search failed: ${err.message}`);
				}
			},
		});

		pi.registerTool({
			name: "exa_fetch",
			label: "Exa Fetch",
			description: "Fetch and read the full text content of specific webpages by URL.",
			promptSnippet: "Fetch webpage content by URL using Exa",
			parameters: Type.Object({
				urls: Type.Array(Type.String(), { description: "URLs to fetch" }),
			}),
			async execute(toolCallId, params, signal) {
				try {
					const res = await fetch("https://api.exa.ai/contents", {
						method: "POST",
						headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
						body: JSON.stringify({ urls: params.urls, text: true }),
						signal,
					});

					if (!res.ok) {
						return fail(`Exa fetch failed (${res.status}): ${await res.text()}`);
					}

					const data = await res.json();
					const results =
						data.results
							?.map((r: any) => `**${r.title}**\n${r.url}\n\n${r.text}`)
							.join("\n\n---\n\n") || "No content fetched";

					return ok(results);
				} catch (err: any) {
					return fail(`Exa fetch failed: ${err.message}`);
				}
			},
		});
	}

	// ------------------------------------------------------------------
	// Sourcegraph: public GitHub code search (free, no API key)
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "code_search",
		label: "Sourcegraph Code Search",
		description:
			"Search code across millions of public GitHub repositories using Sourcegraph. Supports language, repo, and path filters. Free, no API key required.",
		promptSnippet: "Search GitHub code examples using Sourcegraph",
		promptGuidelines: [
			"Use code_search when you want to find real-world code examples, usage patterns, or implementations across GitHub.",
			"Use code_search with lang/repo/path filters to narrow results.",
			"code_search is free and requires no API key.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query, e.g. 'rate limiting middleware' or 'func NewRouter'" }),
			lang: Type.Optional(Type.String({ description: "Programming language filter, e.g. 'Go', 'Python', 'JavaScript'" })),
			repo: Type.Optional(Type.String({ description: "Repository filter, e.g. 'gin-gonic/gin'" })),
			count: Type.Optional(Type.Number({ description: "Number of results (default 5, max 20)" })),
		}),
		async execute(toolCallId, params, signal) {
			let q = params.query;
			if (params.lang) q += ` lang:${params.lang}`;
			if (params.repo) q += ` repo:${params.repo}`;
			q += ` count:${params.count ?? 5}`;

			const url = `https://sourcegraph.com/.api/search/stream?q=${encodeURIComponent(q)}`;

			try {
				const res = await fetch(url, { signal });

				if (!res.ok) {
					return fail(`Sourcegraph search failed (${res.status})`);
				}

				const text = await res.text();
				const matches: any[] = [];

				// Parse SSE format
				for (const line of text.split("\n")) {
					if (line.startsWith("data: ")) {
						try {
							const data = JSON.parse(line.slice(6));
							if (Array.isArray(data)) {
								for (const item of data) {
									if (item.type === "content" && item.lineMatches) {
										matches.push(item);
									}
								}
							}
						} catch {}
					}
				}

				if (matches.length === 0) {
					return ok("No results found.");
				}

				const results = matches
					.slice(0, 10)
					.map((m: any, i: number) => {
						const repo = m.repository ?? "";
						const path = m.path ?? "";
						const lang = m.language ?? "";
						const stars = m.repoStars ?? "";
						const lines =
							m.lineMatches?.map((l: any) => `  L${l.lineNumber}: ${l.line?.trim()}`).join("\n") ?? "";

						return `${i + 1}. **${repo}** — \`${path}\`${lang ? ` (${lang})` : ""}${stars ? ` ⭐${stars}` : ""}
${lines}`;
					})
					.join("\n\n");

				return ok(`Found ${matches.length} results:\n\n${results}`);
			} catch (err: any) {
				return fail(`Sourcegraph search failed: ${err.message}`);
			}
		},
	});

	// ------------------------------------------------------------------
	// Startup notice: summarize which tools are active
	// ------------------------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		const missing: string[] = [];
		if (!EXA_API_KEY) missing.push("EXA_API_KEY (exa_search/exa_fetch disabled)");
		if (!CONTEXT7_API_KEY) missing.push("CONTEXT7_API_KEY (Context7 uses free-tier rate limits)");
		if (missing.length > 0) {
			ctx.ui.notify(`pi-web-toolkit: ${missing.join("; ")}`, EXA_API_KEY ? "info" : "warning");
		}
	});
}
