# pi-web-toolkit

A [pi](https://pi.dev) package with two independent extensions (toggle each one via `pi config`):

- **Exa** — `exa_search` / `exa_fetch`: high-quality web search with category/date/domain filters, selectable content extraction (highlights/text/summary/links/code blocks), freshness control, subpage crawling, and optional structured synthesis
- **Sourcegraph** — `code_search`: search code across millions of public open-source repositories (free, no API key)

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
| `EXA_API_KEY` | no | `exa_search` / `exa_fetch` are not registered |
| `SRC_ENDPOINT` | no | `code_search` queries `https://sourcegraph.com` |
| `SRC_ACCESS_TOKEN` | no | `code_search` queries the public index anonymously (rate limited, no private repos) |

Get an Exa API key at [exa.ai](https://exa.ai). pi-web-toolkit notifies you at session start which tools are active.

Need Context7 library docs? Use the official extension instead — `pi install npm:@upstash/context7-pi`.

## Tools

| Tool           | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `exa_search`   | Web search with filters, content modes, freshness, code/link extraction, structured output |
| `exa_fetch`    | Fetch page text/highlights/summary by URL with freshness and subpages |
| `code_search`  | Code search across public open-source repos via the Sourcegraph streaming API |

## `code_search` notes

- **Queries use Sourcegraph syntax.** `patternType:regexp` for regex, plus `lang:`, `repo:`, `file:`, `type:` filters. `count:` is managed by the tool (default 5, max 20) — a top-level `count:` is replaced; quote it if you need a literal `count:` inside a pattern.
- **Match types are rendered, not filtered.** `type:path` / `type:commit` / `type:repo` / `type:symbol` results are shown as such instead of being reported as "no results".
- **Errors and truncation are surfaced.** Sourcegraph answers HTTP 200 even for a broken query, and silently excludes archived/forked repositories by default; both are reported back to the model instead of being mistaken for "this code does not exist".
- **Content line numbers are shown 1-based** (the API reports them 0-based).
- **Nothing is sent anywhere except to Sourcegraph.** The endpoint defaults to the public anonymous index; set `SRC_ENDPOINT` / `SRC_ACCESS_TOKEN` (same variables as [`src-cli`](https://github.com/sourcegraph/src-cli)) to search a self-hosted instance. Keep in mind that query text leaves your machine.
- The public index is a free, best-effort endpoint: requests are retried twice and capped at 15s, but heavy use may be rate limited.

## License

MIT
