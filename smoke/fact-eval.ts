// fact-eval.ts — correctness regression eval for web-research answers.
//
// A fixed suite of fact-heavy questions, each with ground-truth tokens that
// were verified against official pages (nodejs.org, github releases,
// typescriptlang.org). Questions run through headless pi sessions per arm;
// grading is deterministic: the final answer must contain every ground-truth
// token (case-insensitive). Purpose: measure the factual error rate of the
// OFF vs ON arms so jev-judge / skill changes can be validated by numbers
// instead of eyeballing single A/B runs.
//
// Grading caveat: token presence proves the fact survived into the answer; it
// cannot catch wrong-but-differently-worded claims. Conversely, an exact-token
// miss can still be a correct answer phrased differently — list accepted
// equivalents (e.g. ["26.0.0", "v26"]) where wording legitimately varies.
// Keep truths exact (versions, ISO dates) so a match is meaningful.
//
// Usage:
//   node smoke/fact-eval.ts                          # all questions × both arms × 1 run
//   node smoke/fact-eval.ts --arm ON                 # one arm
//   node smoke/fact-eval.ts --n 3                    # 3 repetitions per cell
//   node smoke/fact-eval.ts --q node-strip-backport,tsx-compat-fix
//
// Keys: TYPESAFE_API_KEY (ON arm), EXA_API_KEY. Live APIs — manual smoke tool,
// not part of npm test.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_TOOLS, ARMS, runPiSession, type RunTrace } from "./pi-session.ts";

interface FactQuestion {
	id: string;
	prompt: string;
	/** Every token must appear in the final answer (case-insensitive); an
	 *  array lists accepted alternatives, any one of which counts. */
	truth: Array<string | string[]>;
	/** Verified-true tokens that are nice-to-have (reported as hit rate, not required). */
	bonusTokens?: string[];
	/** Official page the ground truth was verified against. */
	source: string;
	/** Official domain that a correct answer should plausibly cite. */
	officialDomain?: string;
}

const QUESTIONS: FactQuestion[] = [
	{
		id: "node-strip-backport",
		prompt:
			"只做检索和回答,不要修改任何文件。Node.js 把 type stripping 默认启用回移植到 v22 LTS 的是哪个版本?它发布于哪一天?回答必须包含确切版本号和 ISO 格式日期(YYYY-MM-DD),并给出来源链接,控制在 120 字以内。",
		truth: ["22.18.0", "2025-07-31"],
		source: "https://nodejs.org/en/blog/release/v22.18.0",
		officialDomain: "nodejs.org",
	},
	{
		id: "node-strip-stable",
		prompt:
			"只做检索和回答,不要修改任何文件。Node.js 的 type stripping 在哪些版本被标记为稳定(Stable)?回答必须列出全部确切版本号,并给出来源链接,控制在 120 字以内。",
		truth: ["24.12.0", "25.2.0"],
		source: "https://nodejs.org/api/typescript.html",
		officialDomain: "nodejs.org",
	},
	{
		id: "node-transform-removed",
		prompt:
			"只做检索和回答,不要修改任何文件。Node.js 哪个版本移除了 --experimental-transform-types 标志?回答必须包含确切版本号,并给出来源链接,控制在 120 字以内。",
		truth: ["26.0.0"],
		source: "https://nodejs.org/api/typescript.html",
		officialDomain: "nodejs.org",
	},
	{
		id: "ts-erasable-only",
		prompt:
			"只做检索和回答,不要修改任何文件。TypeScript 哪个版本引入了 erasableSyntaxOnly 编译选项?回答必须包含确切版本号,并给出来源链接,控制在 120 字以内。",
		truth: ["5.8"],
		source: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html",
		officialDomain: "typescriptlang.org",
	},
	{
		id: "tsx-compat-fix",
		prompt:
			"只做检索和回答,不要修改任何文件。Node.js 22.18.0 默认启用 type stripping 后,tsx 运行器出现兼容性破坏(nodejs/node#59364)。该问题在 tsx 的哪个版本修复?回答必须包含确切版本号,并给出来源链接,控制在 120 字以内。",
		truth: ["4.20.4"],
		source: "https://github.com/privatenumber/tsx/releases/tag/v4.20.4",
		officialDomain: "github.com",
	},
	{
		id: "node-krypton-lts",
		prompt:
			"只做检索和回答,不要修改任何文件。Node.js 24 进入 LTS 时采用的代号是什么?该代号从哪个具体版本开始使用?回答必须包含代号与确切版本号,并给出来源链接,控制在 120 字以内。",
		truth: ["Krypton", "24.11.0"],
		source: "https://nodejs.org/en/blog/release/v24.11.0",
		officialDomain: "nodejs.org",
	},
	{
		// composite: the multi-fact task where single-fact questions show no
		// errors but the earlier A/B did — graded on token hit rate
		id: "research-composite",
		prompt:
			"只做检索和回答,不要修改任何文件。调研任务:Node.js 对 TypeScript 的原生支持(type stripping)的现状。报告需覆盖:1) 从哪个版本起默认启用,经历了哪些版本与命令行标志的变化;2) 当前已知限制(如 enum、namespace 等语法不支持);3) tsx / ts-node 等社区工具受影响的情况;4) 附 3-5 个可核实来源链接。输出一份结构化中文调研报告,400-600 字。",
		truth: ["22.6.0", "23.6.0", "22.18.0", "24.12.0", "25.2.0", ["26.0.0", "v26"], "4.20.4"],
		bonusTokens: ["2025-07-31", "22.7.0", "erasableSyntaxOnly"],
		source: "https://nodejs.org/api/typescript.html + https://github.com/privatenumber/tsx/releases/tag/v4.20.4",
		officialDomain: "nodejs.org",
	},
];

