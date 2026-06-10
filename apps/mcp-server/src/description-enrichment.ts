import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import { getAIConfig } from '../../../packages/analyzer-core/src/config/ai.config';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import { getProjectStorageDir, loadAnalysis, saveAnalysis } from './storage';

export type DescriptionTargetKind = 'node' | 'service' | 'entity' | 'capability' | 'entry_point' | 'exit_point';

interface StoredDescription {
  key: string;
  target_kind: DescriptionTargetKind;
  target_id: string;
  target_name: string;
  description: string;
  generated_at: string;
  analysis_id: string;
  fingerprint: string;
  source: 'ai';
  invalidated_at?: string;
  invalidation_reason?: string;
}

interface DescriptionStore {
  version: string;
  project_path: string;
  updated_at: string;
  entries: Record<string, StoredDescription>;
}

interface ResolvedTarget {
  kind: DescriptionTargetKind;
  id: string;
  name: string;
  target: any;
  file?: string;
  line?: number;
  fingerprint: string;
  context: Record<string, unknown>;
}

export async function generateElementDescription(input: {
  projectPath: string;
  target: string;
  targetKind?: DescriptionTargetKind;
  instructions?: string;
}): Promise<{
  status: 'success';
  target: Omit<ResolvedTarget, 'target' | 'fingerprint' | 'context'>;
  description: string;
  generated_at: string;
  stored: boolean;
}> {
  if (!hasAIProviderConfigured()) {
    throw new Error('AI descriptions require OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_BASE_URL/LOCAL_OPENAI_BASE_URL, OLLAMA_BASE_URL, or AI_LOCAL_ENABLED=true.');
  }

  const cas = await loadAnalysis(input.projectPath);
  if (!cas) throw new Error(`No analysis found for: ${input.projectPath}. Run analyze_codebase first.`);

  const resolved = await resolveTarget(input.projectPath, cas, input.target, input.targetKind);
  if (!resolved) {
    throw new Error(`Could not find ${input.targetKind || 'analysis element'} matching: ${input.target}`);
  }

  const generated = await generateUsefulDescription(cas, resolved, input.instructions);
  const { description } = generated;

  const generatedAt = new Date().toISOString();
  const key = descriptionKey(resolved.kind, resolved.id);
  const store = await loadDescriptionStore(input.projectPath);
  store.entries[key] = {
    key,
    target_kind: resolved.kind,
    target_id: resolved.id,
    target_name: resolved.name,
    description,
    generated_at: generatedAt,
    analysis_id: cas.analysis_id,
    fingerprint: resolved.fingerprint,
    source: 'ai',
  };
  store.updated_at = generatedAt;
  await saveDescriptionStore(input.projectPath, store);

  applyDescriptionToTarget(resolved.target, description, generatedAt, generated.attempts > 1 ? 'manual-trigger-repaired' : 'manual-trigger');
  await saveAnalysis(input.projectPath, cas);

  return {
    status: 'success',
    target: {
      kind: resolved.kind,
      id: resolved.id,
      name: resolved.name,
      file: resolved.file,
      line: resolved.line,
    },
    description,
    generated_at: generatedAt,
    stored: true,
  };
}

async function generateUsefulDescription(
  cas: CASOutput,
  resolved: ResolvedTarget,
  instructions?: string,
): Promise<{ description: string; attempts: number }> {
  const firstRaw = await aiService.generateComponentDescription({
    additionalContext: descriptionPromptContext(cas, resolved, instructions),
  });

  const firstDescription = cleanDescription(firstRaw);
  const firstValidation = validateDescription(firstDescription, resolved);
  if (firstValidation.ok) return { description: firstDescription, attempts: 1 };

  const repairRaw = await aiService.generateComponentDescription({
    additionalContext: descriptionPromptContext(cas, resolved, instructions, {
      rejected_description: firstDescription,
      rejection_reason: firstValidation.reason,
    }),
  });

  const repairedDescription = cleanDescription(repairRaw);
  const repairedValidation = validateDescription(repairedDescription, resolved);
  if (repairedValidation.ok) return { description: repairedDescription, attempts: 2 };

  throw new Error(`AI generated a low-quality or ungrounded description (${repairedValidation.reason}); no description was stored. Rejected text: "${repairedDescription.slice(0, 220)}"`);
}

