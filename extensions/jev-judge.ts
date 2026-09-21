// jev-judge: automatic TypeSafe (Jev) calibration for web-search tool results
//
// Hooks tool_result for exa_search / code_search / ctx7_library / ctx7_docs,
// sends a fixed-template judgment request to TypeSafe's System One API
// (POST /systemone), and appends a compact, probability-calibrated verdict to
// the result before the model sees it. The model never calls anything and
// cannot forget to use it — judgments arrive attached to every search result.
//
// Design constraints:
// - Never blocks or breaks the underlying tool: a missing TYPESAFE_API_KEY,
//   API errors, timeouts and deterministic skip heuristics all pass the
//   original result through untouched (silent degradation).
// - Judgments are data, not conclusions: probabilities plus the meaning of
//   the chosen option are appended; the model still decides.
// - No dependency on the user-level typesafe extension: this file talks to
//   the same endpoint with its own minimal fetch helper, so the package stays
//   self-contained.
//
// Configuration:
//   TYPESAFE_API_KEY   required for anything to happen (shared with the
//                      typesafe extension; without it this hook is inert)
//   JEV_JUDGE          set to "off" to disable entirely
//   JEV_JUDGE_TOOLS    comma-separated tool list to judge
//                      (default: exa_search,code_search,ctx7_library,ctx7_docs)
//   JEV_JUDGE_MODEL    Jev model id (default: jev-latest)
//   /jev-judge         command showing status and the last judgment made

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API_BASE = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TOOLS = ["exa_search", "code_search", "ctx7_library", "ctx7_docs"];
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MIN_RESULT_CHARS = 80;
const MAX_RESULT_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Tool result content helpers
// ---------------------------------------------------------------------------

interface TextBlock {
	type: string;
	text?: unknown;
}

