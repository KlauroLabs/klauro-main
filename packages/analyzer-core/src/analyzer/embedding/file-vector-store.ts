import * as fs from 'fs-extra';
import * as path from 'path';
import type {
  VectorStore,
  NodeEmbeddingRecord,
  VectorStoreMeta,
  VectorQueryFilter,
  ScoredNodeId,
  VectorStoreStats,
} from './types';

interface ManifestNodeEntry {
  nodeId: string;
  row: number;
  embeddingDocHash: string;
  scale: number;
  type?: string;
  file?: string;
}

interface FileVectorManifest {
  model: string;
  dimensions: number;
  documentVersion: string;
  meta: VectorStoreMeta | null;
  nodes: ManifestNodeEntry[];
}

interface LoadedIndex {
  manifest: FileVectorManifest;
  matrix: Int8Array;
}

function emptyManifest(): FileVectorManifest {
  return {
    model: '',
    dimensions: 0,
    documentVersion: '',
    meta: null,
    nodes: [],
  };
}

export class FileVectorStore implements VectorStore {
  readonly kind = 'file' as const;

  private readonly embeddingsDir: string;
  private readonly indexPath: string;
  private readonly manifestPath: string;

  constructor(baseDir: string) {
    this.embeddingsDir = path.join(baseDir, 'embeddings');
    this.indexPath = path.join(this.embeddingsDir, 'index.bin');
    this.manifestPath = path.join(this.embeddingsDir, 'manifest.json');
  }

  async upsert(analysisId: string, records: NodeEmbeddingRecord[]): Promise<void> {
    if (records.length === 0) return;

    const loaded = await this.load();
    const manifest = loaded.manifest;
    const dimensions = records[0].vector.length;

    if (manifest.dimensions === 0) {
      manifest.dimensions = dimensions;
      manifest.model = records[0].model;
      manifest.documentVersion = records[0].documentVersion;
    }

    const rowsByNode = new Map<string, ManifestNodeEntry>();
    for (const entry of manifest.nodes) {
      rowsByNode.set(entry.nodeId, entry);
    }

    const existingRows: Int8Array[] = [];
    for (let row = 0; row < manifest.nodes.length; row += 1) {
      existingRows.push(
        loaded.matrix.subarray(row * manifest.dimensions, (row + 1) * manifest.dimensions),
      );
    }

    const orderedNodes: ManifestNodeEntry[] = [...manifest.nodes];
    const orderedRows: Int8Array[] = existingRows;

    for (const record of records) {
      if (record.vector.length !== manifest.dimensions) {
        throw new Error(
          `FileVectorStore dimension mismatch: expected ${manifest.dimensions}, got ${record.vector.length} for node ${record.nodeId}`,
        );
      }
      const quantized = this.quantize(record.vector);
      const existing = rowsByNode.get(record.nodeId);
      const entry: ManifestNodeEntry = {
        nodeId: record.nodeId,
        row: existing ? existing.row : orderedNodes.length,
        embeddingDocHash: record.embeddingDocHash,
        scale: quantized.scale,
      };
      if (existing) {
        orderedNodes[existing.row] = entry;
        orderedRows[existing.row] = quantized.int8;
        rowsByNode.set(record.nodeId, entry);
      } else {
        entry.row = orderedNodes.length;
        orderedNodes.push(entry);
        orderedRows.push(quantized.int8);
        rowsByNode.set(record.nodeId, entry);
      }
    }

    manifest.nodes = orderedNodes;
    manifest.model = records[0].model;
    manifest.documentVersion = records[0].documentVersion;

    await this.persist(manifest, orderedRows);
  }

  async deleteNodes(analysisId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    const loaded = await this.load();
    const manifest = loaded.manifest;
    if (manifest.nodes.length === 0) return;

    const toDelete = new Set(nodeIds);
    const survivors = manifest.nodes.filter((entry) => !toDelete.has(entry.nodeId));
    if (survivors.length === manifest.nodes.length) return;

    const rows: Int8Array[] = [];
    survivors.forEach((entry, index) => {
      const originalRow = entry.row;
      rows.push(
        loaded.matrix.slice(
          originalRow * manifest.dimensions,
          (originalRow + 1) * manifest.dimensions,
        ),
      );
      entry.row = index;
    });

    manifest.nodes = survivors;
    if (survivors.length === 0) {
      manifest.dimensions = 0;
      manifest.model = '';
      manifest.documentVersion = '';
    }

    await this.persist(manifest, rows);
  }

  async deleteAnalysis(analysisId: string): Promise<void> {
    await fs.remove(this.embeddingsDir);
  }

