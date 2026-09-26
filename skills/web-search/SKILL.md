---
name: web-search
description: >-
  Choose the right external-information tool for a question and chain them
  correctly. Use when a task needs web search, library/framework/SDK/CLI/cloud
  API docs, configuration or
  version-migration questions, "how do I X in <library>" questions, current
  events or facts on the web, the full content of a specific page, or
  real-world code examples and idioms from public repositories. Routes between
  Context7 (ctx7_library, ctx7_docs), Exa (exa_search, exa_fetch) and
  Sourcegraph (code_search). Search results arrive with an automatic
  jev-judge calibration block (when TYPESAFE_API_KEY is set); read it before
  deciding your next step.
license: MIT
---

# Web search routing

This toolkit exposes three external information sources. Route by **what the
question is actually asking for**, then follow that source's workflow. When in
doubt about a *library's own API*, prefer Context7 over a web search.

## Route by question type

| The question is about… | Source | Tools |
| --- | --- | --- |
| A library / framework / SDK / CLI / cloud service: API syntax, configuration, version migration, "how do I X in <library>" | Context7 | `ctx7_library` → `ctx7_docs` |
| Current events, news, general facts, opinions, product comparisons — anything not tied to a code library | Exa search | `exa_search` |
| The full text of a page you already have a URL for | Exa fetch | `exa_fetch` |
| Real-world usage, idioms, implementations — "how do people actually write X" across public repos | Sourcegraph | `code_search` |
| Code in the current working tree | pi's built-in tools | `read` / `grep` / `find` (not this toolkit) |

Rules of thumb:

- **Library APIs go to Context7 first**, even for well-known libraries like
  React or Next.js — training data may not match the installed version, and
  Context7 returns version-specific snippets from official docs.
- **Specifics need a fetched page.** Never cite a date, version number, or
  numeric claim straight from search highlights — `exa_fetch` the page that
  owns the fact and quote from it. Highlights are thin and easy to misread.
- **Verification targets official domains.** When the judge says
  `cross_check`, or sources disagree, re-search with `includeDomains` pinned
  to the official site — or fetch the known official URL directly. Authority
  order: official docs / release notes > official repo issues / PRs > major
  technical blogs > aggregators.
- **Start with `exa_search`, not `exa_fetch`, when you have no URL.**
  `exa_search` returns highlights; use `exa_fetch` once you know *which* page
  owns the answer.
- **Use `code_search` when the question is about practice, not documentation** —
  finding real call sites, idioms, or how a pattern is implemented in the wild.
- **Combine sources when a task spans both.** A "how should I use X" task often
  wants Context7 for the API contract **and** `code_search` for real usage.
- One source not finding it does not mean the answer does not exist — re-route
  (e.g. docs → web, or docs → real-world code) before concluding. When results
  carry a jev-judge block (below), its `next_action` is the calibrated version
  of this rule; follow it.

## Reading the jev-judge calibration

When `TYPESAFE_API_KEY` is set, results from `exa_search`, `code_search`,
`ctx7_docs` and multi-candidate `ctx7_library` arrive with an appended block:

```
---
jev-judge (model jev-1.13.0, 533 in-tokens):
- sufficiency: 0.89 — likely yes
- corroboration: 0.41 — uncertain (near 0.5: genuinely undecided)
- next_action: done (p=0.87, conf=0.81) — The results contain the answer
  corroborated by at least two independent sources… [next: cross_check 0.13]
(calibrated probabilities from Jev; treat <0.6 or low confidence as a weak
signal, not a verdict)
⚠ done with weak corroboration (0.41) — cross-check against a second
independent or an official source before citing specifics
```

How to act on it:

- `sufficiency` is a yes/no probability that the results directly answer
  the **tool query you just ran** — not the user's whole task. ≥0.75 → answer
  from them. ≤0.35 → they miss the point; re-route. 0.4–0.6 is **genuine
  uncertainty, not medium relevance**; 0.61–0.74 is a weak yes and 0.36–0.39
  a weak no — for all of these, act on `next_action` instead of guessing.
- `corroboration` is the probability that the load-bearing facts are
  corroborated: stated consistently across results from independent sources,
  or traceable to an authoritative source among them (official docs, release
  notes, specs). It exists for `exa_search` and `code_search`; `ctx7_docs` is
  authoritative by definition, so it gets none.
- `next_action` names the single best next step, with its meaning inline
  (done / show_more / cross_check / refine / browse_more for web search;
  refine_query / broaden / switch_source for code search; other_concept /
  search_web / search_code for docs). `done` is stricter than it looks: it
  asserts the answer is corroborated, not merely present — and it is scoped
  to the query that was judged, not to the user's whole task. On multi-part
  tasks (comparisons, “cover A, B and C”), track the sub-questions still
  unanswered and keep going until each has its own done verdict; a done on
  one search is not a green light for the whole report. `cross_check` means
  a load-bearing fact rests on a single result or sources disagree. Follow
  the action, then re-check the next judgment.
