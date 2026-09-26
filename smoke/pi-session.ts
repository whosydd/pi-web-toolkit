// pi-session.ts — shared runner for headless `pi -p` A/B sessions.
// Extracted from compare-judge.ts so fact-eval.ts reuses the exact same
// trace extraction (tool calls, judge hits detected via details.jevJudge).

import { spawn } from "node:child_process";

export const AGENT_TOOLS = "read,bash,exa_search,exa_fetch,ctx7_library,ctx7_docs,code_search";

const SESSION_TIMEOUT_MS = 5 * 60_000;

export const ARMS: Array<{ label: string; env: Record<string, string> }> = [
	{ label: "OFF", env: { JEV_JUDGE: "off" } },
	{ label: "ON", env: {} },
];

export interface RunTrace {
	wallMs: number;
	toolCalls: string[];
	/** one "name(args…)" entry per tool call, for explaining judge skips. */
	toolInputs: string[];
	/** toolName + judged answers for every tool result whose details.jevJudge was merged by the hook. */
	judgeHits: string[];
	finalText: string;
}

export function runPiSession(
	task: { name: string; prompt: string },
	arm: { label: string; env: Record<string, string> },
	cwd: string,
	opts: { quiet?: boolean } = {},
): Promise<RunTrace> {
	const args = [
		"--mode", "json",
		"--print",
		"--no-session",
		"-t", AGENT_TOOLS,
		"--", task.prompt,
	];
	if (!opts.quiet) {
		console.log(`  $ JEV_JUDGE=${arm.env.JEV_JUDGE ?? "(unset)"} pi ${args.join(" ")}`);
	}
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn("pi", args, {
			cwd,
			env: { ...process.env, ...arm.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const toolCalls: string[] = [];
		const toolInputs: string[] = [];
		const judgeHits: string[] = [];
		let finalText = "";
		let buffer = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), SESSION_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				let rec: any;
				try {
					rec = JSON.parse(line);
				} catch {
					continue; // not JSONL — ignore
				}
				if (rec.type === "message_end" && rec.message?.role === "assistant") {
					for (const b of rec.message.content ?? []) {
						if (b.type === "toolCall") {
							const name = b.name ?? b.toolName ?? "?";
							toolCalls.push(name);
							toolInputs.push(`${name}(${JSON.stringify(b.arguments ?? b.input ?? {}).slice(0, 140)})`);
						}
						if (b.type === "text" && typeof b.text === "string" && b.text.trim()) finalText = b.text;
					}
				}
				if (rec.type === "turn_end") {
					for (const tr of rec.toolResults ?? []) {
						// genuine hook output merges details.jevJudge — text mentions of the
						// marker alone (e.g. the agent reading SKILL.md) are not judgments
						if (tr?.details?.jevJudge) {
							const parts: string[] = [];
							const answers = tr.details.jevJudge.answers as Record<string, any> | undefined;
							for (const [id, a] of Object.entries(answers ?? {})) {
								if (a?.type === "noul" && typeof a.noul === "number") parts.push(`${id}=${a.noul.toFixed(2)}`);
								else if (a?.type === "choice" && typeof a.choice === "string") {
									const p = a.probabilities?.[a.choice];
									parts.push(`${id}=${a.choice}${typeof p === "number" ? `(${p.toFixed(2)})` : ""}`);
								}
							}
							judgeHits.push(
								`${tr.toolName} | ${parts.join(" ") || "?"} | ${tr.details.jevJudge.model} in ${tr.details.jevJudge.latencyMs}ms`,
							);
						}
					}
				}
			}
		});
		child.stderr.on("data", (c: Buffer) => process.stderr.write(`    [pi] ${c}`));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && !finalText) {
				reject(new Error(`pi exited with code ${code}`));
				return;
			}
			resolve({ wallMs: Date.now() - started, toolCalls, toolInputs, judgeHits, finalText });
		});
	});
}