  async query(
    analysisId: string,
    vector: Float32Array,
    topK: number,
    filter?: VectorQueryFilter,
  ): Promise<ScoredNodeId[]> {
    const loaded = await this.load();
    const manifest = loaded.manifest;
    if (manifest.nodes.length === 0 || topK <= 0) return [];
    if (vector.length !== manifest.dimensions) {
      throw new Error(
        `FileVectorStore query dimension mismatch: expected ${manifest.dimensions}, got ${vector.length}`,
      );
    }

    const queryNorm = this.norm(vector);
    if (queryNorm === 0) return [];

    const candidates = this.applyFilter(manifest.nodes, filter);

    const scored: ScoredNodeId[] = [];
    for (const entry of candidates) {
      const dequantized = this.dequantize(loaded.matrix, entry.row, manifest.dimensions, entry.scale);
      const candidateNorm = this.norm(dequantized);
      if (candidateNorm === 0) continue;
      let dot = 0;
      for (let i = 0; i < manifest.dimensions; i += 1) {
        dot += vector[i] * dequantized[i];
      }
      scored.push({ nodeId: entry.nodeId, score: dot / (queryNorm * candidateNorm) });
    }

    scored.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
    return scored.slice(0, topK);
  }

  async listHashes(analysisId: string): Promise<Map<string, string>> {
    const manifest = await this.loadManifest();
    const hashes = new Map<string, string>();
    for (const entry of manifest.nodes) {
      hashes.set(entry.nodeId, entry.embeddingDocHash);
    }
    return hashes;
  }

  async getMeta(analysisId: string): Promise<VectorStoreMeta | null> {
    const manifest = await this.loadManifest();
    return manifest.meta;
  }

  async putMeta(analysisId: string, meta: VectorStoreMeta): Promise<void> {
    const manifest = await this.loadManifest();
    manifest.meta = meta;
    await this.persistManifest(manifest);
  }

  async stats(analysisId: string): Promise<VectorStoreStats> {
    const manifest = await this.loadManifest();
    return {
      count: manifest.nodes.length,
      model: manifest.model,
      dimensions: manifest.dimensions,
    };
  }

  private applyFilter(
    nodes: ManifestNodeEntry[],
    filter?: VectorQueryFilter,
  ): ManifestNodeEntry[] {
    if (!filter || (!filter.types && !filter.files)) return nodes;
    const hasFilterableData = nodes.some(
      (entry) => entry.type !== undefined || entry.file !== undefined,
    );
    if (!hasFilterableData) return nodes;

    const typeSet = filter.types ? new Set(filter.types) : null;
    const fileSet = filter.files ? new Set(filter.files) : null;
    return nodes.filter((entry) => {
      if (typeSet && entry.type !== undefined && !typeSet.has(entry.type)) return false;
      if (fileSet && entry.file !== undefined && !fileSet.has(entry.file)) return false;
      return true;
    });
  }

  private quantize(vector: Float32Array): { int8: Int8Array; scale: number } {
    let maxAbs = 0;
    for (let i = 0; i < vector.length; i += 1) {
      const abs = Math.abs(vector[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    const int8 = new Int8Array(vector.length);
    if (maxAbs === 0) {
      return { int8, scale: 0 };
    }
    for (let i = 0; i < vector.length; i += 1) {
      const q = Math.round((vector[i] / maxAbs) * 127);
      int8[i] = q > 127 ? 127 : q < -127 ? -127 : q;
    }
    return { int8, scale: maxAbs };
  }

  private dequantize(
    matrix: Int8Array,
    row: number,
    dimensions: number,
    scale: number,
  ): Float32Array {
    const out = new Float32Array(dimensions);
    const offset = row * dimensions;
    for (let i = 0; i < dimensions; i += 1) {
      out[i] = (matrix[offset + i] / 127) * scale;
    }
    return out;
  }

  private norm(vector: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < vector.length; i += 1) {
      sum += vector[i] * vector[i];
    }
    return Math.sqrt(sum);
  }

  private async load(): Promise<LoadedIndex> {
    const manifest = await this.loadManifest();
    if (manifest.nodes.length === 0) {
      return { manifest, matrix: new Int8Array(0) };
    }
    const indexExists = await fs.pathExists(this.indexPath);
    if (!indexExists) {
      return { manifest, matrix: new Int8Array(0) };
    }
    const buffer = await fs.readFile(this.indexPath);
    const matrix = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return { manifest, matrix };
  }

  private async loadManifest(): Promise<FileVectorManifest> {
    const manifestExists = await fs.pathExists(this.manifestPath);
    if (!manifestExists) {
      return emptyManifest();
    }
    return fs.readJson(this.manifestPath);
  }

  private async persist(manifest: FileVectorManifest, rows: Int8Array[]): Promise<void> {
    await fs.ensureDir(this.embeddingsDir);

    const total = rows.length * manifest.dimensions;
    const matrix = new Int8Array(total);
    rows.forEach((row, index) => {
      matrix.set(row, index * manifest.dimensions);
    });

    const tmpIndex = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    const tmpManifest = `${this.manifestPath}.${process.pid}.${Date.now()}.tmp`;

    await fs.writeFile(tmpIndex, Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength));
    await fs.writeJson(tmpManifest, manifest, { spaces: 2 });

    await fs.move(tmpIndex, this.indexPath, { overwrite: true });
    await fs.move(tmpManifest, this.manifestPath, { overwrite: true });
  }

  private async persistManifest(manifest: FileVectorManifest): Promise<void> {
    await fs.ensureDir(this.embeddingsDir);
    const tmpManifest = `${this.manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeJson(tmpManifest, manifest, { spaces: 2 });
    await fs.move(tmpManifest, this.manifestPath, { overwrite: true });
  }
}
