jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { MLTrainingAnalyzer } from '../../analyzer/frameworks/dataml/ml-training-analyzer';

const TORCH_FIXTURE = [
  'import torch',
  'import torch.nn as nn',
  'from torch.utils.data import DataLoader, Dataset',
  '',
  'class MyDataset(Dataset):',
  '    def __len__(self):',
  '        return 0',
  '',
  'class MyModel(nn.Module):',
  '    def __init__(self):',
  '        super().__init__()',
  '        self.linear = nn.Linear(10, 1)',
  '',
  '    def forward(self, x):',
  '        return self.linear(x)',
  '',
  'def train(model, loader, optimizer):',
  '    for batch in loader:',
  '        optimizer.zero_grad()',
  '        loss = model(batch)',
  '        loss.backward()',
  '        optimizer.step()',
  '',
  'train_loader = DataLoader(MyDataset())',
  ''
].join('\n');

const KERAS_FIXTURE = [
  'import tensorflow as tf',
  'from tensorflow import keras',
  '',
  'model = keras.Sequential([keras.layers.Dense(1)])',
  'model.compile(optimizer="adam", loss="mse")',
  'model.fit(x_train, y_train, epochs=10)',
  ''
].join('\n');

async function withTempDir(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-training-test-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.ensureDir(path.dirname(full));
      await fs.writeFile(full, content);
    }
    await run(dir);
  } finally {
    await fs.remove(dir);
  }
}

describe('MLTrainingAnalyzer', () => {
  it('detects a PyTorch training script', async () => {
    await withTempDir({ 'train.py': TORCH_FIXTURE }, async (dir) => {
      const analyzer = new MLTrainingAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(true);
    });
  });

  it('extracts the nn.Module model, the Dataset, and the train() entry point', async () => {
    await withTempDir({ 'train.py': TORCH_FIXTURE }, async (dir) => {
      const analyzer = new MLTrainingAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const modelNodes = contribution.nodes!.filter(n => n.type === 'model');
      expect(modelNodes.map(n => n.name)).toEqual(['MyModel']);

      const datasetNodes = contribution.nodes!.filter(n => n.type === 'dataset');
      expect(datasetNodes.map(n => n.name).sort()).toEqual(['MyDataset', 'train_loader']);

      const trainEntryPoints = contribution.entry_points!.filter(ep => ep.type === 'train');
      expect(trainEntryPoints).toHaveLength(1);
      expect(trainEntryPoints[0].name).toBe('train');

      const trainsEdge = contribution.edges!.find(e => e.type === 'trains');
      expect(trainsEdge).toBeDefined();
    });
  });

  it('detects a Keras model.fit() training entry', async () => {
    await withTempDir({ 'train_keras.py': KERAS_FIXTURE }, async (dir) => {
      const analyzer = new MLTrainingAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const trainEntryPoints = contribution.entry_points!.filter(ep => ep.type === 'train');
      expect(trainEntryPoints).toHaveLength(1);
      expect(trainEntryPoints[0].name).toBe('model.fit');
    });
  });
});
