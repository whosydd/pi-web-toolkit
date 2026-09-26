import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import registerJevJudge, {
	buildFailureWarning,
	buildQuestions,
	buildState,
	classifyFailure,
	extractLibraryCandidates,
	extractText,
	judgeToolResult,
	judgeWanted,
	lastStatus,
	markFailureWarned,
	renderJudgment,
	shouldWarnAboutFailure,
	TypeSafeError,
	type JudgeFailure,
	type JudgeOutcome,
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

/** Narrow an ambiguous judgeToolResult result to a successful outcome. */
function expectOutcome(result: unknown): JudgeOutcome {
	assert.ok(result && typeof result === "object" && !("failure" in result), "expected a judgment, got a failure");
	return result as JudgeOutcome;
}

/** Narrow an ambiguous judgeToolResult result to a classified failure. */
function expectFailure(result: unknown): JudgeFailure {
	assert.ok(result && typeof result === "object" && "failure" in result, "expected a failure, got a judgment");
	return result as JudgeFailure;
}

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
	it("exa_search gets sufficiency + corroboration + web-shaped next action", () => {
		const q = buildQuestions("exa_search", exaResultText)!;
		assert.equal(q.sufficiency.type, "noul");
		assert.equal(q.corroboration.type, "noul");
		assert.ok("show_more" in (q.next_action.criteria as object));
		assert.ok("cross_check" in (q.next_action.criteria as object));
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
		// the named library must itself be a candidate; adjacent libraries do not count
		assert.match(q.best_match.instructions, /IS the library the query names/);
		assert.match(q.best_match.instructions, /pick none_of_these/);
		assert.match(criteria.none_of_these, /adjacent/);
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

	it("labels the 0.61–0.74 and 0.36–0.39 bands as weak leanings, not undecided", () => {
		const leaningYes = renderJudgment("m", undefined, { sufficiency: { type: "noul", noul: 0.74 } }, questions);
		assert.ok(leaningYes.includes("sufficiency: 0.74 — leaning yes (weak)"));
		assert.ok(!leaningYes.includes("genuinely undecided"));
		const leaningNo = renderJudgment("m", undefined, { sufficiency: { type: "noul", noul: 0.38 } }, questions);
		assert.ok(leaningNo.includes("sufficiency: 0.38 — leaning no (weak)"));
		const edgeUncertain = renderJudgment("m", undefined, { sufficiency: { type: "noul", noul: 0.6 } }, questions);
		assert.ok(edgeUncertain.includes("genuinely undecided"));
		const edgeLikelyNo = renderJudgment("m", undefined, { sufficiency: { type: "noul", noul: 0.35 } }, questions);
		assert.ok(edgeLikelyNo.includes("sufficiency: 0.35 — likely no"));
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

	it("warns when the action is done but corroboration is weak", () => {
		const out = renderJudgment("m", undefined, {
			sufficiency: { type: "noul", noul: 0.9 },
			corroboration: { type: "noul", noul: 0.4 },
			next_action: { type: "choice", choice: "done", confidence: 0.8, probabilities: { done: 0.9 } },
		}, questions);
		assert.match(out, /⚠ done with weak corroboration \(0\.40\)/);
	});

	it("does not warn when corroboration is strong or the action is not done", () => {
		const strong = renderJudgment("m", undefined, {
			corroboration: { type: "noul", noul: 0.85 },
			next_action: { type: "choice", choice: "done", confidence: 0.8, probabilities: { done: 0.9 } },
		}, questions);
		assert.ok(!strong.includes("⚠"));
		const notDone = renderJudgment("m", undefined, {
			corroboration: { type: "noul", noul: 0.4 },
			next_action: { type: "choice", choice: "refine", confidence: 0.8, probabilities: { refine: 0.9 } },
		}, questions);
		assert.ok(!notDone.includes("⚠"));
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
		assert.ok(outcome, "expected a judgment for a good result");
		const ok = expectOutcome(outcome);
		assert.ok(ok.appendedText.includes("jev-judge (model jev-1.13.0"));
		assert.ok(ok.appendedText.includes("sufficiency: 0.89"));
		assert.equal(ok.meta.model, "jev-1.13.0");
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

	it("returns a transient failure when the API fails (result still passes through)", async () => {
		const outcome = await judgeToolResult("exa_search", exaInput, text(exaResultText), {
			apiKey: "sk-test",
			fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
		});
		const failure = expectFailure(outcome);
		assert.equal(failure.kind, "transient");
		assert.equal(failure.status, 500);
		assert.ok(!("appendedText" in failure), "failures must not carry a judgment block");
	});

	it("classifies 401 as actionable without retrying", async () => {
		let calls = 0;
		const outcome = await judgeToolResult("exa_search", exaInput, text(exaResultText), {
			apiKey: "sk-test",
			fetchImpl: (async () => {
				calls++;
				return new Response("bad request", { status: 401 });
			}) as typeof fetch,
		});
		assert.equal(calls, 1);
		const failure = expectFailure(outcome);
		assert.equal(failure.kind, "actionable");
		assert.equal(failure.status, 401);
	});
});

// ---------------------------------------------------------------------------
// failure classification + user warnings
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
	it("maps 402 to actionable with a balance remedy", () => {
		const f = classifyFailure(new TypeSafeError("TypeSafe API error 402: insufficient credits", 402));
		assert.equal(f.failure, true);
		assert.equal(f.kind, "actionable");
		assert.equal(f.status, 402);
		assert.match(f.reason, /balance/i);
		assert.match(f.remedy!, /top up/i);
		assert.equal(f.detail, "TypeSafe API error 402: insufficient credits");
	});

	it("maps 401 and 403 to actionable key remedies", () => {
		assert.match(classifyFailure(new TypeSafeError("x", 401)).reason, /key/i);
		assert.match(classifyFailure(new TypeSafeError("x", 403)).reason, /access/i);
	});

	it("treats network errors and 5xx as transient", () => {
		assert.equal(classifyFailure(new Error("fetch failed")).kind, "transient");
		assert.equal(classifyFailure(new TypeSafeError("API error 500", 500)).kind, "transient");
		assert.equal(classifyFailure("weird").kind, "transient");
	});

	it("renders a single-line warning naming the fix", () => {
		const w = buildFailureWarning(
			classifyFailure(new TypeSafeError("TypeSafe API error 402: insufficient credits", 402)),
		);
		assert.match(w, /^jev-judge: TypeSafe judging failed/);
		assert.match(w, /HTTP 402/);
		assert.match(w, /top up/i);
		assert.match(w, /uncalibrated/);
	});

	it("throttles warnings to once per interval", () => {
		const now = Date.now();
		markFailureWarned(now - 9 * 60_000);
		assert.equal(shouldWarnAboutFailure(now), false);
		markFailureWarned(now - 10 * 60_000);
		assert.equal(shouldWarnAboutFailure(now), true);
		// a fresh warning suppresses further ones immediately
		markFailureWarned(now);
		assert.equal(shouldWarnAboutFailure(now + 1), false);
	});
});

// ---------------------------------------------------------------------------
// extension wiring
// ---------------------------------------------------------------------------

type ToolResultHandler = (event: any, ctx: any) => Promise<any>;

function loadExtension(): { hook: ToolResultHandler; commands: Map<string, any> } {
	let hook: ToolResultHandler | undefined;
	const commands = new Map<string, any>();
	const pi = {
		on: (event: string, fn: any) => {
			if (event === "tool_result") hook = fn;
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
	};
	registerJevJudge(pi as any);
	assert.ok(hook, "extension must register a tool_result hook");
	assert.ok(commands.has("jev-judge"), "extension must register the /jev-judge command");
	return { hook: hook!, commands };
}

function loadHook(): ToolResultHandler {
	return loadExtension().hook;
}

function clearStatus(): void {
	for (const key of Object.keys(lastStatus)) {
		delete (lastStatus as Record<string, unknown>)[key];
	}
}

function stubGlobalFetch(body: unknown): void {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

describe("extension hook", () => {
	afterEach(() => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.JEV_JUDGE;
		clearStatus();
		markFailureWarned(0);
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
				{ hasUI: true, ui: { notify: () => {} } },
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
			{ hasUI: true, ui: { notify: () => {} } },
		);
		assert.equal(patch, undefined);
	});

	it("leaves results untouched when disabled", async () => {
		process.env.TYPESAFE_API_KEY = "sk-test";
		process.env.JEV_JUDGE = "off";
		const hook = loadHook();
		const patch = await hook(
			{ toolName: "exa_search", input: exaInput, content: text(exaResultText), details: undefined, isError: false },
			{ hasUI: true, ui: { notify: () => {} } },
		);
		assert.equal(patch, undefined);
	});
});

describe("failure warnings", () => {
	afterEach(() => {
		delete process.env.TYPESAFE_API_KEY;
		clearStatus();
		markFailureWarned(0);
	});

	function failingFetch(status: number): void {
		globalThis.fetch = (async () => new Response("nope", { status })) as typeof fetch;
	}

	const event = {
		toolName: "exa_search",
		input: exaInput,
		content: text(exaResultText),
		details: undefined,
		isError: false,
	};

	it("warns once per interval for actionable failures and never for transient ones", async () => {
		process.env.TYPESAFE_API_KEY = "sk-test";
		const realFetch = globalThis.fetch;
		const notifications: Array<[string, string]> = [];
		const ctx = { hasUI: true, ui: { notify: (m: string, l: string) => notifications.push([m, l]) } };
		try {
			const hook = loadHook();

			failingFetch(402);
			assert.equal(await hook(event, ctx), undefined, "degraded results must pass through");
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0][1], "warning");
			assert.match(notifications[0][0], /402/);
			assert.match(notifications[0][0], /top up/i);
			assert.equal(lastStatus.lastErrorRecovered, false);

			// throttled: an immediate second failure stays silent
			assert.equal(await hook(event, ctx), undefined);
			assert.equal(notifications.length, 1);

			// transient failures never warn
			failingFetch(500);
			assert.equal(await hook(event, ctx), undefined);
			assert.equal(notifications.length, 1);

			// once the interval has elapsed it warns again
			markFailureWarned(Date.now() - 11 * 60_000);
			failingFetch(402);
			assert.equal(await hook(event, ctx), undefined);
			assert.equal(notifications.length, 2);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("records failures without a UI and marks recovery on the next success", async () => {
		process.env.TYPESAFE_API_KEY = "sk-test";
		const realFetch = globalThis.fetch;
		try {
			const hook = loadHook();
			const ctx = { hasUI: false, ui: { notify: () => {} } };

			failingFetch(402);
			await hook(event, ctx);
			assert.match(lastStatus.lastError!, /balance/);
			assert.match(lastStatus.lastError!, /402/);
			assert.ok(lastStatus.lastErrorAt);
			assert.equal(lastStatus.lastErrorRecovered, false);

			stubGlobalFetch(jevResponse);
			await hook(event, ctx);
			assert.equal(lastStatus.lastErrorRecovered, true);
			assert.equal(lastStatus.tool, "exa_search");
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("surfaces an unresolved failure in /jev-judge status as a warning", async () => {
		process.env.TYPESAFE_API_KEY = "sk-test";
		const { commands } = loadExtension();
		const handler = commands.get("jev-judge").handler;
		const notifications: Array<[string, string]> = [];
		const ctx = { ui: { notify: (m: string, l: string) => notifications.push([m, l]) } };

		lastStatus.lastError = "TypeSafe reports payment required (HTTP 402)";
		lastStatus.lastErrorAt = "2025-01-01T00:00:00.000Z";
		lastStatus.lastErrorRecovered = false;
		await handler("", ctx);
		assert.equal(notifications[0][1], "warning");
		assert.match(notifications[0][0], /last failure/);
		assert.match(notifications[0][0], /402/);

		lastStatus.lastErrorRecovered = true;
		notifications.length = 0;
		await handler("", ctx);
		assert.equal(notifications[0][1], "info");
		assert.match(notifications[0][0], /since recovered/);
	});
});
