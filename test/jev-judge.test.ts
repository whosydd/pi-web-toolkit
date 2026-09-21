import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import registerJevJudge, {
	buildQuestions,
	buildState,
	extractLibraryCandidates,
	extractText,
	judgeToolResult,
	judgeWanted,
	renderJudgment,
	type Question,
} from "../extensions/jev-judge.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const exaResultText = `Top results for "Next.js 15 caching":

1. [Next.js Docs — Caching](https://nextjs.org/docs/caching)
   Next.js App Router provides several caching mechanisms: the fetch cache,
   router cache, and unstable_cache. In Next.js 15, fetch requests are no
   longer cached by default.`;

const exaInput = { query: "How to set up caching in Next.js 15?", numResults: 5 };

const codeResultText = `Matches (2 shown of 7):

gin-gonic/gin · middleware/logger.go
  12:  return func(c *gin.Context) {

expressjs/express · lib/router/index.js
  144:  return function router(req, res, next) {`;

const docsResultText = `# Caching in Next.js

Use the \`unstable_cache\` function to cache expensive operations:

\`\`\`ts
const data = await unstable_cache(fn, ['key'], { revalidate: 3600 });
\`\`\``;

const libraryResultText = `- Title: Next.js
- Context7-compatible library ID: /vercel/next.js
- Description: The React framework for the web.
- Source Reputation: High
----------
- Title: Next.js (Community)
- Context7-compatible library ID: /community/nextjs
- Description: Community mirror of the Next.js docs.
- Source Reputation: Medium`;

const jevResponse = {
	answers: {
		sufficiency: { type: "noul", noul: 0.89 },
		next_action: {
			type: "choice",
			choice: "show_more",
			confidence: 0.81,
			probabilities: { done: 0, show_more: 0.87, refine: 0, browse_more: 0.13 },
		},
	},
	usage: { input_tokens: 533 },
	model: "jev-1.13.0",
};

const okFetch =
	(body: unknown): typeof fetch =>
	async () =>
		new Response(JSON.stringify(body), { status: 200 });

const text = (t: string) => [{ type: "text", text: t }];

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("extractText", () => {
	it("concatenates text blocks and ignores other block types", () => {
		const blocks = [
			{ type: "text", text: "a" },
			{ type: "image", data: "xx" },
			{ type: "text", text: "b" },
		];
		assert.equal(extractText(blocks), "a\nb");
	});

	it("returns empty string for non-array content", () => {
		assert.equal(extractText(undefined), "");
		assert.equal(extractText("just text"), "");
	});
});

describe("judgeWanted", () => {
	it("skips when the tool is not in the enabled set", () => {
		assert.equal(
			judgeWanted("bash", {}, exaResultText, { enabledTools: ["exa_search"] }),
			false,
		);
	});

	it("skips results that are too short to be worth judging", () => {
		assert.equal(
			judgeWanted("exa_search", exaInput, "No results found", {
				enabledTools: ["exa_search"],
			}),
			false,
		);
	});

	it("skips ctx7_library with fewer than two candidates", () => {
		const single = libraryResultText.replace(/----------[\s\S]*/, "");
		assert.equal(
			judgeWanted("ctx7_library", {}, libraryResultText, {
				enabledTools: ["ctx7_library"],
			}),
			true,
		);
		assert.equal(
			judgeWanted("ctx7_library", {}, single, {
				enabledTools: ["ctx7_library"],
			}),
			false,
		);
	});

	it("skips trivial instant web searches", () => {
		assert.equal(
			judgeWanted("exa_search", { ...exaInput, type: "instant" }, exaResultText, {
				enabledTools: ["exa_search"],
			}),
			false,
		);
	});

	it("is disabled by JEV_JUDGE=off", () => {
		const prev = process.env.JEV_JUDGE;
		process.env.JEV_JUDGE = "off";
		try {
			assert.equal(
				judgeWanted("exa_search", exaInput, exaResultText, {
					enabledTools: ["exa_search"],
				}),
				false,
			);
		} finally {
			if (prev === undefined) delete process.env.JEV_JUDGE;
			else process.env.JEV_JUDGE = prev;
		}
	});
});

describe("extractLibraryCandidates", () => {
	it("pairs ids with titles in render order", () => {
		const cands = extractLibraryCandidates(libraryResultText);
		assert.deepEqual(cands, [
			{ id: "/vercel/next.js", title: "Next.js" },
			{ id: "/community/nextjs", title: "Next.js (Community)" },
		]);
	});
});

describe("buildQuestions", () => {
	it("exa_search gets sufficiency + web-shaped next action", () => {
		const q = buildQuestions("exa_search", exaResultText)!;
		assert.equal(q.sufficiency.type, "noul");
		assert.ok("show_more" in (q.next_action.criteria as object));
	});

	it("code_search gets code-shaped options", () => {
		const q = buildQuestions("code_search", codeResultText)!;
		assert.ok("refine_query" in (q.next_action.criteria as object));
	});

	it("ctx7_docs gets docs-shaped options", () => {
		const q = buildQuestions("ctx7_docs", docsResultText)!;
		assert.ok("search_code" in (q.next_action.criteria as object));
	});

	it("ctx7_library builds one option per candidate plus a fallback", () => {
		const q = buildQuestions("ctx7_library", libraryResultText)!;
		const criteria = q.best_match.criteria as Record<string, string>;
		assert.ok(criteria["/vercel/next.js"].includes("Next.js"));
		assert.ok(criteria["/community/nextjs"].includes("Community"));
		assert.ok("none_of_these" in criteria);
	});

	it("returns null for unknown tools", () => {
		assert.equal(buildQuestions("bash", "out"), null);
	});
});

describe("buildState", () => {
	it("embeds the query and truncates long results", () => {
		const long = "x".repeat(20_000);
		const state = buildState("exa_search", exaInput, long);
		assert.ok(state.includes("How to set up caching in Next.js 15?"));
		assert.ok(state.length < 20_000);
		assert.ok(state.endsWith("[…truncated]"));
	});

	it("labels the library name for ctx7_library", () => {
		const state = buildState(
			"ctx7_library",
			{ libraryName: "Next.js", query: "caching docs" },
			libraryResultText,
		);
		assert.ok(state.includes("Library name: Next.js"));
	});
});

describe("renderJudgment", () => {
	const questions = buildQuestions("exa_search", exaResultText)!;

	it("renders noul with a verdict phrase", () => {
		const out = renderJudgment("jev-1.13.0", { input_tokens: 10 }, { sufficiency: { type: "noul", noul: 0.89 } }, questions);
		assert.ok(out.includes("sufficiency: 0.89 — likely yes"));
	});

	it("renders uncertain noul as undecided, not medium", () => {
		const out = renderJudgment("m", undefined, { sufficiency: { type: "noul", noul: 0.5 } }, questions);
		assert.ok(out.includes("genuinely undecided"));
	});

	it("renders the chosen option with its criteria description and runner-up", () => {
		const out = renderJudgment("jev-1.13.0", { input_tokens: 533 }, jevResponse.answers, questions);
		assert.ok(out.includes("next_action: show_more (p=0.87, conf=0.81)"));
		assert.ok(out.includes("fetch that page"));
		assert.ok(out.includes("[next: browse_more 0.13]"));
	});

	it("surfaces unknown answer shapes verbatim", () => {
		const out = renderJudgment("m", undefined, { weird: { foo: 1 } }, questions);
		assert.ok(out.includes('weird: {"foo":1}'));
	});
});

// ---------------------------------------------------------------------------
// orchestration (stubbed fetch)
// ---------------------------------------------------------------------------

describe("judgeToolResult", () => {
	it("appends a judgment block for a good exa_search result", async () => {
		let requested: any;
		const outcome = await judgeToolResult("exa_search", exaInput, text(exaResultText), {
			apiKey: "sk-test",
			fetchImpl: (async (url: any, init: any) => {
				requested = { url, init };
				return new Response(JSON.stringify(jevResponse), { status: 200 });
			}) as typeof fetch,
		});
		assert.ok(outcome);
		assert.ok(outcome.appendedText.includes("jev-judge (model jev-1.13.0"));
		assert.ok(outcome.appendedText.includes("sufficiency: 0.89"));
		assert.equal(outcome.meta.model, "jev-1.13.0");
		assert.equal(requested.url, "https://api.typesafe.ai/v1/systemone");
		const body = JSON.parse(requested.init.body);
		assert.equal(body.model, "jev-latest");
		assert.ok(body.state.includes("How to set up caching in Next.js 15?"));
		assert.ok(body.questions.sufficiency);
	});

	it("returns undefined without an API key (inert)", async () => {
		const outcome = await judgeToolResult("exa_search", exaInput, text(exaResultText), {
			apiKey: null,
			fetchImpl: okFetch(jevResponse),
		});
		assert.equal(outcome, undefined);
	});

	it("returns undefined for error results", async () => {
		const outcome = await judgeToolResult("exa_search", exaInput, text("boom"), {
			apiKey: "sk-test",
			isError: true,
			fetchImpl: okFetch(jevResponse),
		});
		assert.equal(outcome, undefined);
	});

	it("degrades silently when the API fails", async () => {
		const outcome = await judgeToolResult("exa_search", exaInput, text(exaResultText), {
			apiKey: "sk-test",
			fetchImpl: (async () => new Response("rate limited", { status: 500 })) as typeof fetch,
		});
		assert.equal(outcome, undefined);
	});

	it("passes non-retryable HTTP errors through without retrying", async () => {
		let calls = 0;
		await judgeToolResult("exa_search", exaInput, text(exaResultText), {
			apiKey: "sk-test",
			fetchImpl: (async () => {
				calls++;
				return new Response("bad request", { status: 401 });
			}) as typeof fetch,
		});
		assert.equal(calls, 1);
	});
});

// ---------------------------------------------------------------------------
// extension wiring
// ---------------------------------------------------------------------------

type ToolResultHandler = (event: any, ctx: any) => Promise<any>;

function loadHook(): ToolResultHandler {
	let handler: ToolResultHandler | undefined;
	const pi = {
		on: (event: string, fn: any) => {
			if (event === "tool_result") handler = fn;
		},
		registerCommand: () => {},
	};
	registerJevJudge(pi as any);
	assert.ok(handler, "extension must register a tool_result hook");
	return handler!;
}

function stubGlobalFetch(body: unknown): void {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

describe("extension hook", () => {
	afterEach(() => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.JEV_JUDGE;
	});

	it("patches content and merges details when a judgment is made", async () => {
		process.env.TYPESAFE_API_KEY = "sk-test";
		const realFetch = globalThis.fetch;
		stubGlobalFetch(jevResponse);
		try {
			const hook = loadHook();
			const patch = await hook(
				{
					toolName: "exa_search",
					input: exaInput,
					content: text(exaResultText),
					details: { requestId: "req-1", costDollars: 0.01 },
					isError: false,
				},
				{},
			);
			assert.ok(patch);
			const texts = patch.content.filter((b: any) => b.type === "text");
			assert.equal(texts.length, 2);
			assert.ok(texts[1].text.startsWith("---\njev-judge"));
			assert.equal(patch.details.requestId, "req-1");
			assert.equal(patch.details.jevJudge.model, "jev-1.13.0");
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("leaves results untouched when no key is set", async () => {
		const hook = loadHook();
		const patch = await hook(
			{
				toolName: "exa_search",
				input: exaInput,
				content: text(exaResultText),
				details: undefined,
				isError: false,
			},
			{},
		);
		assert.equal(patch, undefined);
	});

	it("leaves results untouched when disabled", async () => {
		process.env.TYPESAFE_API_KEY = "sk-test";
		process.env.JEV_JUDGE = "off";
		const hook = loadHook();
		const patch = await hook(
			{ toolName: "exa_search", input: exaInput, content: text(exaResultText), details: undefined, isError: false },
			{},
		);
		assert.equal(patch, undefined);
	});
});
