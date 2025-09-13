// Main spatial layout engine and types exports
export { 
  SpatialLayoutEngine,
  SpatialEngineOptions,
  SpatialEngineMetrics,
  RealTimeUpdate,
  CollisionResult
} from './spatial-layout-engine';

// Spatial types
export * from './spatial-types';

// Metaphor mapping
export { MetaphorMapper } from './metaphor-mapper';

// Layout algorithms
export {
  BaseLayoutAlgorithm,
  WebAppLayout,
  APILayout,
  MicroserviceLayout,
  MobileAppLayout,
  FirmwareLayout,
  LayoutAlgorithmFactory
} from './layout-algorithms';

// Data transformer
export { SpatialDataTransformer } from './spatial-data-transformer';

// Re-export commonly used types for convenience
export type {
  SpatialPosition,
  SpatialDimensions,
  SpatialBounds,
  Room,
  Building,
  Floor,
  Hallway,
  Pathway,
  Campus,
  NavigationPath,
  TrafficFlow,
  Vehicle,
  SpatialBlueprint,
  Animation
} from './spatial-types';