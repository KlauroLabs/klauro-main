/**
 * Coordination fabric barrel — pure, transport-free core (§WS-C/WS-D).
 * See docs/SPEC-COORDINATION-FABRIC.md for the protocol this implements.
 */

export * from './types';
export { arbitrate } from './arbiter';
export { detectCollisions } from './collision';
export { isExpired, reduceClaimLog, deriveActiveClaims, derivePresence } from './presence';