function descriptionPromptContext(
  cas: CASOutput,
  resolved: ResolvedTarget,
  instructions?: string,
  repair?: { rejected_description: string; rejection_reason?: string },
): Record<string, unknown> {
  return {
    task: repair
      ? 'Rewrite the rejected description for this exact codebase element. Use only facts present in the target and system context. Return one grounded sentence about its product responsibility.'
      : 'Describe this exact codebase element in one or two useful sentences. Be specific about its product responsibility and role in this codebase. Do not invent behavior outside the provided CAS facts.',
    style: 'No markdown. No generic or promotional phrases like "plays a crucial role", "robust", "various", "efficient", "compliant", "productivity", "business value", "streamline", "functionality", or "operations for". Never cite graph statistics, endpoint counts, parent signals, entry-point mechanics, or analyzer internals; translate them into what the element lets a user, operator, or engineer do. Do not mention outcomes, compliance, security, scale, cost, or user experience unless the provided facts explicitly say so.',
    instructions,
    repair,
    system: {
      name: cas.system?.name,
      description: cas.enhanced_system_purpose?.inferred_description || cas.system?.description,
      domain: cas.enhanced_system_purpose?.primary_domain,
      concepts: cas.enhanced_system_purpose?.core_concepts || [],
    },
    target: resolved.context,
  };
}

export async function getElementDescription(input: {
  projectPath: string;
  target: string;
  targetKind?: DescriptionTargetKind;
}): Promise<{
  status: 'valid' | 'missing' | 'invalidated';
  target?: Omit<ResolvedTarget, 'target' | 'fingerprint' | 'context'>;
  description?: string;
  generated_at?: string;
  invalidated_at?: string;
  invalidation_reason?: string;
}> {
  const cas = await loadAnalysis(input.projectPath);
  if (!cas) throw new Error(`No analysis found for: ${input.projectPath}. Run analyze_codebase first.`);
  const resolved = await resolveTarget(input.projectPath, cas, input.target, input.targetKind);
  if (!resolved) return { status: 'missing' };
  const store = await loadDescriptionStore(input.projectPath);
  const stored = store.entries[descriptionKey(resolved.kind, resolved.id)];
  if (!stored) return { status: 'missing', target: publicTarget(resolved) };
  if (stored.fingerprint !== resolved.fingerprint || stored.invalidated_at) {
    return {
      status: 'invalidated',
      target: publicTarget(resolved),
      description: stored.description,
      generated_at: stored.generated_at,
      invalidated_at: stored.invalidated_at,
      invalidation_reason: stored.invalidation_reason || 'target-fingerprint-changed',
    };
  }
  return {
    status: 'valid',
    target: publicTarget(resolved),
    description: stored.description,
    generated_at: stored.generated_at,
  };
}

export async function applyStoredElementDescriptions(projectPath: string, cas: CASOutput): Promise<CASOutput> {
  const store = await loadDescriptionStore(projectPath);
  const keys = Object.keys(store.entries);
  if (keys.length === 0) return cas;

  let changed = false;
  for (const key of keys) {
    const entry = store.entries[key];
    const resolved = await resolveTarget(projectPath, cas, entry.target_id, entry.target_kind);
    if (!resolved || resolved.fingerprint !== entry.fingerprint) {
      if (!entry.invalidated_at) {
        entry.invalidated_at = new Date().toISOString();
        entry.invalidation_reason = !resolved ? 'target-not-found' : 'target-fingerprint-changed';
        changed = true;
      }
      continue;
    }
    applyDescriptionToTarget(resolved.target, entry.description, entry.generated_at, 'stored-manual-description');
  }

  if (changed) await saveDescriptionStore(projectPath, store);
  return cas;
}

function hasAIProviderConfigured(): boolean {
  const config = getAIConfig();
  return Boolean(config.openai.apiKey || config.anthropic.apiKey || process.env.AI_LOCAL_ENABLED === 'true');
}

