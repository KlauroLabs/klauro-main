/**
 * Analyzer Repository
 * Database access layer for analyzer architecture data
 * Perfectly aligned with BaseAnalyzer types and database schema
 */

import { Pool } from 'pg';
import {
  ArchitectureBlueprint,
  ComponentNode,
  Connection,
  EntryPoint,
  ExitPoint,
  RiskArea,
  CallGraph,
  CallGraphNode,
  CallGraphEdge,
  HotPath,
  FunctionInfo,
  DatabaseConnection,
  OptimizationSuggestion,
  ProjectMetadata,
  TechnologyStack,
  DependencyAnalysis,
  TestCoverage,
  SecurityVulnerability,
  APIEndpoint
} from '../../../packages/analyzer-core/src/types';

export interface AnalysisRunCreateData {
  projectId: string;
  triggeredBy?: string;
  commitSha?: string;
  branch?: string;
  analyzerVersion: string;
  metadata?: Record<string, any>;
}

export interface ComponentCreateData extends Omit<ComponentNode, 'id'> {
  analysisRunId: string;
  sourceHash?: string;
  fileSizeBytes?: number;
  frameworkSpecificMetadata?: Record<string, any>;
}

export interface CallGraphNodeCreateData extends Omit<CallGraphNode, 'id'> {
  analysisRunId: string;
}

export interface CallGraphEdgeCreateData extends Omit<CallGraphEdge, 'id'> {
  analysisRunId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface AnalysisManifest {
  id: string;
  analysisRunId: string;
  manifestType: 'blueprint' | 'telemetry' | 'comparison' | 'security' | 'testing';
  manifestVersion: string;
  manifestData: Record<string, any>;
  manifestHash: string;
  fileSizeBytes?: number;
  compressionUsed: boolean;
  createdAt: Date;
}

export class AnalyzerRepository {
  constructor(private pool: Pool) {}

  // =============================================================================
  // ANALYSIS RUN MANAGEMENT
  // =============================================================================

  async createAnalysisRun(data: AnalysisRunCreateData): Promise<string> {
    const query = `
      INSERT INTO analysis_runs (
        project_id, triggered_by, commit_sha, branch,
        analyzer_version, status, metadata, started_at
      ) VALUES ($1, $2, $3, $4, $5, 'running', $6, NOW())
      RETURNING id
    `;
    
    const result = await this.pool.query(query, [
      data.projectId,
      data.triggeredBy,
      data.commitSha,
      data.branch,
      data.analyzerVersion,
      JSON.stringify(data.metadata || {})
    ]);

    return result.rows[0].id;
  }

  async completeAnalysisRun(
    analysisRunId: string, 
    processingTimeMs: number,
    errorMessage?: string
  ): Promise<void> {
    const status = errorMessage ? 'failed' : 'completed';
    const query = `
      UPDATE analysis_runs 
      SET status = $1, completed_at = NOW(), processing_time_ms = $2, error_message = $3
      WHERE id = $4
    `;
    
    await this.pool.query(query, [status, processingTimeMs, errorMessage, analysisRunId]);
  }

  async getLatestAnalysisRun(projectId: string): Promise<string | null> {
    const query = `
      SELECT id FROM analysis_runs
      WHERE project_id = $1 AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `;
    
    const result = await this.pool.query(query, [projectId]);
    return result.rows[0]?.id || null;
  }

  async getAnalysisRunStatus(analysisRunId: string): Promise<{
    status: string;
    startedAt: Date;
    completedAt?: Date;
    processingTimeMs?: number;
    errorMessage?: string;
  } | null> {
    const query = `
      SELECT status, started_at, completed_at, processing_time_ms, error_message
      FROM analysis_runs
      WHERE id = $1
    `;
    
    const result = await this.pool.query(query, [analysisRunId]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      processingTimeMs: row.processing_time_ms,
      errorMessage: row.error_message
    };
  }

  // =============================================================================
  // COMPONENT MANAGEMENT
  // =============================================================================