/** Concatenate the text blocks of a tool result (other block types ignored). */
export function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is TextBlock =>
				typeof b === "object" && b !== null && (b as TextBlock).type === "text",
		)
		.map((b) => (typeof b.text === "string" ? b.text : ""))
		.join("\n");
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[…truncated]`;
}

// ---------------------------------------------------------------------------
// Skip heuristics (deterministic; anything skipped costs nothing)
// ---------------------------------------------------------------------------

const LIBRARY_ID_LINE = /- Context7-compatible library ID: (.+)/g;
const TITLE_LINE = /- Title: (.+)/g;

export interface LibraryCandidate {
	id: string;
	title: string;
}

/** Parse the rendered candidate list of ctx7_library results. */
export function extractLibraryCandidates(text: string): LibraryCandidate[] {
	const ids = [...text.matchAll(LIBRARY_ID_LINE)].map((m) => m[1].trim());
	const titles = [...text.matchAll(TITLE_LINE)].map((m) => m[1].trim());
	return ids.map((id, i) => ({ id, title: titles[i] ?? id }));
}

export function judgeWanted(
	toolName: string,
	input: Record<string, unknown> | undefined,
	resultText: string,
	opts: { enabledTools?: string[] } = {},
): boolean {
	if (process.env.JEV_JUDGE === "off") return false;
	const enabled = opts.enabledTools ?? enabledTools();
	if (!enabled.includes(toolName)) return false;
	if (resultText.trim().length < MIN_RESULT_CHARS) return false;
	if (toolName === "ctx7_library") {
		// Single candidate = nothing to disambiguate; zero candidates is a
		// deterministic "fall back to web search" case the skill already covers.
		if (extractLibraryCandidates(resultText).length < 2) return false;
	}
	if (toolName === "exa_search" && input?.type === "instant") return false;
	return true;
}

export function enabledTools(): string[] {
	const raw = process.env.JEV_JUDGE_TOOLS;
	if (!raw?.trim()) return DEFAULT_TOOLS;
	const parsed = raw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return parsed.length ? parsed : DEFAULT_TOOLS;
}

// ---------------------------------------------------------------------------
// State + question templates (the fixed methodology of this judge)
// ---------------------------------------------------------------------------

export function buildState(
	toolName: string,
	input: Record<string, unknown>,
	resultText: string,
): string {
	const line = (label: string, value: unknown) =>
		value === undefined || value === "" ? "" : `${label}: ${value}\n`;
	if (toolName === "ctx7_library") {
		return (
			`Tool: ctx7_library (resolves a library name to Context7 library IDs)\n` +
			line("Library name", input.libraryName) +
			line("Query", input.query) +
			`\nCandidate libraries returned by Context7:\n` +
			truncate(resultText, MAX_RESULT_CHARS)
		);
	}
	if (toolName === "ctx7_docs") {
		return (
			`Tool: ctx7_docs (official documentation of a Context7 library)\n` +
			line("Library", input.libraryId) +
			line("Query", input.query) +
			`\nDocumentation excerpt:\n` +
			truncate(resultText, MAX_RESULT_CHARS)
		);
	}
	if (toolName === "code_search") {
		return (
			`Tool: code_search (Sourcegraph search over public open-source repos)\n` +
			line("Query", input.query) +
			line("Language filter", input.lang) +
			line("Repo filter", input.repo) +
			`\nRendered matches:\n` +
			truncate(resultText, MAX_RESULT_CHARS)
		);
	}
	// exa_search and anything else defaults to the web-search shape
	return (
		`Tool: ${toolName} (web search)\n` +
		line("Query", input.query) +
		line("Search mode", input.type) +
		line("Category filter", input.category) +
		`\nResults:\n` +
		truncate(resultText, MAX_RESULT_CHARS)
	);
}

export interface Question {
	type: "noul" | "choice" | "score";
	instructions: string;
	criteria?: unknown;
}

const SUFFICIENCY_NOUL: Question = {
	type: "noul",
	instructions:
		"One yes/no probability: do the results in the state contain information that directly answers the query, as opposed to merely being topically adjacent?",
};

const EXA_NEXT_ACTION: Question = {
	type: "choice",
	instructions:
		"Pick the single best next action for an information-seeking task given this state.",
	criteria: {
		done: "The results already contain the answer; answer without further retrieval.",
		show_more:
			"A specific result clearly holds the full answer but the excerpt is too thin; fetch that page (exa_fetch) before answering.",
		refine:
			"The query itself missed the target; re-search with different keywords or filters.",
		browse_more:
			"Nothing is clearly sufficient yet; broader or repeated searching would help.",
	},
};

const CODE_NEXT_ACTION: Question = {
	type: "choice",
	instructions:
		"Pick the single best next action for an information-seeking task given this state.",
	criteria: {
		done: "The matches show the usage pattern clearly enough to answer.",
		refine_query:
			"The query missed; rewrite it (better pattern, patternType:regexp, different keywords).",
		broaden:
			"Relax the lang:/repo: filters or try a different angle in the same index.",
		switch_source:
			"This is really a library API/contract question; official docs (ctx7_docs) fit better than code search.",
	},
};

const DOCS_NEXT_ACTION: Question = {
	type: "choice",
	instructions:
		"Pick the single best next action for an information-seeking task given this state.",
	criteria: {
		done: "The docs answer the query; cite them and answer.",
		other_concept:
			"Re-query ctx7_docs with a different single-concept query (same library).",
		search_web:
			"The docs are thin or miss the topic (ecosystem news, very new API, version mismatch); use exa_search.",
		search_code:
			"The documented contract is known but concrete real-world usage is needed; use code_search.",
	},
};

export function buildQuestions(
	toolName: string,
	resultText: string,
): Record<string, Question> | null {
	if (toolName === "ctx7_library") {
		const candidates = extractLibraryCandidates(resultText);
		if (candidates.length < 2) return null;
		const criteria: Record<string, string> = {};
		for (const c of candidates) criteria[c.id] = `Library "${c.title}"`;
		criteria.none_of_these =
			"No listed candidate matches; fall back to exa_search instead of forcing an ID.";
		return {
			best_match: {
				type: "choice",
				instructions:
					"The user resolved a library name and Context7 returned several candidate library IDs. Pick the one that is most likely the library the query means.",
				criteria,
			},
		};
	}
	if (toolName === "code_search") {
		return { sufficiency: SUFFICIENCY_NOUL, next_action: CODE_NEXT_ACTION };
	}
	if (toolName === "ctx7_docs") {
		return { sufficiency: SUFFICIENCY_NOUL, next_action: DOCS_NEXT_ACTION };
	}
	if (toolName === "exa_search") {
		return { sufficiency: SUFFICIENCY_NOUL, next_action: EXA_NEXT_ACTION };
	}
	return null;
}

// ---------------------------------------------------------------------------
// TypeSafe /systemone client (minimal; retry on 429/529 like the official SDK)
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimer();
				reject(signal.reason ?? new Error("Aborted"));
			},
			{ once: true },
		);
		function clearTimer() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", clearTimer);
		}
	});
}

export async function typesafeEvaluate(
	apiKey: string,
	state: string,
	questions: Record<string, Question>,
	opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; model?: string } = {},
): Promise<{ answers: Record<string, any>; usage?: any; model?: string }> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const model = opts.model ?? process.env.JEV_JUDGE_MODEL ?? DEFAULT_MODEL;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = opts.signal
		? (AbortSignal.any?.([opts.signal, timeout]) ?? opts.signal)
		: timeout;

	let attempt = 0;
	for (;;) {
		let res: Response;
		try {
			res = await fetchImpl(`${API_BASE}/systemone`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ state, model, questions }),
				signal,
			});
		} catch (err: any) {
			if (attempt < MAX_RETRIES && err?.name !== "TimeoutError" && err?.name !== "AbortError") {
				await sleep(500 * 2 ** attempt, signal);
				attempt++;
				continue;
			}
			throw err;
		}
		if (res.ok) {
			const data: any = await res.json();
			if (!data?.answers) throw new Error("unexpected TypeSafe response shape");
			return data;
		}
		if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
			const retryAfter = res.headers.get("retry-after");
			await sleep(retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt, signal);
			attempt++;
			continue;
		}
		const body = await res.text().catch(() => "");
		throw new Error(`TypeSafe API error ${res.status}: ${body.slice(0, 200)}`);
	}
}

// ---------------------------------------------------------------------------
// Judgment rendering (data, not conclusions)
// ---------------------------------------------------------------------------

function confidenceVerdict(p: number): string {
	if (p >= 0.75) return "likely yes";
	if (p <= 0.35) return "likely no";
	return "uncertain (near 0.5: genuinely undecided)";
}

function optionDescription(
	question: Question,
	option: string,
): string | undefined {
	if (question.type !== "choice") return undefined;
	const criteria = question.criteria as Record<string, string> | undefined;
	return criteria?.[option];
}

export function renderJudgment(
	model: string,
	usage: { input_tokens?: number } | undefined,
	answers: Record<string, any>,
	questions: Record<string, Question>,
): string {
	const lines: string[] = [];
	const tokens = usage?.input_tokens;
	lines.push(
		`jev-judge (model ${model}${tokens ? `, ${tokens} in-tokens` : ""}):`,
	);
	for (const [id, a] of Object.entries(answers)) {
		if (a?.type === "noul" && typeof a.noul === "number") {
			lines.push(`- ${id}: ${a.noul.toFixed(2)} — ${confidenceVerdict(a.noul)}`);
		} else if (a?.type === "choice" && typeof a.choice === "string") {
			const p = a.probabilities?.[a.choice];
			const conf = typeof a.confidence === "number" ? a.confidence : undefined;
			const desc = optionDescription(questions[id], a.choice);
			const dist = Object.entries(
				(a.probabilities ?? {}) as Record<string, number>,
			);
			const runnerUp = dist
				.filter(([k]) => k !== a.choice)
				.sort((x, y) => y[1] - x[1])[0];
			let line = `- ${id}: ${a.choice}`;
			if (typeof p === "number") line += ` (p=${p.toFixed(2)}`;
			if (conf !== undefined) line += typeof p === "number" ? `, conf=${conf.toFixed(2)}` : ` (conf=${conf.toFixed(2)}`;
			if (typeof p === "number") line += ")";
			if (desc) line += ` — ${desc}`;
			if (runnerUp && runnerUp[1] > 0) line += ` [next: ${runnerUp[0]} ${runnerUp[1].toFixed(2)}]`;
			lines.push(line);
		} else {
			// Unknown shape: surface it verbatim rather than guessing.
			lines.push(`- ${id}: ${JSON.stringify(a)}`);
		}
	}
	lines.push(
		"(calibrated probabilities from Jev; treat <0.6 or low confidence as a weak signal, not a verdict)",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration (pure enough to test end-to-end with a stubbed fetch)
// ---------------------------------------------------------------------------

export interface JudgeOutcome {
	appendedText: string;
	meta: { model: string; answers: Record<string, any>; latencyMs: number };
}

export async function judgeToolResult(
	toolName: string,
	input: Record<string, unknown> | undefined,
	content: unknown,
	opts: {
		isError?: boolean;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
		apiKey?: string | null;
		enabledTools?: string[];
		model?: string;
	} = {},
): Promise<JudgeOutcome | undefined> {
	// An explicitly-passed apiKey (even null) wins over the environment so
	// callers and tests can force-disable the judge.
	const apiKey =
		(opts.apiKey !== undefined ? opts.apiKey : process.env.TYPESAFE_API_KEY) ?? null;
	if (!apiKey) return undefined;
	if (opts.isError) return undefined;

	const resultText = extractText(content);
	if (!judgeWanted(toolName, input, resultText, opts)) return undefined;

	const questions = buildQuestions(toolName, resultText);
	if (!questions) return undefined;

	const state = buildState(toolName, input ?? {}, resultText);
	const started = Date.now();
	try {
		const data = await typesafeEvaluate(apiKey, state, questions, {
			signal: opts.signal,
			fetchImpl: opts.fetchImpl,
			model: opts.model,
		});
		const appendedText = renderJudgment(
			data.model ?? opts.model ?? process.env.JEV_JUDGE_MODEL ?? DEFAULT_MODEL,
			data.usage,
			data.answers,
			questions,
		);
		return {
			appendedText,
			meta: {
				model: data.model ?? opts.model ?? DEFAULT_MODEL,
				answers: data.answers,
				latencyMs: Date.now() - started,
			},
		};
	} catch {
		// Silent degradation: an unavailable judge must never break the search.
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const lastStatus: { tool?: string; latencyMs?: number; error?: string; at?: string } = {};

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		const apiKey = process.env.TYPESAFE_API_KEY ?? null;
		if (!apiKey || process.env.JEV_JUDGE === "off") return undefined;
		const outcome = await judgeToolResult(
			event.toolName,
			event.input as Record<string, unknown> | undefined,
			event.content,
			{ isError: event.isError, signal: ctx.signal, apiKey },
		);
		if (!outcome) return undefined;
		lastStatus.tool = event.toolName;
		lastStatus.latencyMs = outcome.meta.latencyMs;
		lastStatus.error = undefined;
		lastStatus.at = new Date().toISOString();
		return {
			content: [
				...event.content,
				{ type: "text" as const, text: `---\n${outcome.appendedText}` },
			],
			details: { ...((event.details as Record<string, unknown>) ?? {}), jevJudge: outcome.meta },
		};
	});

	pi.registerCommand("jev-judge", {
		description: "Show jev-judge status (watched tools, model, last judgment)",
		handler: async (_args, ctx) => {
			const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
			if (process.env.JEV_JUDGE === "off") {
				ctx.ui.notify("jev-judge: disabled (JEV_JUDGE=off)", "info");
				return;
			}
			if (!hasKey) {
				ctx.ui.notify(
					'jev-judge: inert — set TYPESAFE_API_KEY="sk-..." to enable automatic result calibration',
					"warning",
				);
				return;
			}
			const last = lastStatus.tool
				? `last judgment: ${lastStatus.tool} in ${lastStatus.latencyMs}ms (${lastStatus.at})`
				: "no judgments made yet this session";
			ctx.ui.notify(
				`jev-judge: active — tools: ${enabledTools().join(", ")}, model: ${process.env.JEV_JUDGE_MODEL ?? DEFAULT_MODEL}; ${last}`,
				"info",
			);
		},
	});
}
