import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';







interface IpcHandler {
  channel: string;
  method: 'handle' | 'on';
  handlerName: string;
  file: string;
  line: number;
}








interface IpcInvoke {
  channel: string;
  method: 'invoke' | 'send';
  file: string;
  line: number;
}



interface ExposedApi {
  key: string;
  file: string;
  line: number;
}


interface WindowCreation {
  file: string;
  line: number;
  varName?: string;
}

export class ElectronAnalyzer extends BaseAnalyzer {
  constructor() {
    super('electron', 'Electron Desktop Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      const hasElectron = Object.keys(deps).some(dep => dep === 'electron' || dep.startsWith('electron-'));
      if (!hasElectron) return false;

      const jsFiles = await glob(['**/*.{js,ts,jsx,tsx,mjs,cjs}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeElectronUsage(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    try {
      const jsFiles = await glob(['**/*.{js,ts,jsx,tsx,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      const fileContents = new Map<string, string>();
      for (const file of jsFiles) {
        fileContents.set(file, await fs.readFile(path.join(context.projectPath, file), 'utf-8'));
      }

      const allHandlers: IpcHandler[] = [];
      const allInvokes: IpcInvoke[] = [];
      const allExposed: ExposedApi[] = [];
      const allWindows: WindowCreation[] = [];
      let hasWhenReady = false;

      for (const [file, content] of fileContents) {
        allHandlers.push(...this.extractIpcHandlers(content, file));
        allInvokes.push(...this.extractIpcInvokes(content, file));
        allExposed.push(...this.extractExposedApis(content, file));
        allWindows.push(...this.extractWindowCreations(content, file));
        if (/\bapp\.whenReady\s*\(/.test(content)) hasWhenReady = true;
      }

      if (allHandlers.length === 0 && allWindows.length === 0 && !hasWhenReady) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'electron',
          ipcHandlersFound: 0
        });
      }

      let version = 'unknown';
      try {
        const packageJson = await fs.readJson(path.join(context.projectPath, 'package.json'));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        version = deps.electron || 'unknown';
      } catch {   }

      const appId = 'app_electron';
      const anchorFile = allWindows[0]?.file || jsFiles[0] || '';
      const appNode = this.createNodeBuilder(appId, 'Electron Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'electron', 'desktop'])
        .withSource({ file: anchorFile, line: 1, end_line: 1 })
        .withDescription('Electron desktop application (main + renderer processes)')
        .withMetadata({ framework: 'electron', attributes: { version, ipcHandlers: allHandlers.length, windows: allWindows.length } })
        .build();
      nodes.push(appNode);


      allWindows.forEach((win, index) => {
        const winId = `window_electron_${index}`;
        const winNode = this.createNodeBuilder(winId, win.varName ? `BrowserWindow: ${win.varName}` : 'BrowserWindow', 'window')
          .withLevel(2, 'architectural')
          .withCategory('window', ['electron', 'renderer'])
          .withSource({ file: win.file, line: win.line, end_line: win.line })
          .withDescription('Electron renderer window (BrowserWindow instance)')
          .withMetadata({ framework: 'electron', attributes: { varName: win.varName } })
          .build();
        nodes.push(winNode);
        edges.push(this.createEdge(`${appId}_creates_${winId}`, appId, winId, 'creates'));
      });




      const handlerIdByChannel = new Map<string, string[]>();
      allHandlers.forEach((h, index) => {
        const handlerId = `ipc_handler_${this.sanitizeId(h.channel)}_${index}`;
        const list = handlerIdByChannel.get(h.channel) || [];
        list.push(handlerId);
        handlerIdByChannel.set(h.channel, list);

        const handlerNode = this.createNodeBuilder(handlerId, `ipcMain.${h.method} '${h.channel}'`, 'ipc_handler')
          .withLevel(3, 'code')
          .withCategory('ipc_handler', ['electron', 'ipc', 'entry-point'])
          .withSource({ file: h.file, line: h.line, end_line: h.line })
          .withDescription(`Electron IPC ${h.method === 'handle' ? 'request/response' : 'fire-and-forget'} handler for channel '${h.channel}'`)
          .withMetadata({
            framework: 'electron',
            attributes: { channel: h.channel, method: h.method, handler: h.handlerName }
          })
          .build();
        nodes.push(handlerNode);
        edges.push(this.createEdge(`${appId}_exposes_${handlerId}`, appId, handlerId, 'exposes'));

        entryPoints.push({
          id: `entry_${handlerId}`,
          name: `IPC ${h.method === 'handle' ? 'invoke' : 'send'}: ${h.channel}`,
          type: 'ipc',
          source_node: handlerId,
          trigger: {
            event: h.channel,
            pattern: h.method === 'handle' ? 'invoke/response' : 'fire-and-forget'
          },
          handler: {
            node_id: handlerId,
            method_name: h.handlerName,
            file: h.file,
            line: h.line
          },
          security: {
            authenticated: false,
            guards: [],
            authorized_roles: []
          },
          metadata: {
            channel: h.channel,
            ipcMethod: h.method,
            handler: h.handlerName,
            handler_file: h.file,
            framework: 'electron'
          }
        } as CASEntryPoint);
      });





      allInvokes.forEach((call, index) => {
        const callId = `ipc_invoke_${this.sanitizeId(call.channel)}_${index}`;
        const callNode = this.createNodeBuilder(callId, `ipcRenderer.${call.method} '${call.channel}'`, 'ipc_call')
          .withLevel(3, 'code')
          .withCategory('ipc_call', ['electron', 'ipc', 'call-site'])
          .withSource({ file: call.file, line: call.line, end_line: call.line })
          .withDescription(`Electron renderer-side IPC call to channel '${call.channel}'`)
          .withMetadata({ framework: 'electron', attributes: { channel: call.channel, method: call.method } })
          .build();
        nodes.push(callNode);

        const targets = handlerIdByChannel.get(call.channel) || [];
        for (const targetId of targets) {
          edges.push(this.createEdge(
            `${callId}_invokes_${targetId}`,
            callId,
            targetId,
            'invokes',
            'ipc',
            { channel: call.channel, resolved: true }
          ));
        }
        if (targets.length === 0) {


          edges.push(this.createEdge(
            `${appId}_calls_${callId}`,
            appId,
            callId,
            'calls',
            'ipc',
            { channel: call.channel, resolved: false }
          ));
        }
      });



      allExposed.forEach((exp, index) => {
        const exposedId = `exposed_api_${this.sanitizeId(exp.key)}_${index}`;
        const exposedNode = this.createNodeBuilder(exposedId, `window.${exp.key}`, 'exposed_api')
          .withLevel(3, 'code')
          .withCategory('exposed_api', ['electron', 'preload', 'contextBridge'])
          .withSource({ file: exp.file, line: exp.line, end_line: exp.line })
          .withDescription(`Preload-exposed API surface reachable from the renderer as window.${exp.key}`)
          .withMetadata({ framework: 'electron', attributes: { key: exp.key } })
          .build();
        nodes.push(exposedNode);
        edges.push(this.createEdge(`${appId}_exposes_${exposedId}`, appId, exposedId, 'exposes'));
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'electron',
        version,
        ipcHandlersFound: allHandlers.length,
        ipcInvokesFound: allInvokes.length,
        exposedApisFound: allExposed.length,
        windowsFound: allWindows.length
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Electron analysis failed: ${(error as Error).message}`, 'ELECTRON_ANALYSIS_ERROR');
    }
  }

  private looksLikeElectronUsage(content: string): boolean {
    const importsElectron =
      /from\s+['"]electron['"]/.test(content) ||
      /require\(\s*['"]electron['"]\s*\)/.test(content);
    const usesCoreApi = /\b(app|BrowserWindow|ipcMain|ipcRenderer|contextBridge)\b/.test(content);
    return importsElectron && usesCoreApi;
  }










  private extractIpcHandlers(content: string, file: string): IpcHandler[] {
    const handlers: IpcHandler[] = [];
    const pattern = /\bipcMain\.(handle|on)\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const method = match[1] as 'handle' | 'on';
      const channel = match[3];
      const line = content.slice(0, match.index).split('\n').length;
      const args = this.parseRemainingCallArgs(content, pattern.lastIndex);
      const handlerName = args.length > 0 ? this.describeHandler(args[args.length - 1].trim()) : 'anonymous';
      handlers.push({ channel, method, handlerName, file, line });
    }
    return handlers;
  }





  private extractIpcInvokes(content: string, file: string): IpcInvoke[] {
    const invokes: IpcInvoke[] = [];
    const pattern = /\bipcRenderer\.(invoke|send)\s*\(\s*(['"`])([^'"`]+)\2/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const method = match[1] as 'invoke' | 'send';
      const channel = match[3];
      const line = content.slice(0, match.index).split('\n').length;
      invokes.push({ channel, method, file, line });
    }
    return invokes;
  }



  private extractExposedApis(content: string, file: string): ExposedApi[] {
    const exposed: ExposedApi[] = [];
    const pattern = /\bcontextBridge\.exposeInMainWorld\s*\(\s*(['"`])([^'"`]+)\1/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const key = match[2];
      const line = content.slice(0, match.index).split('\n').length;
      exposed.push({ key, file, line });
    }
    return exposed;
  }



  private extractWindowCreations(content: string, file: string): WindowCreation[] {
    const windows: WindowCreation[] = [];
    const pattern = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?new\s+BrowserWindow\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      windows.push({ file, line, varName: match[1] });
    }
    return windows;
  }



  private describeHandler(raw: string): string {
    if (/^[A-Za-z_$][\w$.]*$/.test(raw)) return raw;
    if (/^async\s+[A-Za-z_$][\w$.]*$/.test(raw)) return raw.replace(/^async\s+/, '');
    return 'inline handler';
  }






  private parseRemainingCallArgs(content: string, pos: number): string[] {
    const args: string[] = [];
    let depth = 1;
    let cur = '';
    let inStr: string | null = null;
    for (let i = pos; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return args;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'electron-ipc',
      name: 'Electron IPC Flows',
      description: 'Electron main-process IPC handlers, renderer call sites, and the contextBridge-exposed API surface',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['application', 'window', 'ipc_handler', 'ipc_call', 'exposed_api'],
        relevant_edge_types: ['exposes', 'creates', 'invokes', 'calls'],
        node_connections: [
          { from_type: 'application', to_types: ['window', 'ipc_handler', 'exposed_api'], edge_type: 'exposes' },
          { from_type: 'ipc_call', to_types: ['ipc_handler'], edge_type: 'invokes' }
        ]
      },
      layout_hints: { style: 'hierarchical', direction: 'LR', group_by: 'channel' },
      metadata: { show_ipc_direction: true }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;
      if (!node.perspectives) node.perspectives = {};
      if (['application', 'window', 'ipc_handler', 'ipc_call', 'exposed_api'].includes(node.type)) {
        node.perspectives['electron-ipc'] = { hierarchy: ['electron', 'ipc'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['electron-analysis', 'ipc-entry-point-extraction', 'ipc-invoke-resolution', 'preload-api-surface'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }
}