async function resolveTarget(
  projectPath: string,
  cas: CASOutput,
  target: string,
  targetKind?: DescriptionTargetKind,
): Promise<ResolvedTarget | null> {
  const candidateKinds: DescriptionTargetKind[] = targetKind
    ? [targetKind]
    : ['node', 'entity', 'capability', 'entry_point', 'exit_point'];
  for (const kind of candidateKinds) {
    const resolved = await resolveTargetByKind(projectPath, cas, target, kind);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveTargetByKind(projectPath: string, cas: CASOutput, target: string, kind: DescriptionTargetKind): Promise<ResolvedTarget | null> {
  const lower = target.toLowerCase();
  const matches = (value?: string) => value?.toLowerCase() === lower || value?.toLowerCase().includes(lower);
  if (kind === 'node' || kind === 'service') {
    const node = cas.nodes.find(n => (kind !== 'service' || n.type === 'service') && (n.id === target || matches(n.name) || matches(n.qualified_name)));
    return node ? buildNodeTarget(projectPath, cas, node, kind === 'service' ? 'service' : 'node') : null;
  }
  if (kind === 'entity') {
    const entity = (cas.data_entities || []).find(e => e.id === target || matches(e.name));
    return entity ? buildGenericTarget(projectPath, 'entity', entity.id, entity.name, entity, entity.schema_source) : null;
  }
  if (kind === 'capability') {
    const capability = (cas.system_capabilities || []).find(c => c.id === target || matches(c.name));
    return capability ? buildGenericTarget(projectPath, 'capability', capability.id, capability.name, capability) : null;
  }
  if (kind === 'entry_point') {
    const entryPoint = (cas.entry_points || []).find(ep => ep.id === target || matches(ep.name) || matches(ep.trigger?.path));
    return entryPoint ? buildGenericTarget(projectPath, 'entry_point', entryPoint.id, entryPoint.name, entryPoint, entryPoint.handler?.file) : null;
  }
  const exitPoint = (cas.exit_points || []).find(ep => ep.id === target || matches(ep.name));
  return exitPoint ? buildGenericTarget(projectPath, 'exit_point', exitPoint.id, exitPoint.name, exitPoint, undefined) : null;
}

async function buildNodeTarget(projectPath: string, cas: CASOutput, node: CASNode, kind: DescriptionTargetKind): Promise<ResolvedTarget> {
  const incoming = cas.edges.filter(edge => edge.target === node.id).slice(0, 8);
  const outgoing = cas.edges.filter(edge => edge.source === node.id).slice(0, 8);
  const sourceExcerpt = await readSourceExcerpt(projectPath, node.source?.file, node.source?.line);
  const context = {
    kind,
    id: node.id,
    name: node.name,
    type: node.type,
    qualified_name: node.qualified_name,
    file: node.source?.file,
    line: node.source?.line,
    current_description: node.description,
    source_excerpt: sourceExcerpt,
    incoming: incoming.map(edge => ({ type: edge.type, source: nodeName(cas, edge.source) })),
    outgoing: outgoing.map(edge => ({ type: edge.type, target: nodeName(cas, edge.target) })),
  };
  return {
    kind,
    id: node.id,
    name: node.name,
    target: node,
    file: node.source?.file,
    line: node.source?.line,
    fingerprint: await fingerprintTarget(projectPath, context, node.source?.file),
    context,
  };
}

async function buildGenericTarget(
  projectPath: string,
  kind: DescriptionTargetKind,
  id: string,
  name: string,
  target: any,
  file?: string,
): Promise<ResolvedTarget> {
  const sourceExcerpt = await readSourceExcerpt(projectPath, file, target.source?.line || target.handler?.line);
  const context = {
    kind,
    id,
    name,
    file,
    source_excerpt: sourceExcerpt,
    facts: promptFacts(kind, target),
  };
  return {
    kind,
    id,
    name,
    target,
    file,
    line: target.source?.line || target.handler?.line,
    fingerprint: await fingerprintTarget(projectPath, context, file),
    context,
  };
}

function promptFacts(kind: DescriptionTargetKind, target: any): Record<string, unknown> {
  if (kind === 'capability') {
    return {
      category: target.category,
      criticality: target.criticality,
      operations: (target.operations || []).slice(0, 10).map((operation: any) =>
        [operation.action, operation.path_or_command].filter(Boolean).join(' ')),
      related_entities: target.related_entities,
      related_domains: target.related_domains,
    };
  }
  if (kind === 'entity') {
    return {
      fields: (target.fields || []).slice(0, 15).map((field: any) => field.name),
      relationships: (target.relationships || []).slice(0, 10),
      schema_source: target.schema_source,
    };
  }
  return target;
}

async function readSourceExcerpt(projectPath: string, file?: string, line?: number): Promise<string | undefined> {
  if (!file) return undefined;
  const absolute = path.isAbsolute(file) ? file : path.join(projectPath, file);
  const source = await fs.readFile(absolute, 'utf8').catch(() => undefined);
  if (!source) return undefined;

  const lines = source.split(/\r?\n/);
  if (!line || line < 1) return lines.slice(0, 80).join('\n').slice(0, 6000);

  const start = Math.max(0, line - 20);
  const end = Math.min(lines.length, line + 80);
  return lines.slice(start, end).join('\n').slice(0, 6000);
}

async function fingerprintTarget(projectPath: string, context: Record<string, unknown>, file?: string): Promise<string> {
  let fileStats: Record<string, unknown> | undefined;
  if (file) {
    const absolute = path.isAbsolute(file) ? file : path.join(projectPath, file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat?.isFile()) {
      fileStats = {
        file: path.relative(projectPath, absolute),
        size: stat.size,
        mtime_ms: Math.floor(stat.mtimeMs),
      };
    }
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify({ context: stableFingerprintValue(context), fileStats }))
    .digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined && typeof child !== 'function')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  const volatileKeys = new Set(['description', 'current_description', 'description_source', 'description_generation']);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, child]) => !volatileKeys.has(key) && child !== undefined && typeof child !== 'function')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableFingerprintValue(child)])
  );
}

