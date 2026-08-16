import type { CASFirstPartyProductEvidence } from '../../types/cas.types';

export interface FirstPartyProductSignal {
  manifestDescription?: string;
  productDocTitle?: string;
  productDocSummary?: string;
  productDocSource?: string;
}

export function buildFirstPartyProductEvidence(
  signal: FirstPartyProductSignal,
): CASFirstPartyProductEvidence | undefined {
  const title = String(signal.productDocTitle || '').trim().slice(0, 120);
  const overview = String(signal.productDocSummary || '').trim().slice(0, 400);
  const manifestDescription = String(signal.manifestDescription || '').trim().slice(0, 400);
  const documentSource = String(signal.productDocSource || '').trim();
  const evidence: CASFirstPartyProductEvidence = {};

  if (title && documentSource) evidence.title = { value: title, source: documentSource };
  if (overview && documentSource) evidence.overview = { value: overview, source: documentSource };
  if (manifestDescription) {
    evidence.manifest_description = { value: manifestDescription, source: 'package.json' };
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined;
}
