import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';






















const ISR_MACRO_PATTERN = /\bISR\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
const ATTR_INTERRUPT_PATTERN = /(?:void|int)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*__attribute__\s*\(\s*\(\s*interrupt(?:\s*\([^)]*\))?\s*\)\s*\)/g;
const IRQ_HANDLER_PATTERN = /\bvoid\s+([A-Za-z_]\w*(?:IRQHandler|_ISR|_Handler))\s*\(\s*void\s*\)/g;

export class EmbeddedCAnalyzer extends BaseAnalyzer {
  constructor() {
    super('embedded-c', 'Embedded C Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      for (const file of await this.findCFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (this.hasEmbeddedEvidence(content)) return true;
      }
      const linkerScripts = await glob(['**/*.ld'], { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
      if (linkerScripts.length > 0) {
        for (const file of await this.findCFiles(projectPath)) {
          const content = await fs.readFile(file, 'utf-8').catch(() => '');
          if (/\bwhile\s*\(\s*1\s*\)|\bfor\s*\(\s*;;\s*\)/.test(content) && /\bint\s+main\s*\(/.test(content)) return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private hasEmbeddedEvidence(content: string): boolean {
    return /#include\s*[<"]avr\/(io|interrupt)\.h[>"]/.test(content) ||
      /#include\s*[<"]core_cm\d\.h[>"]/.test(content) ||
      /#include\s*[<"][A-Za-z0-9_]+_hal\.h[>"]/i.test(content) ||
      /\bISR\s*\(/.test(content) ||
      /__attribute__\s*\(\s*\(\s*interrupt/.test(content);
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
        if (!content) continue;
        this.extractSuperLoop(content, relativePath, nodes, edges, entryPoints);
        this.extractISRs(content, relativePath, nodes, edges, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'embedded-c',
          isr_count: entryPoints.filter(ep => ep.type === 'interrupt').length,
          super_loop_count: entryPoints.filter(ep => ep.metadata?.attributes === 'super-loop').length,
        },
      });
    } catch (error) {
      throw new Error(`Embedded C analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['super-loop-detection', 'isr-detection', 'irq-handler-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'firmware';
      case 2: return 'main-loop';
      case 3: return 'interrupt-handlers';
      default: return `embedded-level-${level}`;
    }
  }


  private extractSuperLoop(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const mainPattern = /\bint\s+main\s*\(\s*(?:void)?\s*\)\s*\{/;
    const mainMatch = mainPattern.exec(content);
    if (!mainMatch) return;

    const bodyStart = mainMatch.index + mainMatch[0].length;
    const bodyEnd = this.findMatchingBrace(content, bodyStart - 1);
    const body = content.slice(bodyStart, bodyEnd === -1 ? content.length : bodyEnd);
    const hasSuperLoop = /\bwhile\s*\(\s*1\s*\)|\bfor\s*\(\s*;;\s*\)/.test(body);
    if (!hasSuperLoop) return;

    const lineForIndex = this.buildLineIndex(content);
    const line = lineForIndex(mainMatch.index);
    const nodeId = `function_${this.sanitizeId(relativePath)}_main_${line}`;
    nodes.push(this.createNodeBuilder(nodeId, 'main', 'function')
      .withLevel(2, this.getLevelName(2))
      .withSource({ file: relativePath, line })
      .withMetadata({ language: 'c', framework: 'embedded-c', attributes: { super_loop: true } })
      .build());

    entryPoints.push(this.createEntryPoint(
      `entry:lifecycle:${relativePath}:main:${line}`,
      nodeId,
      'lifecycle',
      'main (super-loop)',
      'main() runs a bare-metal super-loop (while(1)/for(;;)) that is the firmware\'s entire runtime after boot/init.',
      { event: 'reset-vector-start' },
      undefined,
      { framework: 'embedded-c', attributes: 'super-loop', file: relativePath, line },
      { node_id: nodeId, method_name: 'main', file: relativePath, line }
    ));
  }


  private extractISRs(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);

    const pushIsr = (name: string, index: number, macroForm: string) => {
      const line = lineForIndex(index);
      const nodeId = `function_${this.sanitizeId(relativePath)}_isr_${this.sanitizeId(name)}_${line}`;
      if (nodes.some(n => n.id === nodeId)) return;
      nodes.push(this.createNodeBuilder(nodeId, name, 'function')
        .withLevel(3, this.getLevelName(3))
        .withSource({ file: relativePath, line })
        .withMetadata({ language: 'c', framework: 'embedded-c', attributes: { isr: true, vector: name, form: macroForm } })
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry:interrupt:${relativePath}:${name}:${line}`,
        nodeId,
        'interrupt',
        name,
        `Hardware interrupt controller invokes ${name} directly on the "${name}" interrupt vector — never called from application code.`,
        { event: `irq:${name}` },
        undefined,
        { framework: 'embedded-c', vector: name, form: macroForm, file: relativePath, line },
        { node_id: nodeId, method_name: name, file: relativePath, line }
      ));
    };

    let m: RegExpExecArray | null;
    ISR_MACRO_PATTERN.lastIndex = 0;
    while ((m = ISR_MACRO_PATTERN.exec(content)) !== null) pushIsr(m[1], m.index, 'ISR-macro');

    ATTR_INTERRUPT_PATTERN.lastIndex = 0;
    while ((m = ATTR_INTERRUPT_PATTERN.exec(content)) !== null) pushIsr(m[1], m.index, 'attribute-interrupt');

    IRQ_HANDLER_PATTERN.lastIndex = 0;
    while ((m = IRQ_HANDLER_PATTERN.exec(content)) !== null) pushIsr(m[1], m.index, 'irq-handler');
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
