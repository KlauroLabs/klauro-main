import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';





















const FOPS_FIELDS = [
  'open', 'release', 'read', 'write', 'llseek', 'mmap',
  'unlocked_ioctl', 'compat_ioctl', 'poll', 'fsync', 'flush',
];

export class LinuxKernelModuleAnalyzer extends BaseAnalyzer {
  constructor() {
    super('linux-kernel-module', 'Linux Kernel Module Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      for (const file of await this.findCFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (/#include\s*[<"]linux\/module\.h[>"]/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    try {
      const files = await this.findCFiles(context.projectPath);
      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (!content || !/#include\s*[<"]linux\/module\.h[>"]/.test(content)) continue;
        this.extractModuleInitExit(content, relativePath, nodes, edges, entryPoints);
        this.extractFileOperations(content, relativePath, nodes, edges, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'linux-kernel-module',
          driver_entry_point_count: entryPoints.filter(ep => ep.type === 'driver').length,
        },
      });
    } catch (error) {
      throw new Error(`Linux kernel module analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['module-init-exit-detection', 'file-operations-fops-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'kernel-module';
      case 2: return 'module-lifecycle';
      case 3: return 'fops-handlers';
      default: return `kernel-module-level-${level}`;
    }
  }


  private extractModuleInitExit(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);

    for (const [macro, label, description] of [
      ['module_init', 'insmod', 'Kernel module loader invokes this function when the module is inserted (insmod/modprobe).'],
      ['module_exit', 'rmmod', 'Kernel module loader invokes this function when the module is removed (rmmod).'],
    ] as const) {
      const pattern = new RegExp(`\\b${macro}\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\)`);
      const m = pattern.exec(content);
      if (!m) continue;
      const fnName = m[1];
      const defPattern = new RegExp(`\\b(?:static\\s+)?int\\s+${fnName}\\s*\\(\\s*void\\s*\\)\\s*\\{`);
      const defMatch = defPattern.exec(content);
      const line = defMatch ? lineForIndex(defMatch.index) : lineForIndex(m.index);
      const nodeId = `function_${this.sanitizeId(relativePath)}_${this.sanitizeId(fnName)}_${line}`;
      if (!nodes.some(n => n.id === nodeId)) {
        nodes.push(this.createNodeBuilder(nodeId, fnName, 'function')
          .withLevel(2, this.getLevelName(2))
          .withSource({ file: relativePath, line })
          .withMetadata({ language: 'c', framework: 'linux-kernel-module', attributes: { module_hook: macro } })
          .build());
      }

      entryPoints.push(this.createEntryPoint(
        `entry:driver:${relativePath}:${fnName}:${line}`,
        nodeId,
        'driver',
        `${fnName} (${macro})`,
        description,
        { event: label },
        undefined,
        { framework: 'linux-kernel-module', hook: macro, file: relativePath, line },
        { node_id: nodeId, method_name: fnName, file: relativePath, line }
      ));
    }
  }






  private extractFileOperations(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);
    const structPattern = /struct\s+file_operations\s+([A-Za-z_]\w*)\s*=\s*\{/g;
    let sm: RegExpExecArray | null;
    while ((sm = structPattern.exec(content)) !== null) {
      const structName = sm[1];
      const bodyStart = sm.index + sm[0].length;
      const bodyEnd = this.findMatchingBrace(content, bodyStart - 1);
      const body = content.slice(bodyStart, bodyEnd === -1 ? content.length : bodyEnd);

      for (const field of FOPS_FIELDS) {
        const fieldPattern = new RegExp(`\\.${field}\\s*=\\s*([A-Za-z_]\\w*)`);
        const fm = fieldPattern.exec(body);
        if (!fm) continue;
        const handlerFn = fm[1];
        const defPattern = new RegExp(`\\b(?:static\\s+)?\\w[\\w\\s*]*\\b${handlerFn}\\s*\\([^)]*\\)\\s*\\{`);
        const defMatch = defPattern.exec(content);
        const line = defMatch ? lineForIndex(defMatch.index) : lineForIndex(bodyStart + fm.index);
        const nodeId = `function_${this.sanitizeId(relativePath)}_fops_${this.sanitizeId(handlerFn)}_${line}`;
        if (!nodes.some(n => n.id === nodeId)) {
          nodes.push(this.createNodeBuilder(nodeId, handlerFn, 'function')
            .withLevel(3, this.getLevelName(3))
            .withSource({ file: relativePath, line })
            .withMetadata({ language: 'c', framework: 'linux-kernel-module', attributes: { fops_field: field, fops_struct: structName } })
            .build());
        }

        entryPoints.push(this.createEntryPoint(
          `entry:driver:${relativePath}:${handlerFn}:${line}`,
          nodeId,
          'driver',
          `${handlerFn} (fops.${field})`,
          `VFS/kernel invokes ${handlerFn} when userspace performs the ${field} operation on this device's file_operations (${structName}).`,
          { event: `fops:${field}` },
          undefined,
          { framework: 'linux-kernel-module', fops_field: field, fops_struct: structName, file: relativePath, line },
          { node_id: nodeId, method_name: handlerFn, file: relativePath, line }
        ));
      }
    }
  }

  private findMatchingBrace(content: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
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

  private async findCFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.c', '**/*.h'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
