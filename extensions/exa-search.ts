// Exa: web search + page contents
//
// Environment variables:
//   EXA_API_KEY required — without it the exa_* tools are not registered

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ok = (text: string, details?: unknown) => ({
	content: [{ type: "text" as const, text }],
	details,
});

const fail = (text: string, details?: unknown) => ({
	content: [{ type: "text" as const, text }],
	details,
	isError: true,
});

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(n)));

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Surface the official error envelope ({requestId, error, tag}) instead of raw JSON.
async function httpError(prefix: string, res: Response) {
	const raw = await res.text();
	let detail = raw;
	let details: Record<string, unknown> = { status: res.status };
	try {
		const parsed = JSON.parse(raw);
		const parts = [parsed?.error, parsed?.tag].filter(isNonEmptyString);
		if (parts.length) detail = parts.join(" — ");
		if (parsed?.requestId || parsed?.tag) details = { ...details, requestId: parsed?.requestId, tag: parsed?.tag };
	} catch {
		// Non-JSON error body; keep the raw text.
	}
	return fail(`${prefix} (${res.status}): ${detail}`, details);
}

// --- Bounds and enums ---

const MAX_URLS = 100;
const MAX_TEXT_CHARS = 10000;
const MAX_SUBPAGES = 100;
const MAX_AGE_HOURS = 720;
const MAX_LIVECRAWL_TIMEOUT = 90000;
const MAX_ADDITIONAL_QUERIES = 10;
const MAX_EXTRAS = 1000;
const MAX_RENDERED_LINKS = 20;
const MAX_RENDERED_CODE_BLOCKS = 3;
const MAX_RENDERED_CODE_CHARS = 1000;
const MAX_RENDERED_SUBPAGES = 20;

// `company` and `people` reject startPublishedDate/endPublishedDate/excludeDomains
// with a 400, so those filters must be dropped when either category is used.
const RESTRICTED_CATEGORIES = new Set(["company", "people"]);

// `people` only accepts LinkedIn domains in includeDomains.
const LINKEDIN_DOMAIN = /(^|\.)linkedin\.com(\/|$)/i;

// `additionalQueries` is only honored by the deep search variants.
const DEEP_TYPES = new Set(["deep-lite", "deep", "deep-reasoning"]);

const PAGE_SECTIONS = ["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"];

// --- Content-selection parameters (shared by /search and /contents) ---
// On /search these nest under `contents`; on /contents they are top-level.

const SectionParam = Type.Array(
	Type.Union(PAGE_SECTIONS.map((s) => Type.Literal(s))),
	{ description: "Page sections to include/exclude" }
);

const TextParam = Type.Union([
	Type.Boolean(),
	Type.Object({
		maxCharacters: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TEXT_CHARS })),
		verbosity: Type.Optional(
			Type.Union([Type.Literal("compact"), Type.Literal("standard"), Type.Literal("full")], {
				description: "Text rendering verbosity (default 'compact')",
			})
		),
		includeHtmlTags: Type.Optional(Type.Boolean()),
		includeSections: Type.Optional(SectionParam),
		excludeSections: Type.Optional(SectionParam),
	}),
]);

const HighlightsParam = Type.Union([
	Type.Boolean(),
	Type.Object({
		query: Type.Optional(Type.String()),
		maxCharacters: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TEXT_CHARS })),
	}),
]);

const SummaryParam = Type.Union([Type.Boolean(), Type.Object({ query: Type.Optional(Type.String()) })]);

const ExtrasParam = Type.Object(
	{
		links: Type.Optional(Type.Number({ description: "Links to extract per page (0-1000)" })),
		richLinks: Type.Optional(Type.Number({ description: "Links with anchor text to extract per page (0-1000)" })),
		codeBlocks: Type.Optional(Type.Number({ description: "Code blocks to extract per page (0-1000)" })),
	},
	{ description: "Extra data to extract from each page" }
);

