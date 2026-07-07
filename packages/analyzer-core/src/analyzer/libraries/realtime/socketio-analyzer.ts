import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const LIFECYCLE_EVENTS = new Set(['connection', 'disconnect', 'connect', 'error', 'connect_error', 'reconnect']);

const SOCKET_IO_IMPORT = /(?:import|require)\s*(?:\(?\s*['"]socket\.io(?:-client)?['"]\s*\)?|.*from\s*['"]socket\.io(?:-client)?['"])/;

const HANDLER_PATTERN = /\b(\w+)\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
const EMITTER_PATTERN = /\b(\w+)\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g;

export class SocketIOAnalyzer extends BaseAnalyzer {
  constructor() {
    super('socketio', 'Socket.io Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };

      if (!('socket.io' in deps) && !('socket.io-client' in deps)) return false;
      if ('@nestjs/websockets' in deps || '@nestjs/platform-socket.io' in deps) return false;

      const sourceFiles = await glob('**/*.{ts,js,tsx,jsx}', {
        cwd: projectPath,
        ignore: [
          ...this.getIgnorePatterns({ projectPath }),
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**'
        ],
        absolute: false,
        nodir: true
      });

      for (const relativePath of sourceFiles) {
        const content = await fs.readFile(path.join(projectPath, relativePath), 'utf-8');
        if (SOCKET_IO_IMPORT.test(content)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);
    const nodes: CASNode[] = [];

    const sourceFiles = this.capAndPrioritizeSourceFiles(await glob('**/*.{ts,js,tsx,jsx}', {
      cwd: projectPath,
      ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
      absolute: false,
      nodir: true
    }), 'Socket.io candidate files');

    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenEntryIds = new Set<string>();
    const seenExitIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(projectPath, relativePath);
      const content = await fs.readFile(absolutePath, 'utf-8');

      if (!this.hasSocketUsage(content)) continue;

      const fileNodeId = this.findFileNodeId(relativePath, context.existingAnalysis);
      const nodeId = fileNodeId || this.ensureRealtimeSourceNode(relativePath, nodes);

      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      let match: RegExpExecArray | null;

      HANDLER_PATTERN.lastIndex = 0;
      while ((match = HANDLER_PATTERN.exec(content)) !== null) {
        const callerName = match[1];
        const eventName = match[2];
        if (LIFECYCLE_EVENTS.has(eventName)) continue;
        if (!this.looksLikeSocketVariable(callerName, content)) continue;

        const sanitizedEvent = eventName.replace(/[^a-zA-Z0-9]/g, '_');
        const entryId = `entry_socket_${sanitizedPath}_${sanitizedEvent}`;

        if (seenEntryIds.has(entryId)) continue;
        seenEntryIds.add(entryId);

        entryPoints.push(
          this.createEntryPoint(
            entryId,
            nodeId,
            'event',
            `SOCKET ${eventName}`,
            undefined,
            { event: eventName },
            undefined,
            { framework: 'socket.io', sourceFile: relativePath }
          )
        );
      }

      EMITTER_PATTERN.lastIndex = 0;
      while ((match = EMITTER_PATTERN.exec(content)) !== null) {
        const callerName = match[1];
        const eventName = match[2];
        if (!this.looksLikeSocketVariable(callerName, content)) continue;

        const sanitizedEvent = eventName.replace(/[^a-zA-Z0-9]/g, '_');
        const exitId = `exit_socket_${sanitizedPath}_${sanitizedEvent}`;

        if (seenExitIds.has(exitId)) continue;
        seenExitIds.add(exitId);

        exitPoints.push(
          this.createExitPoint(
            exitId,
            nodeId,
            'message',
            `EMIT ${eventName}`,
            undefined,
            { service_id: 'socket.io', endpoint: eventName },
            undefined,
            { framework: 'socket.io', sourceFile: relativePath }
          )
        );
      }
    }

    return this.createContribution(nodes, [], entryPoints, exitPoints);
  }

  private hasSocketUsage(content: string): boolean {
    if (!SOCKET_IO_IMPORT.test(content)) return false;
    return content.includes('.on(') || content.includes('.emit(');
  }

  private looksLikeSocketVariable(name: string, content: string): boolean {
    const lower = name.toLowerCase();
    if (lower === 'io' || lower === 'socket' || lower === 'ws') return true;
    if (lower.includes('socket') || lower.includes('io') || lower.includes('ws')) return true;

    const assignmentPattern = new RegExp(
      `(?:const|let|var)\\s+${name}\\s*=\\s*(?:io\\s*\\(|.*\\.connect\\s*\\(|new\\s+(?:Socket|WebSocket))`,
    );
    if (assignmentPattern.test(content)) return true;

    const typePattern = new RegExp(
      `${name}\\s*(?::|as)\\s*(?:Socket|Server)`,
    );
    if (typePattern.test(content)) return true;

    const refPattern = new RegExp(
      `(?:useRef|createRef).*Socket`,
    );
    if (refPattern.test(content) && content.includes(`${name}.current`)) return true;

    return false;
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === fileId);
      if (found) return found.id;
      const bySource = contribution.nodes?.find(n =>
        n.type === 'file' &&
        (n.source?.file === relativePath || n.source?.file?.endsWith(relativePath))
      );
      if (bySource) return bySource.id;
    }
    return undefined;
  }

  private ensureRealtimeSourceNode(relativePath: string, nodes: CASNode[]): string {
    const nodeId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (nodes.some(n => n.id === nodeId)) return nodeId;

    nodes.push(this.createNode(nodeId, relativePath, 'file', 3, relativePath, undefined, undefined, {
      framework: 'socket.io',
      attributes: { sourceFile: relativePath }
    }));

    return nodeId;
  }

  protected getCapabilities(): string[] {
    return ['socket-event-detection', 'realtime-communication', 'event-handler-mapping'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
