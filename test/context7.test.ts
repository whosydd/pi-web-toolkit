import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerContext7, {
	errorMessage,
	formatSearchResult,
	formatSearchResults,
} from "../extensions/context7.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const result = (over: Record<string, unknown> = {}) => ({
	id: "/vercel/next.js",
	title: "Next.js",
	description: "The React framework for the web.",
	totalSnippets: 1240,
	trustScore: 9,
	benchmarkScore: 88,
	versions: ["v14.2.0", "v15.0.0"],
	...over,
});

type Tool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal
	) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};

function loadTools(): Record<string, Tool> {
	const tools: Tool[] = [];
	registerContext7({ registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI);
	return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.CONTEXT7_API_KEY;
});

/** Stub fetch with scripted responses; records requested URLs and headers. */
function stubFetch(script: ((url: string, init?: RequestInit) => Response | Promise<Response>)[]) {
	const urls: string[] = [];
	const auths: (string | undefined)[] = [];
	let call = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		urls.push(String(input));
		auths.push((init?.headers as Record<string, string> | undefined)?.Authorization);
		const handler = script[Math.min(call++, script.length - 1)];
		return handler(String(input), init);
	}) as typeof fetch;
	return { urls, auths };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

describe("context7 formatting", () => {
	it("renders every field the official extension renders", () => {
		const text = formatSearchResult(result());
		assert.match(text, /- Title: Next\.js/);
		assert.match(text, /- Context7-compatible library ID: \/vercel\/next\.js/);
		assert.match(text, /- Code Snippets: 1240/);
		assert.match(text, /- Source Reputation: High/);
		assert.match(text, /- Benchmark Score: 88/);
		assert.match(text, /- Versions: v14\.2\.0, v15\.0\.0/);
	});

	it("maps reputation thresholds and hides unknown/empty fields", () => {
		assert.match(formatSearchResult(result({ trustScore: 4 })), /Source Reputation: Medium/);
		assert.match(formatSearchResult(result({ trustScore: 1 })), /Source Reputation: Low/);
		const sparse = formatSearchResult(result({ trustScore: undefined, benchmarkScore: 0, versions: [] }));
		assert.match(sparse, /Source Reputation: Unknown/);
		assert.doesNotMatch(sparse, /Benchmark Score|Versions/);
	});

	it("says so when nothing matched", () => {
		assert.match(formatSearchResults({ results: [] }), /No documentation libraries found/);
	});

	it("notes teamspace filtering and separates multiple results", () => {
		const text = formatSearchResults({
			searchFilterApplied: true,
			results: [result(), result({ id: "/facebook/react", title: "React" })],
		});
		assert.match(text, /teamspace's library filters/);
		assert.match(text, /\n----------\n/);
	});
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

describe("context7 errorMessage", () => {
	it("prefers the API-provided message", async () => {
		assert.equal(await errorMessage(json({ message: "quota exhausted" }, 429)), "quota exhausted");
	});

	it("falls back to a keyed 429 hint", async () => {
		process.env.CONTEXT7_API_KEY = "ctx7sk_test";
		assert.match(await errorMessage(json({}, 429)), /context7\.com\/plans/);
	});

	it("falls back to a keyless 429 hint", async () => {
		assert.match(await errorMessage(json({}, 429)), /context7\.com\/dashboard/);
	});

	it("explains 401 and 404", async () => {
		assert.match(await errorMessage(json({}, 401)), /ctx7sk/);
		assert.match(await errorMessage(json({}, 404)), /does not exist/);
	});

	it("tolerates a non-JSON body", async () => {
		assert.match(await errorMessage(new Response("<html>", { status: 502 })), /status 502/);
	});
});

// ---------------------------------------------------------------------------
// execute(): end-to-end with a stubbed transport
// ---------------------------------------------------------------------------

describe("ctx7_library execute", () => {
	it("registers both tools", () => {
		assert.deepEqual(Object.keys(loadTools()).sort(), ["ctx7_docs", "ctx7_library"]);
	});

	it("searches with both query parameters and renders the results", async () => {
		const { urls } = stubFetch([() => json({ results: [result()] })]);
		const tool = loadTools().ctx7_library;
		const out = await tool.execute("id", { libraryName: "Next.js", query: "caching" });
		assert.equal(out.isError, undefined);
		assert.match(out.content[0].text, /Available Libraries:/);
		assert.match(out.content[0].text, /\/vercel\/next\.js/);
		assert.match(urls[0], /\/v2\/libs\/search\?/);
		assert.match(urls[0], /libraryName=Next\.js/);
		assert.match(urls[0], /query=caching/);
	});

	it("sends a bearer token when CONTEXT7_API_KEY is set", async () => {
		process.env.CONTEXT7_API_KEY = "ctx7sk_test";
		const { auths } = stubFetch([() => json({ results: [result()] })]);
		await loadTools().ctx7_library.execute("id", { libraryName: "Next.js", query: "caching" });
		assert.equal(auths[0], "Bearer ctx7sk_test");
	});

	it("surfaces an API error as a tool error", async () => {
		stubFetch([() => json({ message: "rate limited" }, 429)]);
		const out = await loadTools().ctx7_library.execute("id", { libraryName: "Next.js", query: "caching" });
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /rate limited/);
	});

	it("treats an empty result set as an error", async () => {
		stubFetch([() => json({ results: [] })]);
		const out = await loadTools().ctx7_library.execute("id", { libraryName: "nope", query: "nope" });
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /No libraries found/);
	});

	it("reports a transport failure without throwing", async () => {
		stubFetch([
			() => {
				throw new TypeError("fetch failed");
			},
		]);
		const out = await loadTools().ctx7_library.execute("id", { libraryName: "Next.js", query: "caching" });
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /fetch failed/);
	});
});

describe("ctx7_docs execute", () => {
	it("fetches context for a library ID and returns the body verbatim", async () => {
		const { urls } = stubFetch([() => new Response("### Example\n\n```ts\nfoo()\n```")]);
		const out = await loadTools().ctx7_docs.execute("id", {
			libraryId: "/vercel/next.js",
			query: "caching",
		});
		assert.equal(out.isError, undefined);
		assert.match(out.content[0].text, /foo\(\)/);
		assert.match(urls[0], /\/v2\/context\?/);
		assert.match(urls[0], /libraryId=%2Fvercel%2Fnext\.js/);
	});

	it("treats an empty body as an error with a recovery hint", async () => {
		stubFetch([() => new Response("")]);
		const out = await loadTools().ctx7_docs.execute("id", { libraryId: "/bad/id", query: "caching" });
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /Documentation not found/);
		assert.match(out.content[0].text, /ctx7_library/);
	});

	it("surfaces a 404 as a tool error", async () => {
		stubFetch([() => json({}, 404)]);
		const out = await loadTools().ctx7_docs.execute("id", { libraryId: "/bad/id", query: "caching" });
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /does not exist/);
	});

	it("stops when the caller aborts", async () => {
		const controller = new AbortController();
		stubFetch([
			() => {
				controller.abort();
				throw new DOMException("aborted", "AbortError");
			},
		]);
		const out = await loadTools().ctx7_docs.execute("id", { libraryId: "/vercel/next.js", query: "caching" }, controller.signal);
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /cancelled/);
	});
});
