/**
 * Client-disconnect plumbing.
 *
 * server.js attaches the request's AbortSignal under a Symbol key. Symbol keys survive object spread/rest
 * (the many `{ ...anthropicRequest, model }` fallback copies) but are ignored by JSON.stringify, so the
 * signal never leaks into upstream payloads.
 */
export const CLIENT_SIGNAL = Symbol.for('antigravity.clientSignal');

export function attachClientSignal(req, signal) {
    if (req && signal) req[CLIENT_SIGNAL] = signal;
}
export function getClientSignal(req) {
    return req?.[CLIENT_SIGNAL];
}
export function isClientAborted(req) {
    return !!req?.[CLIENT_SIGNAL]?.aborted;
}
