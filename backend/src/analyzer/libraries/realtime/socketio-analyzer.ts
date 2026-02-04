import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

const LIFECYCLE_EVENTS = new Set(['connection', 'disconnect']);

const HANDLER_PATTERN = /(?:io|socket)\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
const EMITTER_PATTERN = /(?:io|socket)\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g;

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

      return 'socket.io' in deps || 'socket.io-client' in deps;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);

    const sourceFiles = await glob('**/*.{ts,js,tsx,jsx}', {
      cwd: projectPath,
      ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
      absolute: false
    });

    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenEntryIds = new Set<string>();
    const seenExitIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(projectPath, relativePath);
      const content = await fs.readFile(absolutePath, 'utf-8');

      if (!content.includes('io.on(') && !content.includes('socket.on(') &&
          !content.includes('io.emit(') && !content.includes('socket.emit(')) {
        continue;
      }

      const nodeId = this.findFileNodeId(relativePath, context.existingAnalysis);
      if (!nodeId) continue;

      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      let match: RegExpExecArray | null;

      HANDLER_PATTERN.lastIndex = 0;
      while ((match = HANDLER_PATTERN.exec(content)) !== null) {
        const eventName = match[1];
        if (LIFECYCLE_EVENTS.has(eventName)) continue;

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
        const eventName = match[1];

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

    return this.createContribution([], [], entryPoints, exitPoints);
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === fileId);
      if (found) return found.id;
    }
    return undefined;
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
