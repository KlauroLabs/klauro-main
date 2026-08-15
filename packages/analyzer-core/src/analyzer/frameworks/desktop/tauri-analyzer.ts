import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';








interface TauriCommand {
  name: string;
  isAsync: boolean;
  file: string;
  line: number;
}




interface HandlerRegistration {
  commands: string[];
  file: string;
  line: number;
}



interface InvokeCall {
  command: string;
  file: string;
  line: number;
}

export class TauriAnalyzer extends BaseAnalyzer {
  constructor() {
    super('tauri', 'Tauri Desktop Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const cargoTomlPath = path.join(projectPath, 'src-tauri', 'Cargo.toml');
      const rootCargoTomlPath = path.join(projectPath, 'Cargo.toml');
      const cargoPath = (await fs.pathExists(cargoTomlPath)) ? cargoTomlPath
        : (await fs.pathExists(rootCargoTomlPath)) ? rootCargoTomlPath
          : undefined;

      let hasTauriCrate = false;
      if (cargoPath) {
        const cargo = await fs.readFile(cargoPath, 'utf-8');
        hasTauriCrate = /\btauri\b/.test(cargo);
      }

      let hasTauriApiDep = false;
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        hasTauriApiDep = Object.keys(deps).some(dep => dep.startsWith('@tauri-apps/'));
      }

      if (!hasTauriCrate && !hasTauriApiDep) return false;

      const rustFiles = await this.findRustFiles(projectPath);
      for (const file of rustFiles) {
        const content = await fs.readFile(file, 'utf-8');
        if (/#\[tauri::command\]/.test(content)) return true;
      }


      return hasTauriApiDep;
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
      const rustFiles = await this.findRustFiles(context.projectPath);
      const jsFiles = await glob(['**/*.{js,ts,jsx,tsx,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      const allCommands: TauriCommand[] = [];
      const allRegistrations: HandlerRegistration[] = [];
      for (const file of rustFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const relFile = path.relative(context.projectPath, file);
        allCommands.push(...this.extractTauriCommands(content, relFile));
        allRegistrations.push(...this.extractHandlerRegistrations(content, relFile));
      }

      const allInvokes: InvokeCall[] = [];
      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        if (!/\binvoke\s*\(/.test(content)) continue;
        allInvokes.push(...this.extractInvokeCalls(content, file));
      }

      if (allCommands.length === 0 && allInvokes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'tauri',
          commandsFound: 0
        });
      }

      let version = 'unknown';
      try {
        const packageJsonPath = path.join(context.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
          const packageJson = await fs.readJson(packageJsonPath);
          const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
          version = deps['@tauri-apps/api'] || deps.tauri || 'unknown';
        }
      } catch {   }

      const registeredNames = new Set<string>(allRegistrations.flatMap(r => r.commands));

      const appId = 'app_tauri';
      const anchorFile = allCommands[0]?.file || rustFiles[0] ? path.relative(context.projectPath, rustFiles[0] || '') : (jsFiles[0] || '');
      const appNode = this.createNodeBuilder(appId, 'Tauri Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'tauri', 'desktop'])
        .withSource({ file: anchorFile, line: 1, end_line: 1 })
        .withDescription('Tauri desktop application (Rust backend + web frontend)')
        .withMetadata({ framework: 'tauri', attributes: { version, commands: allCommands.length } })
        .build();
      nodes.push(appNode);

      const commandIdByName = new Map<string, string[]>();
      allCommands.forEach((cmd, index) => {
        const commandId = `tauri_command_${this.sanitizeId(cmd.name)}_${index}`;
        const list = commandIdByName.get(cmd.name) || [];
        list.push(commandId);
        commandIdByName.set(cmd.name, list);

        const registered = registeredNames.size === 0 || registeredNames.has(cmd.name);

        const commandNode = this.createNodeBuilder(commandId, `#[tauri::command] ${cmd.name}`, 'tauri_command')
          .withLevel(3, 'code')
          .withCategory('tauri_command', ['tauri', 'command', 'entry-point'])
          .withSource({ file: cmd.file, line: cmd.line, end_line: cmd.line })
          .withDescription(`Tauri command '${cmd.name}' invoked from the frontend via invoke()`)
          .withMetadata({
            framework: 'tauri',
            attributes: { command: cmd.name, async: cmd.isAsync, registered }
          })
          .build();
        nodes.push(commandNode);
        edges.push(this.createEdge(`${appId}_exposes_${commandId}`, appId, commandId, 'exposes'));

        entryPoints.push({
          id: `entry_${commandId}`,
          name: `Tauri command: ${cmd.name}`,
          type: 'command',
          source_node: commandId,
          trigger: {
            event: cmd.name,
            pattern: 'invoke/response'
          },
          handler: {
            node_id: commandId,
            method_name: cmd.name,
            file: cmd.file,
            line: cmd.line
          },
          security: {
            authenticated: false,
            guards: [],
            authorized_roles: []
          },
          metadata: {
            command: cmd.name,
            async: cmd.isAsync,
            registered,
            handler_file: cmd.file,
            framework: 'tauri'
          }
        } as CASEntryPoint);
      });



      allRegistrations.forEach((reg, index) => {
        const regId = `tauri_generate_handler_${index}`;
        const regNode = this.createNodeBuilder(regId, 'tauri::generate_handler![...]', 'tauri_registration')
          .withLevel(2, 'architectural')
          .withCategory('tauri_registration', ['tauri', 'wiring'])
          .withSource({ file: reg.file, line: reg.line, end_line: reg.line })
          .withDescription(`Registers ${reg.commands.length} Tauri command(s) with the app builder`)
          .withMetadata({ framework: 'tauri', attributes: { commands: reg.commands } })
          .build();
        nodes.push(regNode);
        edges.push(this.createEdge(`${appId}_wires_${regId}`, appId, regId, 'wires'));
        for (const cmdName of reg.commands) {
          for (const targetId of commandIdByName.get(cmdName) || []) {
            edges.push(this.createEdge(`${regId}_registers_${targetId}`, regId, targetId, 'registers'));
          }
        }
      });


      allInvokes.forEach((call, index) => {
        const callId = `tauri_invoke_${this.sanitizeId(call.command)}_${index}`;
        const callNode = this.createNodeBuilder(callId, `invoke('${call.command}')`, 'tauri_invoke')
          .withLevel(3, 'code')
          .withCategory('tauri_invoke', ['tauri', 'call-site'])
          .withSource({ file: call.file, line: call.line, end_line: call.line })
          .withDescription(`Frontend call to Tauri command '${call.command}'`)
          .withMetadata({ framework: 'tauri', attributes: { command: call.command } })
          .build();
        nodes.push(callNode);

        const targets = commandIdByName.get(call.command) || [];
        for (const targetId of targets) {
          edges.push(this.createEdge(
            `${callId}_invokes_${targetId}`,
            callId,
            targetId,
            'invokes',
            'ipc',
            { command: call.command, resolved: true }
          ));
        }
        if (targets.length === 0) {
          edges.push(this.createEdge(
            `${appId}_calls_${callId}`,
            appId,
            callId,
            'calls',
            'ipc',
            { command: call.command, resolved: false }
          ));
        }
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'tauri',
        version,
        commandsFound: allCommands.length,
        invokesFound: allInvokes.length,
        registrationsFound: allRegistrations.length
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Tauri analysis failed: ${(error as Error).message}`, 'TAURI_ANALYSIS_ERROR');
    }
  }






  private extractTauriCommands(content: string, file: string): TauriCommand[] {
    const commands: TauriCommand[] = [];
    const attrPattern = /#\[tauri::command(?:\([^)]*\))?\]/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(content)) !== null) {
      const searchStart = attrMatch.index + attrMatch[0].length;
      const fnMatch = /^\s*(?:#\[[^\]]*\]\s*)*\s*(pub\s+)?(async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(content.slice(searchStart, searchStart + 400));
      if (!fnMatch) continue;
      const line = content.slice(0, attrMatch.index).split('\n').length;
      commands.push({ name: fnMatch[3], isAsync: !!fnMatch[2], file, line });
    }
    return commands;
  }






  private extractHandlerRegistrations(content: string, file: string): HandlerRegistration[] {
    const registrations: HandlerRegistration[] = [];
    const pattern = /(?:tauri::)?generate_handler!\s*\[([\s\S]*?)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const commands = match[1]
        .split(',')
        .map(c => c.trim())
        .filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
      if (commands.length > 0) registrations.push({ commands, file, line });
    }
    return registrations;
  }




  private extractInvokeCalls(content: string, file: string): InvokeCall[] {
    const invokes: InvokeCall[] = [];
    const pattern = /\binvoke\s*\(\s*(['"`])([^'"`]+)\1/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const command = match[2];
      const line = content.slice(0, match.index).split('\n').length;
      invokes.push({ command, file, line });
    }
    return invokes;
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.map(file => path.join(projectPath, file));
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'tauri-commands',
      name: 'Tauri Commands',
      description: 'Tauri Rust commands, their frontend invoke() call sites, and generate_handler! wiring',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['application', 'tauri_command', 'tauri_registration', 'tauri_invoke'],
        relevant_edge_types: ['exposes', 'wires', 'registers', 'invokes', 'calls'],
        node_connections: [
          { from_type: 'application', to_types: ['tauri_command', 'tauri_registration'], edge_type: 'exposes' },
          { from_type: 'tauri_invoke', to_types: ['tauri_command'], edge_type: 'invokes' }
        ]
      },
      layout_hints: { style: 'hierarchical', direction: 'LR', group_by: 'command' },
      metadata: { show_registration_status: true }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;
      if (!node.perspectives) node.perspectives = {};
      if (['application', 'tauri_command', 'tauri_registration', 'tauri_invoke'].includes(node.type)) {
        node.perspectives['tauri-commands'] = { hierarchy: ['tauri', 'commands'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['tauri-analysis', 'command-entry-point-extraction', 'invoke-resolution', 'handler-registration-check'];
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
