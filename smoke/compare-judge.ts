// compare-judge.ts — A/B the jev-judge calibration against live tools.
//
// Layer 1 (default): run a fixed set of real searches once, then show what the
//   model would see with the judge off (raw passthrough) vs on (appended
//   calibration block) — including judge latency, in-token overhead and the
//   deterministic skip heuristics.
// Layer 2 (--agents): run identical research tasks through headless `pi -p`
//   sessions with JEV_JUDGE=off vs on and compare the tool-call traces.
//
// Usage:
//   node smoke/compare-judge.ts                      # layer 1 (fast)
//   node smoke/compare-judge.ts --agents             # layer 2, all tasks × both arms
//   node smoke/compare-judge.ts --agents web-facts   # one task, both arms
//   node smoke/compare-judge.ts --agents web-facts ON # a single cell
//   node smoke/compare-judge.ts --agents research OFF --full  # full report, saved to $TMPDIR/jev-report
//
// Keys: TYPESAFE_API_KEY (judging + the ON arm), EXA_API_KEY, CONTEXT7_API_KEY
// optional. Live APIs — manual smoke tool, not part of npm test.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerContext7 from "../extensions/context7.ts";
import registerExa from "../extensions/exa-search.ts";
import registerSourcegraph from "../extensions/sourcegraph.ts";
import { judgeToolResult, judgeWanted } from "../extensions/jev-judge.ts";
import { AGENT_TOOLS, ARMS, runPiSession, type RunTrace } from "./pi-session.ts";