  async saveComponents(components: ComponentCreateData[]): Promise<void> {
    if (components.length === 0) return;

    const query = `
      INSERT INTO components (
        analysis_run_id, component_id, name, type, path, architectural_layer,
        line_count, complexity, last_modified, is_entry_point, is_orphaned,
        exports, imports, responsibilities, ai_description, test_coverage,
        position_x, position_y, http_methods, db_queries, external_calls,
        functions, performance_metrics, side_effects, annotations,
        source_hash, file_size_bytes, framework_specific_metadata, metadata
      ) VALUES ${components.map((_, i) => 
        `($${i * 29 + 1}, $${i * 29 + 2}, $${i * 29 + 3}, $${i * 29 + 4}, $${i * 29 + 5}, 
         $${i * 29 + 6}, $${i * 29 + 7}, $${i * 29 + 8}, $${i * 29 + 9}, $${i * 29 + 10}, 
         $${i * 29 + 11}, $${i * 29 + 12}, $${i * 29 + 13}, $${i * 29 + 14}, $${i * 29 + 15}, 
         $${i * 29 + 16}, $${i * 29 + 17}, $${i * 29 + 18}, $${i * 29 + 19}, $${i * 29 + 20}, 
         $${i * 29 + 21}, $${i * 29 + 22}, $${i * 29 + 23}, $${i * 29 + 24}, $${i * 29 + 25}, 
         $${i * 29 + 26}, $${i * 29 + 27}, $${i * 29 + 28}, $${i * 29 + 29})`
      ).join(', ')}
      ON CONFLICT (analysis_run_id, component_id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        path = EXCLUDED.path,
        architectural_layer = EXCLUDED.architectural_layer,
        line_count = EXCLUDED.line_count,
        complexity = EXCLUDED.complexity,
        last_modified = EXCLUDED.last_modified,
        is_entry_point = EXCLUDED.is_entry_point,
        is_orphaned = EXCLUDED.is_orphaned,
        exports = EXCLUDED.exports,
        imports = EXCLUDED.imports,
        responsibilities = EXCLUDED.responsibilities,
        ai_description = EXCLUDED.ai_description,
        test_coverage = EXCLUDED.test_coverage,
        position_x = EXCLUDED.position_x,
        position_y = EXCLUDED.position_y,
        http_methods = EXCLUDED.http_methods,
        db_queries = EXCLUDED.db_queries,
        external_calls = EXCLUDED.external_calls,
        functions = EXCLUDED.functions,
        performance_metrics = EXCLUDED.performance_metrics,
        side_effects = EXCLUDED.side_effects,
        annotations = EXCLUDED.annotations,
        source_hash = EXCLUDED.source_hash,
        file_size_bytes = EXCLUDED.file_size_bytes,
        framework_specific_metadata = EXCLUDED.framework_specific_metadata,
        metadata = EXCLUDED.metadata
    `;

    const values: any[] = [];
    components.forEach(comp => {
      values.push(
        comp.analysisRunId, comp.id, comp.name, comp.type, comp.path,
        comp.metadata.layer, comp.metadata.lineCount, comp.metadata.complexity,
        comp.metadata.lastModified, comp.metadata.isEntry, comp.metadata.isOrphaned,
        JSON.stringify(comp.metadata.exports || []),
        JSON.stringify(comp.metadata.imports || []),
        JSON.stringify(comp.metadata.responsibilities || []),
        comp.metadata.aiDescription,
        comp.metadata.testCoverage,
        comp.position?.x, comp.position?.y,
        JSON.stringify(comp.metadata.httpMethods || []),
        JSON.stringify(comp.metadata.dbQueries || []),
        JSON.stringify(comp.metadata.externalCalls || []),
        JSON.stringify(comp.metadata.functions || []),
        JSON.stringify(comp.metadata.performanceMetrics || {}),
        JSON.stringify([]), // side_effects - would need to extract from metadata
        JSON.stringify([]), // annotations - would need to extract from metadata
        comp.sourceHash,
        comp.fileSizeBytes,
        JSON.stringify(comp.frameworkSpecificMetadata || {}),
        JSON.stringify(comp.metadata)
      );
    });

    await this.pool.query(query, values);
  }

