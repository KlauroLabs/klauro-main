export interface CASFirstPartyProductEvidenceValue {
  value: string;
  source: string;
}

export interface CASFirstPartyProductStatement extends CASFirstPartyProductEvidenceValue {
  role: 'overview' | 'feature' | 'context' | 'example';
}

export interface CASFirstPartyProductEvidence {
  title?: CASFirstPartyProductEvidenceValue;
  overview?: CASFirstPartyProductEvidenceValue;
  manifest_description?: CASFirstPartyProductEvidenceValue;
  statements?: CASFirstPartyProductStatement[];
}
