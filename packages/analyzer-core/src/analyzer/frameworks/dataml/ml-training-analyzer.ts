import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';


interface MLModel {
  className: string;
  file: string;
  line: number;
  bodyEnd: number;
  framework: 'pytorch' | 'keras' | 'tensorflow';
}



interface TrainingEntry {
  name: string;
  file: string;
  line: number;
  kind: 'function' | 'call';
  framework: 'pytorch' | 'keras' | 'tensorflow';
  modelRef?: string;
}


interface DatasetRef {
  name: string;
  file: string;
  line: number;
  kind: 'loader-instantiation' | 'dataset-subclass';
}

const TORCH_MODULE_CLASS_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:nn\.Module|torch\.nn\.Module)\s*\)\s*:/;
const KERAS_MODEL_CLASS_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:tf\.keras\.Model|keras\.Model|Model)\s*\)\s*:/;
const TRAIN_DEF_PATTERN = /^\s*(?:async\s+)?def\s+(train|fit|train_model|train_loop|main)\s*\(/;
const MODEL_FIT_CALL_PATTERN = /^\s*(?:[\w.]+\s*=\s*)?([A-Za-z_][A-Za-z0-9_.]*)\.fit\s*\(/;
const DATALOADER_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:torch\.utils\.data\.)?DataLoader\s*\(/;
const DATASET_SUBCLASS_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:torch\.utils\.data\.)?Dataset\s*\)\s*:/;
const TRAINING_LOOP_PATTERN = /\.backward\s*\(\s*\)|optimizer\.step\s*\(\s*\)/;