  async getComponents(analysisRunId: string): Promise<ComponentNode[]> {
    const query = `
      SELECT 
        component_id, name, type, path, architectural_layer,
        line_count, complexity, last_modified, is_entry_point, is_orphaned,
        exports, imports, responsibilities, ai_description, test_coverage,
        position_x, position_y, http_methods, db_queries, external_calls,
        functions, performance_metrics, health_score, metadata
      FROM components
      WHERE analysis_run_id = $1
      ORDER BY name
    `;

    const result = await this.pool.query(query, [analysisRunId]);
    
    return result.rows.map(row => ({
      id: row.component_id,
      name: row.name,
      type: row.type,
      path: row.path,
      dependencies: [], // Would need to derive from connections
      dependents: [], // Would need to derive from connections
      metadata: {
        lineCount: row.line_count,
        complexity: row.complexity,
        lastModified: row.last_modified,
        exports: row.exports || [],
        imports: row.imports || [],
        httpMethods: row.http_methods || [],
        dbQueries: row.db_queries || [],
        externalCalls: row.external_calls || [],
        isEntry: row.is_entry_point,
        isOrphaned: row.is_orphaned,
        layer: row.architectural_layer,
        responsibilities: row.responsibilities || [],
        aiDescription: row.ai_description,
        functions: row.functions || [],
        testCoverage: row.test_coverage,
        performanceMetrics: row.performance_metrics || {}
      },
      position: row.position_x && row.position_y ? {
        x: row.position_x,
        y: row.position_y
      } : undefined
    }));
  }

  async getComponentsByIds(
    analysisRunId: string, 
    componentIds: string[]
  ): Promise<ComponentNode[]> {
    if (componentIds.length === 0) return [];

    const query = `
      SELECT 
        component_id, name, type, path, architectural_layer,
        line_count, complexity, last_modified, is_entry_point, is_orphaned,
        exports, imports, responsibilities, ai_description, test_coverage,
        position_x, position_y, http_methods, db_queries, external_calls,
        functions, performance_metrics, health_score, metadata
      FROM components
      WHERE analysis_run_id = $1 AND component_id = ANY($2)
      ORDER BY name
    `;

    const result = await this.pool.query(query, [analysisRunId, componentIds]);
    
    // Use the same mapping logic as getComponents
    return result.rows.map(row => ({
      id: row.component_id,
      name: row.name,
      type: row.type,
      path: row.path,
      dependencies: [],
      dependents: [],
      metadata: {
        lineCount: row.line_count,
        complexity: row.complexity,
        lastModified: row.last_modified,
        exports: row.exports || [],
        imports: row.imports || [],
        httpMethods: row.http_methods || [],
        dbQueries: row.db_queries || [],
        externalCalls: row.external_calls || [],
        isEntry: row.is_entry_point,
        isOrphaned: row.is_orphaned,
        layer: row.architectural_layer,
        responsibilities: row.responsibilities || [],
        aiDescription: row.ai_description,
        functions: row.functions || [],
        testCoverage: row.test_coverage,
        performanceMetrics: row.performance_metrics || {}
      },
      position: row.position_x && row.position_y ? {
        x: row.position_x,
        y: row.position_y
      } : undefined
    }));
  }

  async updateComponentHealth(
    analysisRunId: string,
    componentId: string,
    healthScore: number
  ): Promise<void> {
    // The health score is automatically calculated, but we can trigger a recalculation
    const query = `
      UPDATE components 
      SET metadata = jsonb_set(metadata, '{lastHealthUpdate}', to_jsonb(NOW()))
      WHERE analysis_run_id = $1 AND component_id = $2
    `;
    
    await this.pool.query(query, [analysisRunId, componentId]);
  }

  // =============================================================================
  // CONNECTION MANAGEMENT
  // =============================================================================

