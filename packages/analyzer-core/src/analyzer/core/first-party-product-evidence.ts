import type { CASFirstPartyProductEvidence } from '../../types/cas.types';
import type { ProductDocumentStatement } from './product-document-framing';

export interface FirstPartyProductSignal {
  manifestDescription?: string;
  productDocTitle?: string;
  productDocSummary?: string;
  productDocStatements?: ProductDocumentStatement[];
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
  if (signal.productDocStatements?.length && documentSource) {
    evidence.statements = signal.productDocStatements.map(statement => ({ ...statement, source: documentSource }));
  }
  if (manifestDescription) {
    evidence.manifest_description = { value: manifestDescription, source: 'package.json' };
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

export function firstPartyProductEvidenceRefreshDecision(
  previous: CASFirstPartyProductEvidence | undefined,
  current: CASFirstPartyProductEvidence | undefined,
): { refresh: true; reason: string } | undefined {
  const identity = (evidence: CASFirstPartyProductEvidence | undefined) => JSON.stringify({
    title: evidence?.title && [evidence.title.source, evidence.title.value],
    overview: evidence?.overview && [evidence.overview.source, evidence.overview.value],
    manifest_description: evidence?.manifest_description && [evidence.manifest_description.source, evidence.manifest_description.value],
    statements: (evidence?.statements || []).map(statement => [statement.role, statement.source, statement.value]),
  });
  return identity(previous) === identity(current)
    ? undefined
    : { refresh: true, reason: 'first-party-product-evidence-changed' };
}
