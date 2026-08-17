import type { CASContribution } from '../../types/cas.types';

export function fileNodeIdFromExistingAnalysis(
  relativePath: string,
  existingAnalysis?: CASContribution[]
): string | undefined {
  if (!existingAnalysis) return undefined;
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const exactId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
  for (const contribution of existingAnalysis) {
    if (contribution.nodes?.some(node => node.id === exactId)) return exactId;
  }
  for (const contribution of existingAnalysis) {
    const byPath = contribution.nodes?.find(node => {
      if (node.type !== 'file' || !node.source?.file) return false;
      const sourceFile = node.source.file.replace(/\\/g, '/');
      return sourceFile === normalizedRelativePath || sourceFile.endsWith(`/${normalizedRelativePath}`);
    });
    if (byPath) return byPath.id;
  }
  return undefined;
}