  async saveConnections(
    analysisRunId: string,
    connections: Connection[]
  ): Promise<void> {
    if (connections.length === 0) return;

    // First, get the internal component IDs for the connection component_ids
    const componentIdMap = await this.getComponentIdMapping(analysisRunId);

    const query = `
      INSERT INTO connections (
        analysis_run_id, from_component_id, to_component_id, connection_type,
        weight, call_sites, data_flow, http_method, metadata
      ) VALUES ${connections.map((_, i) => 
        `($${i * 9 + 1}, $${i * 9 + 2}, $${i * 9 + 3}, $${i * 9 + 4}, $${i * 9 + 5}, $${i * 9 + 6}, $${i * 9 + 7}, $${i * 9 + 8}, $${i * 9 + 9})`
      ).join(', ')}
      ON CONFLICT (analysis_run_id, from_component_id, to_component_id, connection_type) 
      DO UPDATE SET
        weight = EXCLUDED.weight,
        call_sites = EXCLUDED.call_sites,
        data_flow = EXCLUDED.data_flow,
        http_method = EXCLUDED.http_method,
        metadata = EXCLUDED.metadata
    `;

    const values: any[] = [];
    connections.forEach(conn => {
      const fromId = componentIdMap.get(conn.from);
      const toId = componentIdMap.get(conn.to);
      
      if (fromId && toId) {
        values.push(
          analysisRunId,
          fromId,
          toId,
          conn.type,
          conn.weight,
          conn.metadata?.callSites || 0,
          conn.metadata?.dataFlow,
          conn.metadata?.httpMethod,
          JSON.stringify(conn.metadata || {})
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  async getConnections(analysisRunId: string): Promise<Connection[]> {
    const query = `
      SELECT 
        c.connection_type, c.weight, c.call_sites, c.data_flow, c.http_method, c.metadata,
        from_comp.component_id as from_component_id,
        to_comp.component_id as to_component_id
      FROM connections c
      JOIN components from_comp ON c.from_component_id = from_comp.id
      JOIN components to_comp ON c.to_component_id = to_comp.id
      WHERE c.analysis_run_id = $1
      ORDER BY c.weight DESC
    `;

    const result = await this.pool.query(query, [analysisRunId]);
    
    return result.rows.map(row => ({
      from: row.from_component_id,
      to: row.to_component_id,
      type: row.connection_type,
      weight: row.weight,
      metadata: {
        callSites: row.call_sites,
        dataFlow: row.data_flow,
        httpMethod: row.http_method,
        ...((row.metadata as any) || {})
      }
    }));
  }

  private async getComponentIdMapping(analysisRunId: string): Promise<Map<string, string>> {
    const query = `
      SELECT id, component_id FROM components WHERE analysis_run_id = $1
    `;
    
    const result = await this.pool.query(query, [analysisRunId]);
    const map = new Map<string, string>();
    
    result.rows.forEach(row => {
      map.set(row.component_id, row.id);
    });
    
    return map;
  }

  // =============================================================================
  // CALL GRAPH MANAGEMENT
  // =============================================================================

  async saveCallGraph(analysisRunId: string, callGraph: CallGraph): Promise<void> {
    // Save call graph nodes
    if (callGraph.nodes.length > 0) {
      await this.saveCallGraphNodes(analysisRunId, callGraph.nodes);
    }

    // Save call graph edges
    if (callGraph.edges.length > 0) {
      await this.saveCallGraphEdges(analysisRunId, callGraph.edges);
    }

    // Save hot paths
    if (callGraph.hotPaths.length > 0) {
      await this.saveHotPaths(analysisRunId, callGraph.hotPaths);
    }
  }

  private async saveCallGraphNodes(
    analysisRunId: string,
    nodes: CallGraphNode[]
  ): Promise<void> {
    const componentIdMap = await this.getComponentIdMapping(analysisRunId);

    const query = `
      INSERT INTO call_graph_nodes (
        analysis_run_id, component_id, node_id, name, node_type, file_path,
        line_number, column_number, signature, return_type, complexity,
        fan_in, fan_out, depth, is_critical, is_async, is_generator,
        is_constructor, is_static, is_abstract, parameters, annotations,
        side_effects, test_coverage, performance_metrics
      ) VALUES ${nodes.map((_, i) => 
        `($${i * 25 + 1}, $${i * 25 + 2}, $${i * 25 + 3}, $${i * 25 + 4}, $${i * 25 + 5}, 
         $${i * 25 + 6}, $${i * 25 + 7}, $${i * 25 + 8}, $${i * 25 + 9}, $${i * 25 + 10}, 
         $${i * 25 + 11}, $${i * 25 + 12}, $${i * 25 + 13}, $${i * 25 + 14}, $${i * 25 + 15}, 
         $${i * 25 + 16}, $${i * 25 + 17}, $${i * 25 + 18}, $${i * 25 + 19}, $${i * 25 + 20}, 
         $${i * 25 + 21}, $${i * 25 + 22}, $${i * 25 + 23}, $${i * 25 + 24}, $${i * 25 + 25})`
      ).join(', ')}
      ON CONFLICT (analysis_run_id, node_id) DO UPDATE SET
        name = EXCLUDED.name,
        node_type = EXCLUDED.node_type,
        complexity = EXCLUDED.complexity,
        fan_in = EXCLUDED.fan_in,
        fan_out = EXCLUDED.fan_out,
        depth = EXCLUDED.depth,
        is_critical = EXCLUDED.is_critical
    `;

    const values: any[] = [];
    nodes.forEach(node => {
      const componentId = componentIdMap.get(node.file); // Using file as component lookup
      if (componentId) {
        values.push(
          analysisRunId, componentId, node.id, node.name, node.type,
          node.file, undefined, undefined, // line_number, column_number
          undefined, undefined, // signature, return_type
          node.complexity, node.fanIn, node.fanOut, node.depth,
          node.critical, false, false, false, false, false, // boolean flags
          JSON.stringify([]), // parameters
          JSON.stringify([]), // annotations
          JSON.stringify([]), // side_effects
          undefined, // test_coverage
          JSON.stringify({}) // performance_metrics
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  private async saveCallGraphEdges(
    analysisRunId: string,
    edges: CallGraphEdge[]
  ): Promise<void> {
    // Get node ID mappings
    const nodeIdMap = await this.getCallGraphNodeIdMapping(analysisRunId);

    const query = `
      INSERT INTO call_graph_edges (
        analysis_run_id, from_node_id, to_node_id, call_count,
        edge_type, is_async, is_conditional, call_sites
      ) VALUES ${edges.map((_, i) => 
        `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`
      ).join(', ')}
      ON CONFLICT (analysis_run_id, from_node_id, to_node_id) DO UPDATE SET
        call_count = EXCLUDED.call_count,
        edge_type = EXCLUDED.edge_type,
        is_async = EXCLUDED.is_async,
        is_conditional = EXCLUDED.is_conditional,
        call_sites = EXCLUDED.call_sites
    `;

    const values: any[] = [];
    edges.forEach(edge => {
      const fromNodeId = nodeIdMap.get(edge.from);
      const toNodeId = nodeIdMap.get(edge.to);
      
      if (fromNodeId && toNodeId) {
        values.push(
          analysisRunId,
          fromNodeId,
          toNodeId,
          edge.count,
          edge.type,
          edge.async,
          edge.conditional,
          JSON.stringify([])
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  private async saveHotPaths(
    analysisRunId: string,
    hotPaths: HotPath[]
  ): Promise<void> {
    // Get node ID mappings for the path nodes
    const nodeIdMap = await this.getCallGraphNodeIdMapping(analysisRunId);

    const query = `
      INSERT INTO hot_paths (
        analysis_run_id, path_nodes, frequency_score, average_time_ms,
        critical_path, description, optimization_suggestions
      ) VALUES ${hotPaths.map((_, i) => 
        `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`
      ).join(', ')}
    `;

    const values: any[] = [];
    hotPaths.forEach(path => {
      // Map path node IDs to database IDs
      const pathNodeIds: string[] = [];
      path.path.forEach(nodeId => {
        const dbNodeId = nodeIdMap.get(nodeId);
        if (dbNodeId) {
          pathNodeIds.push(dbNodeId);
        }
      });

      if (pathNodeIds.length > 0) {
        values.push(
          analysisRunId,
          pathNodeIds, // PostgreSQL array
          path.frequency / 100, // Convert percentage to decimal
          path.averageTime,
          path.critical,
          path.description,
          JSON.stringify([]) // optimization_suggestions
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  private async getCallGraphNodeIdMapping(analysisRunId: string): Promise<Map<string, string>> {
    const query = `
      SELECT id, node_id FROM call_graph_nodes WHERE analysis_run_id = $1
    `;
    
    const result = await this.pool.query(query, [analysisRunId]);
    const map = new Map<string, string>();
    
    result.rows.forEach(row => {
      map.set(row.node_id, row.id);
    });
    
    return map;
  }

  async getCallGraph(analysisRunId: string): Promise<CallGraph | null> {
    // This would be a complex query to reconstruct the call graph
    // For now, return null as this would typically be cached in the manifest
    return null;
  }

  // =============================================================================
  // ENTRY AND EXIT POINTS
  // =============================================================================

  async saveEntryPoints(
    analysisRunId: string,
    entryPoints: EntryPoint[]
  ): Promise<void> {
    if (entryPoints.length === 0) return;

    const componentIdMap = await this.getComponentIdMapping(analysisRunId);

    const query = `
      INSERT INTO entry_points (
        analysis_run_id, component_id, entry_point_id, type, path, methods,
        description, parameters, response_schema, middleware, 
        authentication_required, authentication_type, rate_limit_requests,
        rate_limit_window
      ) VALUES ${entryPoints.map((_, i) => 
        `($${i * 14 + 1}, $${i * 14 + 2}, $${i * 14 + 3}, $${i * 14 + 4}, $${i * 14 + 5}, 
         $${i * 14 + 6}, $${i * 14 + 7}, $${i * 14 + 8}, $${i * 14 + 9}, $${i * 14 + 10}, 
         $${i * 14 + 11}, $${i * 14 + 12}, $${i * 14 + 13}, $${i * 14 + 14})`
      ).join(', ')}
      ON CONFLICT (analysis_run_id, entry_point_id) DO UPDATE SET
        type = EXCLUDED.type,
        path = EXCLUDED.path,
        methods = EXCLUDED.methods,
        description = EXCLUDED.description,
        parameters = EXCLUDED.parameters,
        response_schema = EXCLUDED.response_schema,
        middleware = EXCLUDED.middleware,
        authentication_required = EXCLUDED.authentication_required,
        authentication_type = EXCLUDED.authentication_type,
        rate_limit_requests = EXCLUDED.rate_limit_requests,
        rate_limit_window = EXCLUDED.rate_limit_window
    `;

    const values: any[] = [];
    entryPoints.forEach(ep => {
      const componentId = componentIdMap.get(ep.componentId);
      if (componentId) {
        values.push(
          analysisRunId,
          componentId,
          ep.id,
          ep.type,
          ep.path,
          JSON.stringify(ep.methods || []),
          ep.description,
          JSON.stringify(ep.parameters || []),
          JSON.stringify(ep.responseSchema || {}),
          JSON.stringify(ep.middleware || []),
          ep.authentication?.required || false,
          ep.authentication?.type,
          ep.rateLimit?.requests,
          ep.rateLimit?.window
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  async saveExitPoints(
    analysisRunId: string,
    exitPoints: ExitPoint[]
  ): Promise<void> {
    if (exitPoints.length === 0) return;

    const componentIdMap = await this.getComponentIdMapping(analysisRunId);

    const query = `
      INSERT INTO exit_points (
        analysis_run_id, component_id, exit_point_id, type, destination,
        description, is_critical, authentication_type, error_handling
      ) VALUES ${exitPoints.map((_, i) => 
        `($${i * 9 + 1}, $${i * 9 + 2}, $${i * 9 + 3}, $${i * 9 + 4}, $${i * 9 + 5}, $${i * 9 + 6}, $${i * 9 + 7}, $${i * 9 + 8}, $${i * 9 + 9})`
      ).join(', ')}
      ON CONFLICT (analysis_run_id, exit_point_id) DO UPDATE SET
        type = EXCLUDED.type,
        destination = EXCLUDED.destination,
        description = EXCLUDED.description,
        is_critical = EXCLUDED.is_critical,
        authentication_type = EXCLUDED.authentication_type,
        error_handling = EXCLUDED.error_handling
    `;

    const values: any[] = [];
    exitPoints.forEach(ep => {
      const componentId = componentIdMap.get(ep.componentId);
      if (componentId) {
        values.push(
          analysisRunId,
          componentId,
          ep.id,
          ep.type,
          ep.destination,
          ep.description,
          ep.critical,
          ep.authentication?.type,
          JSON.stringify(ep.errorHandling || [])
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  // =============================================================================
  // RISK AREAS AND OPTIMIZATION SUGGESTIONS
  // =============================================================================

  async saveRiskAreas(
    analysisRunId: string,
    riskAreas: RiskArea[]
  ): Promise<void> {
    if (riskAreas.length === 0) return;

    const componentIdMap = await this.getComponentIdMapping(analysisRunId);

    const query = `
      INSERT INTO risk_areas (
        analysis_run_id, component_id, risk_level, reasons, impact, mitigation_suggestions
      ) VALUES ${riskAreas.map((_, i) => 
        `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
      ).join(', ')}
    `;

    const values: any[] = [];
    riskAreas.forEach(risk => {
      const componentId = componentIdMap.get(risk.componentId);
      if (componentId) {
        values.push(
          analysisRunId,
          componentId,
          risk.riskLevel,
          JSON.stringify(risk.reasons),
          risk.impact,
          JSON.stringify([]) // mitigation_suggestions
        );
      }
    });

    if (values.length > 0) {
      await this.pool.query(query, values);
    }
  }

  async saveOptimizationSuggestions(
    analysisRunId: string,
    suggestions: Array<{
      componentId?: string;
      type: string;
      location: string;
      currentPerformance?: number;
      estimatedImprovement: number;
      effort: 'low' | 'medium' | 'high';
      priority: number;
      title: string;
      description: string;
      implementationSteps?: string[];
      codeExample?: string;
    }>
  ): Promise<void> {
    if (suggestions.length === 0) return;

    const componentIdMap = await this.getComponentIdMapping(analysisRunId);

    const query = `
      INSERT INTO optimization_suggestions (
        analysis_run_id, component_id, suggestion_type, location,
        current_performance_ms, estimated_improvement_percent,
        implementation_effort, priority_score, title, description,
        implementation_steps, code_example, status
      ) VALUES ${suggestions.map((_, i) => 
        `($${i * 13 + 1}, $${i * 13 + 2}, $${i * 13 + 3}, $${i * 13 + 4}, $${i * 13 + 5}, 
         $${i * 13 + 6}, $${i * 13 + 7}, $${i * 13 + 8}, $${i * 13 + 9}, $${i * 13 + 10}, 
         $${i * 13 + 11}, $${i * 13 + 12}, $${i * 13 + 13})`
      ).join(', ')}
    `;

    const values: any[] = [];
    suggestions.forEach(suggestion => {
      const componentId = suggestion.componentId ? componentIdMap.get(suggestion.componentId) : null;
      
      values.push(
        analysisRunId,
        componentId,
        suggestion.type,
        suggestion.location,
        suggestion.currentPerformance,
        suggestion.estimatedImprovement,
        suggestion.effort,
        suggestion.priority,
        suggestion.title,
        suggestion.description,
        JSON.stringify(suggestion.implementationSteps || []),
        suggestion.codeExample,
        'pending'
      );
    });

    await this.pool.query(query, values);
  }

  // =============================================================================
  // ANALYSIS MANIFEST MANAGEMENT
  // =============================================================================

  async saveAnalysisManifest(
    analysisRunId: string,
    manifestType: AnalysisManifest['manifestType'],
    manifestData: Record<string, any>,
    manifestVersion: string = '1.0.0'
  ): Promise<void> {
    const manifestJson = JSON.stringify(manifestData);
    const manifestHash = await this.calculateHash(manifestJson);

    const query = `
      INSERT INTO analysis_manifests (
        analysis_run_id, manifest_type, manifest_version,
        manifest_data, manifest_hash, file_size_bytes, compression_used
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (analysis_run_id, manifest_type) DO UPDATE SET
        manifest_data = EXCLUDED.manifest_data,
        manifest_hash = EXCLUDED.manifest_hash,
        file_size_bytes = EXCLUDED.file_size_bytes,
        manifest_version = EXCLUDED.manifest_version
    `;

    await this.pool.query(query, [
      analysisRunId,
      manifestType,
      manifestVersion,
      manifestJson,
      manifestHash,
      Buffer.byteLength(manifestJson, 'utf8'),
      false
    ]);
  }

  async getAnalysisManifest(
    analysisRunId: string,
    manifestType: AnalysisManifest['manifestType']
  ): Promise<AnalysisManifest | null> {
    const query = `
      SELECT 
        id, analysis_run_id, manifest_type, manifest_version,
        manifest_data, manifest_hash, file_size_bytes, 
        compression_used, created_at
      FROM analysis_manifests
      WHERE analysis_run_id = $1 AND manifest_type = $2
    `;

    const result = await this.pool.query(query, [analysisRunId, manifestType]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      analysisRunId: row.analysis_run_id,
      manifestType: row.manifest_type,
      manifestVersion: row.manifest_version,
      manifestData: row.manifest_data,
      manifestHash: row.manifest_hash,
      fileSizeBytes: row.file_size_bytes,
      compressionUsed: row.compression_used,
      createdAt: row.created_at
    };
  }

  async saveCompleteBlueprint(
    analysisRunId: string,
    blueprint: ArchitectureBlueprint
  ): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Save all components
      if (blueprint.components.length > 0) {
        const componentsWithAnalysisId = blueprint.components.map(comp => ({
          ...comp,
          analysisRunId
        }));
        await this.saveComponents(componentsWithAnalysisId);
      }

      // Save connections
      if (blueprint.connections.length > 0) {
        await this.saveConnections(analysisRunId, blueprint.connections);
      }

      // Save entry points
      if (blueprint.entryPoints.length > 0) {
        await this.saveEntryPoints(analysisRunId, blueprint.entryPoints);
      }

      // Save exit points
      if (blueprint.exitPoints.length > 0) {
        await this.saveExitPoints(analysisRunId, blueprint.exitPoints);
      }

      // Save risk areas
      if (blueprint.riskAreas.length > 0) {
        await this.saveRiskAreas(analysisRunId, blueprint.riskAreas);
      }

      // Save the complete blueprint as a manifest
      await this.saveAnalysisManifest(analysisRunId, 'blueprint', blueprint);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  private async calculateHash(data: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async getProjectHealth(projectId: string): Promise<{
    overallHealthScore: number;
    componentsCount: number;
    riskAreas: number;
    criticalIssues: number;
    optimizationOpportunities: number;
  } | null> {
    const query = `
      SELECT 
        phd.avg_health_score,
        phd.total_components,
        phd.critical_components,
        phd.total_active_bottlenecks,
        phd.pending_optimizations
      FROM v_project_health_dashboard phd
      WHERE phd.project_id = $1
    `;

    const result = await this.pool.query(query, [projectId]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      overallHealthScore: row.avg_health_score || 0,
      componentsCount: row.total_components || 0,
      riskAreas: row.critical_components || 0,
      criticalIssues: row.total_active_bottlenecks || 0,
      optimizationOpportunities: row.pending_optimizations || 0
    };
  }

  async getComponentsWithIssues(projectId: string, limit: number = 10): Promise<Array<{
    componentId: string;
    componentName: string;
    healthScore: number;
    issues: string[];
    priority: 'low' | 'medium' | 'high' | 'critical';
  }>> {
    const query = `
      SELECT 
        cpr.component_id,
        cpr.component_name,
        cpr.health_score,
        cpr.status,
        cpr.error_rate_percent,
        cpr.avg_response_time
      FROM v_component_performance_realtime cpr
      WHERE cpr.project_id = $1
        AND cpr.recency_rank = 1
        AND cpr.status IN ('warning', 'critical')
      ORDER BY cpr.health_score ASC, cpr.error_rate_percent DESC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [projectId, limit]);
    
    return result.rows.map(row => {
      const issues: string[] = [];
      if (row.error_rate_percent > 5) {
        issues.push(`High error rate: ${row.error_rate_percent.toFixed(2)}%`);
      }
      if (row.avg_response_time > 2000) {
        issues.push(`Slow response time: ${row.avg_response_time.toFixed(0)}ms`);
      }
      if (row.health_score < 50) {
        issues.push('Low health score');
      }

      return {
        componentId: row.component_id,
        componentName: row.component_name,
        healthScore: row.health_score,
        issues,
        priority: row.status === 'critical' ? 'critical' : 'high'
      };
    });
  }
}