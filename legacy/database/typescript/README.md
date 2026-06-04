# Klauro Database Layer

This TypeScript database layer provides comprehensive access to the Klauro platform's PostgreSQL database, with perfect alignment between the analyzer architecture types and telemetry system requirements.

## Features

- 🔄 **Perfect Type Alignment**: Fully aligned with `BaseAnalyzer` types and `TelemetryCollector` schema
- 🚀 **High Performance**: Optimized for time-series telemetry data with partitioning and indexing
- 🔧 **Real-time Analytics**: Built-in views and functions for live system monitoring
- 📊 **Health Monitoring**: Comprehensive component and system health tracking
- 🛠️ **Maintenance Tools**: Automated cleanup, partitioning, and optimization
- 🔒 **Transaction Support**: Full ACID transaction support with retry mechanisms
- 📈 **Telemetry Integration**: Direct integration with the telemetry collection system

## Quick Start

### Installation

```bash
npm install @klauro/database
```

### Basic Setup

```typescript
import {
  DatabaseClient,
  DatabaseClientFactory,
  createDatabaseConfig
} from '@klauro/database';

// Create database configuration
const config = createDatabaseConfig({
  host: 'localhost',
  port: 5432,
  database: 'klauro',
  user: 'postgres',
  password: 'your_password'
});

// Initialize database client
const db = DatabaseClientFactory.create(config);
await db.connect();

// Access repositories
const analyzer = db.analyzer;
const telemetry = db.telemetry;
```

### Environment Variables

```bash
DB_HOST=localhost
DB_PORT=5432
DB_NAME=klauro
DB_USER=postgres
DB_PASSWORD=your_password
DB_SSL=false
DB_MAX_CONNECTIONS=20
```

## Repository Usage

### Analyzer Repository

Perfect integration with `BaseAnalyzer` for storing architecture analysis results:

```typescript
import { AnalyzerRepository, ArchitectureBlueprint } from '@klauro/database';

// Create an analysis run
const analysisRunId = await analyzer.createAnalysisRun({
  projectId: 'project-uuid',
  commitSha: 'abc123',
  branch: 'main',
  analyzerVersion: '1.0.0'
});

// Save complete architecture blueprint
const blueprint: ArchitectureBlueprint = {
  // ... your analyzer results
};

await analyzer.saveCompleteBlueprint(analysisRunId, blueprint);

// Retrieve components with health scores
const components = await analyzer.getComponents(analysisRunId);

// Get project health overview
const health = await analyzer.getProjectHealth('project-uuid');
```

### Telemetry Repository

Seamless integration with `TelemetryCollector` for real-time data:

```typescript
import { TelemetryRepository, TelemetryEventCreateData } from '@klauro/database';

// Insert telemetry events (single)
await telemetry.insertTelemetryEvent({
  projectId: 'project-uuid',
  componentId: 'component-123',
  eventType: 'function_call',
  eventName: 'processData',
  durationMs: 150,
  status: 'success'
});

// Batch insert for high performance
const events: TelemetryEventCreateData[] = [
  // ... array of events
];
await telemetry.insertTelemetryEventsBatch(events);

// Real-time component performance monitoring
const performance = await telemetry.getRealtimeComponentPerformance('project-uuid');

// System health dashboard
const dashboard = await telemetry.getProjectHealthDashboard('project-uuid');
```

## Advanced Features

### Call Graph Analysis

```typescript
// Save call graph from analyzer
await analyzer.saveCallGraph(analysisRunId, callGraph);

// Get call graph analysis with risk assessment
const analysis = await telemetry.getCallGraphAnalysis('project-uuid');

// Get hot functions based on telemetry data
const hotFunctions = await telemetry.getHotFunctions('project-uuid', '1 hour', 20);
```

### Instrumentation Management

```typescript
// Create instrumentation point
await telemetry.createInstrumentationPoint({
  projectId: 'project-uuid',
  componentId: 'component-123',
  pointId: 'func_processData_entry',
  pointType: 'function_entry',
  locationFile: '/src/processor.ts',
  locationLine: 45,
  samplingRate: 0.1 // 10% sampling
});

// Update metrics from instrumentation
await telemetry.updateInstrumentationMetrics('func_processData_entry', 150, false);

// Check instrumentation effectiveness
const effectiveness = await telemetry.getInstrumentationEffectiveness('project-uuid');
```

### Health Monitoring

