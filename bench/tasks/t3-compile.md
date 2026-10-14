---
id: t3-compile
prompt: |
  Open {{BASE_URL}}/docs/ . Every page listed there is a documentation page.
  Find every documentation page whose text mentions the word "recipe", and
  report the title and URL of each one.
  Do not count a page where the word appears only inside a code block, and do
  not count a page where it appears only as part of a longer word.
  Output ONLY lines of the form: TITLE — URL
  One line per matching page, and nothing else — no preamble, no table, no
  commentary, and no lines for pages that do not match.
requiresLogin: false
origins: []
timeoutMs: 600000
---

## What this measures

Multi-page navigate-and-compile: the agent has to visit eight pages, read each,
and apply a judgement the page text does not label. It is the closest of the
four to what an agent actually does on the web, and the only one where the cost
scales with page count — which is where a per-page-expensive driver should show
up.

## Grader

`t3-compile.grader.mjs`. Ground truth is the fixture's own `T3_EXPECTED_SLUGS`,
which is derived from the same `DOCS` table the server renders from, so the
expected set cannot drift from what was served.

Grading extracts every `/docs/<slug>` URL from the agent's answer and compares
as a **set**: order does not matter, but a missing page or an extra one fails.

Two pages are deliberate traps, and both are *excluded* from the expected set:

- `api-reference` mentions "recipe" only inside a `<pre>` code block.
- `caching` contains "Prerecipes", the word as a substring only.

An agent that fetches raw HTML and greps will include both and fail. That is the
point: the task says "mentions the word", and reading a page is not the same as
matching a string in its markup.