function grade(finalText: string, q: FactQuestion): { pass: boolean; missing: string[]; hitRate: number; bonusHit: string[] } {
	const haystack = finalText.toLowerCase();
	const isHit = (t: string | string[]) => (Array.isArray(t) ? t : [t]).some((alt) => haystack.includes(alt.toLowerCase()));
	const missing = q.truth.filter((t) => !isHit(t)).map((t) => (Array.isArray(t) ? t.join(" | ") : t));
	const bonusHit = (q.bonusTokens ?? []).filter((t) => haystack.includes(t.toLowerCase()));
	const total = q.truth.length + (q.bonusTokens?.length ?? 0);
	const hit = q.truth.length - missing.length + bonusHit.length;
	return { pass: missing.length === 0, missing, hitRate: total ? hit / total : 1, bonusHit };
}

interface Row {
	arm: string;
	run: number;
	id: string;
	pass: boolean;
	missing: string[];
	hitRate: number;
	officialCited: boolean;
	wallMs: number;
	calls: number;
	judgeHits: string[];
	trace: RunTrace;
}

async function main(filterArm?: string, n = 1, qFilter?: string): Promise<void> {
	const ids = qFilter?.split(",").map((s) => s.trim()).filter(Boolean);
	const questions = QUESTIONS.filter((q) => !ids?.length || ids.includes(q.id));
	const arms = ARMS.filter((a) => !filterArm || a.label === filterArm.toUpperCase());
	if (!questions.length || !arms.length) {
		console.error(`no matching question/arm (questions: ${QUESTIONS.map((q) => q.id).join(", ")}; arms: ${ARMS.map((a) => a.label).join(", ")})`);
		process.exit(1);
	}
	if (ids?.length) {
		const unknown = ids.filter((id) => !QUESTIONS.some((q) => q.id === id));
		if (unknown.length) {
			console.error(`unknown question ids: ${unknown.join(", ")}`);
			process.exit(1);
		}
	}

	const workdir = mkdtempSync(join(tmpdir(), "jev-fact-"));
	const outDir = join(tmpdir(), "jev-fact-eval");
	mkdirSync(outDir, { recursive: true });
	console.log(`fact-eval — ${questions.length} question(s) × ${arms.length} arm(s) × ${n} run(s), cwd ${workdir}, tools: ${AGENT_TOOLS}\n`);

	const rows: Row[] = [];
	for (const arm of arms) {
		for (let run = 1; run <= n; run++) {
			for (const q of questions) {
				process.stdout.write(`[${arm.label} #${run}] ${q.id} … `);
				try {
					const trace = await runPiSession({ name: q.id, prompt: q.prompt }, arm, workdir, { quiet: true });
					const { pass, missing, hitRate } = grade(trace.finalText, q);
					const officialCited = q.officialDomain ? trace.finalText.toLowerCase().includes(q.officialDomain) : true;
					rows.push({ arm: arm.label, run, id: q.id, pass, missing, hitRate, officialCited, wallMs: trace.wallMs, calls: trace.toolCalls.length, judgeHits: trace.judgeHits, trace });
					console.log(`${pass ? "PASS" : `FAIL (missing: ${missing.join(", ")})`} | hit ${(hitRate * 100).toFixed(0)}% | ${(trace.wallMs / 1000).toFixed(0)}s | ${trace.toolCalls.length} calls | ${trace.judgeHits.length} judged`);
				} catch (err: any) {
					console.log(`ERROR: ${err.message}`);
					rows.push({ arm: arm.label, run, id: q.id, pass: false, missing: ["<run failed>"], hitRate: 0, officialCited: false, wallMs: 0, calls: 0, judgeHits: [], trace: { wallMs: 0, toolCalls: [], toolInputs: [], judgeHits: [], finalText: "" } });
				}
			}
		}
	}

	console.log("\n=== summary ===");
	for (const arm of arms) {
		const armRows = rows.filter((r) => r.arm === arm.label);
		const passed = armRows.filter((r) => r.pass).length;
		const official = armRows.filter((r) => r.officialCited).length;
		const avgWall = armRows.reduce((s, r) => s + r.wallMs, 0) / (armRows.length || 1);
		const avgHit = armRows.reduce((s, r) => s + r.hitRate, 0) / (armRows.length || 1);
		console.log(`arm ${arm.label}: ${passed}/${armRows.length} facts correct | token hit rate ${(avgHit * 100).toFixed(0)}% | official source cited in ${official}/${armRows.length} | avg ${(avgWall / 1000).toFixed(0)}s/run`);
		for (const r of armRows.filter((r) => !r.pass)) {
			console.log(`  ✗ ${r.id} (run ${r.run}) — missing: ${r.missing.join(", ")} | hit ${(r.hitRate * 100).toFixed(0)}%`);
		}
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = join(outDir, `fact-eval-${stamp}.md`);
	writeFileSync(file, [
		`# fact-eval — ${new Date().toISOString()}`,
		``,
		`questions: ${questions.map((q) => q.id).join(", ")}`,
		`arms: ${arms.map((a) => a.label).join(", ")} | runs per cell: ${n} | tools: ${AGENT_TOOLS}`,
		``,
		`| arm | run | question | result | missing | hit | official cited | wall | calls | judged |`,
		`|---|---|---|---|---|---|---|---|---|---|`,
		...rows.map((r) => `| ${r.arm} | ${r.run} | ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${r.missing.join(", ") || "—"} | ${(r.hitRate * 100).toFixed(0)}% | ${r.officialCited ? "yes" : "no"} | ${(r.wallMs / 1000).toFixed(0)}s | ${r.calls} | ${r.judgeHits.length} |`),
		``,
		...rows.filter((r) => !r.pass).flatMap((r) => [
			`## FAIL ${r.id} (${r.arm} #${r.run})`,
			``,
			`missing tokens: ${r.missing.join(", ")}`,
			`tool inputs: ${r.trace.toolInputs.join(" | ") || "(none)"}`,
			`judge hits: ${r.judgeHits.join("; ") || "none"}`,
			``,
			`answer:`,
			``,
			r.trace.finalText || "(empty)",
			``,
		]),
	].join("\n"));
	console.log(`\nreport: ${file}`);
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const arm = flag("--arm");
const n = Number(flag("--n") ?? 1);
const q = flag("--q");
await main(arm, Number.isFinite(n) && n > 0 ? n : 1, q);
