import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';





















const GDSCRIPT_LIFECYCLE = ['_ready', '_process', '_physics_process', '_enter_tree', '_exit_tree', '_input', '_unhandled_input'];
const CSHARP_GODOT_LIFECYCLE = ['_Ready', '_Process', '_PhysicsProcess', '_EnterTree', '_ExitTree', '_Input', '_UnhandledInput'];

export class GodotAnalyzer extends BaseAnalyzer {
  constructor() {
    super('godot', 'Godot Engine Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const markers = await glob(['project.godot', '**/*.tscn'], {
        cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true,
      });
      return markers.length > 0;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    try {
      const gdFiles = await glob(['**/*.gd'], {
        cwd: context.projectPath, ignore: this.getIgnorePatterns({ projectPath: context.projectPath }), nodir: true,
      });
      for (const rel of gdFiles) {
        const fullPath = path.join(context.projectPath, rel);
        const content = await fs.readFile(fullPath, 'utf-8').catch(() => '');
        if (!content) continue;
        this.extractGdScriptFile(content, rel, nodes, edges, entryPoints);
      }

      const csFiles = await glob(['**/*.cs'], {
        cwd: context.projectPath, ignore: this.getIgnorePatterns({ projectPath: context.projectPath }), nodir: true,
      });
      for (const rel of csFiles) {
        const fullPath = path.join(context.projectPath, rel);
        const content = await fs.readFile(fullPath, 'utf-8').catch(() => '');
        if (!content || !/\bGodot\b/.test(content)) continue;
        this.extractGodotCSharpFile(content, rel, nodes, edges, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'godot',
          script_count: gdFiles.length,
          lifecycle_entry_point_count: entryPoints.filter(ep => ep.metadata?.framework === 'godot').length,
        },
      });
    } catch (error) {
      throw new Error(`Godot analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['gdscript-lifecycle-detection', 'signal-entry-point-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'godot-project';
      case 2: return 'scripts';
      case 3: return 'lifecycle-hooks';
      default: return `godot-level-${level}`;
    }
  }

  private extractGdScriptFile(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);
    const fileNodeId = `file_${this.sanitizeId(relativePath)}`;
    nodes.push(this.createNodeBuilder(fileNodeId, path.basename(relativePath), 'file')
      .withLevel(2, this.getLevelName(2))
      .withSource({ file: relativePath, line: 1 })
      .withMetadata({ language: 'gdscript', framework: 'godot' })
      .build());

    for (const hookName of GDSCRIPT_LIFECYCLE) {
      const pattern = new RegExp(`\\bfunc\\s+${hookName}\\s*\\(`);
      const m = pattern.exec(content);
      if (!m) continue;
      const line = lineForIndex(m.index);
      const methodNodeId = `func_${this.sanitizeId(relativePath)}_${hookName}_${line}`;
      nodes.push(this.createNodeBuilder(methodNodeId, hookName, 'function')
        .withLevel(3, this.getLevelName(3))
        .withSource({ file: relativePath, line })
        .withMetadata({ language: 'gdscript', framework: 'godot', attributes: { godot_lifecycle_hook: hookName } })
        .build());
      edges.push(this.createEdge(`${fileNodeId}_contains_${methodNodeId}`, fileNodeId, methodNodeId, 'contains'));

      entryPoints.push(this.createEntryPoint(
        `entry:lifecycle:${relativePath}:${hookName}:${line}`,
        methodNodeId,
        'lifecycle',
        `${path.basename(relativePath, '.gd')}.${hookName}`,
        hookName === '_ready'
          ? `Godot engine calls ${hookName}() once when this node enters the scene tree.`
          : `Godot engine calls ${hookName}() as part of the node's per-frame/physics/input dispatch.`,
        { event: `godot:${hookName}` },
        undefined,
        { framework: 'godot', engine: 'godot', hook: hookName, file: relativePath, line },
        { node_id: methodNodeId, method_name: hookName, file: relativePath, line }
      ));
    }




    const signalPattern = /\bsignal\s+([A-Za-z_]\w*)/g;
    let sm: RegExpExecArray | null;
    while ((sm = signalPattern.exec(content)) !== null) {
      const signalName = sm[1];
      const handlerPattern = new RegExp(`\\bfunc\\s+(_on_\\w*${signalName}\\w*|_on_[A-Za-z0-9_]+)\\s*\\(`, 'i');

      const conventional = new RegExp(`\\bfunc\\s+(_on_[A-Za-z0-9_]*${this.toPascal(signalName)}\\w*)\\s*\\(`, 'i');
      const handlerMatch = conventional.exec(content) || handlerPattern.exec(content);
      if (!handlerMatch) continue;
      const handlerName = handlerMatch[1];
      const line = lineForIndex(handlerMatch.index);
      const methodNodeId = `func_${this.sanitizeId(relativePath)}_${this.sanitizeId(handlerName)}_${line}`;
      if (nodes.some(n => n.id === methodNodeId)) continue;
      nodes.push(this.createNodeBuilder(methodNodeId, handlerName, 'function')
        .withLevel(3, this.getLevelName(3))
        .withSource({ file: relativePath, line })
        .withMetadata({ language: 'gdscript', framework: 'godot', attributes: { godot_signal_handler: signalName } })
        .build());
      edges.push(this.createEdge(`${fileNodeId}_contains_${methodNodeId}`, fileNodeId, methodNodeId, 'contains'));

      entryPoints.push(this.createEntryPoint(
        `entry:event:${relativePath}:${signalName}:${line}`,
        methodNodeId,
        'event',
        handlerName,
        `Godot invokes ${handlerName}() when the "${signalName}" signal is emitted.`,
        { event: `godot-signal:${signalName}` },
        undefined,
        { framework: 'godot', engine: 'godot', signal: signalName, file: relativePath, line },
        { node_id: methodNodeId, method_name: handlerName, file: relativePath, line }
      ));
    }
  }

  private extractGodotCSharpFile(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);
    const classPattern = /\bclass\s+([A-Za-z_]\w*)\s*:\s*([^{]+)\{/g;
    let match: RegExpExecArray | null;
    while ((match = classPattern.exec(content)) !== null) {
      const className = match[1];
      const baseList = match[2];
      if (!/\b(Node\w*|Control|Node2D|Node3D|Spatial)\b/.test(baseList)) continue;
      const classLine = lineForIndex(match.index);
      const classNodeId = `class_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${classLine}`;
      nodes.push(this.createNodeBuilder(classNodeId, className, 'class')
        .withLevel(2, this.getLevelName(2))
        .withSource({ file: relativePath, line: classLine })
        .withMetadata({ language: 'csharp', framework: 'godot', attributes: { godot_node: true, base_type: baseList.trim() } })
        .build());

      for (const hookName of CSHARP_GODOT_LIFECYCLE) {
        const pattern = new RegExp(`\\b(?:public|private|protected)?\\s*override\\s+void\\s+${hookName}\\s*\\(`);
        const m = pattern.exec(content);
        if (!m) continue;
        const line = lineForIndex(m.index);
        const methodNodeId = `method_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${hookName}_${line}`;
        nodes.push(this.createNodeBuilder(methodNodeId, `${className}.${hookName}`, 'method')
          .withLevel(3, this.getLevelName(3))
          .withSource({ file: relativePath, line })
          .withMetadata({ language: 'csharp', framework: 'godot', attributes: { godot_lifecycle_hook: hookName, class: className } })
          .build());
        edges.push(this.createEdge(`${classNodeId}_contains_${methodNodeId}`, classNodeId, methodNodeId, 'contains'));

        entryPoints.push(this.createEntryPoint(
          `entry:lifecycle:${relativePath}:${className}:${hookName}:${line}`,
          methodNodeId,
          'lifecycle',
          `${className}.${hookName}`,
          `Godot engine invokes ${className}.${hookName} as part of the node lifecycle/frame dispatch.`,
          { event: `godot:${hookName}` },
          undefined,
          { framework: 'godot', engine: 'godot', hook: hookName, class: className, file: relativePath, line },
          { node_id: methodNodeId, method_name: hookName, file: relativePath, line }
        ));
      }
    }
  }

  private toPascal(snake: string): string {
    return snake.split('_').filter(Boolean).map(s => s[0]?.toUpperCase() + s.slice(1)).join('');
  }

  private buildLineIndex(content: string): (idx: number) => number {
    const offsets: number[] = [];
    let offset = 0;
    for (const line of content.split('\n')) { offsets.push(offset); offset += line.length + 1; }
    return (idx: number) => {
      let low = 0, high = offsets.length - 1, result = 0;
      while (low <= high) { const mid = (low + high) >> 1; if (offsets[mid] <= idx) { result = mid; low = mid + 1; } else { high = mid - 1; } }
      return result + 1;
    };
  }
}
