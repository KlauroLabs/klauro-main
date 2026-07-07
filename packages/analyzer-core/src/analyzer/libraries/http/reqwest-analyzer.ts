import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASContribution, CASExitPoint, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

interface ReqwestCall {
  method: string;
  endpoint: string;
  serviceAlias?: string;
  line: number;
}

const REQWEST_DEPENDENCY = /^\s*reqwest\s*=/m;
const REQWEST_IMPORT = /\buse\s+reqwest\b|\breqwest::|\bClient::builder\s*\(|\bself\.url(?:\.clone\s*\(\s*\))?\.join\s*\(/;
const DIRECT_URL_CALL = /\.(get|post|put|patch|delete|head)\s*\(\s*["']([^"']+)["']/g;
const JOIN_CALL = /\.(get|post|put|patch|delete|head)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*clone\s*\(\s*\))?\s*\.\s*join\s*\(\s*["']([^"']+)["']/g;
const LOCAL_JOIN_THEN_CALL = /\blet\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*self\.url\s*(?:\.\s*clone\s*\(\s*\))?\s*\.\s*join\s*\(\s*(?:&?\s*format!\s*\(\s*)?["']([^"']+)["'][\s\S]{0,900}?\.(get|post|put|patch|delete|head)\s*\(\s*\1(?:\.as_str\s*\(\s*\))?/g;

export class ReqwestAnalyzer extends BaseAnalyzer {
  constructor() {
    super('reqwest', 'Reqwest HTTP Client Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const manifests = await glob('**/Cargo.toml', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      absolute: false,
      nodir: true,
    });
    for (const relativePath of manifests) {
      const content = await fs.readFile(path.join(projectPath, relativePath), 'utf8');
      if (REQWEST_DEPENDENCY.test(content)) return true;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const allSourceFiles = await glob('**/*.rs', {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/target/**'],
      absolute: false,
      nodir: true,
    });

    const candidateFiles: string[] = [];
    for (const relativePath of allSourceFiles) {
      const content = await fs.readFile(path.join(context.projectPath, relativePath), 'utf8');
      if (REQWEST_IMPORT.test(content)) candidateFiles.push(relativePath);
    }

    const sourceFiles = this.capAndPrioritizeSourceFiles(candidateFiles, 'Reqwest candidate files');

    const nodes: CASNode[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenNodeIds = new Set<string>();
    const seenExitIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(context.projectPath, relativePath);
      const content = await fs.readFile(absolutePath, 'utf8');

      const nodeId = this.findFileNodeId(relativePath, context.existingAnalysis) ||
        this.ensureReqwestSourceNode(relativePath, nodes, seenNodeIds);

      for (const call of this.extractCalls(content, relativePath)) {
        const exitId = `exit_reqwest_${this.safeId(relativePath)}_${call.method}_${this.safeId(call.endpoint)}_${call.line}`;
        if (seenExitIds.has(exitId)) continue;
        seenExitIds.add(exitId);
        exitPoints.push(this.createExitPoint(
          exitId,
          nodeId,
          'api',
          `${call.method.toUpperCase()} ${call.endpoint}`,
          `Reqwest client call to ${call.endpoint}.`,
          {
            service_id: call.serviceAlias || 'reqwest',
            endpoint: call.endpoint,
            resource: call.endpoint,
          },
          {
            method: call.method.toUpperCase(),
            action: call.method,
            async: true,
          },
          {
            library: 'reqwest',
            service_aliases: call.serviceAlias ? [call.serviceAlias] : [],
            sourceFile: relativePath,
            line: call.line,
          }
        ));
      }
    }

    return this.createContribution(nodes, [], [], exitPoints, {
      library: 'reqwest',
      http_client: 'reqwest',
      callsFound: exitPoints.length,
    });
  }

  protected getCapabilities(): string[] {
    return ['reqwest-http-client-call-detection', 'rust-service-api-consumer-detection'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'reqwest calls' : 'reqwest call detail';
  }

  private extractCalls(content: string, relativePath: string): ReqwestCall[] {
    const calls: ReqwestCall[] = [];
    const localServiceAlias = serviceAliasFromFile(relativePath);
    let match: RegExpExecArray | null;

    DIRECT_URL_CALL.lastIndex = 0;
    while ((match = DIRECT_URL_CALL.exec(content)) !== null) {
      const endpoint = match[2];
      if (!/^https?:\/\//.test(endpoint)) continue;
      calls.push({
        method: match[1],
        endpoint,
        serviceAlias: serviceAliasFromEndpoint(endpoint),
        line: lineForIndex(content, match.index),
      });
    }

    JOIN_CALL.lastIndex = 0;
    while ((match = JOIN_CALL.exec(content)) !== null) {
      const method = match[1];
      const baseVariable = match[2];
      const pathPart = match[3];
      const serviceAlias = serviceAliasFromVariable(baseVariable);
      calls.push({
        method,
        endpoint: serviceAlias ? `http://${serviceAlias}/${pathPart.replace(/^\/+/, '')}` : `/${pathPart.replace(/^\/+/, '')}`,
        serviceAlias,
        line: lineForIndex(content, match.index),
      });
    }

    LOCAL_JOIN_THEN_CALL.lastIndex = 0;
    while ((match = LOCAL_JOIN_THEN_CALL.exec(content)) !== null) {
      const pathPart = match[2];
      calls.push({
        method: match[3],
        endpoint: localServiceAlias ? `http://${localServiceAlias}/${pathPart.replace(/^\/+/, '')}` : `/${pathPart.replace(/^\/+/, '')}`,
        serviceAlias: localServiceAlias,
        line: lineForIndex(content, match.index),
      });
    }

    return calls;
  }

  private ensureReqwestSourceNode(relativePath: string, nodes: CASNode[], seen: Set<string>): string {
    const nodeId = `reqwest_source_${this.safeId(relativePath)}`;
    if (seen.has(nodeId)) return nodeId;
    seen.add(nodeId);
    nodes.push(this.createNode(nodeId, `Reqwest calls: ${relativePath}`, 'http_client_source', 3, relativePath, 1, 1, {
      library: 'reqwest',
      subcategories: ['http-client', 'reqwest'],
    }));
    return nodeId;
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    for (const contribution of existingAnalysis || []) {
      const found = contribution.nodes?.find(node => node.id === fileId || (node.type === 'file' && node.source?.file === relativePath));
      if (found) return found.id;
    }
    return undefined;
  }

  private safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9]/g, '_');
  }
}

function serviceAliasFromVariable(variable: string): string | undefined {
  const normalized = variable.replace(/_(url|base|host|endpoint)$/i, '').toLowerCase();
  return normalizeServiceAlias(normalized);
}

function serviceAliasFromEndpoint(endpoint: string): string | undefined {
  const match = endpoint.match(/^https?:\/\/([A-Za-z0-9_.-]+)/);
  return match?.[1];
}

function serviceAliasFromFile(relativePath: string): string | undefined {
  const normalized = relativePath.toLowerCase().replace(/\\/g, '/');
  const parts = normalized.split('/');
  const namedSegment = parts.find((part, index) =>
    ['bin', 'apps', 'services', 'crates', 'packages'].includes(parts[index - 1] || '') &&
    /[a-z0-9]/.test(part)
  );
  return normalizeServiceAlias(namedSegment || normalized.split('/').pop()?.replace(/\.[^.]+$/, ''));
}

function normalizeServiceAlias(value: string | undefined): string | undefined {
  const normalized = String(value || '')
    .replace(/[_\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!normalized || /^(url|base|host|endpoint|api|client|server|service|src|lib|main|mod)$/.test(normalized)) return undefined;
  if (/^(admin|user|internal|public|mcp)$/.test(normalized)) return `${normalized}-api`;
  if (/^(admin|user|internal|public|mcp)-api$/.test(normalized)) return normalized;
  if (/(api|server|service|worker|agent|client|coordinator|gateway|broker|relay|daemon)$/.test(normalized)) return normalized;
  return undefined;
}

function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}
