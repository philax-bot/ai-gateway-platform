/**
 * Re-exported from the shared contracts package so the data plane, the control
 * plane and the existing gateway tests classify upstream failures identically.
 */
export { definitelyNotSent, shouldRetryConnect, MAX_CONNECT_ATTEMPTS } from '@ai-gateway/contracts';