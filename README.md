# pi-web-toolkit

A [pi](https://pi.dev) package with four independent extensions (toggle each one via `pi config`) plus a `web-search` routing skill:

- **Context7** — `ctx7_library` / `ctx7_docs`: up-to-date, version-aware library and framework documentation from [Context7](https://context7.com)
- **Exa** — `exa_search` / `exa_fetch`: high-quality web search with category/date/domain filters, selectable content extraction (highlights/text/summary/links/code blocks), freshness control, subpage crawling, and optional structured synthesis
- **Sourcegraph** — `code_search`: search code across millions of public open-source repositories (free, no API key)
- **jev-judge** — automatic TypeSafe (Jev) calibration appended to web-search tool results: every result arrives with probability-calibrated verdicts (is it sufficient? what's the best next step?) before the model sees it; persistent account failures (empty balance, bad key) raise throttled user warnings

The bundled `web-search` skill teaches the agent which source to use for a given question and how to chain the tools.

## Install

```bash
pi install git:github.com/whosydd/pi-web-toolkit
```

Or try it out without installing:

```bash
pi -e git:github.com/whosydd/pi-web-toolkit
```

## Configuration

| Variable           | Required | Effect when missing                                    |
| ------------------ | -------- | ------------------------------------------------------ |
| `CONTEXT7_API_KEY` | no | `ctx7_*` fall back to Context7's IP-based free-tier rate limits |
| `EXA_API_KEY` | no | `exa_search` / `exa_fetch` are not registered |
| `SRC_ENDPOINT` | no | `code_search` queries `https://sourcegraph.com` |
| `SRC_ACCESS_TOKEN` | no | `code_search` queries the public index anonymously (rate limited, no private repos) |
| `TYPESAFE_API_KEY` | no | `jev-judge` is inert: search results pass through uncalibrated |
| `JEV_JUDGE` | no | set to `off` to disable `jev-judge` entirely |
| `JEV_JUDGE_TOOLS` | no | comma-separated tool list `jev-judge` judges (default: `exa_search,code_search,ctx7_library,ctx7_docs`) |
| `JEV_JUDGE_MODEL` | no | Jev model id for `jev-judge` (default: `jev-latest`) |

Get an Exa API key at [exa.ai](https://exa.ai) and a Context7 key at [context7.com/dashboard](https://context7.com/dashboard). If `EXA_API_KEY` is missing, pi warns once at session start that the exa tools are disabled. `ctx7_*` and `code_search` are always registered — Context7 works keyless at IP-based free-tier limits.

Get a TypeSafe key at [docs.typesafe.ai](https://docs.typesafe.ai) for `jev-judge`. It shares the `TYPESAFE_API_KEY` with the separately-installed typesafe extension but does not depend on it.

## Tools

| Tool           | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `ctx7_library` | Resolve a package/product name to a Context7 library ID (`/org/project`, optionally `/version`) |
| `ctx7_docs`    | Fetch documentation and code examples for a resolved Context7 library ID |
| `exa_search`   | Web search with filters, content modes, freshness, code/link extraction, structured output |
| `exa_fetch`    | Fetch page text/highlights/summary by URL with freshness and subpages |
| `code_search`  | Code search across public open-source repos via the Sourcegraph streaming API |

## Routing skill

`skills/web-search` ships with the package and is loaded on demand. It maps a question to the right source — library docs → Context7, web/current facts → Exa, real-world usage → Sourcegraph — and describes each tool's workflow and limits. When `jev-judge` is active it also teaches the agent how to read the appended calibration block.

## jev-judge notes

- **No new tools.** `jev-judge` hooks `tool_result` instead: after `exa_search` / `code_search` / `ctx7_docs` (and multi-candidate `ctx7_library`) finish, a fixed-template judgment request goes to TypeSafe's System One API and a compact block is appended to the result —

  ```
  ---
  jev-judge (model jev-1.13.0, 533 in-tokens):
  - sufficiency: 0.89 — likely yes
  - next_action: show_more (p=0.87, conf=0.81) — A specific result clearly holds the full answer… [next: browse_more 0.13]
  (calibrated probabilities from Jev; treat <0.6 or low confidence as a weak signal, not a verdict)
  ```

- **Multi-candidate `ctx7_library` gets disambiguation.** When Context7 returns several library IDs, one `choice` question asks which ID is most likely the intended library; the chosen option's meaning is rendered inline. Single-candidate and empty resolutions are skipped (deterministic cases).
- **Silent degradation.** A missing key, `JEV_JUDGE=off`, API errors, timeouts (15s), or skip heuristics (error results, empty/too-short results, trivial `instant` searches) all pass the original result through untouched. An unavailable judge must never break the search.
- **Account failures warn the user.** Persistent judge failures — 402 (insufficient balance), 401 or 403 (key problems) — surface a `ui.notify` warning that names the fix (top up at docs.typesafe.ai, check `TYPESAFE_API_KEY`), throttled to once per 10 minutes and skipped in modes without a UI. Transient failures (timeouts, 429/529, 5xx) stay fully silent. `/jev-judge` always shows the last failure, marked *since recovered* once a later judgment succeeds.
- **Retries are bounded.** Network failures and 429/529 are retried twice with backoff honoring `retry-after`; other HTTP errors fail fast.
- **Data, not conclusions.** The block carries probabilities, the chosen option's meaning, and the runner-up. The model still decides; the bundled skill teaches how to read it. Low-confidence verdicts are labeled as weak signals.
- **What leaves your machine.** The tool's query parameters and a truncated excerpt of its result (≤ 6 000 chars) are sent to `api.typesafe.ai`. Keep secrets and proprietary code in mind before enabling the judge on sensitive searches.
- **Status.** `/jev-judge` shows the watched tools, model, the last judgment made this session, and the last failure (with a recovery marker; an unresolved failure turns the notice into a warning).

## `ctx7_*` notes

- **Resolve first.** `ctx7_library` takes `libraryName` (official spelling, e.g. `Next.js`) and `query`; `ctx7_docs` takes the returned `libraryId` and a single-concept `query`. Skip resolution when the user already provides a `/org/project` (optionally `/version`) ID.
- **Version-aware.** Append a version to the ID (`/vercel/next.js/v14.3.0-canary.87`) to pin docs to it.
- **Errors are surfaced as tool errors.** A 429 explains the free-tier/key distinction, 401 points at the `ctx7sk` key format, 404 means the ID does not exist, and an empty body says the docs are not finalized.
- **The query is sent to Context7.** Keep secrets, credentials and proprietary code out of it.

## `code_search` notes

- **Queries use Sourcegraph syntax.** `patternType:regexp` for regex, plus `lang:`, `repo:`, `file:`, `type:` filters. `count:` is managed by the tool (default 5, max 20) — a top-level `count:` is replaced; quote it if you need a literal `count:` inside a pattern.
- **Match types are rendered, not filtered.** `type:path` / `type:commit` / `type:repo` / `type:symbol` results are shown as such instead of being reported as "no results".
- **Errors and truncation are surfaced.** Sourcegraph answers HTTP 200 even for a broken query, so query alerts, unparseable stream events and real truncation are reported instead of being mistaken for "this code does not exist".
- **Warnings are filtered to what is actionable.** A `shard-match-limit` skip is not reported as truncation when the search simply filled the requested `count:` (that is the expected stop condition), and the "archived/forked repos are excluded" hints are only shown when a query returns no matches — where they are what stops the model from concluding the code does not exist.
- **Rate limiting and network failures are told apart.** Only a real 429 or a timeout mentions `SRC_ACCESS_TOKEN`; a DNS/TLS/proxy failure is reported as-is.
- **At most 10 files are rendered** (only for `count:` up to 20) — the header states how many were shown and whether Sourcegraph reported more matches in total.
- **Content line numbers are shown 1-based** (the API reports them 0-based).
- **Nothing is sent anywhere except to Sourcegraph.** The endpoint defaults to the public anonymous index; set `SRC_ENDPOINT` / `SRC_ACCESS_TOKEN` (same variables as [`src-cli`](https://github.com/sourcegraph/src-cli)) to search a self-hosted instance. Keep in mind that query text leaves your machine.
- The public index is a free, best-effort endpoint: requests are retried twice and capped at 15s, but heavy use may be rate limited.

## License

MIT
