// Core architecture types for Unravl visualization

export interface ComponentNode {
  id: string;
  name: string;
  type: ComponentType;
  path: string;
  dependencies: string[];
  dependents: string[];
  metadata: ComponentMetadata;
  position?: { x: number; y: number };
}

export type ComponentType = 
  | 'route' 
  | 'controller' 
  | 'middleware' 
  | 'model' 
  | 'service' 
  | 'utility' 
  | 'config'
  | 'database'
  | 'external_api'
  | 'orphaned';

export interface ComponentMetadata {
  lineCount: number;
  complexity: number; // 1-10 scale
  lastModified: Date;
  exports: string[];
  imports: string[];
  httpMethods?: string[]; // For routes
  dbQueries?: string[]; // For models/services
  externalCalls?: string[]; // For API integrations
  isEntry?: boolean; // Entry points (main routes)
  isOrphaned?: boolean; // No dependencies or dependents
  layer: ArchitecturalLayer; // Which architectural layer
  responsibilities: string[]; // What this component does
  aiDescription?: string; // AI-generated description
  functions?: FunctionInfo[]; // Function-level analysis
  testCoverage?: number; // Test coverage percentage
  performanceMetrics?: PerformanceMetrics; // Performance data
}

export interface ArchitectureBlueprint {
  projectName: string;
  framework: string;
  components: ComponentNode[];
  connections: Connection[];
  entryPoints: EntryPoint[];
  exitPoints: ExitPoint[];
  orphanedComponents: string[];
  riskAreas: RiskArea[];
  metadata: ProjectMetadata;
  technologyStack: TechnologyStack;
  dependencies: DependencyAnalysis;
  databaseInfo?: DatabaseAnalysis;
  apiEndpoints: APIEndpoint[];
  securityAnalysis: SecurityAnalysis;
  testingInfo: TestingInfo;
  deploymentInfo: DeploymentInfo;
}

export interface Connection {
  from: string; // Component ID
  to: string; // Component ID
  type: ConnectionType;
  weight: number; // Usage frequency/importance
  metadata?: {
    callSites: number;
    dataFlow?: string;
    httpMethod?: string;
  };
}

export type ConnectionType = 
  | 'import' 
  | 'http_call' 
  | 'database' 
  | 'middleware_chain' 
  | 'function_call'
  | 'data_flow';

export interface RiskArea {
  componentId: string;
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
  impact: string;
}

export interface ProjectMetadata {
  totalComponents: number;
  frameworkVersion: string;
  analysisDate: Date;
  repositoryPath: string;
  entryPointsCount: number;
  orphanedCount: number;
  complexityAverage: number;
  primaryLanguage: string;
  languageDistribution: Record<string, number>;
  codebaseSize: {
    totalLines: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
  };
  aiGeneratedSummary?: string;
}

// Analysis request/response types
export interface AnalysisRequest {
  repositoryPath: string;
  options?: {
    includeTests?: boolean;
    maxDepth?: number;
    excludePatterns?: string[];
  };
}

export interface AnalysisResponse {
  success: boolean;
  blueprint?: ArchitectureBlueprint;
  error?: string;
  processingTime: number;
}

// ===== CALL GRAPH AND DEPENDENCY ANALYSIS =====

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  entryPoints: string[];
  cycles: string[][];
  layers: CallGraphLayer[];
  hotPaths: HotPath[];
  deadCode: string[];
}

export interface CallGraphNode {
  id: string;
  name: string;
  type: 'function' | 'method' | 'class' | 'module';
  file: string;
  complexity: number;
  fanIn: number;
  fanOut: number;
  depth: number;
  critical: boolean;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  count: number;
  type: 'direct' | 'indirect' | 'virtual' | 'callback';
  async: boolean;
  conditional: boolean;
}

export interface CallGraphLayer {
  level: number;
  nodes: string[];
  description: string;
}

export interface HotPath {
  path: string[];
  frequency: number;
  averageTime?: number;
  critical: boolean;
  description: string;
}

// ===== COMPREHENSIVE ARCHITECTURE INTELLIGENCE TYPES =====

// Architectural Layers
export type ArchitecturalLayer = 
  | 'presentation'   // UI components, views, pages
  | 'business'       // Business logic, services, controllers
  | 'data'          // Models, repositories, data access
  | 'infrastructure' // Configuration, utilities, frameworks
  | 'external';     // External APIs, third-party services

// Function-level Analysis
export interface FunctionInfo {
  name: string;
  signature: string;
  parameters: Parameter[];
  returnType: string;
  complexity: number;
  lineCount: number;
  isPublic: boolean;
  isAsync: boolean;
  isGenerator?: boolean;
  isConstructor?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  calls: FunctionCall[]; // Functions this function calls
  calledBy: string[]; // Functions that call this
  aiDescription?: string;
  annotations?: Annotation[];
  testCoverage?: TestCoverageInfo;
  performance?: FunctionPerformance;
  sideEffects?: SideEffect[];
  purity?: boolean;
}

