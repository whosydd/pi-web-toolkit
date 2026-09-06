# pi-web-toolkit

A [pi](https://pi.dev) package with three independent extensions (toggle each one via `pi config`):

- **Context7** — `ctx7_library` / `ctx7_docs`: search and fetch up-to-date official library documentation (runs via `npx ctx7`, no install required)
- **Exa** — `exa_search` / `exa_fetch`: high-quality web search with category/date/domain filters, plus full-text page fetching
- **Sourcegraph** — `code_search`: search code across millions of public GitHub repositories (free, no API key)

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
| `EXA_API_KEY`      | no       | `exa_search` / `exa_fetch` are not registered          |
| `CONTEXT7_API_KEY` | no       | Context7 falls back to free-tier rate limits           |

Get an Exa API key at [exa.ai](https://exa.ai). pi-web-toolkit notifies you at session start which tools are active.

## Tools

| Tool           | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `ctx7_library` | Resolve a library name to a Context7 documentation ID              |
| `ctx7_docs`    | Fetch official docs/code snippets for a Context7 library ID        |
| `exa_search`   | Web search with optional category, date range, and domain filters  |
| `exa_fetch`    | Fetch full text content of webpages by URL                         |
| `code_search`  | Regex/code search across public GitHub repos via Sourcegraph       |

## License

MIT
