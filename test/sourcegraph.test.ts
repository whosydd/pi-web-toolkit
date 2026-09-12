import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSourcegraph, {
	buildQuery,
	checkFilterValue,
	collectResults,
	formatMatch,
	normalizeCount,
	parseSse,
	renderResults,
	stripCount,
} from "../extensions/sourcegraph.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const contentFrame = (lineNumber: number, line: string, path = "gin.go") =>
	`event: matches\ndata: [{"type":"content","repository":"github.com/gin-gonic/gin","path":${JSON.stringify(path)},"language":"Go","repoStars":89201,"commit":"dcaa429","lineMatches":[{"line":${JSON.stringify(line)},"lineNumber":${lineNumber},"offsetAndLengths":[[3,7]]}]}]\n\n`;

const bodyOf = (...frames: string[]) => [...frames, "event: done\ndata: {}\n\n"].join("");

const alertBody = 'event: alert\ndata: {"title":"Unable To Process Query","description":"Error parsing regexp: missing closing ]: `[`","proposedQueries":null}\n\nevent: done\ndata: {}\n\n';

const progressBody = (extra: object = {}) =>
	`event: progress\ndata: ${JSON.stringify({ done: true, matchCount: 2, repositoriesCount: 1, skipped: [{ reason: "shard-match-limit" }, { reason: "excluded-archive" }], ...extra })}\n\n`;

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: { text: string }[]; isError?: boolean }> };

function loadTool(): Tool {
	const tools: Tool[] = [];
	registerSourcegraph({ registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI);
	assert.equal(tools.length, 1);
	return tools[0];
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.SRC_ENDPOINT;
	delete process.env.SRC_ACCESS_TOKEN;
});

/** Stub fetch with a queue of scripted responses; records requested URLs. */
function stubFetch(script: ((url: string, init?: RequestInit) => Response | Promise<Response>)[]) {
	const urls: string[] = [];
	let call = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		urls.push(url);
		const handler = script[Math.min(call++, script.length - 1)];
		return handler(url, init);
	}) as typeof fetch;
	return urls;
}

const sseResponse = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/event-stream" } });

// ---------------------------------------------------------------------------
// SSE + result collection
// ---------------------------------------------------------------------------

describe("parseSse", () => {
	it("parses event/data pairs", () => {
		const frames = parseSse(bodyOf(contentFrame(0, "x")));
		assert.deepEqual(frames.map((frame) => frame.event), ["matches", "done"]);
		assert.equal(JSON.parse(frames[0].data)[0].path, "gin.go");
	});

	it("joins multi-line data payloads into one frame", () => {
		// SSE allows one payload to span several `data:` lines; the old parser
		// JSON.parsed each line on its own and silently dropped the whole event.
		const frames = parseSse('event: matches\ndata: [\ndata:   {"type":"content"}\ndata: ]\n\n');
		assert.equal(frames.length, 1);
		assert.equal(frames[0].event, "matches");
		assert.equal(JSON.parse(frames[0].data)[0].type, "content");
	});

	it("tolerates CRLF and blocks without data", () => {
		const frames = parseSse("event: progress\r\ndata: {\"done\":false}\r\n\r\n: keep-alive\r\n\r\n");
		assert.deepEqual(frames, [{ event: "progress", data: '{"done":false}' }]);
	});
});

describe("collectResults", () => {
	it("collects matches from a multi-line data frame", () => {
		const results = collectResults(
			'event: matches\ndata: [\ndata: {"type":"content","repository":"r/x","path":"a.ts","lineMatches":[{"line":"hi","lineNumber":1}]}\ndata: ]\n\nevent: done\ndata: {}\n\n',
		);
		assert.equal(results.matches.length, 1);
		assert.equal(results.parseErrors, 0);
	});

	it("collects alerts, skipped reasons and counters", () => {
		const results = collectResults(bodyOf(progressBody()));
		assert.deepEqual(results.alerts, []);
		assert.equal(results.matchCount, 2);
		assert.equal(results.repositoriesCount, 1);
		assert.deepEqual([...results.skipped], [["shard-match-limit", 1], ["excluded-archive", 1]]);
	});

	it("counts unparseable frames instead of dropping them silently", () => {
		const results = collectResults("event: matches\ndata: {oops\n\n");
		assert.equal(results.matches.length, 0);
		assert.equal(results.parseErrors, 1);
	});
});

