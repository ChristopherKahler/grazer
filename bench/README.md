# Grazer benchmark

The same web tasks, run by the same agent, through three drivers — Grazer,
Playwright MCP, and the Chrome extension — measuring wall-clock, tokens, cost,
tool turns and success.

The approved methodology lives in `.paul/phases/05-benchmark/05-01-PLAN.md`
(sections *G0 DESIGN DRAFT* and *G0 AMENDMENT*). This file is the operating
manual; that one is the argument.

## Run it

**From a plain shell. Not from inside an agent session.**

```sh
node bench/run.mjs --task t3-compile --driver grazer --reps 1   # one cell
node bench/run.mjs                                              # everything, 3 reps
node bench/report.mjs bench/results/<timestamp>                  # render REPORT.md
```

`run.mjs` refuses to start when `CLAUDECODE` is set. That is not fussiness:
the same `claude --print` invocation was measured from inside a session
returning in 2 s, in 23 minutes, and twice not at all. Wall-clock is a headline
metric, so a harness whose own invocation path adds an unbounded, variable delay
cannot measure it.

## Before you run it

Two environment facts, both measured on this machine, both capable of making a
run fail for reasons that have nothing to do with any driver:

**Run from an interactive shell.** `run.mjs` already refuses when `CLAUDECODE`
is set, but a non-interactive Windows Task Scheduler session is a second trap:
a cold headless Chrome start there overran the product's 15 s
`DevToolsActivePort` window and the rep died with
`exit 3: browser did not write DevToolsActivePort within 15000ms`. The same
start from an interactive shell takes about 2 s. The grazer driver now retries
`browser start` once on a fresh home, which absorbs a cold first start — but the
retry is a cushion, not a licence to run headless-detached.

**Expect the first `grazer` call to be `grazer nodejs`.** The driver puts
`<repo>/bin` first on the agent's PATH so `grazer` resolves to `grazer.exe`,
matching what `skills/grazer/SKILL.md` tells the agent to type. Without it the
agent follows its own documentation, gets "not recognized", and burns turns
finding `node bin/grazer.mjs` — a cost that measures packaging, not transport.

## What is here

| Path | What |
|---|---|
| `tasks/<id>.md` | prompt + metadata; the prompt is byte-identical across drivers |
| `tasks/<id>.grader.mjs` | `groundTruth(ctx)` and `grade(answer, truth)` |
| `fixture/server.mjs` | the local site both login-free tasks run against |
| `drivers/index.mjs` | the three drivers behind one interface |
| `lib/metrics.mjs` | the CLI result parser — read its comment before touching tokens |
| `lib/secrets.mjs` | the tripwire that refuses to write a result carrying a credential |
| `run.mjs` / `report.mjs` | the runner and the renderer |
| `results/<timestamp>/` | one JSON per rep, plus `REPORT.md` |

## Three things that are easy to get wrong

**Tokens are not `usage.input_tokens`.** Measured on a real run: that field said
10 while the run billed 36,144 of input. Almost everything lands in
`cache_creation_input_tokens` and `cache_read_input_tokens`. Input is the sum of
all three; `lib/metrics.mjs` is the only place that should compute it.

**Absent is not zero.** A metric the CLI did not report is `null` in the result
and `—` in the report. A driver that reported nothing must never look like a
driver that used nothing.

**Medians cover passing reps only**, with the success count shown as `n/N`.
Averaging a crashed run's wall-clock is how a benchmark makes the driver that
fails fastest look fastest.

## Status

- **T3** (multi-page compile) and **T4** (form fill and submit) are built and
  run against the local fixture.
- **T1** and **T2** need a real logged-in account; the site and account are
  not chosen yet, and their task files do not exist yet.
- The Playwright and Chrome drivers need profile seeding from a Grazer Sync
  bundle, which needs `grazer-replay --default-context` (plan 04-03). Until it
  lands they run unauthenticated, which is fine for T3/T4 and not for T1/T2.
- Reports are labelled **PILOT** until the model and rep count are settled.