```typescript
// Calculate component health in real-time
const healthScore = await telemetry.calculateComponentHealth(
  'project-uuid', 
  'component-123', 
  '1 hour'
);

// Track system health snapshot
await telemetry.insertSystemHealthSnapshot({
  projectId: 'project-uuid',
  timestamp: new Date(),
  totalComponents: 45,
  healthyComponents: 40,
  warningComponents: 4,
  criticalComponents: 1,
  averageHealthScore: 78.5,
  // ... other metrics
});

// Get comprehensive system health
const systemHealth = await telemetry.getSystemHealthComprehensive('project-uuid');
```

### Performance Analytics

```typescript
// Get optimization opportunities
const optimizations = await telemetry.getOptimizationOpportunities('project-uuid', 20);

// Track and resolve bottlenecks
await telemetry.insertBottleneck({
  projectId: 'project-uuid',
  componentId: 'slow-component',
  bottleneckType: 'cpu',
  location: 'processLargeData function',
  severity: 'high',
  impactScore: 85,
  frequencyCount: 1,
  averageDelayMs: 5000,
  recommendations: ['Add caching', 'Optimize algorithm'],
  metrics: { cpuUsage: 95, memoryUsage: 78 }
});

// Get active bottlenecks
const bottlenecks = await telemetry.getActiveBottlenecks('project-uuid', 'high');
```

### Error Tracking

```typescript
// Track errors with automatic grouping
await telemetry.trackError(
  'project-uuid',
  'component-123',
  'TypeError',
  'Cannot read property of undefined',
  'stack trace here',
  ['api', 'authentication'],
  { userId: 'user-456', endpoint: '/api/login' }
);

// Get errors by component
const errors = await telemetry.getErrorsByComponent('project-uuid', 'component-123');

// Resolve error
await telemetry.resolveError('project-uuid', 'error-hash-123');
```

## Database Views and Analytics

### Pre-built Analytics Views

```typescript
// Real-time component performance
const realtimePerf = await db.query(`
  SELECT * FROM v_component_performance_realtime 
  WHERE project_id = $1 AND status = 'critical'
`, ['project-uuid']);

// Project health dashboard
const healthDashboard = await db.query(`
  SELECT * FROM v_project_health_dashboard 
  WHERE project_id = $1
`, ['project-uuid']);

// Hot functions analysis
const hotFunctions = await db.query(`
  SELECT * FROM v_hot_functions 
  WHERE performance_category = 'critical_performance'
  ORDER BY hotness_score DESC 
  LIMIT 10
`);

// Optimization opportunities
const opportunities = await db.query(`
  SELECT * FROM v_optimization_opportunities 
  WHERE project_id = $1 AND priority_rank <= 10
`, ['project-uuid']);
```

### Custom Query Patterns

```typescript
import { DatabasePatterns } from '@klauro/database';

// Use pre-built query patterns
const slowestComponents = await db.query(
  DatabasePatterns.performance.getSlowestComponents('project-uuid', 10),
  ['project-uuid']
);

const recentEvents = await db.query(
  DatabasePatterns.telemetry.getRecentEvents('project-uuid', 2),
  ['project-uuid']
);
```

## Transaction Management

```typescript
// Simple transaction
await db.transaction(async (client) => {
  await client.query('INSERT INTO components (...) VALUES (...)');
  await client.query('INSERT INTO connections (...) VALUES (...)');
  // If any query fails, all are rolled back
});

// Transaction with retry on failure
await db.transactionWithRetry(async (client) => {
  // Transaction logic here
  await client.query('...');
}, 3); // Retry up to 3 times on retriable errors
```

## Health Monitoring and Maintenance

```typescript
// Check database health
const health = await db.healthCheck();
console.log(`Database healthy: ${health.healthy}, latency: ${health.latencyMs}ms`);

// Detailed health check
const detailedHealth = await db.detailedHealthCheck();

// Run maintenance tasks
const maintenanceResults = await db.runMaintenance();

// Monitor table sizes
const tableSizes = await db.getTableSizes();

// Check connection info
const connInfo = await db.getConnectionInfo();

// Clean up old telemetry data
const cleanupResult = await telemetry.cleanupOldTelemetryData();

// Refresh materialized views
await telemetry.refreshTelemetryViews();
```

## Configuration Options

### Database Configuration