export interface FunctionCall {
  target: string;
  count: number;
  isRecursive?: boolean;
  isAsync?: boolean;
  location: CodeLocation;
}

export interface CodeLocation {
  file: string;
  line: number;
  column: number;
}

export interface Annotation {
  type: string;
  value?: any;
  metadata?: Record<string, any>;
}

export interface TestCoverageInfo {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
  tests: string[];
}

export interface FunctionPerformance {
  averageExecutionTime?: number;
  minExecutionTime?: number;
  maxExecutionTime?: number;
  callCount?: number;
  memoryUsage?: number;
}

export interface SideEffect {
  type: 'io' | 'network' | 'database' | 'state' | 'dom' | 'console';
  description: string;
  target?: string;
}

export interface Parameter {
  name: string;
  type: string;
  isOptional: boolean;
  defaultValue?: string;
}

// Performance Metrics
export interface PerformanceMetrics {
  avgResponseTime?: number;
  throughput?: number;
  errorRate?: number;
  memoryUsage?: number;
  cpuUsage?: number;
  lastUpdated: Date;
}

// Entry Points (Comprehensive)
export interface EntryPoint {
  id: string;
  type: EntryPointType;
  path: string;
  methods?: string[];
  description: string;
  parameters?: APIParameter[];
  responseSchema?: any;
  middleware?: string[];
  authentication?: AuthenticationInfo;
  rateLimit?: RateLimitInfo;
  componentId: string; // Links to component
  handler?: string; // Function/method name handling this entry
  priority?: number; // Execution order/priority
  async?: boolean;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  documentation?: string;
  examples?: RequestExample[];
  metrics?: EntryPointMetrics;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffStrategy: 'linear' | 'exponential' | 'fixed';
  retryableErrors?: string[];
  timeout?: number;
}

export interface RequestExample {
  name: string;
  description?: string;
  request: any;
  response: any;
  headers?: Record<string, string>;
}

