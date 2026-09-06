// Context7: official library docs (via npx ctx7, no install required)
//
// Environment variables:
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
	const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
	const ctx7Env = { ...process.env, ...(CONTEXT7_API_KEY ? { CONTEXT7_API_KEY } : {}) };

	// Search for a library and get its Context7 ID
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

	// Fetch documentation for a specific library
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

	pi.on("session_start", (_event, ctx) => {
		if (!CONTEXT7_API_KEY) {
			ctx.ui.notify("CONTEXT7_API_KEY not set, using free tier rate limits", "info");
		}
	});
}
