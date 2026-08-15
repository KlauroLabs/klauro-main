import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';























const UNITY_LIFECYCLE_METHODS = [
  'Awake', 'OnEnable', 'Start', 'FixedUpdate', 'Update', 'LateUpdate',
  'OnDisable', 'OnDestroy', 'OnApplicationQuit', 'OnApplicationPause', 'OnApplicationFocus',
  'Reset', 'OnValidate',
];

const UNITY_PHYSICS_CALLBACKS = [
  'OnCollisionEnter', 'OnCollisionStay', 'OnCollisionExit',
  'OnCollisionEnter2D', 'OnCollisionStay2D', 'OnCollisionExit2D',
  'OnTriggerEnter', 'OnTriggerStay', 'OnTriggerExit',
  'OnTriggerEnter2D', 'OnTriggerStay2D', 'OnTriggerExit2D',
  'OnMouseDown', 'OnMouseUp', 'OnMouseEnter', 'OnMouseExit', 'OnMouseOver', 'OnMouseDrag',
];

const UNITY_ALL_HOOKS = [...UNITY_LIFECYCLE_METHODS, ...UNITY_PHYSICS_CALLBACKS];


export class UnityAnalyzer extends BaseAnalyzer {
  constructor() {
    super('unity', 'Unity Engine Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (await this.hasUnityProjectEvidence(projectPath)) return true;
      for (const file of await this.findCsFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (/^\s*using\s+UnityEngine\s*;/m.test(content)) return true;
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
      const files = await this.findCsFiles(context.projectPath);
      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (!content) continue;
        this.extractMonoBehaviours(content, relativePath, nodes, edges, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'unity',
          monobehaviour_count: nodes.filter(n => n.metadata?.attributes?.unity_monobehaviour).length,
          lifecycle_entry_point_count: entryPoints.filter(ep => ep.metadata?.framework === 'unity').length,
        },
      });
    } catch (error) {
      throw new Error(`Unity analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['monobehaviour-lifecycle-detection', 'physics-callback-detection', 'serializefield-config-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'unity-project';
      case 2: return 'monobehaviours';
      case 3: return 'lifecycle-hooks';
      default: return `unity-level-${level}`;
    }
  }

  private async hasUnityProjectEvidence(projectPath: string): Promise<boolean> {
    const markers = await glob(
      ['ProjectSettings/ProjectVersion.txt', '**/*.unity', '**/*.meta', 'Assets/**'],
      { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: false }
    );
    return markers.length > 0;
  }







  private extractMonoBehaviours(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const lineForIndex = this.buildLineIndex(content);
    const classPattern = /\bclass\s+([A-Za-z_]\w*)\s*(?:<[^>{}]+>)?\s*:\s*([^{]+)\{/g;
    let match: RegExpExecArray | null;

    while ((match = classPattern.exec(content)) !== null) {
      const className = match[1];
      const baseList = match[2].trim();
      const isMonoBehaviour = /\bMonoBehaviour\b/.test(baseList);
      if (!isMonoBehaviour) continue;

      const bodyStart = match.index + match[0].length;
      const bodyEnd = this.findMatchingBrace(content, bodyStart - 1);
      const classBody = content.slice(bodyStart, bodyEnd === -1 ? content.length : bodyEnd);
      const classLine = lineForIndex(match.index);

      const serializeFields = this.extractSerializeFields(classBody);

      const classNodeId = `class_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${classLine}`;
      nodes.push(this.createNodeBuilder(classNodeId, className, 'class')
        .withLevel(2, this.getLevelName(2))
        .withSource({ file: relativePath, line: classLine })
        .withMetadata({
          language: 'csharp',
          framework: 'unity',
          attributes: {
            unity_monobehaviour: true,
            base_type: baseList,
            serialize_fields: serializeFields,
          },
        })
        .build());

      for (const hookName of UNITY_ALL_HOOKS) {
        const hookPattern = new RegExp(
          `\\b(?:public|private|protected|internal)?\\s*(?:virtual\\s+|override\\s+)?(?:void|IEnumerator)\\s+${hookName}\\s*\\(`
        );
        const hookMatch = hookPattern.exec(classBody);
        if (!hookMatch) continue;

        const hookLine = lineForIndex(bodyStart + hookMatch.index);
        const methodNodeId = `method_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${hookName}_${hookLine}`;
        nodes.push(this.createNodeBuilder(methodNodeId, `${className}.${hookName}`, 'method')
          .withLevel(3, this.getLevelName(3))
          .withSource({ file: relativePath, line: hookLine })
          .withMetadata({
            language: 'csharp',
            framework: 'unity',
            attributes: {
              unity_lifecycle_hook: hookName,
              is_physics_callback: UNITY_PHYSICS_CALLBACKS.includes(hookName),
              class: className,
            },
          })
          .build());
        edges.push(this.createEdge(
          `${classNodeId}_contains_${methodNodeId}`, classNodeId, methodNodeId, 'contains'
        ));

        entryPoints.push(this.createEntryPoint(
          `entry:lifecycle:${relativePath}:${className}:${hookName}:${hookLine}`,
          methodNodeId,
          'lifecycle',
          `${className}.${hookName}`,
          UNITY_PHYSICS_CALLBACKS.includes(hookName)
            ? `Unity engine invokes ${className}.${hookName} on collision/trigger events for this MonoBehaviour.`
            : `Unity engine invokes ${className}.${hookName} as part of its per-object lifecycle/frame tick.`,
          { event: `unity:${hookName}` },
          undefined,
          {
            framework: 'unity',
            engine: 'unity',
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

  private extractSerializeFields(classBody: string): string[] {
    const fields: string[] = [];
    const fieldPattern = /\[SerializeField\][^;]*?\b(?:public|private|protected|internal)?\s*[\w<>[\],\s]+?\s+([A-Za-z_]\w*)\s*(?:=|;)/g;
    let m: RegExpExecArray | null;
    while ((m = fieldPattern.exec(classBody)) !== null) {
      fields.push(m[1]);
    }
    return fields;
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

  private async findCsFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.cs'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
