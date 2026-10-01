import { AssetEditRepository } from './asset-edit.repository';

export async function syncEdits(assetEditRepository, assetId) {
  await assetEditRepository.replaceAll(assetId);
}

export class EditService {
  constructor(private readonly repository: AssetEditRepository) {}

  async reset(assetId: string) {
    await this.repository.replaceAll(assetId);
  }
}