export interface EntryPointMetrics {
  requestsPerMinute?: number;
  averageResponseTime?: number;
  errorRate?: number;
  successRate?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export type EntryPointType = 
  | 'http_endpoint'   // REST/GraphQL endpoints
  | 'websocket'       // WebSocket connections
  | 'cli_command'     // Command line interfaces
  | 'event_handler'   // Event listeners/handlers
  | 'scheduler'       // Cron jobs, scheduled tasks
  | 'queue_consumer'  // Message queue consumers
  | 'webhook'         // Webhook endpoints
  | 'grpc_service';   // gRPC services

// Exit Points (External Integrations)
export interface ExitPoint {
  id: string;
  type: ExitPointType;
  destination: string;
  description: string;
  authentication?: AuthenticationInfo;
  rateLimit?: RateLimitInfo;
  critical: boolean;
  componentId: string; // Links to component
  errorHandling?: string[];
  retryPolicy?: RetryPolicy;
  timeout?: number;
  circuitBreaker?: CircuitBreakerConfig;
  caching?: CachingStrategy;
  dataTransformation?: DataTransformation;
  monitoring?: MonitoringConfig;
}

export interface CircuitBreakerConfig {
  threshold: number;
  timeout: number;
  resetTimeout: number;
  halfOpenRequests: number;
}

export interface CachingStrategy {
  enabled: boolean;
  ttl: number;
  strategy: 'read-through' | 'write-through' | 'write-behind' | 'refresh-ahead';
  invalidationRules?: string[];
}

export interface DataTransformation {
  request?: TransformationRule[];
  response?: TransformationRule[];
}

export interface TransformationRule {
  type: 'mapping' | 'filtering' | 'aggregation' | 'enrichment';
  specification: any;
}

export interface MonitoringConfig {
  metrics: string[];
  alerts: AlertRule[];
  logging: LoggingConfig;
}

export interface AlertRule {
  condition: string;
  threshold: number;
  action: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: string[];
  sanitization?: string[];
}

export type ExitPointType = 
  | 'database_query'   // Database operations
  | 'external_api'     // Third-party API calls
  | 'message_publish'  // Message queue publishing
  | 'file_operation'   // File system operations
  | 'cache_operation'  // Cache read/write
  | 'email_send'       // Email notifications
  | 'sms_send'         // SMS notifications
  | 'webhook_call'     // Outbound webhooks
  | 'log_write';       // Logging operations

// Technology Stack Analysis
export interface TechnologyStack {
  primaryFramework: FrameworkInfo;
  additionalFrameworks: FrameworkInfo[];
  languages: LanguageInfo[];
  buildTools: BuildToolInfo[];
  testingFrameworks: TestingFrameworkInfo[];
  databases: DatabaseInfo[];
  messageQueues: MessageQueueInfo[];
  caching: CachingInfo[];
  authentication: AuthenticationInfo[];
  deployment: DeploymentInfo[];
}

export interface FrameworkInfo {
  name: string;
  version: string;
  type: 'web' | 'mobile' | 'desktop' | 'api' | 'library';
  logo?: string;
  usage: 'primary' | 'secondary' | 'development';
  conventions: string[];
  patterns: string[];
  configFiles?: string[];
  detectionConfidence: number;
  metadata?: FrameworkMetadata;
}

export interface FrameworkMetadata {
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'pip' | 'maven' | 'gradle' | 'nuget' | 'cargo';
  buildSystem?: string;
  testRunner?: string;
  linter?: string;
  formatter?: string;
  bundler?: string;
  transpiler?: string;
  stylePreprocessor?: string;
  templateEngine?: string;
  orm?: string;
  httpClient?: string;
  stateManagement?: string;
  router?: string;
}

export interface LanguageInfo {
  name: string;
  version?: string;
  fileCount: number;
  lineCount: number;
  percentage: number;
}

export interface BuildToolInfo {
  name: string;
  version?: string;
  configFile: string;
  scripts: string[];
}

// Dependencies Analysis
export interface DependencyAnalysis {
  totalCount: number;
  directDependencies: Dependency[];
  devDependencies: Dependency[];
  peerDependencies: Dependency[];
  vulnerabilities: SecurityVulnerability[];
  outdated: OutdatedDependency[];
  unused: string[];
  licenseCompliance: LicenseInfo[];
}

export interface Dependency {
  name: string;
  version: string;
  type: 'production' | 'development' | 'peer';
  description?: string;
  license: string;
  size?: number;
  isDirectlyUsed: boolean;
  usageLocations: string[];
  repository?: string;
  homepage?: string;
  lastUpdated?: Date;
  weeklyDownloads?: number;
  dependencyDepth?: number;
  transitiveCount?: number;
  securityAdvisories?: SecurityAdvisory[];
  licenseMetadata?: LicenseMetadata;
}

export interface SecurityAdvisory {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affectedVersions: string;
  patchedVersions?: string;
  references: string[];
  publishedDate: Date;
}

export interface LicenseMetadata {
  spdxId: string;
  osiApproved: boolean;
  fsApproved: boolean;
  copyleft: boolean;
  linking: 'static' | 'dynamic' | 'none';
  distribution: 'source' | 'binary' | 'both';
  modification: boolean;
  patent: boolean;
  privateUse: boolean;
  warranty: boolean;
}

export interface SecurityVulnerability {
  dependency: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  cve?: string;
  fixAvailable: boolean;
  recommendedVersion?: string;
}

export interface OutdatedDependency {
  name: string;
  currentVersion: string;
  latestVersion: string;
  versionsBehind: number;
  breakingChanges: boolean;
}

export interface LicenseInfo {
  license: string;
  dependencies: string[];
  compatible: boolean;
  restrictions: string[];
}

// Database Analysis
export interface DatabaseAnalysis {
  type: DatabaseType;
  connectionMethod: ConnectionMethod;
  host?: string;
  port?: number;
  database?: string;
  schema?: DatabaseSchema;
  migrations: MigrationInfo[];
  queries: QueryAnalysis[];
  performance: DatabasePerformance;
  connections: DatabaseConnection[];
  pools?: ConnectionPoolConfig[];
  replication?: ReplicationConfig;
  sharding?: ShardingConfig;
  backup?: BackupConfig;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  ssl?: boolean;
  poolSize?: number;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  usage: DatabaseUsage[];
  componentIds: string[];
}

export interface DatabaseUsage {
  componentId: string;
  operations: DatabaseOperation[];
  frequency: number;
  critical: boolean;
}

export interface DatabaseOperation {
  type: 'read' | 'write' | 'transaction' | 'batch';
  tables: string[];
  complexity: number;
  optimized: boolean;
}

export interface ConnectionPoolConfig {
  name: string;
  minSize: number;
  maxSize: number;
  acquireTimeout: number;
  idleTimeout: number;
  maxLifetime: number;
}

export interface ReplicationConfig {
  type: 'master-slave' | 'master-master' | 'multi-master';
  nodes: ReplicationNode[];
  lag?: number;
  failover: 'automatic' | 'manual';
}

export interface ReplicationNode {
  host: string;
  port: number;
  role: 'master' | 'slave' | 'replica';
  priority: number;
}

export interface ShardingConfig {
  strategy: 'range' | 'hash' | 'geo' | 'custom';
  shardKey: string;
  shards: ShardInfo[];
}

export interface ShardInfo {
  id: string;
  range?: string;
  host: string;
  database: string;
}

export interface BackupConfig {
  type: 'full' | 'incremental' | 'differential';
  schedule: string;
  retention: number;
  location: string;
}

export type DatabaseType = 
  | 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' 
  | 'redis' | 'elasticsearch' | 'cassandra' | 'dynamodb';

export type ConnectionMethod = 
  | 'orm' | 'query_builder' | 'raw_sql' | 'odm' | 'driver';

export interface DatabaseSchema {
  tables: TableInfo[];
  relationships: RelationshipInfo[];
  indexes: IndexInfo[];
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  rowCount?: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey?: string;
  defaultValue?: string;
}

export interface RelationshipInfo {
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  fromTable: string;
  toTable: string;
  fromColumn: string;
  toColumn: string;
}

export interface ConstraintInfo {
  name: string;
  type: 'primary_key' | 'foreign_key' | 'unique' | 'check';
  columns: string[];
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface MigrationInfo {
  file: string;
  version: string;
  description: string;
  timestamp: Date;
  applied: boolean;
}

export interface QueryAnalysis {
  query: string;
  type: 'select' | 'insert' | 'update' | 'delete';
  tables: string[];
  complexity: number;
  performance?: {
    avgExecutionTime: number;
    frequency: number;
    lastExecuted: Date;
  };
}

export interface DatabasePerformance {
  avgQueryTime: number;
  slowQueries: string[];
  nPlusOneProblems: string[];
  indexUsage: Record<string, number>;
}

// API Endpoint Analysis
export interface APIEndpoint {
  id: string;
  method: HTTPMethod;
  path: string;
  description: string;
  summary?: string;
  tags?: string[];
  parameters: APIParameter[];
  requestSchema?: any;
  responseSchema?: any;
  statusCodes: StatusCodeInfo[];
  middleware: string[];
  authentication: AuthenticationInfo;
  authorization?: AuthorizationInfo;
  rateLimit?: RateLimitInfo;
  caching?: CachingInfo;
  userBehavior?: UserBehaviorInfo;
  businessProcess?: BusinessProcessInfo;
  componentId: string;
  controller?: string;
  handler?: string;
  version?: string;
  deprecated?: boolean;
  deprecationInfo?: DeprecationInfo;
  documentation?: EndpointDocumentation;
  metrics?: EndpointMetrics;
}

export interface StatusCodeInfo {
  code: number;
  description: string;
  schema?: any;
  examples?: any[];
}

export interface AuthorizationInfo {
  type: 'role' | 'permission' | 'scope' | 'custom';
  requirements: string[];
  strategy: 'all' | 'any' | 'custom';
}

export interface DeprecationInfo {
  since: string;
  removal?: string;
  replacement?: string;
  reason?: string;
}

export interface EndpointDocumentation {
  description: string;
  examples: RequestExample[];
  notes?: string[];
  changelog?: ChangelogEntry[];
}

export interface ChangelogEntry {
  version: string;
  date: Date;
  changes: string[];
}

export interface EndpointMetrics {
  requestsPerDay: number;
  uniqueUsersPerDay: number;
  averageResponseTime: number;
  errorRate: number;
  successRate: number;
  bandwidthUsage: number;
}

export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

export interface APIParameter {
  name: string;
  type: 'query' | 'path' | 'body' | 'header';
  dataType: string;
  required: boolean;
  description?: string;
  validation?: ValidationRule[];
}

export interface ValidationRule {
  type: string;
  value?: any;
  message?: string;
}

export interface AuthenticationInfo {
  type: 'none' | 'api_key' | 'jwt' | 'oauth' | 'basic' | 'bearer';
  provider?: string;
  scopes?: string[];
  required: boolean;
}

export interface RateLimitInfo {
  requests: number;
  window: string;
  strategy: string;
}

export interface CachingInfo {
  type: 'redis' | 'memcached' | 'in_memory' | 'cdn' | 'browser';
  ttl?: number;
  strategy: string;
  keys?: string[];
}

export interface UserBehaviorInfo {
  primaryAction: string;
  userJourney: string[];
  conversionRate?: number;
  frequentErrors: string[];
}

export interface BusinessProcessInfo {
  process: string;
  step: number;
  stakeholders: string[];
  businessValue: string;
  slaRequirements?: string[];
}

// Frontend-Specific Analysis
export interface FrontendAnalysis {
  framework: FrameworkInfo;
  stateManagement: StateManagementInfo;
  routing: RoutingInfo;
  styling: StylingInfo;
  bundleAnalysis: BundleAnalysis;
  performance: FrontendPerformance;
}

export interface StateManagementInfo {
  library: string;
  pattern: string;
  stores: string[];
  actions: string[];
  complexity: number;
}

export interface RoutingInfo {
  library: string;
  routes: RouteInfo[];
  guards: string[];
  lazy: boolean;
}

export interface RouteInfo {
  path: string;
  component: string;
  children?: RouteInfo[];
  meta?: Record<string, any>;
}

export interface StylingInfo {
  methodology: 'css' | 'scss' | 'css-in-js' | 'tailwind' | 'css-modules';
  preprocessor?: string;
  framework?: string;
  themeSystem: boolean;
}

export interface BundleAnalysis {
  totalSize: number;
  chunks: ChunkInfo[];
  duplicates: string[];
  unusedCode: string[];
  treeshaking: boolean;
}

export interface ChunkInfo {
  name: string;
  size: number;
  modules: string[];
  async: boolean;
}

export interface FrontendPerformance {
  bundleSize: number;
  loadTime: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  cumulativeLayoutShift: number;
}

// Testing Information
export interface TestingInfo {
  frameworks: TestingFrameworkInfo[];
  coverage: TestCoverage;
  testTypes: TestTypeInfo[];
  testFiles: string[];
  totalTests: number;
  passingTests: number;
  failingTests: number;
  skippedTests: number;
  testSuites: TestSuite[];
  executionTime?: number;
  lastRun?: Date;
  continuousIntegration?: CITestConfig;
  mutationTesting?: MutationTestingInfo;
  propertyTesting?: PropertyTestingInfo;
}

export interface TestSuite {
  name: string;
  file: string;
  tests: TestCase[];
  setupFiles?: string[];
  teardownFiles?: string[];
  timeout?: number;
  parallel?: boolean;
}

export interface TestCase {
  name: string;
  type: 'unit' | 'integration' | 'e2e' | 'performance' | 'security';
  status: 'passed' | 'failed' | 'skipped' | 'pending';
  duration?: number;
  retries?: number;
  error?: TestError;
  coverage?: TestCoverageInfo;
}

export interface TestError {
  message: string;
  stack?: string;
  expected?: any;
  actual?: any;
  diff?: string;
}

export interface CITestConfig {
  platform: string;
  configFile: string;
  stages: string[];
  parallelization?: number;
  retryPolicy?: RetryPolicy;
}

export interface MutationTestingInfo {
  framework: string;
  mutationScore: number;
  killedMutants: number;
  survivedMutants: number;
  timeout: number;
}

export interface PropertyTestingInfo {
  framework: string;
  properties: PropertyTest[];
}

export interface PropertyTest {
  name: string;
  property: string;
  inputs: string[];
  passed: boolean;
  counterexample?: any;
}

export interface TestingFrameworkInfo {
  name: string;
  version: string;
  type: 'unit' | 'integration' | 'e2e' | 'performance';
  configFile?: string;
}

export interface TestCoverage {
  overall: number;
  lines: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  statements: CoverageMetric;
  byComponent: Record<string, ComponentCoverage>;
  byType: Record<string, number>;
  uncoveredFiles: string[];
  coverageMap?: CoverageMap[];
  trends?: CoverageTrend[];
}

export interface CoverageMetric {
  covered: number;
  total: number;
  percentage: number;
  details?: CoverageDetail[];
}

export interface CoverageDetail {
  file: string;
  startLine: number;
  endLine: number;
  hits: number;
}

export interface ComponentCoverage {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
  tests: number;
  critical?: boolean;
}

export interface CoverageMap {
  file: string;
  lines: LineCoverage[];
}

export interface LineCoverage {
  line: number;
  hits: number;
  branch?: BranchCoverage;
}

export interface BranchCoverage {
  taken: boolean;
  alternate?: boolean;
}

export interface CoverageTrend {
  date: Date;
  overall: number;
  lines: number;
  branches: number;
  functions: number;
}

export interface TestTypeInfo {
  type: 'unit' | 'integration' | 'e2e' | 'performance' | 'visual';
  count: number;
  coverage: number;
  tools: string[];
}

// Security Analysis
export interface SecurityAnalysis {
  vulnerabilities: SecurityVulnerability[];
  authenticationMethods: AuthenticationInfo[];
  authorizationPatterns: string[];
  dataEncryption: EncryptionInfo[];
  inputValidation: ValidationInfo[];
  securityHeaders: SecurityHeaderInfo[];
  secrets: SecretInfo[];
}

export interface EncryptionInfo {
  type: 'at_rest' | 'in_transit' | 'end_to_end';
  method: string;
  strength: string;
  location: string;
}

export interface ValidationInfo {
  type: 'input' | 'output' | 'schema';
  method: string;
  coverage: number;
  vulnerabilities: string[];
}

export interface SecurityHeaderInfo {
  header: string;
  value: string;
  present: boolean;
  secure: boolean;
}

export interface SecretInfo {
  type: 'api_key' | 'password' | 'token' | 'certificate';
  location: string;
  secure: boolean;
  rotationPolicy?: string;
}

// Deployment Information
export interface DeploymentInfo {
  platform: string;
  containerization: ContainerInfo;
  orchestration?: OrchestrationInfo;
  cicd: CICDInfo;
  monitoring: MonitoringInfo;
  scaling: ScalingInfo;
}

export interface ContainerInfo {
  type: 'docker' | 'podman' | 'none';
  baseImage?: string;
  size?: number;
  layers?: number;
  securityScan?: SecurityScanInfo;
}

export interface SecurityScanInfo {
  vulnerabilities: number;
  lastScan: Date;
  tool: string;
}

export interface OrchestrationInfo {
  platform: 'kubernetes' | 'docker-swarm' | 'ecs' | 'nomad';
  manifests: string[];
  services: string[];
  ingress: boolean;
}

export interface CICDInfo {
  platform: string;
  configFile: string;
  stages: string[];
  deploymentStrategy: string;
  automated: boolean;
}

export interface MonitoringInfo {
  tools: string[];
  metrics: string[];
  logging: LoggingInfo;
  alerting: AlertingInfo;
}

export interface LoggingInfo {
  level: string;
  destination: string;
  structured: boolean;
  aggregation: boolean;
}

export interface AlertingInfo {
  platform: string;
  rules: string[];
  channels: string[];
}

export interface ScalingInfo {
  type: 'horizontal' | 'vertical' | 'both';
  automatic: boolean;
  metrics: string[];
  limits: ScalingLimits;
}

export interface ScalingLimits {
  minInstances: number;
  maxInstances: number;
  cpu: string;
  memory: string;
}

// Missing database and message queue types
export interface DatabaseInfo {
  type: DatabaseType;
  name: string;
  version?: string;
  usage: 'primary' | 'cache' | 'analytics' | 'logging';
  connectionString?: string;
  schema?: DatabaseSchema;
}

export interface MessageQueueInfo {
  type: 'rabbitmq' | 'kafka' | 'redis' | 'sqs' | 'azure-servicebus';
  name: string;
  version?: string;
  topics: string[];
  usage: 'event-streaming' | 'job-queue' | 'pub-sub';
}

// ===== ANALYZER PLUGIN SYSTEM TYPES =====

export interface AnalyzerCapabilities {
  languages: string[];
  frameworks: string[];
  projectTypes: ProjectType[];
  features: AnalyzerFeature[];
  limitations?: AnalyzerLimitation[];
  performance?: PerformanceProfile;
}

export type ProjectType = 
  | 'web-application'
  | 'mobile-application'
  | 'desktop-application' 
  | 'cli-tool'
  | 'library'
  | 'microservice'
  | 'monolith'
  | 'serverless'
  | 'data-pipeline'
  | 'machine-learning'
  | 'game'
  | 'embedded'
  | 'blockchain';

export type AnalyzerFeature =
  | 'ast-parsing'
  | 'dependency-analysis'
  | 'call-graph-generation'
  | 'test-coverage-analysis'
  | 'security-scanning'
  | 'performance-analysis'
  | 'code-quality-metrics'
  | 'architectural-pattern-detection'
  | 'database-analysis'
  | 'api-endpoint-detection'
  | 'configuration-analysis'
  | 'build-tool-integration'
  | 'documentation-generation';

export interface AnalyzerLimitation {
  type: 'size' | 'complexity' | 'language-version' | 'dependency' | 'platform';
  description: string;
  threshold?: number;
  workaround?: string;
}

export interface PerformanceProfile {
  filesPerSecond: number;
  memoryUsageMB: number;
  maxProjectSize: number; // in files
  parallelizable: boolean;
  cacheable: boolean;
}

// ===== ANALYZER RESULT VALIDATION =====

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  score: number; // 0-100
}

export interface ValidationError {
  code: string;
  message: string;
  component?: string;
  severity: 'critical' | 'major' | 'minor';
  location?: SourceLocation;
  suggestion?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  component?: string;
  location?: SourceLocation;
  category: 'performance' | 'maintainability' | 'security' | 'best-practices';
}

export interface SourceLocation {
  file: string;
  line?: number;
  column?: number;
  range?: { start: { line: number; column: number }, end: { line: number; column: number } };
}

// ===== CONFIGURATION MANAGEMENT =====

export interface AnalyzerConfiguration {
  global: GlobalConfiguration;
  language: Record<string, LanguageConfiguration>;
  framework: Record<string, FrameworkConfiguration>;
  custom: Record<string, any>;
  overrides?: ConfigurationOverride[];
}

export interface GlobalConfiguration {
  includeTests: boolean;
  maxDepth: number;
  maxFileSize: number;
  parallelProcessing: boolean;
  cacheEnabled: boolean;
  metricsEnabled: boolean;
  timeout: number;
  excludePatterns: string[];
  includePatterns?: string[];
  outputFormat: 'json' | 'yaml' | 'xml';
  outputPath?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface LanguageConfiguration {
  version?: string;
  dialect?: string;
  extensions: string[];
  excludePatterns: string[];
  parserOptions?: Record<string, any>;
  linterRules?: Record<string, any>;
  featureFlags?: Record<string, boolean>;
}

export interface FrameworkConfiguration {
  version?: string;
  features: string[];
  conventions: string[];
  configFiles: string[];
  specialHandling?: SpecialHandling[];
}

export interface SpecialHandling {
  type: 'file-pattern' | 'directory-structure' | 'dependency' | 'annotation';
  pattern: string;
  handler: string;
  options?: Record<string, any>;
}

export interface ConfigurationOverride {
  condition: ConfigurationCondition;
  configuration: Partial<AnalyzerConfiguration>;
}

export interface ConfigurationCondition {
  type: 'path' | 'file-exists' | 'dependency' | 'size' | 'custom';
  value: string | number;
  operator?: 'equals' | 'contains' | 'matches' | 'greater-than' | 'less-than';
}

// ===== TELEMETRY AND MONITORING =====

export interface TelemetryData {
  analysisId: string;
  timestamp: Date;
  metrics: TelemetryMetric[];
  events: TelemetryEvent[];
  traces: TelemetryTrace[];
  logs: TelemetryLog[];
  context: TelemetryContext;
}

export interface TelemetryMetric {
  name: string;
  value: number;
  unit?: string;
  timestamp: Date;
  tags?: Record<string, string>;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
}

export interface TelemetryEvent {
  name: string;
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  component?: string;
  properties?: Record<string, any>;
  exception?: ErrorInfo;
}

export interface TelemetryTrace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  status: 'ok' | 'error' | 'timeout';
  tags?: Record<string, string>;
  logs?: TelemetryLog[];
}

export interface TelemetryLog {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  component?: string;
  traceId?: string;
  spanId?: string;
  properties?: Record<string, any>;
}

export interface TelemetryContext {
  analyzer: string;
  version: string;
  projectPath: string;
  projectName: string;
  projectSize: number;
  language: string;
  framework?: string;
  platform: string;
  nodeVersion?: string;
  memory: MemoryInfo;
  cpu: CPUInfo;
}

export interface ErrorInfo {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  component?: string;
  recoverable: boolean;
}

export interface MemoryInfo {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

export interface CPUInfo {
  model: string;
  cores: number;
  usage?: number;
}

// ===== PROGRESSIVE ANALYSIS =====

export interface ProgressiveAnalysisState {
  analysisId: string;
  phase: AnalysisPhase;
  progress: number; // 0-100
  currentOperation: string;
  estimatedTimeRemaining?: number;
  partialResults?: Partial<ArchitectureBlueprint>;
  checkpoints: AnalysisCheckpoint[];
  error?: ErrorInfo;
}

export type AnalysisPhase =
  | 'initialization'
  | 'language-detection'
  | 'file-discovery'
  | 'component-analysis'
  | 'relationship-analysis'
  | 'pattern-detection'
  | 'risk-assessment'
  | 'manifest-generation'
  | 'validation'
  | 'completed'
  | 'failed';

export interface AnalysisCheckpoint {
  phase: AnalysisPhase;
  timestamp: Date;
  duration: number;
  success: boolean;
  data?: any;
  error?: ErrorInfo;
}

// ===== EXTENSIBILITY AND PLUGINS =====

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  homepage?: string;
  repository?: string;
  keywords: string[];
  engines: PluginEngineRequirements;
  main: string;
  capabilities: AnalyzerCapabilities;
  dependencies: PluginDependency[];
  configuration?: PluginConfigurationSchema;
  resources?: PluginResource[];
}

export interface PluginEngineRequirements {
  unravl: string;
  node?: string;
  npm?: string;
}

export interface PluginDependency {
  name: string;
  version: string;
  optional: boolean;
  reason?: string;
}

export interface PluginConfigurationSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface PluginResource {
  type: 'file' | 'url' | 'template' | 'schema';
  path: string;
  description?: string;
  required?: boolean;
}

// ===== BATCH AND ENTERPRISE FEATURES =====

export interface BatchAnalysisRequest {
  id: string;
  projects: BatchProject[];
  options: BatchAnalysisOptions;
  schedule?: AnalysisSchedule;
  notifications?: NotificationConfiguration;
}

export interface BatchProject {
  name: string;
  path: string;
  repository?: RepositoryInfo;
  configuration?: Partial<AnalyzerConfiguration>;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface BatchAnalysisOptions {
  parallel: boolean;
  maxConcurrency: number;
  failFast: boolean;
  aggregateResults: boolean;
  compareWithBaseline?: string;
  outputFormat: 'individual' | 'aggregate' | 'both';
}

export interface AnalysisSchedule {
  type: 'immediate' | 'cron' | 'interval' | 'trigger';
  expression?: string; // cron expression or interval
  timezone?: string;
  triggers?: ScheduleTrigger[];
}

export interface ScheduleTrigger {
  type: 'webhook' | 'file-change' | 'git-push' | 'time';
  configuration: Record<string, any>;
}

export interface NotificationConfiguration {
  channels: NotificationChannel[];
  events: NotificationEvent[];
  templates?: NotificationTemplate[];
}

export interface NotificationChannel {
  type: 'email' | 'slack' | 'webhook' | 'sms';
  configuration: Record<string, any>;
  enabled: boolean;
}

export interface NotificationEvent {
  type: 'started' | 'completed' | 'failed' | 'warning' | 'error';
  channels: string[];
  conditions?: NotificationCondition[];
}

export interface NotificationCondition {
  field: string;
  operator: 'equals' | 'greater-than' | 'less-than' | 'contains';
  value: any;
}

export interface NotificationTemplate {
  event: string;
  channel: string;
  subject?: string;
  body: string;
  format: 'text' | 'html' | 'markdown';
}

export interface RepositoryInfo {
  url: string;
  branch?: string;
  commit?: string;
  credentials?: RepositoryCredentials;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'custom';
}

export interface RepositoryCredentials {
  type: 'token' | 'ssh-key' | 'username-password';
  value: string;
  username?: string;
}

// ===== AUTHENTICATION AND USER MANAGEMENT =====

export interface User {
  id: string;
  email: string;
  email_verified_at?: Date;
  password_hash?: string;
  first_name?: string;
  last_name?: string;
  avatar_url?: string;
  timezone?: string;
  locale?: string;
  last_login_at?: Date;
  settings?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  description?: string;
  website_url?: string;
  logo_url?: string;
  settings?: Record<string, any>;
  billing_email?: string;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface Membership {
  id: string;
  user_id: string;
  organization_id: string;
  team_id?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  permissions?: string[];
  invited_by?: string;
  invited_at?: Date;
  joined_at?: Date;
  created_at: Date;
  organization_name?: string;
  organization_slug?: string;
  team_name?: string;
  team_slug?: string;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
  revoked_at?: Date;
}

export interface JWTPayload {
  sub: string; // user id
  email: string;
  organizations?: {
    id: string;
    role: string;
  }[];
  iat?: number;
  exp?: number;
  type?: 'access' | 'refresh';
}

export interface AuthRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: User;
  organizations?: Organization[];
}

export interface OAuthProfile {
  id: string;
  email: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  avatar_url?: string;
  provider: string;
}

// ===== COMPARATIVE ANALYSIS =====

export interface ComparativeAnalysisRequest {
  baseline: AnalysisReference;
  comparison: AnalysisReference;
  options: ComparisonOptions;
}

export interface AnalysisReference {
  type: 'file' | 'analysis-id' | 'project-path';
  value: string;
  version?: string;
  timestamp?: Date;
}

export interface ComparisonOptions {
  includeComponents: boolean;
  includeConnections: boolean;
  includeMetrics: boolean;
  includeRisks: boolean;
  sensitivityThreshold: number; // 0-1
  categories?: ComparisonCategory[];
}

export type ComparisonCategory = 
  | 'architecture'
  | 'complexity'
  | 'performance'
  | 'security'
  | 'testing'
  | 'dependencies'
  | 'quality';

export interface ComparisonResult {
  summary: ComparisonSummary;
  differences: ArchitecturalDifference[];
  recommendations: ComparisonRecommendation[];
  score: ComparisonScore;
}

export interface ComparisonSummary {
  totalChanges: number;
  significantChanges: number;
  improvements: number;
  regressions: number;
  newComponents: number;
  removedComponents: number;
  modifiedComponents: number;
}

export interface ArchitecturalDifference {
  category: ComparisonCategory;
  type: 'addition' | 'removal' | 'modification';
  component?: string;
  before?: any;
  after?: any;
  significance: 'low' | 'medium' | 'high';
  description: string;
}

export interface ComparisonRecommendation {
  category: ComparisonCategory;
  priority: 'low' | 'medium' | 'high';
  action: string;
  rationale: string;
  impact: string;
  effort: 'low' | 'medium' | 'high';
}

export interface ComparisonScore {
  overall: number; // -100 to 100
  categories: Record<ComparisonCategory, number>;
  explanation: string;
}