```typescript
const config: DatabaseConfig = {
  host: 'localhost',
  port: 5432,
  database: 'klauro',
  user: 'postgres',
  password: 'password',
  ssl: false,
  max: 20, // Maximum connections in pool
  idleTimeoutMillis: 30000, // 30 seconds
  connectionTimeoutMillis: 10000, // 10 seconds
  maxUses: 7500, // Recycle connections after 7500 uses
  application_name: 'klauro-platform'
};
```

### Connection URL

```typescript
const db = DatabaseClientFactory.create(
  createDatabaseConfigFromUrl('postgresql://user:pass@localhost:5432/klauro')
);
```

## Performance Considerations

### High-Volume Telemetry Ingestion

```typescript
// Use batch inserts for high-volume telemetry
const events = []; // Array of 1000+ events
await telemetry.insertTelemetryEventsBatch(events); // Much faster than individual inserts

// Use streaming for extremely high volumes
// The repository uses PostgreSQL COPY for maximum performance
```

### Partitioning Support

The database automatically partitions telemetry tables by time:
- `telemetry_events`: Monthly partitions
- `telemetry_traces`: Monthly partitions  
- `component_health_metrics`: Daily partitions

### Indexing Strategy

Comprehensive indexes are automatically created for:
- Time-series queries (timestamp-based)
- Component lookups
- Project-based queries
- Call graph traversals
- Error grouping and tracking

## Error Handling

```typescript
import { DatabaseError, ValidationError, NotFoundError } from '@klauro/database';

try {
  await analyzer.getComponents('non-existent-analysis');
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Analysis not found');
  } else if (error instanceof ValidationError) {
    console.log('Invalid data provided');
  } else if (error instanceof DatabaseError) {
    console.log('Database error:', error.code);
  }
}
```

## Migration Support

```typescript
// Check and run migrations
const migrationStatus = await db.runMigrations();
console.log('Migrations:', migrationStatus);
```

## Best Practices

### 1. Connection Management
```typescript
// Always use the singleton factory
const db = DatabaseClientFactory.getInstance();

// Proper shutdown
process.on('SIGINT', async () => {
  await DatabaseClientFactory.shutdown();
  process.exit(0);
});
```

### 2. Performance Optimization
```typescript
// Use batch operations for bulk data
await telemetry.insertTelemetryEventsBatch(events);

// Use transactions for related operations
await db.transaction(async (client) => {
  // Related operations here
});

// Use prepared statements for repeated queries
// The repositories handle this automatically
```

### 3. Error Handling
```typescript
// Always handle database errors
try {
  await telemetry.insertTelemetryEvent(event);
} catch (error) {
  console.error('Failed to insert telemetry:', error);
  // Handle gracefully - maybe queue for retry
}
```

### 4. Health Monitoring
```typescript
// Regular health checks
setInterval(async () => {
  const health = await db.healthCheck();
  if (!health.healthy) {
    console.error('Database unhealthy:', health.error);
    // Alert monitoring system
  }
}, 30000); // Every 30 seconds
```

## Integration Examples

### With BaseAnalyzer

```typescript
import { BaseAnalyzer } from '../analyzer/base-analyzer';
import { DatabaseClientFactory } from '@klauro/database';

class MyAnalyzer extends BaseAnalyzer {
  async analyzeRepository(repositoryPath: string, options: AnalyzerOptions) {
    // Run analysis
    const blueprint = await super.analyzeRepository(repositoryPath, options);
    
    // Save to database
    const db = DatabaseClientFactory.getInstance();
    const analysisRunId = await db.analyzer.createAnalysisRun({
      projectId: 'project-uuid',
      analyzerVersion: '1.0.0'
    });
    
    await db.analyzer.saveCompleteBlueprint(analysisRunId, blueprint);
    
    return blueprint;
  }
}
```

### With TelemetryCollector

```typescript
import { TelemetryCollector } from '../telemetry/telemetry-schema';
import { DatabaseClientFactory } from '@klauro/database';

const collector = new TelemetryCollector();

// Override the persistence method to use our database
collector.persistEvents = async (events) => {
  const db = DatabaseClientFactory.getInstance();
  await db.telemetry.insertTelemetryEventsBatch(
    events.map(e => ({
      projectId: e.metadata.projectId,
      componentId: e.source.component,
      eventType: e.type,
      eventName: e.source.function || e.type,
      timestamp: new Date(e.timestamp),
      durationMs: e.performance?.duration,
      // ... map other fields
    }))
  );
};
```

## License

MIT - See LICENSE file for details.