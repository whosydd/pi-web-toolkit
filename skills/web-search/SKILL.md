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
  Sourcegraph (code_search).
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
- **Start with `exa_search`, not `exa_fetch`, when you have no URL.**
  `exa_search` returns highlights; use `exa_fetch` once you know *which* page
  owns the answer.
- **Use `code_search` when the question is about practice, not documentation** —
  finding real call sites, idioms, or how a pattern is implemented in the wild.
- **Combine sources when a task spans both.** A "how should I use X" task often
  wants Context7 for the API contract **and** `code_search` for real usage.
- One source not finding it does not mean the answer does not exist — re-route
  (e.g. docs → web, or docs → real-world code) before concluding.

## Context7 — library documentation

Use for anything scoped to a specific library, framework, SDK, CLI tool, or
cloud service.

1. **Resolve the ID.** Unless the user already gave a Context7 ID in
   `/org/project` or `/org/project/version` form, call `ctx7_library` with:
   - `libraryName`: the official name with proper punctuation (`Next.js`, not
     `nextjs`; `Three.js`, not `threejs`).
   - `query`: what you are trying to accomplish — this ranks the results.
   Pick the best match by name match, source reputation, code-snippet coverage,
   and benchmark score.
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
