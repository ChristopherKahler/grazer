---
id: t4-form
prompt: |
  Open {{BASE_URL}}/apply and fill in the application form with exactly these
  values, then submit it:
    Name: Dana Okafor
    Email: dana@example.test
    Role: Engineer
    How did you hear about us: Conference
    Notes: Interested in the scheduling API.
  After submitting, report the confirmation code the page shows.
requiresLogin: false
origins: []
timeoutMs: 600000
---

## What this measures

The write path: text inputs, a `<select>`, a radio group, a textarea, and a
submit — the interactions that separate a driver which can only read a page from
one that can operate it. It runs against a Grazer-owned fixture, so exercising
"submit" carries no risk of sending anything real.

## Grader

`t4-form.grader.mjs`. Ground truth is `GET /__submissions` — what the server
actually received. That is the independent path: the agent's own account of what
it typed is never trusted, only what arrived.

Two conditions, both required:

1. **The server received the right values.** Every field compared exactly, after
   trimming. The radio and select are where a driver that "clicks near enough"
   quietly fails.
2. **The agent reported the code the server issued.** Proves it read the result
   page rather than declaring success on submit.

A run that submits twice fails: the grader requires exactly one submission, so
a retry loop cannot pass by eventually getting it right.
