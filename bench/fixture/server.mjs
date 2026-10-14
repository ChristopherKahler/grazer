/**
 * The benchmark fixture site.
 *
 * Both login-free tasks are served from here rather than from a real public
 * site. A benchmark's job is to compare three drivers, so anything that varies
 * between runs for reasons unrelated to the driver — a site edit, a CDN hiccup,
 * rate limiting, a cookie banner A/B test — is noise injected straight into the
 * headline number. Local and deterministic means a rerun a month from now is
 * comparable with today's.
 *
 * T1/T2 are the ones that deliberately use real logged-in sites; realism lives
 * there.
 *
 * Routes:
 *   /docs/                 index linking every doc page (T3 entry point)
 *   /docs/<slug>           one doc page; some mention the search term
 *   /apply                 a form (T4)
 *   POST /apply            records the submission, returns a confirmation code
 *   /__submissions         what the server actually received (grader use only)
 *   /healthz               liveness + the run's nonce
 */

import { createServer } from "node:http";

/**
 * T3's corpus. `mentions` is the ground truth: which pages contain the term.
 * Two decoys ("recipe" inside a longer word, and the term only in a code
 * comment) keep a naive Ctrl-F from being a perfect strategy.
 */
const DOCS = [
  { slug: "getting-started", title: "Getting started", mentions: true,
    body: "Install the toolkit and run your first <em>recipe</em> in under a minute." },
  { slug: "configuration", title: "Configuration", mentions: false,
    body: "Every option can be set in the config file or through the environment." },
  { slug: "recipes-overview", title: "Recipes overview", mentions: true,
    body: "A <em>recipe</em> is a named sequence of steps. Recipes compose." },
  { slug: "troubleshooting", title: "Troubleshooting", mentions: false,
    body: "Check the log first. Most failures are a missing permission." },
  { slug: "caching", title: "Caching", mentions: false,
    body: "Results are cached by content hash. Prerecipes are not a thing." },
  { slug: "scheduling", title: "Scheduling", mentions: true,
    body: "Schedule a <em>recipe</em> with cron syntax. Overlapping runs are skipped." },
  { slug: "api-reference", title: "API reference", mentions: false,
    body: "<pre>// a recipe id is a string\nrun(id)</pre> The call returns a handle." },
  { slug: "migration", title: "Migration", mentions: false,
    body: "Version 2 renamed several fields. Update your config before upgrading." },
];

/** The term T3 asks about. */
export const T3_TERM = "recipe";

/**
 * T3's expected answer: slugs whose PROSE mentions the term.
 *
 * `api-reference` mentions it only inside a code block and `caching` only
 * inside "Prerecipes", so both are excluded — the task asks for pages that
 * mention the term, and an agent that greps raw HTML gets those two wrong.
 */
export const T3_EXPECTED_SLUGS = DOCS.filter((d) => d.mentions).map((d) => d.slug);

/** T4's form fields and the values the task tells the agent to enter. */
export const T4_VALUES = {
  name: "Dana Okafor",
  email: "dana@example.test",
  role: "engineer",
  referral: "conference",
  notes: "Interested in the scheduling API.",
};

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title></head><body>${inner}</body></html>`;
}

function docIndex() {
  const items = DOCS.map(
    (d) => `<li><a href="/docs/${d.slug}">${d.title}</a></li>`,
  ).join("");
  return page(
    "Docs index",
    `<h1>Documentation</h1><ul id="doc-list">${items}</ul>`,
  );
}

function docPage(doc) {
  return page(doc.title, `<h1>${doc.title}</h1><p>${doc.body}</p>`);
}

function applyForm() {
  return page(
    "Apply",
    `<h1>Apply</h1>
     <form id="apply-form" method="post" action="/apply">
       <label>Name <input id="name" name="name" required></label>
       <label>Email <input id="email" name="email" type="email" required></label>
       <label>Role
         <select id="role" name="role">
           <option value="">Choose…</option>
           <option value="engineer">Engineer</option>
           <option value="designer">Designer</option>
           <option value="other">Other</option>
         </select>
       </label>
       <fieldset><legend>How did you hear about us?</legend>
         <label><input type="radio" name="referral" value="search" id="ref-search"> Search</label>
         <label><input type="radio" name="referral" value="conference" id="ref-conference"> Conference</label>
         <label><input type="radio" name="referral" value="friend" id="ref-friend"> A friend</label>
       </fieldset>
       <label>Notes <textarea id="notes" name="notes"></textarea></label>
       <button id="submit" type="submit">Submit</button>
     </form>`,
  );
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

/** Deterministic per-submission code, so the grader knows what the page showed. */
function confirmationCode(index) {
  return `GRZ-${String(1000 + index)}`;
}

export async function startBenchFixture({ nonce = String(Date.now()) } = {}) {
  /** Every POST /apply the server actually received. The grader reads this. */
  const submissions = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const send = (status, type, body) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };

    if (url.pathname === "/healthz") {
      return send(200, "application/json", JSON.stringify({ ok: true, nonce }));
    }
    if (url.pathname === "/__submissions") {
      return send(200, "application/json", JSON.stringify({ submissions }));
    }
    if (url.pathname === "/docs" || url.pathname === "/docs/") {
      return send(200, "text/html; charset=utf-8", docIndex());
    }
    if (url.pathname.startsWith("/docs/")) {
      const doc = DOCS.find((d) => d.slug === url.pathname.slice("/docs/".length));
      if (!doc) return send(404, "text/html; charset=utf-8", page("Not found", "<h1>404</h1>"));
      return send(200, "text/html; charset=utf-8", docPage(doc));
    }
    if (url.pathname === "/apply" && request.method === "GET") {
      return send(200, "text/html; charset=utf-8", applyForm());
    }
    if (url.pathname === "/apply" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const fields = parseForm(Buffer.concat(chunks).toString("utf8"));
      const code = confirmationCode(submissions.length);
      submissions.push({ fields, code, at: new Date().toISOString() });
      return send(
        200,
        "text/html; charset=utf-8",
        page("Submitted", `<h1>Thanks</h1><p>Your confirmation code is <strong id="code">${code}</strong>.</p>`),
      );
    }
    if (url.pathname === "/") {
      return send(200, "text/html; charset=utf-8",
        page("Bench fixture", `<h1>Grazer bench fixture</h1><ul><li><a href="/docs/">Docs</a></li><li><a href="/apply">Apply</a></li></ul>`));
    }
    send(404, "text/html; charset=utf-8", page("Not found", "<h1>404</h1>"));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    nonce,
    /** What the server received — the independent path T4's grader reads. */
    submissions: () => submissions.slice(),
    close: () =>
      new Promise((resolve) => {
        server.closeIdleConnections?.();
        server.close(() => resolve());
      }),
  };
}
