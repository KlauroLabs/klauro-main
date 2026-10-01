import * as fs from 'node:fs/promises';

export class AssetEditRepository {
  async replaceAll(assetId: string): Promise<void> {
    await fs.unlink(assetId);
  }
}
