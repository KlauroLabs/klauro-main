import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput } from '../../backend/src/types/cas.types';

const DEFAULT_STORAGE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.unravl',
  'analyses'
);

interface AnalysisIndex {
  analyses: Record<string, AnalysisEntry>;
}

export interface AnalysisEntry {
  name: string;
  path: string;
  file: string;
  analyzed_at: string;
  system_type: string;
  frameworks: string[];
  node_count: number;
  edge_count: number;
}

function getStoragePath(): string {
  return process.env.UNRAVL_STORAGE_PATH || DEFAULT_STORAGE_PATH;
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}

async function ensureStorageDir(): Promise<string> {
  const storagePath = getStoragePath();
  await fs.ensureDir(storagePath);
  return storagePath;
}

async function loadIndex(): Promise<AnalysisIndex> {
  const storagePath = await ensureStorageDir();
  const indexPath = path.join(storagePath, 'index.json');
  if (await fs.pathExists(indexPath)) {
    return fs.readJson(indexPath);
  }
  return { analyses: {} };
}

async function saveIndex(index: AnalysisIndex): Promise<void> {
  const storagePath = await ensureStorageDir();
  const indexPath = path.join(storagePath, 'index.json');
  await fs.writeJson(indexPath, index, { spaces: 2 });
}

export async function saveAnalysis(projectPath: string, output: CASOutput): Promise<AnalysisEntry> {
  const storagePath = await ensureStorageDir();
  const slug = slugify(output.system.name || path.basename(projectPath));
  const fileName = `${slug}.json`;
  const filePath = path.join(storagePath, fileName);

  await fs.writeJson(filePath, output);

  const frameworks = output.system.technologies?.frameworks?.map(f => f.name) || [];

  const entry: AnalysisEntry = {
    name: output.system.name,
    path: projectPath,
    file: fileName,
    analyzed_at: output.analysis_timestamp,
    system_type: output.system.type,
    frameworks,
    node_count: output.nodes.length,
    edge_count: output.edges.length,
  };

  const index = await loadIndex();
  index.analyses[projectPath] = entry;
  await saveIndex(index);

  return entry;
}

export async function loadAnalysis(projectPath: string): Promise<CASOutput | null> {
  const index = await loadIndex();
  const entry = index.analyses[projectPath];
  if (!entry) return null;

  const storagePath = getStoragePath();
  const filePath = path.join(storagePath, entry.file);
  if (!(await fs.pathExists(filePath))) return null;

  return fs.readJson(filePath);
}

export async function listAnalyses(): Promise<AnalysisEntry[]> {
  const index = await loadIndex();
  return Object.values(index.analyses);
}

export async function getAnalysisEntry(projectPath: string): Promise<AnalysisEntry | null> {
  const index = await loadIndex();
  return index.analyses[projectPath] || null;
}