export class MLTrainingAnalyzer extends BaseAnalyzer {
  constructor() {
    super('ml-training', 'ML Training Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      for (const manifest of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
        const manifestPath = path.join(projectPath, manifest);
        if (await fs.pathExists(manifestPath)) {
          const contents = await fs.readFile(manifestPath, 'utf-8');
          if (/\btorch\b|\btensorflow\b|\bkeras\b/i.test(contents)) return true;
        }
      }

      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true
      });

      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeMLTraining(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikeMLTraining(content: string): boolean {
    const importsTorch = /^\s*import\s+torch\b|^\s*from\s+torch\b/m.test(content);
    const importsTf = /^\s*import\s+tensorflow\b|^\s*from\s+tensorflow\b|^\s*import\s+keras\b|^\s*from\s+keras\b/m.test(content);
    if (!importsTorch && !importsTf) return false;
    return TORCH_MODULE_CLASS_PATTERN.test(content) ||
      KERAS_MODEL_CLASS_PATTERN.test(content) ||
      /\.fit\s*\(/.test(content) ||
      TRAINING_LOOP_PATTERN.test(content);
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const pyFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      const relevantFiles: string[] = [];
      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        if (this.looksLikeMLTraining(content)) relevantFiles.push(file);
      }

      if (relevantFiles.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, { framework: 'ml-training', modelsFound: 0 });
      }

      let modelsFound = 0;
      let trainingEntriesFound = 0;
      let datasetsFound = 0;

      for (const file of relevantFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        const models = this.extractModels(content, file);
        const trainingEntries = this.extractTrainingEntries(content, file);
        const datasets = this.extractDatasets(content, file);

        modelsFound += models.length;
        trainingEntriesFound += trainingEntries.length;
        datasetsFound += datasets.length;

        const modelNodeIdByClass = new Map<string, string>();
        const datasetNodeIdByName = new Map<string, string>();

        for (const model of models) {
          const modelId = `mlmodel_${this.sanitizeId(model.className)}_${this.sanitizeId(file)}`;
          modelNodeIdByClass.set(model.className, modelId);

          const node = this.createNodeBuilder(modelId, model.className, 'model')
            .withLevel(3, 'code')
            .withCategory('model', ['ml', model.framework])
            .withSource({ file: model.file, line: model.line, end_line: model.bodyEnd })
            .withDescription(`${model.framework === 'pytorch' ? 'PyTorch' : 'Keras/TensorFlow'} model: ${model.className}`)
            .withMetadata({ framework: model.framework, attributes: { kind: 'model-definition' } })
            .build();
          nodes.push(node);
        }

        for (const ds of datasets) {
          const dsId = `mldataset_${this.sanitizeId(ds.name)}_${this.sanitizeId(file)}_${ds.line}`;
          datasetNodeIdByName.set(ds.name, dsId);

          const node = this.createNodeBuilder(dsId, ds.name, 'dataset')
            .withLevel(3, 'code')
            .withCategory('dataset', ['ml', ds.kind])
            .withSource({ file: ds.file, line: ds.line, end_line: ds.line })
            .withDescription(ds.kind === 'dataset-subclass'
              ? `Dataset class: ${ds.name}`
              : `Dataset loader: ${ds.name}`)
            .withMetadata({ framework: 'ml-training', attributes: { kind: ds.kind } })
            .build();
          nodes.push(node);
        }

        for (const entry of trainingEntries) {
          const entryNodeId = `mltrain_${this.sanitizeId(entry.name)}_${this.sanitizeId(file)}_${entry.line}`;





          const resolvedModelClass = entry.modelRef ||
            (modelNodeIdByClass.size === 1 ? [...modelNodeIdByClass.keys()][0] : undefined);

          const node = this.createNodeBuilder(entryNodeId, entry.name, 'train')
            .withLevel(3, 'code')
            .withCategory('train', ['ml', 'training-entry', entry.framework])
            .withSource({ file: entry.file, line: entry.line, end_line: entry.line })
            .withDescription(`ML training entry point: ${entry.name}`)
            .withMetadata({ framework: entry.framework, attributes: { kind: entry.kind } })
            .build();
          nodes.push(node);

          entryPoints.push(this.createEntryPoint(
            `entry_${entryNodeId}`,
            entryNodeId,
            'train',
            entry.name,
            `ML training entry point: ${entry.name}`,
            undefined,
            undefined,
            { framework: entry.framework, kind: entry.kind, modelRef: resolvedModelClass },
            { node_id: entryNodeId, method_name: entry.name, file: entry.file, line: entry.line }
          ));




          if (entry.modelRef) {
            const resolvedModelId = modelNodeIdByClass.get(entry.modelRef) ||
              [...modelNodeIdByClass.values()][0];
            if (resolvedModelId) {
              edges.push(this.createEdge(
                `${entryNodeId}_trains_${resolvedModelId}`,
                entryNodeId,
                resolvedModelId,
                'trains',
                'ml-training',
                { framework: entry.framework }
              ));
            }
          } else if (modelNodeIdByClass.size === 1) {
            const [onlyModelId] = modelNodeIdByClass.values();
            edges.push(this.createEdge(
              `${entryNodeId}_trains_${onlyModelId}`,
              entryNodeId,
              onlyModelId,
              'trains',
              'ml-training',
              { framework: entry.framework }
            ));
          }

          for (const dsId of datasetNodeIdByName.values()) {
            edges.push(this.createEdge(
              `${dsId}_feeds_${entryNodeId}`,
              dsId,
              entryNodeId,
              'feeds',
              'ml-training-input',
              { framework: entry.framework }
            ));
          }
        }
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'ml-training',
        modelsFound,
        trainingEntriesFound,
        datasetsFound
      });
    } catch (error) {
      throw new AnalyzerError(`ML training analysis failed: ${(error as Error).message}`, 'ML_TRAINING_ANALYSIS_ERROR');
    }
  }

  extractModels(content: string, file: string): MLModel[] {
    const results: MLModel[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      let framework: MLModel['framework'] | null = null;
      let match = lines[i].match(TORCH_MODULE_CLASS_PATTERN);
      if (match) framework = 'pytorch';
      if (!match) {
        match = lines[i].match(KERAS_MODEL_CLASS_PATTERN);
        if (match) framework = 'keras';
      }
      if (!match || !framework) continue;

      const className = match[1];
      const classIndent = lines[i].match(/^\s*/)?.[0].length ?? 0;
      let bodyEnd = i;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') { bodyEnd = k; continue; }
        const indent = lines[k].match(/^\s*/)?.[0].length ?? 0;
        if (indent <= classIndent) break;
        bodyEnd = k;
      }

      results.push({ className, file, line: i + 1, bodyEnd, framework });
    }

    return results;
  }

  extractTrainingEntries(content: string, file: string): TrainingEntry[] {
    const results: TrainingEntry[] = [];
    const lines = content.split('\n');
    const isTf = /^\s*import\s+tensorflow\b|^\s*from\s+tensorflow\b|^\s*import\s+keras\b|^\s*from\s+keras\b/m.test(content);
    const isTorch = /^\s*import\s+torch\b|^\s*from\s+torch\b/m.test(content);

    for (let i = 0; i < lines.length; i++) {
      const defMatch = lines[i].match(TRAIN_DEF_PATTERN);
      if (defMatch) {


        const defIndent = lines[i].match(/^\s*/)?.[0].length ?? 0;
        let bodyText = '';
        for (let k = i + 1; k < lines.length; k++) {
          if (lines[k].trim() === '') continue;
          const indent = lines[k].match(/^\s*/)?.[0].length ?? 0;
          if (indent <= defIndent) break;
          bodyText += lines[k] + '\n';
        }
        const isTrainingBody = TRAINING_LOOP_PATTERN.test(bodyText) || /\.fit\s*\(/.test(bodyText) || defMatch[1] !== 'main';
        if (isTrainingBody) {
          results.push({
            name: defMatch[1],
            file,
            line: i + 1,
            kind: 'function',
            framework: isTf && !isTorch ? 'keras' : 'pytorch'
          });
        }
        continue;
      }

      const fitMatch = lines[i].match(MODEL_FIT_CALL_PATTERN);
      if (fitMatch) {
        results.push({
          name: `${fitMatch[1]}.fit`,
          file,
          line: i + 1,
          kind: 'call',
          framework: 'keras',
          modelRef: fitMatch[1]
        });
      }
    }

    return results;
  }

  extractDatasets(content: string, file: string): DatasetRef[] {
    const results: DatasetRef[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const loaderMatch = lines[i].match(DATALOADER_PATTERN);
      if (loaderMatch) {
        results.push({ name: loaderMatch[1], file, line: i + 1, kind: 'loader-instantiation' });
        continue;
      }
      const subclassMatch = lines[i].match(DATASET_SUBCLASS_PATTERN);
      if (subclassMatch) {
        results.push({ name: subclassMatch[1], file, line: i + 1, kind: 'dataset-subclass' });
      }
    }

    return results;
  }

  protected getCapabilities(): string[] {
    return ['ml-model-extraction', 'training-entry-extraction', 'dataset-extraction', 'ml-training-dataflow'];
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
