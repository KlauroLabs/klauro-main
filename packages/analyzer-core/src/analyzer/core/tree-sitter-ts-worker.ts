import { parentPort } from 'node:worker_threads';
import { TreeSitterTSExtractor } from './tree-sitter-ts-extractor';

if (!parentPort) throw new Error('Tree-sitter extraction worker requires a parent port');

const extractor = new TreeSitterTSExtractor();

parentPort.on('message', (task: { id: number; content: string; filePath: string }) => {
  try {
    parentPort!.postMessage({
      id: task.id,
      extraction: extractor.extractFromSource(task.content, task.filePath),
    });
  } catch (error) {
    parentPort!.postMessage({
      id: task.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
