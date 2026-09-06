// Exa: web search + page contents
//
// Environment variables:
//   EXA_API_KEY required — without it the exa_* tools are not registered

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
	const EXA_API_KEY = process.env.EXA_API_KEY;

	if (!EXA_API_KEY) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("EXA_API_KEY not set, exa tools disabled", "warning");
		});
		return;
	}

	// Web search (basic + advanced merged)
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
						?.map((r: any, i: number) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.text?.slice(0, 500) ?? ""}`)
						.join("\n\n") || "No results found";

				return ok(results);
			} catch (err: any) {
				return fail(`Exa search failed: ${err.message}`);
			}
		},
	});

	// Fetch webpage contents by URL
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
