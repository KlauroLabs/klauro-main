import {
  CASNode,
  CASEdge,
  CASContribution,
  CASEntryPoint,
  CASExitPoint,
  CASAnalyzerContribution,
  CASNodeBuilder,
  CASEdgeBuilder,
  generateNodeId,
  generateEdgeId
} from '../../types/cas.types';

export {
  CASNode,
  CASEdge,
  CASContribution,
  CASEntryPoint,
  CASExitPoint,
  CASAnalyzerContribution,
  CASNodeBuilder,
  CASEdgeBuilder,
  generateNodeId,
  generateEdgeId
} from '../../types/cas.types';

export type CASAnalysisResult = CASContribution;

export interface AnalysisContext {
  projectPath: string;
  includeTests?: boolean;
  maxDepth?: number;
  filters?: string[];
  existingAnalysis?: CASContribution[];
  targetLevel?: number;
}

import * as path from 'path';
import * as fs from 'fs-extra';

export abstract class BaseAnalyzer {
  protected analyzerId: string;
  protected analyzerName: string;
  protected analyzerVersion: string;
  protected analyzerType: 'language' | 'framework' | 'library' | 'pattern';

  constructor(
    id: string,
    name: string,
    version: string,
    type: 'language' | 'framework' | 'library' | 'pattern'
  ) {
    this.analyzerId = id;
    this.analyzerName = name;
    this.analyzerVersion = version;
    this.analyzerType = type;
  }

  get id(): string {
    return this.analyzerId;
  }

  get name(): string {
    return this.analyzerName;
  }

  get version(): string {
    return this.analyzerVersion;
  }

  get type(): 'language' | 'framework' | 'library' | 'pattern' {
    return this.analyzerType;
  }

  abstract canAnalyze(projectPath: string): Promise<boolean>;

  abstract analyze(context: AnalysisContext): Promise<CASContribution>;

  protected getFrameworkVersion(projectPath: string, frameworkName: string): Promise<string | undefined> {
    return this.getPackageVersion(projectPath, frameworkName);
  }

  protected async getPackageVersion(projectPath: string, packageName: string): Promise<string | undefined> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return undefined;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      return deps[packageName];
    } catch {
      return undefined;
    }
  }

  protected createContribution(
    nodes: CASNode[] = [],
    edges: CASEdge[] = [],
    entryPoints: CASEntryPoint[] = [],
    exitPoints: CASExitPoint[] = [],
    additionalMetadata: Record<string, any> = {}
  ): CASContribution {
    const { categories, ...metadataWithoutCategories } = additionalMetadata;

    const analyzerMetadata: CASAnalyzerContribution = {
      analyzer_id: this.analyzerId,
      analyzer_name: this.analyzerName,
      version: this.analyzerVersion,
      contribution_type: this.analyzerType,
      nodes_contributed: nodes.length,
      edges_contributed: edges.length,
      contributed_entry_points: entryPoints.length,
      contributed_exit_points: exitPoints.length,
      capabilities: this.getCapabilities(),
      ...metadataWithoutCategories
    };

    const contribution: CASContribution = {
      nodes,
      edges,
      entry_points: entryPoints,
      exit_points: exitPoints,
      analyzer_metadata: analyzerMetadata
    };

    if (categories) {
      contribution.categories = categories;
    }

    return contribution;
  }

  protected abstract getCapabilities(): string[];

  protected createNodeBuilder(id: string, name: string, type: string): CASNodeBuilder {
    return new CASNodeBuilder(id, name, type);
  }

  protected createNode(
    id: string,
    name: string,
    type: string,
    level?: number,
    filePath?: string,
    lineStart?: number,
    lineEnd?: number,
    metadata?: Record<string, any>
  ): CASNode {
    const builder = this.createNodeBuilder(id, name, type);

    if (level !== undefined) {
      builder.withLevel(level, this.getLevelName(level));
    }

    if (filePath) {
      builder.withSource({ file: filePath, line: lineStart, end_line: lineEnd });
    }

    if (metadata) {
      builder.withMetadata({
        framework: this.analyzerName.toLowerCase().replace(' analyzer', ''),
        ...metadata
      });
    }

    return builder.build();
  }

  protected abstract getLevelName(level: number): string;

  protected createEdgeBuilder(id: string, source: string, target: string, type: string): CASEdgeBuilder {
    return new CASEdgeBuilder(id, source, target, type);
  }

  protected createEdge(
    id: string,
    source: string,
    target: string,
    type: string,
    category?: string,
    metadata?: Record<string, any>
  ): CASEdge {
    const builder = this.createEdgeBuilder(id, source, target, type);

    if (category) {
      builder.withCategory(category);
    }

    if (metadata) {
      builder.withMetadata(metadata);
    }

    return builder.build();
  }

  protected getQueriableResults(
    analysis: CASContribution,
    levelFilter?: number,
    typeFilter?: string,
    nameFilter?: string
  ): { nodes: CASNode[]; edges: CASEdge[] } {
    let filteredNodes = analysis.nodes || [];
    let filteredEdges = analysis.edges || [];

    if (levelFilter !== undefined) {
      filteredNodes = filteredNodes.filter(node =>
        node.level === undefined || node.level <= levelFilter
      );
    }

    if (typeFilter) {
      filteredNodes = filteredNodes.filter(node => node.type === typeFilter);
    }

    if (nameFilter) {
      const regex = new RegExp(nameFilter, 'i');
      filteredNodes = filteredNodes.filter(node => regex.test(node.name));
    }

    const nodeIds = new Set(filteredNodes.map(node => node.id));
    filteredEdges = filteredEdges.filter(edge =>
      nodeIds.has(edge.source) && nodeIds.has(edge.target)
    );

    return { nodes: filteredNodes, edges: filteredEdges };
  }

  protected createEntryPoint(
    id: string,
    sourceNode: string,
    type: CASEntryPoint['type'],
    name: string,
    description?: string,
    trigger?: CASEntryPoint['trigger'],
    security?: CASEntryPoint['security'],
    metadata?: Record<string, any>
  ): CASEntryPoint {
    return {
      id,
      source_node: sourceNode,
      source_analyzer: this.analyzerId,
      type,
      name,
      description,
      trigger,
      security,
      metadata
    };
  }

  protected createExitPoint(
    id: string,
    sourceNode: string,
    type: CASExitPoint['type'],
    name: string,
    description?: string,
    target?: CASExitPoint['target'],
    operation?: CASExitPoint['operation'],
    metadata?: Record<string, any>
  ): CASExitPoint {
    return {
      id,
      source_node: sourceNode,
      source_analyzer: this.analyzerId,
      type,
      name,
      description,
      target,
      operation,
      metadata
    };
  }

  protected generateId = generateNodeId;
  protected generateEdgeId = generateEdgeId;

  protected sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }
}