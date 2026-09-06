// Sourcegraph: public GitHub code search (free, no API key)

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
}