function nodeName(cas: CASOutput, id: string): string {
  const node = cas.nodes.find(candidate => candidate.id === id);
  return node ? `${node.name} (${node.type})` : id;
}

function cleanDescription(raw: string): string {
  return raw
    .replace(/^```(?:text|markdown)?/i, '')
    .replace(/```$/i, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/`/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

function validateDescription(description: string, target: ResolvedTarget): { ok: boolean; reason?: string } {
  if (description.length < 35) return { ok: false, reason: 'too-short' };
  if (description.length > 800) return { ok: false, reason: 'too-long' };
  if (description.includes('**') || description.includes('`') || /^#+\s/.test(description)) return { ok: false, reason: 'markdown-formatting' };
  const lower = description.toLowerCase();
  const nameTokens = target.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2);
  const marketingTerms = ungroundedMarketingTerms(description, nameTokens);
  if (marketingTerms.length > 0) {
    return { ok: false, reason: `unsupported-marketing-language: ${marketingTerms.join(', ')}` };
  }
  if (/\b(graph endpoints?|parent signals?|internal entry points?|graph structure|entry[- ]point mechanics|associated (?:graph )?endpoints?|(?:read|update|coordinate|process|analyze|delete)(?:,? (?:and )?(?:read|update|coordinate|process|analyze|delete))+ (?:actions|operations|paths)|operations for|centers on)\b/i.test(description)) {
    return { ok: false, reason: 'structural-parser-language-instead-of-product-behavior' };
  }
  if (nameTokens.length > 0 && !nameTokens.some(token => lower.includes(token))) {
    return { ok: false, reason: 'target-name-not-referenced' };
  }
  return { ok: true };
}

function isUsefulDescription(description: string, target: ResolvedTarget): boolean {
  return validateDescription(description, target).ok;
}

function ungroundedMarketingTerms(description: string, groundedTokens: string[]): string[] {
  const pattern = /\b(plays a crucial role|plays a key role|robust|various|operations for|functionality|seamless(?:ly)?|comprehensive|efficient(?:ly)?|efficiency|productivity|compliant|compliance|advanced|streamline(?:s|d|ing)?|user-friendly|business value|improving operational|enhances?|reduces? costs?|best practices|scalable|secure by design)\b/gi;
  const matches = Array.from(new Set((description.match(pattern) || []).map(match => match.toLowerCase().trim())));
  if (matches.length === 0) return [];
  const groundedStems = new Set(groundedTokens.filter(token => token.length >= 4).map(token => token.slice(0, 8)));
  return matches.filter(match => {
    const tokens = match.split(/\s+/);
    if (tokens.length > 1) return true;
    return !groundedStems.has(tokens[0].slice(0, 8));
  });
}

function applyDescriptionToTarget(target: any, description: string, generatedAt: string, reason: string): void {
  target.description = description;
  target.description_source = 'ai';
  target.description_generation = {
    status: 'ai_applied',
    attempted: true,
    reason,
    generated_at: generatedAt,
  };
}

function descriptionKey(kind: DescriptionTargetKind, id: string): string {
  return `${kind}:${id}`;
}

function publicTarget(resolved: ResolvedTarget) {
  return {
    kind: resolved.kind,
    id: resolved.id,
    name: resolved.name,
    file: resolved.file,
    line: resolved.line,
  };
}

async function loadDescriptionStore(projectPath: string): Promise<DescriptionStore> {
  const file = descriptionStorePath(projectPath);
  if (await fs.pathExists(file)) return fs.readJson(file);
  return {
    version: '1.0.0',
    project_path: projectPath,
    updated_at: new Date(0).toISOString(),
    entries: {},
  };
}

async function saveDescriptionStore(projectPath: string, store: DescriptionStore): Promise<void> {
  const file = descriptionStorePath(projectPath);
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, store, { spaces: 2 });
}

function descriptionStorePath(projectPath: string): string {
  return path.join(getProjectStorageDir(projectPath), 'element-descriptions.json');
}