const apiKey = process.env.TYPESAFE_API_KEY ?? null;
if (!apiKey) {
	console.error("TYPESAFE_API_KEY is not set — the judge is inert; nothing to compare.");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

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

const textOf = (r: any) =>
	(r?.content ?? [])
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n");

const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? "(empty)";

// ---------------------------------------------------------------------------
// layer 1 — tool-result A/B on live searches
// ---------------------------------------------------------------------------

const ctx7 = capture(registerContext7);
const sg = capture(registerSourcegraph);
const exa = capture(registerExa);

interface Case {
	label: string;
	toolName: string;
	input: Record<string, unknown>;
	run: () => Promise<any>;
	/** Why the judge would skip this case (when judgeWanted says no). */
	expectSkip?: string;
}

const cases: Case[] = [
	{
		label: 'exa_search — specific question (likely answerable)',
		toolName: "exa_search",
		input: { query: "Next.js 15 removed default fetch caching — what replaced it?", numResults: 3 },
		run: () => exa.get("exa_search")!.execute("c1", { query: "Next.js 15 removed default fetch caching — what replaced it?", numResults: 3 }),
	},
	{
		label: 'exa_search — vague query (likely needs refining)',
		toolName: "exa_search",
		input: { query: "javascript stuff", numResults: 3 },
		run: () => exa.get("exa_search")!.execute("c2", { query: "javascript stuff", numResults: 3 }),
	},
	{
		label: 'exa_search — instant mode (skip heuristic expected)',
		toolName: "exa_search",
		input: { query: "current node lts version", type: "instant", numResults: 3 },
		run: () => exa.get("exa_search")!.execute("c3", { query: "current node lts version", type: "instant", numResults: 3 }),
		expectSkip: "trivial instant search",
	},
	{
		label: 'code_search — real-world usage',
		toolName: "code_search",
		input: { query: "patternType:regexp unstable_cache\\(", lang: "TypeScript" },
		run: () => sg.get("code_search")!.execute("c4", { query: "patternType:regexp unstable_cache\\(", lang: "TypeScript" }),
	},
	{
		label: 'ctx7_library — ambiguous name (multi-candidate)',
		toolName: "ctx7_library",
		input: { libraryName: "TanStack Query", query: "server-side usage in RSC" },
		run: () => ctx7.get("ctx7_library")!.execute("c5", { libraryName: "TanStack Query", query: "server-side usage in RSC" }),
	},
];

/** Skill rule for acting on a sufficiency probability (mirrors skills/web-search). */
function sufficiencyRule(p: number): string {
	if (p >= 0.75) return "≥0.75 → answer from these results";
	if (p <= 0.35) return "≤0.35 → results miss the point; re-route";
	return "0.36–0.74 → follow the judged next_action (0.4–0.6 uncertainty; 0.61–0.74 weak yes; 0.36–0.39 weak no)";
}

async function runLayer1(): Promise<void> {
	console.log(`jev-judge tool-result A/B (key: ${apiKey!.slice(0, 7)}…, model: ${process.env.JEV_JUDGE_MODEL ?? "jev-latest"})\n`);

	let judged = 0;
	let skipped = 0;
	let totalLatencyMs = 0;
	let totalInTokens = 0;
	const skipReasons = new Map<string, number>();

	for (const [i, c] of cases.entries()) {
		console.log(`=== ${i + 1}. ${c.label} ===`);
		const result = await c.run().catch((err) => ({ content: [{ type: "text", text: `TOOL FAILED: ${err.message}` }] }));
		const raw = textOf(result);
		console.log(`[off] model sees ${raw.length} chars of raw results | ${firstLine(raw).slice(0, 100)}`);

		const wanted = judgeWanted(c.toolName, c.input, raw);
		if (!wanted) {
			skipped++;
			const reason = c.expectSkip ?? "skip heuristic";
			skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
			console.log(`[on ] judge skipped (${reason}) — no block, zero overhead\n`);
			continue;
		}

		const out = await judgeToolResult(c.toolName, c.input, result.content, { isError: result.isError, apiKey });
		if (!out || "failure" in out) {
			console.log(`[on ] judge ${out ? "failed" : "produced nothing"}: ${out && "failure" in out ? out.reason : "n/a"} — raw result still passes through\n`);
			continue;
		}
		judged++;
		totalLatencyMs += out.meta.latencyMs;
		const tokens = Number(out.appendedText.match(/, (\d+) in-tokens/)?.[1] ?? 0);
		totalInTokens += tokens;
		console.log(`[on ] judge ${out.meta.latencyMs}ms via ${out.meta.model} (${tokens} in-tokens):`);
		console.log(
			out.appendedText.split("\n").map((l) => `      | ${l}`).join("\n"),
		);
		const suff = Number(out.appendedText.match(/sufficiency: ([\d.]+)/)?.[1]);
		if (!Number.isNaN(suff)) console.log(`      → skill rule: ${sufficiencyRule(suff)}`);
		console.log();
	}

	console.log("=== layer-1 summary ===");
	console.log(`judged ${judged}/${cases.length}, skipped ${skipped}${[...skipReasons].map(([r, n]) => ` (${r} ×${n})`).join("")}`);
	console.log(`judge overhead: ${(totalLatencyMs / 1000).toFixed(1)}s total (avg ${judged ? Math.round(totalLatencyMs / judged) : 0}ms), ${totalInTokens} in-tokens sent to api.typesafe.ai`);
	console.log("with the judge off the model sees identical raw results, zero added latency/tokens — and zero signal about whether to keep searching.");
}

// ---------------------------------------------------------------------------
// layer 2 — headless pi sessions with the judge off vs on
// ---------------------------------------------------------------------------

const AGENT_TASKS = [
	{
		name: "web-facts",
		prompt:
			"只做检索和回答,不要修改任何文件。用网络检索查证:Node.js 当前的活跃 LTS 大版本号是多少,以及该版本引入的两个值得注意的运行时特性。回答给出两个来源 URL,控制在 150 字以内。",
	},
	{
		name: "library-docs",
		prompt:
			"只做检索和回答,不要修改任何文件。查证 Next.js App Router 中按需缓存失效的做法:涉及哪些 API(如 revalidateTag 等),各用一句话说明用途。需要官方文档依据,注明你查到的来源。",
	},
	{
		name: "research",
		prompt:
			"只做检索和回答,不要修改任何文件。调研任务:Node.js 对 TypeScript 的原生支持(type stripping)的现状。报告需覆盖:1) 从哪个版本起默认启用,经历了哪些版本与命令行标志的变化;2) 当前已知限制(如 enum、namespace 等语法不支持);3) tsx / ts-node 等社区工具受影响的情况;4) 附 3-5 个可核实来源链接。输出一份结构化中文调研报告,400-600 字。",
	},
];

async function runLayer2(filterTask?: string, filterArm?: string, full = false): Promise<void> {
	const tasks = AGENT_TASKS.filter((t) => !filterTask || t.name === filterTask);
	const arms = ARMS.filter((a) => !filterArm || a.label === filterArm.toUpperCase());
	if (!tasks.length || !arms.length) {
		console.error(`no matching task/arm (tasks: ${AGENT_TASKS.map((t) => t.name).join(", ")}; arms: ${ARMS.map((a) => a.label).join(", ")})`);
		process.exit(1);
	}
	const outDir = join(tmpdir(), "jev-report");
	if (full) mkdirSync(outDir, { recursive: true });
	const workdir = mkdtempSync(join(tmpdir(), "jev-ab-"));
	console.log(`jev-judge agent A/B — ${tasks.length} task(s) × ${arms.length} arm(s), cwd ${workdir}, tools: ${AGENT_TOOLS}\n`);

	for (const task of tasks) {
		for (const arm of arms) {
			console.log(`=== task "${task.name}" — judge ${arm.label} ===`);
			try {
				const trace = await runPiSession(task, arm, workdir);
				console.log(`  wall: ${(trace.wallMs / 1000).toFixed(1)}s | tool calls: ${trace.toolCalls.length}${trace.toolCalls.length ? ` [${trace.toolCalls.join(" → ")}]` : ""} | results carrying jev-judge block: ${trace.judgeHits.length}`);
				for (const hit of trace.judgeHits) console.log(`    [hit] ${hit}`);
				if (full) {
					for (const ti of trace.toolInputs) console.log(`    [call] ${ti}`);
					const file = join(outDir, `${task.name}-${arm.label}.md`);
					writeFileSync(file, [
						`# jev-judge A/B — task "${task.name}" — arm ${arm.label}`, "",
						`- wall: ${(trace.wallMs / 1000).toFixed(1)}s`,
						`- tool calls: ${trace.toolCalls.join(" → ") || "(none)"}`,
					`- tool inputs: ${trace.toolInputs.join(" | ") || "(none)"}`,
						`- judged results: ${trace.judgeHits.length ? trace.judgeHits.join("; ") : "none"}`,
						`- prompt: ${task.prompt}`, "", "## report", "", trace.finalText, "",
					].join("\n"));
					console.log(`  saved: ${file}`);
					console.log(`  answer:\n${trace.finalText}`);
				} else {
					console.log(`  answer: ${trace.finalText.slice(0, 400).replace(/\n+/g, " ")}${trace.finalText.length > 400 ? "…" : ""}`);
				}
			} catch (err: any) {
				console.log(`  RUN FAILED: ${err.message}`);
			}
			console.log();
		}
	}
	console.log("=== layer-2 notes ===");
	console.log("single run per arm — treat differences as indicative, not statistically significant.");
	console.log("detection: a hit is a tool result whose details.jevJudge was merged by the hook; a mere text");
	console.log("mention of 'jev-judge (' (e.g. the agent reading SKILL.md) is not a judgment and is ignored.");
	console.log("what to look for: ON-arm traces stop earlier on sufficient results (sufficiency ≥0.75 → done),");
	console.log("re-route on misses (≤0.35), and disambiguate ctx7_library via best_match; OFF-arm relies on generic routing only.");
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes("--agents")) {
	const rest = argv.filter((a) => a !== "--agents" && a !== "--full");
	await runLayer2(rest[0], rest[1], argv.includes("--full"));
} else {
	await runLayer1();
}