const CommonContentParams = {
	maxAgeHours: Type.Optional(
		Type.Number({
			description:
				"Content freshness in hours: 0 = always livecrawl, -1 = cache only, omit for cache-first with livecrawl fallback",
		})
	),
	livecrawlTimeout: Type.Optional(Type.Number({ description: "Livecrawl timeout in ms (default 10000)" })),
	subpages: Type.Optional(Type.Number({ description: `Subpages to crawl per result, 0-${MAX_SUBPAGES}` })),
	subpageTarget: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Terms used to prioritize which subpages to crawl",
		})
	),
	extras: Type.Optional(ExtrasParam),
};

// --- Normalizers: official camelCase shape with bounds applied ---

function normalizeText(input: any) {
	if (input == null || typeof input !== "object") return input;
	const out: Record<string, any> = {};
	if (input.maxCharacters != null) out.maxCharacters = clamp(input.maxCharacters, 1, MAX_TEXT_CHARS);
	if (input.verbosity != null) out.verbosity = input.verbosity;
	if (input.includeHtmlTags != null) out.includeHtmlTags = input.includeHtmlTags;
	if (input.includeSections != null) out.includeSections = input.includeSections;
	if (input.excludeSections != null) out.excludeSections = input.excludeSections;
	return out;
}

function normalizeHighlights(input: any) {
	if (input == null || typeof input !== "object") return input;
	const out: Record<string, any> = {};
	if (input.query != null) out.query = input.query;
	if (input.maxCharacters != null) out.maxCharacters = clamp(input.maxCharacters, 1, MAX_TEXT_CHARS);
	return out;
}

function normalizeExtras(input: any) {
	if (input == null) return undefined;
	const out: Record<string, number> = {};
	for (const key of ["links", "richLinks", "codeBlocks"]) {
		const value = input[key];
		if (value != null && value > 0) out[key] = clamp(value, 0, MAX_EXTRAS);
	}
	return Object.keys(out).length ? out : undefined;
}

function normalizeContentOptions(input: any) {
	const src = input ?? {};
	const out: Record<string, any> = {};
	if (src.text != null) out.text = normalizeText(src.text);
	if (src.highlights != null) out.highlights = normalizeHighlights(src.highlights);
	if (src.summary != null) out.summary = src.summary;
	if (src.maxAgeHours != null) out.maxAgeHours = clamp(src.maxAgeHours, -1, MAX_AGE_HOURS);
	if (src.livecrawlTimeout != null) out.livecrawlTimeout = clamp(src.livecrawlTimeout, 1, MAX_LIVECRAWL_TIMEOUT);
	if (src.subpages != null) out.subpages = clamp(src.subpages, 0, MAX_SUBPAGES);
	if (src.subpageTarget != null) out.subpageTarget = src.subpageTarget;
	const extras = normalizeExtras(src.extras);
	if (extras) out.extras = extras;
	return out;
}

// --- Renderers ---

const renderSubpages = (indent: string, subpages: any[]) => {
	const shown = subpages.slice(0, MAX_RENDERED_SUBPAGES);
	const more = subpages.length > shown.length ? ` (+${subpages.length - shown.length} more)` : "";
	return `${indent}Subpages: ${shown.map((s: any) => s.url).join(", ")}${more}`;
};

function renderExtras(extras: any, indent: string): string[] {
	if (!extras) return [];
	const lines: string[] = [];

	if (extras.codeBlocks?.length) {
		lines.push(`${indent}Code blocks:`);
		for (const block of extras.codeBlocks.slice(0, MAX_RENDERED_CODE_BLOCKS)) {
			const text = String(block?.text ?? "").slice(0, MAX_RENDERED_CODE_CHARS);
			lines.push(`${indent}\`\`\`${block?.source ?? ""}\n${text}\n${indent}\`\`\``);
		}
		if (extras.codeBlocks.length > MAX_RENDERED_CODE_BLOCKS) {
			lines.push(`${indent}… ${extras.codeBlocks.length - MAX_RENDERED_CODE_BLOCKS} more code block(s)`);
		}
	}

	const links = [
		...new Set<string>([
			...(extras.links ?? []),
			...(extras.richLinks ?? []).map((l: any) => l?.url).filter(isNonEmptyString),
		]),
	];
	if (links.length) {
		const shown = links.slice(0, MAX_RENDERED_LINKS);
		const more = links.length > shown.length ? ` (+${links.length - shown.length} more)` : "";
		lines.push(`${indent}Links: ${shown.join(", ")}${more}`);
	}

	return lines;
}

