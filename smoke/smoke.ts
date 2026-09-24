// smoke.ts — manual end-to-end run against live APIs (not part of npm test)
// Usage: node --experimental-strip-types smoke/smoke.ts
import registerContext7 from "../extensions/context7.ts";
import registerSourcegraph from "../extensions/sourcegraph.ts";
import registerExa from "../extensions/exa-search.ts";
import { judgeToolResult } from "../extensions/jev-judge.ts";

type Tool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (u: any) => void,
	) => Promise<any>;
};

function capture(register: (pi: any) => void): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	register({ registerTool: (t: any) => tools.set(t.name, t) });
	return tools;
}

const text = (r: any) =>
	(r?.content ?? [])
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n");

async function judge(toolName: string, input: any, result: any) {
	const apiKey = process.env.TYPESAFE_API_KEY ?? null;
	const out = await judgeToolResult(toolName, input, result?.content, {
		isError: result?.isError,
		apiKey,
	});
	if (!out) {
		console.log(`   [jev-judge] no judgment (${result?.isError ? "error result" : "skipped or inert"})`);
		return;
	}
	if ("failure" in out) {
		const status = out.status ? ` (HTTP ${out.status})` : "";
		const remedy = out.kind === "actionable" && out.remedy ? ` — ${out.remedy}` : "";
		console.log(`   [jev-judge] judgment failed: ${out.reason}${status}${remedy}`);
		return;
	}
	console.log(`   [jev-judge] ${out.meta.latencyMs}ms via ${out.meta.model}`);
	console.log(
		out.appendedText
			.split("\n")
			.map((l) => "   | " + l)
			.join("\n"),
	);
}

const ctx7 = capture(registerContext7);
const sg = capture(registerSourcegraph);
const exa = capture(registerExa);

console.log("=== 1. ctx7_library → ctx7_docs (chained, live Context7) ===");
const lib = await ctx7.get("ctx7_library")!.execute("t1", {
	libraryName: "Next.js",
	query: "How to set up caching",
});
console.log(text(lib).slice(0, 400));
await judge("ctx7_library", { libraryName: "Next.js", query: "How to set up caching" }, lib);

const libId = text(lib).match(/Context7-compatible library ID: (\S+)/)?.[1];
if (libId) {
	const docs = await ctx7.get("ctx7_docs")!.execute("t2", {
		libraryId: libId,
		query: "App Router caching configuration",
	});
	console.log(`\n--- ctx7_docs(${libId}) → ${text(docs).length} chars ---`);
	console.log(text(docs).slice(0, 300));
	await judge("ctx7_docs", { libraryId: libId, query: "App Router caching configuration" }, docs);
}

console.log("\n=== 2. code_search (live Sourcegraph) ===");
const code = await sg.get("code_search")!.execute("t3", {
	query: "patternType:regexp unstable_cache\\(",
	lang: "TypeScript",
});
console.log(text(code).slice(0, 400));
await judge("code_search", { query: "unstable_cache(", lang: "TypeScript" }, code);

console.log("\n=== 3. exa_search (live Exa) ===");
const search = await exa.get("exa_search")!.execute("t4", {
	query: "Next.js 15 caching default changes",
	numResults: 3,
});
console.log(text(search).slice(0, 400));
await judge("exa_search", { query: "Next.js 15 caching default changes" }, search);

console.log("\n=== 4. degradation: judge inert without key ===");
const inert = await judgeToolResult("exa_search", { query: "x" }, search?.content, {
	apiKey: null,
});
console.log(`   apiKey=null → ${inert === undefined ? "undefined (passthrough) ✓" : "UNEXPECTED: " + JSON.stringify(inert)}`);
