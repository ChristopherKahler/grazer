/**
 * CDP WebSocket client.
 *
 * One socket to Chrome's browser-level endpoint, multiplexing every request and
 * every attached page session over it (flat-session mode). Node 22's global
 * `WebSocket` (undici) connects to `/devtools/browser/<id>` without Chrome
 * needing `--remote-allow-origins`, so there is no `ws` dependency here.
 *
 * Two send paths exist on purpose:
 *   - `send(method, ...)` numbers the request itself; used by our own helpers.
 *   - `sendRaw(message)` keys the request by the id the CALLER already chose,
 *     so a harness payload's id survives end to end untouched.
 */

import { grazerErrorFor } from "../grazer/errors.js";
import {
  isCdpResponse,
  type CdpEvent,
  type CdpFrame,
  type CdpRequest,
  type CdpResponse,
  type CdpSend,
} from "./types.js";

/** Guards leaks only — the harness's own 15 s timeout is meant to win. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ConnectOptions {
  /** Debug port; the browser websocket URL is discovered via /json/version. */
  port?: number;
  /** An already-known browser websocket URL, bypassing discovery. */
  wsUrl?: string;
  /** How long to wait for the socket to open. */
  openTimeoutMs?: number;
}

/**
 * An Error carrying the CDP `error.code` alongside its message.
 *
 * It also keeps the FULL response frame. A protocol error is a legitimate CDP
 * response, not a transport failure: the harness's own `handleMessage` reads
 * `data.error` and rejects the matching request itself. The runtime adapter
 * therefore has to hand the untouched frame back, so rejecting here must not
 * destroy it.
 */
export class CdpProtocolError extends Error {
  readonly code: number;
  readonly data?: string;
  readonly response: CdpResponse;

  constructor(response: CdpResponse) {
    const body = response.error;
    super(body?.message ?? "CDP error");
    this.name = "CdpProtocolError";
    this.code = body?.code ?? 0;
    this.data = body?.data;
    this.response = response;
  }
}

interface PendingEntry {
  resolve: (response: CdpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpConnection extends CdpSend {
  /** The websocket URL this connection is attached to. */
  readonly wsUrl: string;
  /** Close the socket; every pending request rejects with GRAZER_TASK_HOST_DISCONNECTED. */
  close(): Promise<void>;
}

/**
 * Resolve the browser-level websocket URL from a debug port.
 *
 * `/json/version` is served over plain HTTP on the debug port and reports
 * `webSocketDebuggerUrl` for the browser endpoint (not a page endpoint), which
 * is the one that accepts `Target.*` and flat sessions.
 */
export async function browserWebSocketUrl(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) {
    throw new Error(
      `CDP /json/version failed on port ${port}: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new Error(
      `CDP /json/version on port ${port} returned no webSocketDebuggerUrl`,
    );
  }
  return body.webSocketDebuggerUrl;
}

/** Read the product string (e.g. "Chrome/152.0.7977.66") off a Browser.getVersion response. */
export function productFromVersion(response: CdpResponse): string {
  const product = response.result?.product;
  return typeof product === "string" ? product : "";
}

export async function connect(
  options: ConnectOptions,
): Promise<CdpConnection> {
  const { port, openTimeoutMs = 15_000 } = options;
  const wsUrl =
    options.wsUrl ??
    (port !== undefined
      ? await browserWebSocketUrl(port)
      : (() => {
          throw new Error("connect() needs either a port or a wsUrl");
        })());

  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, PendingEntry>();
  const eventListeners = new Set<(event: CdpEvent) => void>();
  const closeListeners = new Set<() => void>();
  let nextId = 1;
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened is not interesting.
      }
      reject(new Error(`CDP socket did not open within ${openTimeoutMs}ms`));
    }, openTimeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`CDP socket failed to connect: ${wsUrl}`));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    let frame: CdpFrame;
    try {
      frame = JSON.parse(String(event.data)) as CdpFrame;
    } catch {
      // A frame Chrome sent that is not JSON is not ours to interpret; dropping
      // it is strictly better than tearing the connection down.
      return;
    }
    if (isCdpResponse(frame)) {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) {
        entry.reject(new CdpProtocolError(frame));
        return;
      }
      entry.resolve(frame);
      return;
    }
    // Unknown/unsubscribed event frames are fine — listeners opt in.
    for (const listener of [...eventListeners]) listener(frame);
  });

  const handleClose = () => {
    if (closed) return;
    closed = true;
    const entries = [...pending.values()];
    pending.clear();
    const error = grazerErrorFor("host-disconnected");
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const listener of [...closeListeners]) listener();
  };
  socket.addEventListener("close", handleClose);
  // An error after open (host killed mid-flight) may or may not be followed by a
  // close event; handleClose is idempotent, so wiring both is safe.
  socket.addEventListener("error", handleClose);

  function isOpen(): boolean {
    return !closed && socket.readyState === WebSocket.OPEN;
  }

  function write(
    message: CdpRequest,
    timeoutMs: number,
  ): Promise<CdpResponse> {
    return new Promise<CdpResponse>((resolve, reject) => {
      if (!isOpen()) {
        reject(grazerErrorFor("channel-unavailable"));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(
          new Error(`CDP request timed out after ${timeoutMs}ms: ${message.method}`),
        );
      }, timeoutMs);
      pending.set(message.id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(message));
      } catch (cause) {
        pending.delete(message.id);
        clearTimeout(timer);
        const error = grazerErrorFor("send-failed");
        error.cause = cause;
        reject(error);
      }
    });
  }

  return {
    wsUrl,
    isOpen,
    send(method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const message: CdpRequest = {
        id: nextId++,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      };
      return write(message, timeoutMs);
    },
    sendRaw(message) {
      return write(message, DEFAULT_TIMEOUT_MS);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    async close() {
      if (closed) return;
      const settled = new Promise<void>((resolve) => {
        const done = () => resolve();
        socket.addEventListener("close", done, { once: true });
        // A socket already past CLOSING never fires another close event.
        if (socket.readyState === WebSocket.CLOSED) done();
      });
      try {
        socket.close();
      } catch {
        // Nothing useful to do; handleClose still settles the pending map.
      }
      handleClose();
      await settled;
    },
  };
}