export default function (pi: ExtensionAPI) {
	const EXA_API_KEY = process.env.EXA_API_KEY;

	if (!EXA_API_KEY) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("EXA_API_KEY not set, exa tools disabled", "warning");
		});
		return;
	}

	// Web search (basic + advanced merged)
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web using Exa AI search engine. Supports semantic search modes, category/date/domain filters, geo targeting, and selectable content extraction (highlights, text, summary, links, code blocks).",
		promptSnippet: "Search the web for current information using Exa",
		promptGuidelines: [
			"Use exa_search for web searches — it provides higher quality results than basic web search.",
			"Use exa_search with category/date/domain filters when the user needs filtered or recent results.",
			"exa_search defaults to highlights (token-efficient). Request contents.summary or systemPrompt+outputSchema when you need a synthesized answer, or contents.text for full page text.",
			"Use contents.extras.codeBlocks to pull code samples from pages and contents.extras.links to discover related pages.",
			"Set contents.maxAgeHours: 0 only when results must be freshly crawled; it increases latency.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(
				Type.Number({ description: "Number of results, 1-100 (omit to use the API default of 10)" })
			),
			type: Type.Optional(
				Type.Union(
					[
						Type.Literal("auto"),
						Type.Literal("fast"),
						Type.Literal("instant"),
						Type.Literal("deep-lite"),
						Type.Literal("deep"),
						Type.Literal("deep-reasoning"),
					],
					{
						description:
							"Search mode (default 'auto'): 'fast'/'instant' for low latency, 'deep-lite'/'deep'/'deep-reasoning' for multi-step research",
					}
				)
			),
			category: Type.Optional(
				Type.String({
					description:
						"Category filter: 'company', 'publication', 'news', 'personal site', 'financial report', or 'people'",
				})
			),
			startPublishedDate: Type.Optional(
				Type.String({ description: "Filter results published after this date (ISO format, e.g. 2024-01-01)" })
			),
			endPublishedDate: Type.Optional(
				Type.String({ description: "Filter results published before this date (ISO format)" })
			),
			includeDomains: Type.Optional(
				Type.Array(Type.String(), { description: "Only include results from these domains" })
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), { description: "Exclude results from these domains" })
			),
			additionalQueries: Type.Optional(
				Type.Array(Type.String(), {
					description: `Extra query variants, only used with deep search types (max ${MAX_ADDITIONAL_QUERIES})`,
				})
			),
			userLocation: Type.Optional(
				Type.String({ description: "Two-letter ISO country code for geo-targeting, e.g. 'US' or 'GB'" })
			),
			moderation: Type.Optional(Type.Boolean({ description: "Filter unsafe content from results" })),
			systemPrompt: Type.Optional(
				Type.String({
					description: "Instructions guiding synthesized output and deep-search planning, e.g. source preferences",
				})
			),
			outputSchema: Type.Optional(
				Type.Object({}, {
					additionalProperties: true,
					description:
						"JSON Schema for synthesized output. When set, the response includes output.content (matching the schema) plus output.grounding citations",
				})
			),
			contents: Type.Optional(
				Type.Object(
					{
						text: Type.Optional(TextParam),
						highlights: Type.Optional(HighlightsParam),
						summary: Type.Optional(SummaryParam),
						...CommonContentParams,
					},
					{ description: "Content extraction options (default: { highlights: true })" }
				)
			),
		}),
		async execute(toolCallId, params, signal) {
			// Keep the request minimal: only send what the caller actually asked for.
			const contents = normalizeContentOptions(params.contents);
			if (contents.text == null && contents.highlights == null && contents.summary == null) {
				contents.highlights = true;
			}

			const type = params.type ?? "auto";
			const body: Record<string, any> = { query: params.query, type, contents };
			if (params.numResults != null) body.numResults = clamp(params.numResults, 1, 100);
			if (params.category) body.category = params.category;
			if (params.userLocation) body.userLocation = params.userLocation;
			if (params.moderation) body.moderation = true;
			if (params.systemPrompt) body.systemPrompt = params.systemPrompt;
			if (params.outputSchema) body.outputSchema = params.outputSchema;

			// `additionalQueries` only works with deep search types.
			const additionalQueries = (params.additionalQueries ?? []).filter(isNonEmptyString);
			const useAdditionalQueries = additionalQueries.length > 0 && DEEP_TYPES.has(type);
			if (useAdditionalQueries) body.additionalQueries = additionalQueries.slice(0, MAX_ADDITIONAL_QUERIES);

			const restricted = params.category != null && RESTRICTED_CATEGORIES.has(params.category);
			const isPeople = params.category === "people";

			if (params.startPublishedDate && !restricted) body.startPublishedDate = params.startPublishedDate;
			if (params.endPublishedDate && !restricted) body.endPublishedDate = params.endPublishedDate;
			if (params.includeDomains) {
				// `people` only accepts LinkedIn domains; drop the rest to avoid a 400.
				const domains = isPeople
					? params.includeDomains.filter((d) => LINKEDIN_DOMAIN.test(d))
					: params.includeDomains;
				if (domains.length) body.includeDomains = domains;
			}
			if (params.excludeDomains && !restricted) body.excludeDomains = params.excludeDomains;

			try {
				const res = await fetch("https://api.exa.ai/search", {
					method: "POST",
					headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
					body: JSON.stringify(body),
					signal,
				});

				if (!res.ok) {
					return await httpError("Exa search failed", res);
				}

				const data: any = await res.json();
				const blocks = (data.results ?? []).map((r: any, i: number) => {
					const lines = [`${i + 1}. **${r.title ?? r.url}**`, `   ${r.url}`];
					const meta = [r.author, r.publishedDate?.slice?.(0, 10)].filter(isNonEmptyString).join(" · ");
					if (meta) lines.push(`   ${meta}`);
					if (r.highlights?.length) lines.push(`   ${r.highlights.join(" … ")}`);
					if (r.summary) lines.push(`   Summary: ${r.summary}`);
					if (r.text) lines.push(`   ${r.text}`);
					if (r.subpages?.length) lines.push(renderSubpages("   ", r.subpages));
					lines.push(...renderExtras(r.extras, "   "));
					return lines.join("\n");
				});

				let out = blocks.join("\n\n");

				// Synthesized output (present when outputSchema is provided).
				if (data.output?.content != null) {
					const content =
						typeof data.output.content === "string"
							? data.output.content
							: "```json\n" + JSON.stringify(data.output.content, null, 2) + "\n```";
					const citations = [
						...new Set<string>(
							(data.output.grounding ?? []).flatMap((g: any) =>
								(g.citations ?? []).map((c: any) => c.url).filter(isNonEmptyString)
							)
						),
					];
					const sources = citations.length ? `\n\nSources:\n${citations.map((u) => `- ${u}`).join("\n")}` : "";
					out = `**Synthesized answer:**\n${content}${sources}${out ? `\n\n---\n\n${out}` : ""}`;
				}

				if (additionalQueries.length > 0 && !useAdditionalQueries) {
					out += `\n\n_Note: additionalQueries ignored — only supported with deep search types (got '${type}')._`;
				}

				return ok(out || "No results found", {
					requestId: data.requestId,
					searchTime: data.searchTime,
					costDollars: data.costDollars,
				});
			} catch (err: any) {
				return fail(`Exa search failed: ${err.message}`);
			}
		},
	});

	// Fetch webpage contents by URL
	pi.registerTool({
		name: "exa_fetch",
		label: "Exa Fetch",
		description:
			"Fetch page content by URL: full text (default, capped via text.maxCharacters), highlights, summary, links, and/or code blocks. Supports freshness control and subpage crawling.",
		promptSnippet: "Fetch webpage content by URL using Exa",
		promptGuidelines: [
			"Use exa_fetch once you have the URL of the page that owns the answer; exa_search only returns highlights, not the full page.",
			"Keep pages small: pass text.maxCharacters (default 10000) or pick highlights/summary instead of full text.",
			"exa_fetch answers HTTP 200 even when individual URLs fail, so check the reported per-URL failures before concluding a page has no content.",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String(), { description: `URLs to fetch (max ${MAX_URLS})` }),
			text: Type.Optional(TextParam),
			highlights: Type.Optional(HighlightsParam),
			summary: Type.Optional(SummaryParam),
			...CommonContentParams,
		}),
		async execute(toolCallId, params, signal) {
			const urls = params.urls.slice(0, MAX_URLS);
			if (urls.length === 0) {
				return fail("Exa fetch failed: no URLs provided");
			}
			const truncation =
				params.urls.length > MAX_URLS
					? `Only the first ${MAX_URLS} of ${params.urls.length} URLs were fetched (API limit).\n\n`
					: "";

			// Default to capped full text; if the caller picked any mode, honor exactly that.
			const hasMode = params.text != null || params.highlights != null || params.summary != null;
			const content = normalizeContentOptions({
				text: hasMode ? params.text : { maxCharacters: MAX_TEXT_CHARS },
				highlights: params.highlights,
				summary: params.summary,
				maxAgeHours: params.maxAgeHours,
				livecrawlTimeout: params.livecrawlTimeout,
				subpages: params.subpages,
				subpageTarget: params.subpageTarget,
				extras: params.extras,
			});
			if (content.text == null && content.highlights == null && content.summary == null) {
				content.text = { maxCharacters: MAX_TEXT_CHARS };
			}

			try {
				const res = await fetch("https://api.exa.ai/contents", {
					method: "POST",
					headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
					body: JSON.stringify({ urls, ...content }),
					signal,
				});

				if (!res.ok) {
					return await httpError("Exa fetch failed", res);
				}

				const data: any = await res.json();
				const sections = (data.results ?? []).map((r: any) => {
					const parts = [`**${r.title ?? r.url}**`, r.url];
					const meta = [r.author, r.publishedDate?.slice?.(0, 10)].filter(isNonEmptyString).join(" · ");
					if (meta) parts.push(meta);
					if (r.highlights?.length) parts.push(`Highlights:\n${r.highlights.map((h: string) => `- ${h}`).join("\n")}`);
					if (r.summary) parts.push(`Summary:\n${r.summary}`);
					if (r.text) parts.push(r.text);
					if (r.subpages?.length) {
						const shown = r.subpages.slice(0, MAX_RENDERED_SUBPAGES);
						const more =
							r.subpages.length > shown.length ? `\n- … (+${r.subpages.length - shown.length} more)` : "";
						parts.push(`Subpages:\n${shown.map((s: any) => `- ${s.url}`).join("\n")}${more}`);
					}
					const extras = renderExtras(r.extras, "");
					if (extras.length) parts.push(extras.join("\n"));
					return parts.join("\n\n");
				});

				// /contents returns HTTP 200 even when individual URLs fail, so per-URL
				// errors only show up in `statuses` and must be surfaced explicitly.
				const failures = (data.statuses ?? []).filter((s: any) => s.status === "error");
				let out = sections.join("\n\n---\n\n");
				if (failures.length) {
					const lines = failures
						.map((s: any) => {
							const code = s.error?.httpStatusCode ? ` (HTTP ${s.error.httpStatusCode})` : "";
							return `- ${s.id} — ${s.error?.tag ?? "ERROR"}${code}`;
						})
						.join("\n");
					const report = `**Failed to fetch ${failures.length} URL(s):**\n${lines}`;
					out = out ? `${out}\n\n${report}` : report;
				}

				const details = { requestId: data.requestId, searchTime: data.searchTime, costDollars: data.costDollars };

				if (!out) {
					return ok(`${truncation}No content fetched`, details);
				}
				// Every URL failed → surface as a tool error.
				if (sections.length === 0) {
					return fail(`${truncation}${out}`, details);
				}
				return ok(`${truncation}${out}`, details);
			} catch (err: any) {
				return fail(`Exa fetch failed: ${err.message}`);
			}
		},
	});
}