// ---------------------------------------------------------------------------
// query building
// ---------------------------------------------------------------------------

describe("count handling", () => {
	it("clamps to the documented range", () => {
		assert.deepEqual(normalizeCount(undefined), { count: 5 });
		assert.deepEqual(normalizeCount(3), { count: 3 });
		assert.equal(normalizeCount(1_000_000).count, 20);
		assert.equal(normalizeCount(2.5).count, 2);
		assert.equal(normalizeCount(0).count, 1);
		assert.equal(normalizeCount(-4).count, 1);
		assert.match(normalizeCount(1_000_000).note ?? "", /adjusted to count:20/);
	});

	it("strips an agent-supplied count so Sourcegraph does not reject the query", () => {
		const notes: string[] = [];
		assert.equal(stripCount("func NewRouter( count:100", notes), "func NewRouter(");
		assert.equal(stripCount("count:all secret", notes), "secret");
		assert.equal(notes.length, 2);
	});

	it("leaves count: inside quotes untouched", () => {
		const notes: string[] = [];
		assert.equal(stripCount('patternType:regexp "count:all"', notes), 'patternType:regexp "count:all"');
		assert.equal(stripCount('patternType:regexp "a  count:5  b"', notes), 'patternType:regexp "a  count:5  b"');
		assert.equal(notes.length, 0);
	});

	it("builds a query with exactly one count", () => {
		const built = buildQuery({ query: "router count:50", lang: "Go", repo: "gin-gonic/gin", count: 500 });
		assert.ok(built.ok);
		assert.equal(built.query, "router lang:Go repo:gin-gonic/gin count:20");
		assert.equal((built.query.match(/count:/g) ?? []).length, 1);
	});

	it("rejects filter values that would inject query operators", () => {
		assert.equal(checkFilterValue("Go type:diff"), "must not contain whitespace or control characters (they would be parsed as extra query operators)");
		assert.equal(checkFilterValue("gin-gonic/gin"), null);
		const built = buildQuery({ query: "router", lang: "Go type:diff" });
		assert.equal(built.ok, false);
	});
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

describe("formatMatch", () => {
	it("converts 0-based content line numbers to editor line numbers", () => {
		const text = formatMatch({ type: "content", repository: "r/x", path: "a.go", lineMatches: [{ line: "\tHandlerFunc HandlerFunc", lineNumber: 71 }] }, 1);
		assert.match(text, /L72: HandlerFunc HandlerFunc/);
	});

	it("renders path, symbol, commit and repo matches", () => {
		assert.match(formatMatch({ type: "path", repository: "r/x", path: "cmd/router.go" }, 1), /\(path match\)/);
		assert.match(
			formatMatch({ type: "symbol", repository: "r/x", path: "NewRouter.java", symbols: [{ name: "NewRouter", kind: "CLASS", line: 26 }] }, 2),
			/CLASS NewRouter @ L26/,
		);
		assert.match(formatMatch({ type: "commit", repository: "r/x", oid: "dcaa4296d111", message: "fix: thing\n\nbody", authorName: "Amirhf" }, 3), /commit `dcaa429` by Amirhf/);
		assert.match(formatMatch({ type: "repo", repository: "r/x", repoStars: 12, description: "a parser" }, 4), /⭐12 — a parser/);
	});
});

describe("renderResults", () => {
	it("reports truncation, skipped reasons and totals", () => {
		const results = collectResults(bodyOf(contentFrame(0, "a"), progressBody({ matchCount: 99 })));
		const text = renderResults(results, []);
		assert.match(text, /Found 1 match in 1 file across 1 repository/);
		assert.match(text, /reports 99 matches in total; returned 1/);
		assert.match(text, /truncated/);
		assert.match(text, /archived repositories are excluded by default/);
		assert.doesNotMatch(text, /×2/);
	});

	it("states how many of the matches are shown", () => {
		const frames = Array.from({ length: 12 }, (_, i) => contentFrame(i, `line ${i}`, `file${i}.go`));
		const results = collectResults(bodyOf(...frames));
		const text = renderResults(results, []);
		assert.match(text, /Found 12 matches in 12 files across 1 repository \(showing the first 10 files\)/);
		assert.equal(text.split("\n").filter((line) => /^ {3}L/.test(line)).length, 10);
	});
});

// ---------------------------------------------------------------------------
// execute(): end-to-end with a stubbed transport
// ---------------------------------------------------------------------------

describe("code_search execute", () => {
	it("registers a single tool with the expected parameters", () => {
		const tool = loadTool();
		assert.equal(tool.name, "code_search");
	});

	it("returns formatted matches and pins the query version", async () => {
		const urls = stubFetch([() => sseResponse(bodyOf(contentFrame(71, "\tHandlerFunc HandlerFunc")))]);
		const result = await loadTool().execute("id", { query: "func NewRouter(" });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /L72: HandlerFunc HandlerFunc/);
		assert.match(urls[0], /v=V3/);
		assert.match(urls[0], /q=func%20NewRouter\(%20count%3A5/);
	});

	it("surfaces a Sourcegraph alert instead of reporting no results", async () => {
		stubFetch([() => sseResponse(alertBody)]);
		const result = await loadTool().execute("id", { query: "patternType:regexp ((" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Unable To Process Query/);
		assert.match(result.content[0].text, /missing closing \]/);
	});

	it("reports when zero matches come with skipped-reason warnings", async () => {
		stubFetch([() => sseResponse(bodyOf(progressBody({ matchCount: 0 })))]);
		const result = await loadTool().execute("id", { query: "nothing" });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /No results found\./);
		assert.match(result.content[0].text, /truncated/);
	});

	it("retries transient network failures", async () => {
		const urls = stubFetch([
			() => {
				throw new TypeError("fetch failed");
			},
			() => sseResponse(bodyOf(contentFrame(0, "x"))),
		]);
		const result = await loadTool().execute("id", { query: "func" });
		assert.equal(result.isError, undefined);
		assert.equal(urls.length, 2);
	});

	it("retries a 429 and reports rate limiting when it persists", async () => {
		stubFetch([() => new Response("slow down", { status: 429 })]);
		const result = await loadTool().execute("id", { query: "func" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /rate limited \(HTTP 429\)/);
	});

	it("explains that 401 needs a token", async () => {
		stubFetch([() => new Response("Private mode requires authentication.", { status: 401 })]);
		const result = await loadTool().execute("id", { query: "func" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /SRC_ACCESS_TOKEN/);
	});

	it("rejects injection attempts without hitting the network", async () => {
		const urls = stubFetch([() => sseResponse("")]);
		const result = await loadTool().execute("id", { query: "func", lang: "Go type:diff" });
		assert.equal(result.isError, true);
		assert.equal(urls.length, 0);
	});

	it("honours SRC_ENDPOINT and SRC_ACCESS_TOKEN", async () => {
		process.env.SRC_ENDPOINT = "https://sg.example.com/";
		process.env.SRC_ACCESS_TOKEN = "s3cret";
		let auth: string | undefined;
		const urls = stubFetch([
			(_url, init) => {
				auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				return sseResponse(bodyOf(contentFrame(0, "x")));
			},
		]);
		await loadTool().execute("id", { query: "func" });
		assert.match(urls[0], /^https:\/\/sg\.example\.com\/\.api\/search\/stream\?/);
		assert.equal(auth, "token s3cret");
	});

	it("stops when the caller aborts", async () => {
		const controller = new AbortController();
		stubFetch([
			() => {
				controller.abort();
				throw new DOMException("aborted", "AbortError");
			},
		]);
		const result = await loadTool().execute("id", { query: "func" }, controller.signal);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /cancelled/);
	});
});
