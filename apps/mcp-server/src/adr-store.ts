/**
 * Architecture Decision Records — persisted across sessions, structural parity
 * with codebase-memory's `manage_adr`. ADRs live alongside the analysis in the
 * project storage dir, so a decision recorded in one agent session is available
 * in the next. Klauro can additionally CHECK decisions against the live CAS
 * (does the code still follow the decision?) — comprehension a flat record store
 * has no concept of.
 */
import * as path from 'path';
import * as fs from 'fs-extra';
import { getProjectStorageDir, writeJsonAtomic } from './storage';

export type ADRStatus = 'proposed' | 'accepted' | 'deprecated' | 'superseded';

export interface ADR {
  id: string;
  title: string;
  status: ADRStatus;
  context?: string;
  decision: string;
  consequences?: string;
  date: string; // ISO 8601
  supersedes?: string;
}

function adrPath(projectPath: string): string {
  return path.join(getProjectStorageDir(projectPath), 'adrs.json');
}

export async function getAdrs(projectPath: string): Promise<{ total: number; adrs: ADR[] }> {
  try {
    const adrs: ADR[] = await fs.readJson(adrPath(projectPath));
    return { total: adrs.length, adrs };
  } catch {
    return { total: 0, adrs: [] };
  }
}

export interface SaveAdrInput {
  id?: string;
  title: string;
  decision: string;
  status?: ADRStatus;
  context?: string;
  consequences?: string;
  date?: string;
  supersedes?: string;
}

/** Create or update an ADR. New ADRs get a sequential id (adr-0001, …). */
export async function saveAdr(projectPath: string, input: SaveAdrInput): Promise<ADR> {
  const { adrs } = await getAdrs(projectPath);
  const id = input.id || `adr-${String(adrs.length + 1).padStart(4, '0')}`;
  const record: ADR = {
    id,
    title: input.title,
    status: input.status || 'accepted',
    context: input.context,
    decision: input.decision,
    consequences: input.consequences,
    date: input.date || new Date().toISOString(),
    supersedes: input.supersedes,
  };
  // If this supersedes another, mark that one superseded.
  if (record.supersedes) {
    const prev = adrs.find(a => a.id === record.supersedes);
    if (prev) prev.status = 'superseded';
  }
  const idx = adrs.findIndex(a => a.id === id);
  if (idx >= 0) adrs[idx] = record;
  else adrs.push(record);
  await writeJsonAtomic(adrPath(projectPath), adrs);
  return record;
}
