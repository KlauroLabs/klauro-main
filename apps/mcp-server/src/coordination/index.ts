




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
  publishClaimStream,
  releaseClaimStream,
  heartbeatClaimStream,
  getClaimStreams,
  type ClaimStreamRequest,
  type ClaimStreamResult,
  type ClaimStreamVerdict,
  type ClaimStreamOverlap,
  type ActiveClaimStream,
} from './claim-stream-store';
