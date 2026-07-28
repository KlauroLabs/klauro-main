/**
 * Coordination fabric barrel — pure, transport-free core (§WS-C/WS-D).
 * See docs/SPEC-COORDINATION-FABRIC.md for the protocol this implements.
 */

export * from './types';
export { arbitrate } from './arbiter';
export {
  detectCollisions,
  detectDeclaredContractDrift,
  type DeclaredContractDriftFinding,
} from './collision';
export {
  contractIdentity,
  matchContract,
  mergeContracts,
  deriveObservedProduces,
  deriveObservedConsumes,
  derivePhase,
  isAttributionSound,
  isExplorationClaim,
  EXPLORATION_CLAIM_NOTE,
  type ContractMatch,
  type ContractMatchConfidence,
  type PeerContracts,
  type ObservedConsumesResult,
} from './contract-intent';
export {
  buildEventsBlock,
  drainEventsForClaim,
  claimFootprint,
  DEFAULT_EVENTS_CAP,
  type EventsBlock,
  type DrainedEvent,
} from './event-drain';
export { isExpired, reduceClaimLog, deriveActiveClaims, derivePresence } from './presence';
export {
  requestGrant,
  releaseGrant,
  heartbeatGrant,
  getGrants,
  type GrantRequest,
  type GrantResult,
  type GrantVerdict,
  type GrantConflict,
  type ActiveGrant,
} from './grant-manager';
