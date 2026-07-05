import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Unreal Engine (C++) game-engine framework analyzer.
 *
 * Mirrors the Unity analyzer's premise for a different engine/language pair:
 * `AActor`/`UObject`/`APawn`/`ACharacter` subclasses declare `BeginPlay()` and
 * `Tick(float DeltaTime)` overrides that the engine invokes on
 * actor-spawn/per-frame — the engine is the caller, so these are the real
 * flow roots for an Unreal codebase and are emitted as `lifecycle` entry
 * points. `UFUNCTION()`-marked methods (bound to Blueprint/RPC/input) and
 * `UPROPERTY()`-marked fields (the Blueprint/editor-exposed configuration
 * surface, analogous to Unity's `[SerializeField]`) are captured as class
 * metadata.
 *
 * Real dependency gate: a `.uproject` file, or `#include "CoreMinimal.h"` /
 * a `GENERATED_BODY()` macro use, or a `Source/*.Build.cs` module file —
 * never inferred from folder names alone.
 */

const UNREAL_LIFECYCLE_METHODS = [
  'BeginPlay', 'EndPlay', 'Tick', 'PostInitializeComponents', 'BeginDestroy', 'Destroyed',
  'PostInitProperties', 'OnConstruction', 'NotifyActorBeginOverlap', 'NotifyActorEndOverlap',
  'NotifyHit',
];

const UNREAL_BASE_TYPES = ['AActor', 'APawn', 'ACharacter', 'AController', 'UObject', 'UActorComponent'];

interface UnrealClass {
  name: string;
  baseType: string;
}

export class UnrealAnalyzer extends BaseAnalyzer {
  constructor() {
    super('unreal', 'Unreal Engine Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const uprojectFiles = await glob(['**/*.uproject'], {
        cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true,
      });
      if (uprojectFiles.length > 0) return true;

      for (const file of await this.findCppFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (/GENERATED_BODY\s*\(\s*\)/.test(content) || /#include\s*"CoreMinimal\.h"/.test(content)) return true;
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
      const files = await this.findCppFiles(context.projectPath);
      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (!content) continue;
        this.extractUnrealClasses(content, relativePath, nodes, edges, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'unreal',
          actor_class_count: nodes.filter(n => n.metadata?.attributes?.unreal_actor).length,
          lifecycle_entry_point_count: entryPoints.filter(ep => ep.metadata?.framework === 'unreal').length,
        },
      });
    } catch (error) {
      throw new Error(`Unreal analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['actor-lifecycle-detection', 'ufunction-uproperty-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'unreal-project';
      case 2: return 'actor-classes';
      case 3: return 'lifecycle-hooks';
      default: return `unreal-level-${level}`;
    }
  }

  /**
   * Finds `class ANAME_API AFoo : public AActor` (or UActor/APawn/etc.)
   * declarations and, within the class body, textually-present lifecycle
   * overrides — never fabricated. Unreal headers commonly declare the method
   * (`virtual void BeginPlay() override;`) while the .cpp defines the body
   * (`void AFoo::BeginPlay() { ... }`); both forms are matched per-file.
   */
  private extractUnrealClasses(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);

    // Header-style class declaration: `class API_MACRO AClassName : public ABaseType`
    const classPattern = /\bclass\s+(?:[A-Z][A-Z0-9_]*_API\s+)?([A-UW-Za-z_]\w*)\s*:\s*public\s+([A-Za-z_]\w*)/g;
    let match: RegExpExecArray | null;
    const declaredClasses = new Map<string, { baseType: string; line: number }>();

    while ((match = classPattern.exec(content)) !== null) {
      const className = match[1];
      const baseType = match[2];
      if (!UNREAL_BASE_TYPES.includes(baseType) && !UNREAL_BASE_TYPES.some(b => baseType.startsWith(b))) continue;
      declaredClasses.set(className, { baseType, line: lineForIndex(match.index) });

      const classNodeId = `class_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${lineForIndex(match.index)}`;
      const ufunctions = this.extractUFunctions(content);
      const uproperties = this.extractUProperties(content);
      nodes.push(this.createNodeBuilder(classNodeId, className, 'class')
        .withLevel(2, this.getLevelName(2))
        .withSource({ file: relativePath, line: lineForIndex(match.index) })
        .withMetadata({
          language: 'cpp',
          framework: 'unreal',
          attributes: {
            unreal_actor: true,
            base_type: baseType,
            ufunctions,
            uproperties,
          },
        })
        .build());

      // Definitions can live in this same file (single-file actors) or in a
      // paired .cpp; scan this file's content for either declared-inline
      // bodies or `ClassName::Method(...)` out-of-line definitions.
      for (const hookName of UNREAL_LIFECYCLE_METHODS) {
        const inlinePattern = new RegExp(
          `\\bvirtual\\s+void\\s+${hookName}\\s*\\([^)]*\\)\\s*(?:const\\s*)?override\\s*\\{`
        );
        const outOfLinePattern = new RegExp(
          `\\bvoid\\s+${className}::${hookName}\\s*\\([^)]*\\)\\s*(?:const\\s*)?\\{`
        );
        const inlineMatch = inlinePattern.exec(content);
        const outOfLineMatch = outOfLinePattern.exec(content);
        const hookMatch = outOfLineMatch || inlineMatch;
        if (!hookMatch) continue;

        const hookLine = lineForIndex(hookMatch.index);
        const methodNodeId = `method_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${hookName}_${hookLine}`;
        nodes.push(this.createNodeBuilder(methodNodeId, `${className}::${hookName}`, 'method')
          .withLevel(3, this.getLevelName(3))
          .withSource({ file: relativePath, line: hookLine })
          .withMetadata({
            language: 'cpp',
            framework: 'unreal',
            attributes: { unreal_lifecycle_hook: hookName, class: className },
          })
          .build());
        edges.push(this.createEdge(
          `${classNodeId}_contains_${methodNodeId}`, classNodeId, methodNodeId, 'contains'
        ));

        entryPoints.push(this.createEntryPoint(
          `entry:lifecycle:${relativePath}:${className}:${hookName}:${hookLine}`,
          methodNodeId,
          'lifecycle',
          `${className}::${hookName}`,
          hookName === 'Tick'
            ? `Unreal engine invokes ${className}::Tick every frame for this actor.`
            : `Unreal engine invokes ${className}::${hookName} as part of the actor lifecycle.`,
          { event: `unreal:${hookName}` },
          undefined,
          {
            framework: 'unreal',
            engine: 'unreal',
            hook: hookName,
            class: className,
            file: relativePath,
            line: hookLine,
          },
          { node_id: methodNodeId, method_name: hookName, file: relativePath, line: hookLine }
        ));
      }
    }
  }

  private extractUFunctions(content: string): string[] {
    const names: string[] = [];
    const pattern = /UFUNCTION\s*\([^)]*\)\s*(?:virtual\s+)?[\w:<>,\s*&]+?\s+([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) names.push(m[1]);
    return names;
  }

  private extractUProperties(content: string): string[] {
    const names: string[] = [];
    const pattern = /UPROPERTY\s*\([^)]*\)\s*[\w:<>,\s*&]+?\s+([A-Za-z_]\w*)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) names.push(m[1]);
    return names;
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

  private async findCppFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.cpp', '**/*.h'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
