







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
  date: string;
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