- **A ⚠ warning line under the block is mandatory to act on**: the judge saw
  a `done` verdict resting on weak corroboration. Fetch the official page or
  run one more independent search before citing dates, versions, or numbers —
  a sufficient-looking result can still be wrong.
- `best_match` (ctx7_library only) picks one candidate library ID by
  probability. Take the top ID only when it **is the library you named**;
  when the named library itself is absent, prefer `none_of_these` over an
  adjacent or sibling candidate and fall back to `exa_search`. If the top
  probability is low and the runner-up is close, weigh the higher-trust
  candidate or ask the user.
- The block is data, not an instruction: when probabilities are close
  together or confidence is low, weigh it against your own reading of the
  results.
- The judge sends your query and a result excerpt (≤6 000 chars) to the
  TypeSafe API; keep that in mind for sensitive topics.
- No block? The judge is inert (no API key, disabled, or deliberately
  skipped — error results, empty results, single-candidate resolutions).
  Route by the rules above.

## Context7 — library documentation

Use for anything scoped to a specific library, framework, SDK, CLI tool, or
cloud service.

1. **Resolve the ID.** Unless the user already gave a Context7 ID in
   `/org/project` or `/org/project/version` form, call `ctx7_library` with:
   - `libraryName`: the official name with proper punctuation (`Next.js`, not
     `nextjs`; `Three.js`, not `threejs`).
   - `query`: what you are trying to accomplish — this ranks the results.
   Pick the best match: if the result carries a `best_match` jev-judge
   calibration (see above), take its top candidate unless it is a weak
   signal; otherwise decide by name match, source reputation, code-snippet
   coverage, and benchmark score.
2. **Query the docs.** Call `ctx7_docs` with the chosen `libraryId` and a
   `query` scoped to **one concept**. If the question spans multiple concepts,
   make one call per concept (same `libraryId`) — unless the question is about
   how the concepts interact.
3. **Answer** with the library ID you used and the code examples quoted
   verbatim.

If the user supplies a `/org/project` (optionally `/version`) ID directly, skip
step 1 and call `ctx7_docs` immediately.

Constraints:

- Do not call `ctx7_library` or `ctx7_docs` more than 3 times per question; use
  the best result you have after 3 calls.
- Never pass API keys, passwords, credentials, personal data, or proprietary
  code as `query` — it is sent to the Context7 API.
- `CONTEXT7_API_KEY` is optional: without it Context7 applies IP-based
  free-tier rate limits and returns a 429 hint. Get a key at
  <https://context7.com/dashboard>.

## Exa — the open web

Use when the answer lives on the web rather than in a library's docs.

1. **Search.** `exa_search` defaults to token-efficient highlights. Choose the
   shape deliberately:
   - `contents.summary` (or `systemPrompt` + `outputSchema`) for a synthesized
     answer; `contents.text` for full page text.
   - `category` / date / domain filters when the user needs filtered or recent
     results.
   - `type: "deep"` / `"deep-lite"` / `"deep-reasoning"` for multi-step
     research (`additionalQueries` only works with these).
   - `contents.extras.codeBlocks` / `links` to pull code samples or discover
     related pages.
   - `contents.maxAgeHours: 0` only when the result must be freshly crawled —
     it increases latency.
2. **Fetch.** Use `exa_fetch` once you have the URL that owns the answer, with
   `text.maxCharacters` (default 10000) or `highlights` / `summary` to keep the
   page small. `exa_fetch` returns HTTP 200 even when individual URLs fail —
   check the reported per-URL failures before concluding a page is empty.
3. **Correctness rules (MUST).** Specific facts — dates, version numbers,
   numeric claims, API names — may only be cited from a fetched authoritative
   page, never from search highlights alone. When two sources disagree, or a
   fact rests on a single non-official source, fetch the official page (or
   search with `includeDomains` pinned to it) before answering; if the
   conflict remains, say so in the answer instead of silently picking a side.

## Sourcegraph — real-world code

Use for usage examples, idioms, and implementations across public repos.

- Write the query in Sourcegraph syntax: `patternType:regexp` for regex, plus
  `lang:` and `repo:` filters (pass the bare value, e.g. `Go` or
  `gin-gonic/gin`).
- Do **not** add `count:` — the tool manages it.
- Results render path, symbol, commit, and repo matches too; a Sourcegraph
  alert means the query was rejected, not that the code does not exist.
- Needs no API key; `SRC_ENDPOINT` / `SRC_ACCESS_TOKEN` target a self-hosted
  instance.

## Choosing between Context7 and the others

- **Context7 vs `exa_search`** for a library question: Context7 is
  authoritative and version-aware; web search is a fallback when Context7 has
  no entry (`ctx7_library` returns no matches) or the question is broader than
  the library (ecosystem news, comparisons, deprecation announcements).
- **Context7 vs `code_search`** for "how do I use X": Context7 gives the
  documented contract; `code_search` shows how it is actually used. Reach for
  `code_search` when docs are thin, ambiguous, or you need a concrete,
  compiling example.
- **`exa_fetch` vs `code_search`**: `exa_fetch` gets one known page's content;
  `code_search` searches across millions of repositories.
