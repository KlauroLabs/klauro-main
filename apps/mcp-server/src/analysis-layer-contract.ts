export const STRUCTURAL_ANALYSIS_LAYERS = ['L0', 'L1', 'L2', 'L3'] as const;

const structuralAnalysisLayers = new Set<string>(STRUCTURAL_ANALYSIS_LAYERS);

export function isStructuralAnalysisLayer(layer: string): boolean {
  return structuralAnalysisLayers.has(layer);
}
