/**
 * A CDP client whose every await has a deadline.
 *
 * On 2026-09-03 a full `node --test` run hung for 18 minutes:
 * `Extensions.loadUnpacked` never replied — the browser had come up holding
 * only `about:blank` and no service worker — and the live test's `call()`
 * awaited that reply forever. `node --test` has no global timeout, so one
 * silent reply blocked the whole run and the detail of six other failures was
 * lost with it.
 *
 * A test that cannot finish is worse than a test that fails: a failure names
 * itself, a hang destroys the report. So nothing here waits without a bound.
 */

export const DEFAULT_CDP_TIMEOUT_MS = 15_000;

/**
 * Marks a rejection as "nothing answered", so callers can tell it apart from a
 * CDP protocol error. The difference is load-bearing: a protocol error means
 * the browser understood and refused, which a fallback path may legitimately
 * handle, while a timeout means the browser is not answering at all and
 * quietly falling back would hide it.
 */
export const CDP_TIMEOUT = "CDP_TIMEOUT";

/**
 * Race a promise against a deadline.
 *
 * The rejection names the label and the ELAPSED time rather than the configured
 * timeout, because the two differ under load and the elapsed figure is the one
 * that tells you whether you were near the edge or nowhere close.
 *
 * @param {Promise<T>} promise the work to bound
 * @param {string} label what to name in the error, normally the CDP method
 * @param {{ timeoutMs?: number, onTimeout?: () => void }} [options]
 *   `onTimeout` runs before the rejection, to drop whatever the caller
 *   registered while waiting.
 * @returns {Promise<T>}
 * @template T
 */
export function withDeadline(promise, label, { timeoutMs = DEFAULT_CDP_TIMEOUT_MS, onTimeout } = {}) {
  const startedAt = Date.now();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        const error = new Error(`${label} timed out after ${Date.now() - startedAt} ms`);
        error.code = CDP_TIMEOUT;
        reject(error);
      }
    }, timeoutMs);
  });
  // clearTimeout on every path: a pending timer keeps the process alive, which
  // would turn a passing test file into one that never exits.
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Wrap a WebSocket-like object in a CDP client.
 *
 * The socket is injected rather than constructed here so the unit test can hand
 * in one that never answers — proving the deadline without a browser.
 *
 * @param {{ send: Function, close: Function, onmessage?: Function,
 *           onopen?: Function, onerror?: Function }} socket
 * @param {{ label?: string, timeoutMs?: number }} [options]
 */
export function createCdpClient(socket, { label = "cdp", timeoutMs = DEFAULT_CDP_TIMEOUT_MS } = {}) {
  const pending = new Map();
  let nextId = 0;

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // Not a frame we can match; the deadline still covers the waiter.
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };

  // The open deadline starts as soon as the client exists, because the socket
  // is already connecting. That means it can reject before — or without —
  // anyone awaiting it, and an unrejected-but-unhandled promise would surface
  // as an unhandled rejection against whatever test happens to be running,
  // blaming the wrong one. A detached no-op catch marks it handled; awaiting
  // `opened` still sees the rejection, because that is a separate branch.
  const opened = withDeadline(
    new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`could not connect to ${label}`));
    }),
    `${label} open`,
    { timeoutMs },
  );
  opened.catch(() => {});

  const call = async (method, params, sessionId, options = {}) => {
    nextId += 1;
    const id = nextId;
    const reply = await withDeadline(
      new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      method,
      {
        timeoutMs: options.timeoutMs ?? timeoutMs,
        // Drop the waiter, or a socket that answers late resolves a promise
        // nobody holds and the map grows for the life of the run.
        onTimeout: () => pending.delete(id),
      },
    );
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  };

  return {
    call,
    opened,
    close: () => socket.close(),
    /** Waiters still outstanding — the unit test asserts this does not leak. */
    get pendingCount() {
      return pending.size;
    },
  };
}
