import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Arduino framework analyzer — the Arduino core's `setup()`/`loop()`
 * lifecycle, plus FreeRTOS tasks commonly layered on top on ESP32/Arduino-RTOS
 * boards.
 *
 * The Arduino core's `main.cpp` (bundled with the toolchain, not in the
 * user's sketch) calls the user-defined `void setup()` exactly once at boot,
 * then calls `void loop()` repeatedly forever — the sketch never defines
 * `main()` itself. So for an Arduino sketch, `setup` and `loop` ARE the flow
 * roots the same way a bare `main()` super-loop is for embedded C; they are
 * emitted as `lifecycle` entry points.
 *
 * `xTaskCreate(taskFn, ...)` (and the ESP-IDF variant `xTaskCreatePinnedToCore`)
 * hands a function pointer to the FreeRTOS scheduler, which invokes it as an
 * independent concurrent task — never called directly by application code —
 * so each resolved `taskFn` is emitted as a `task` entry point.
 *
 * Real dependency gate: a `.ino` sketch file, or `#include <Arduino.h>` in a
 * `.cpp`/`.h`, or `#include <freertos/FreeRTOS.h>` for the task-scheduler
 * signal — never inferred from folder names alone.
 */

export class ArduinoAnalyzer extends BaseAnalyzer {
  constructor() {
    super('arduino', 'Arduino Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const inoFiles = await glob(['**/*.ino'], { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
      if (inoFiles.length > 0) return true;

      for (const file of await this.findSourceFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (/#include\s*[<"]Arduino\.h[>"]/.test(content)) return true;
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
      const inoFiles = await glob(['**/*.ino'], { cwd: context.projectPath, ignore: this.getIgnorePatterns({ projectPath: context.projectPath }), nodir: true });
      const sourceFiles = await this.findSourceFiles(context.projectPath);
      const allFiles = [...new Set([...inoFiles.map(f => path.join(context.projectPath, f)), ...sourceFiles])];

      for (const file of allFiles) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (!content) continue;
        this.extractSetupLoop(content, relativePath, nodes, edges, entryPoints);
        this.extractRtosTasks(content, relativePath, nodes, edges, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'arduino',
          task_count: entryPoints.filter(ep => ep.type === 'task').length,
          lifecycle_entry_point_count: entryPoints.filter(ep => ep.type === 'lifecycle' && ep.metadata?.framework === 'arduino').length,
        },
      });
    } catch (error) {
      throw new Error(`Arduino analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['setup-loop-detection', 'freertos-task-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'sketch';
      case 2: return 'setup-loop';
      case 3: return 'tasks';
      default: return `arduino-level-${level}`;
    }
  }

  private extractSetupLoop(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);

    for (const [name, description] of [
      ['setup', 'Arduino core calls setup() exactly once at boot, before loop() begins.'],
      ['loop', 'Arduino core calls loop() repeatedly forever after setup() completes.'],
    ] as const) {
      const pattern = new RegExp(`\\bvoid\\s+${name}\\s*\\(\\s*(?:void)?\\s*\\)\\s*\\{`);
      const m = pattern.exec(content);
      if (!m) continue;
      const line = lineForIndex(m.index);
      const nodeId = `function_${this.sanitizeId(relativePath)}_${name}_${line}`;
      nodes.push(this.createNodeBuilder(nodeId, name, 'function')
        .withLevel(2, this.getLevelName(2))
        .withSource({ file: relativePath, line })
        .withMetadata({ language: 'cpp', framework: 'arduino', attributes: { arduino_lifecycle_hook: name } })
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry:lifecycle:${relativePath}:${name}:${line}`,
        nodeId,
        'lifecycle',
        name,
        description,
        { event: `arduino:${name}` },
        undefined,
        { framework: 'arduino', hook: name, file: relativePath, line },
        { node_id: nodeId, method_name: name, file: relativePath, line }
      ));
    }
  }

  /** `xTaskCreate(taskFn, "name", stack, params, priority, &handle)` — resolves
   *  the task function pointer argument to its own definition in this file. */
  private extractRtosTasks(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);
    const callPattern = /\bxTaskCreate(?:PinnedToCore)?\s*\(\s*([A-Za-z_]\w*)\s*,\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = callPattern.exec(content)) !== null) {
      const taskFn = m[1];
      const taskLabel = m[2];
      const defPattern = new RegExp(`\\bvoid\\s+${taskFn}\\s*\\(\\s*void\\s*\\*[^)]*\\)\\s*\\{`);
      const defMatch = defPattern.exec(content);
      const defLine = defMatch ? lineForIndex(defMatch.index) : lineForIndex(m.index);
      const nodeId = `function_${this.sanitizeId(relativePath)}_task_${this.sanitizeId(taskFn)}_${defLine}`;
      if (!nodes.some(n => n.id === nodeId)) {
        nodes.push(this.createNodeBuilder(nodeId, taskFn, 'function')
          .withLevel(3, this.getLevelName(3))
          .withSource({ file: relativePath, line: defLine })
          .withMetadata({ language: 'cpp', framework: 'arduino', attributes: { rtos_task: true, task_label: taskLabel } })
          .build());
      }

      entryPoints.push(this.createEntryPoint(
        `entry:task:${relativePath}:${taskFn}:${defLine}`,
        nodeId,
        'task',
        `${taskFn} (${taskLabel})`,
        `FreeRTOS scheduler invokes ${taskFn} as an independent task ("${taskLabel}") registered via xTaskCreate.`,
        { event: `rtos-task:${taskLabel}` },
        undefined,
        { framework: 'arduino', task_label: taskLabel, file: relativePath, line: defLine },
        { node_id: nodeId, method_name: taskFn, file: relativePath, line: defLine }
      ));
    }
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

  private async findSourceFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.cpp', '**/*.h', '**/*.hpp'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
