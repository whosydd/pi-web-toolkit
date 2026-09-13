# pi-web-toolkit

A [pi](https://pi.dev) package with three independent extensions (toggle each one via `pi config`) plus a `web-search` routing skill:

- **Context7** — `ctx7_library` / `ctx7_docs`: up-to-date, version-aware library and framework documentation from [Context7](https://context7.com)
- **Exa** — `exa_search` / `exa_fetch`: high-quality web search with category/date/domain filters, selectable content extraction (highlights/text/summary/links/code blocks), freshness control, subpage crawling, and optional structured synthesis
- **Sourcegraph** — `code_search`: search code across millions of public open-source repositories (free, no API key)

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

Get an Exa API key at [exa.ai](https://exa.ai) and a Context7 key at [context7.com/dashboard](https://context7.com/dashboard). If `EXA_API_KEY` is missing, pi warns once at session start that the exa tools are disabled. `ctx7_*` and `code_search` are always registered — Context7 works keyless at IP-based free-tier limits.

## Tools

| Tool           | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `ctx7_library` | Resolve a package/product name to a Context7 library ID (`/org/project`, optionally `/version`) |
| `ctx7_docs`    | Fetch documentation and code examples for a resolved Context7 library ID |
| `exa_search`   | Web search with filters, content modes, freshness, code/link extraction, structured output |
| `exa_fetch`    | Fetch page text/highlights/summary by URL with freshness and subpages |
| `code_search`  | Code search across public open-source repos via the Sourcegraph streaming API |

## Routing skill

`skills/web-search` ships with the package and is loaded on demand. It maps a question to the right source — library docs → Context7, web/current facts → Exa, real-world usage → Sourcegraph — and describes each tool's workflow and limits.

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
