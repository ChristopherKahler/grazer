/**
 * CDP wire shapes.
 *
 * Chrome's DevTools Protocol multiplexes three frame kinds over one WebSocket:
 * a request we write, a response keyed by the request's `id`, and an event with
 * no `id` at all. In flat-session mode (`Target.attachToTarget { flatten: true }`)
 * page-scoped frames carry `sessionId` at the TOP LEVEL rather than being
 * wrapped in `Target.receivedMessageFromTarget`, which is what lets the harness
 * read `data.sessionId` straight off the parsed frame.
 */

/** A request frame written to the socket. */
export interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** The `error` member of a failed response. */
export interface CdpErrorBody {
  code: number;
  message: string;
  data?: string;
}

/** A response frame: always has `id`, then exactly one of `result` / `error`. */
export interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: CdpErrorBody;
  sessionId?: string;
}

/** An event frame: never has `id`. */
export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Any frame read off the socket. */
export type CdpFrame = CdpResponse | CdpEvent;

/** True when a parsed frame is a response (has an `id`), false when it is an event. */
export function isCdpResponse(frame: CdpFrame): frame is CdpResponse {
  return Object.hasOwn(frame as object, "id");
}

/**
 * The subset of a connection the grazer runtime adapter needs. Keeping this
 * narrow is what lets `createGrazerRuntime` be unit-tested against a fake.
 */
export interface CdpSend {
  /** Whether the socket is open and writable right now. */
  isOpen(): boolean;
  /**
   * Issue a request we number ourselves. Resolves with the full response frame,
   * rejects on a CDP `error`. Used by the runtime's own methods (listTabs,
   * createTab, getBrowserVersion), never by the harness passthrough.
   */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<CdpResponse>;
  /** Write an already-formed request, keyed by ITS id; resolves with the full response frame. */
  sendRaw(message: CdpRequest): Promise<CdpResponse>;
  /** Subscribe to id-less frames. Returns an unsubscribe function. */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /** Subscribe to socket close. Returns an unsubscribe function. */
  onClose(listener: () => void): () => void;
}

/** A Chromium target as reported by `Target.getTargets`. */
export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
}
