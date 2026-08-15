import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSourceSnapshot, buildWorkingTreeChangeContext } from '../remote-source';
import { workspaceNarrativeMisattributionReason } from '../cross-codebase-analysis';
import type { CASOutput, CASNode } from '../../../../packages/analyzer-core/src/types/cas.types';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from '../remote-analyzer-protocol';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface EnterpriseSurfaceExpectation {
  name: string;
  required_tokens: string[];
}

export const ENTERPRISE_SURFACES: EnterpriseSurfaceExpectation[] = [
  { name: 'typescript-express-react-prisma', required_tokens: ['enterpriseTsHandler', '/ts/orders/:id', 'EnterpriseDashboard', '@prisma/client'] },
  { name: 'python-fastapi-sqlalchemy', required_tokens: ['enterprise_python_handler', '/python/orders/{order_id}', 'sqlalchemy'] },
  { name: 'java-spring', required_tokens: ['enterpriseJavaHandler', '/java/orders/{id}', 'spring-boot-starter-web'] },
  { name: 'csharp-aspnet', required_tokens: ['EnterpriseDotnetHandler', '/dotnet/orders/{id}', 'Microsoft.NET.Sdk.Web'] },
  { name: 'go-gin', required_tokens: ['enterpriseGoHandler', '/go/orders/:id', 'github.com/gin-gonic/gin'] },
  { name: 'rust-axum', required_tokens: ['enterprise_rust_handler', '/rust/orders/:id', 'axum'] },
  { name: 'php-laravel', required_tokens: ['EnterprisePhpHandler', '/php/orders/{id}', 'laravel/framework'] },
  { name: 'dart-flutter', required_tokens: ['EnterpriseFlutterDashboard', 'flutter'] },
  { name: 'shell-terraform-containers-kubernetes', required_tokens: ['deploy_enterprise_stack', 'enterprise_queue', 'EnterpriseQueue'] },
];

export interface LogicalCasProjection {
  content: Json;
}

export interface PhaseTiming {
  name: 'app-cold' | 'infra-cold' | 'unchanged-warm' | 'one-file-incremental' | 'dependency-invalidation' | 'workspace-analysis' | 'post-incremental-workspace';
  elapsed_ms: number;
  budget_ms: number;
  logical_hash?: string;
  nodes?: number;
  edges?: number;
}

export interface EnterpriseHostedParityReport {
  status: 'pass';
  server_url: string;
  generated_at: string;
  projects: { app: string; infra: string };
  workspace_id: string;
  surfaces_proven: string[];
  phases: PhaseTiming[];
  parity: {
    unchanged_warm_exact: true;
    one_file_unrelated_omissions: 0;
    dependency_unrelated_omissions: 0;
    dependency_call_recomputed: true;
  };
  cas_completeness: { app: true; infra: true; final_app: true };
  was_completeness: { exact_membership: true; codebase_count: number };
  semantic_quality: {
    artifact_identity_grounded: true;
    capability_catalog_grounded: true;
    workspace_narrative_ai_generated: true;
    workspace_domains_business_semantic: true;
  };
}

const VOLATILE_KEYS = new Set([
  'analysis_timestamp', 'analysis_id', 'generated_at', 'completed_at', 'started_at', 'finished_at',
  'duration_ms', 'timings', 'analysis_phases', 'description', 'description_generation',
  'description_source', 'description_fingerprint', 'ai_enrichment_error', 'last_attempt',
  'execution_time_ms', 'cache_status', 'ai_enrichment', 'layers_ready', 'analyzer_build',
  'parser_fingerprint', 'derived_fingerprint',
]);

function stable(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.map(stable).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === 'object') {
    const output: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      if (VOLATILE_KEYS.has(key) || child === undefined) continue;
      output[key] = stable(child);
    }
    return output;
  }
  return String(value);
}

function projectNode(node: CASNode): Json {
  return stable({
    id: node.id,
    name: node.name,
    type: node.type,
    source: node.source,
    parent: node.parent,
    qualified_name: node.qualified_name,
    signature: node.signature,
    tags: node.tags,
  });
}

export function logicalCasProjection(cas: CASOutput): LogicalCasProjection {
  return { content: stable(cas) };
}

export function logicalCasHash(cas: CASOutput): string {
  return crypto.createHash('sha256').update(JSON.stringify(logicalCasProjection(cas))).digest('hex');
}

function normalizeFile(file: unknown): string {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function nodeRecord(node: CASNode): string {
  return JSON.stringify(projectNode(node));
}

export function unrelatedNodeOmissions(before: CASOutput, after: CASOutput, changedFiles: string[]): string[] {
  const changed = new Set(changedFiles.map(normalizeFile));
  const afterRecords = new Set((after.nodes || []).map(nodeRecord));
  return (before.nodes || [])
    .filter(node => !changed.has(normalizeFile(node.source?.file)))
    .map(nodeRecord)
    .filter(record => !afterRecords.has(record));
}

export function collectionOmissions(before: CASOutput, after: CASOutput): string[] {
  const ignored = new Set(['analysis_phases']);
  const afterRecord = after as unknown as Record<string, unknown>;
  return Object.entries(before as unknown as Record<string, unknown>)
    .filter(([key, value]) => !ignored.has(key) && Array.isArray(value))
    .flatMap(([key, value]) => {
      const beforeCount = (value as unknown[]).length;
      const afterValue = afterRecord[key];
      const afterCount = Array.isArray(afterValue) ? afterValue.length : 0;
      return afterCount < beforeCount ? [`${key}:${beforeCount}->${afterCount}`] : [];
    });
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertNoDuplicateIds(items: Array<{ id?: string }>, label: string): void {
  const ids = items.map(item => item.id).filter((id): id is string => Boolean(id));
  invariant(new Set(ids).size === ids.length, `${label} contains duplicate ids`);
}

function assertCompleteCas(cas: CASOutput, label: string): void {
  invariant(Array.isArray(cas.nodes) && cas.nodes.length > 0, `${label}: CAS has no nodes`);
  invariant(Array.isArray(cas.edges), `${label}: CAS has no edge collection`);
  invariant(cas.layers_ready?.complete === true, `${label}: layers_ready.complete is not true`);
  const badLayers = (cas.layers_ready?.layers || []).filter(layer => layer.status !== 'ready');
  invariant(badLayers.length === 0, `${label}: incomplete/error layers: ${badLayers.map(layer => `${layer.layer}:${layer.status}`).join(', ')}`);
  const fatalErrors = (cas.analysis_errors || []).filter(error => error.severity === 'error');
  invariant(fatalErrors.length === 0, `${label}: analyzer errors: ${fatalErrors.map(error => error.message).join('; ')}`);
  assertNoDuplicateIds(cas.nodes, `${label} nodes`);
  assertNoDuplicateIds(cas.edges, `${label} edges`);
  assertNoDuplicateIds(cas.entry_points || [], `${label} entry points`);
  assertNoDuplicateIds(cas.exit_points || [], `${label} exit points`);
  const integrity = cas.validation?.graph_integrity;
  if (integrity) {
    invariant(integrity.dangling_edges === 0, `${label}: ${integrity.dangling_edges} dangling edges`);
    const duplicates = integrity.duplicate_ids;
    invariant(!duplicates || Object.values(duplicates).every(count => count === 0), `${label}: validation reports duplicate ids`);
  }
}

function assertSurfaceTokens(cas: CASOutput, surfaces: EnterpriseSurfaceExpectation[], label: string): void {
  const searchable = JSON.stringify(logicalCasProjection(cas)).toLowerCase();
  for (const surface of surfaces) {
    for (const token of surface.required_tokens) {
      invariant(searchable.includes(token.toLowerCase()), `${label}: ${surface.name} omitted required logical token ${token}`);
    }
  }
}

function assertProjectSemanticQuality(appCas: CASOutput, infraCas: CASOutput): void {
  const appPurpose = appCas.enhanced_system_purpose;
  const infraPurpose = infraCas.enhanced_system_purpose;
  const isAiAuthored = (value: { description_source?: string; description_generation?: { origin_source?: string } } | undefined): boolean =>
    value?.description_source === 'ai'
      || (value?.description_source === 'reused' && value.description_generation?.origin_source === 'ai');
  invariant(appPurpose?.artifact_type === 'app', `app artifact type expected app, got ${appPurpose?.artifact_type || 'missing'}`);
  invariant(infraPurpose?.artifact_type === 'infrastructure', `infra artifact type expected infrastructure, got ${infraPurpose?.artifact_type || 'missing'}`);
  invariant(isAiAuthored(appPurpose), `app description must be AI authored, got ${appPurpose.description_source || 'missing'} (${appPurpose.description_generation?.origin_source || 'unknown origin'})`);
  invariant(isAiAuthored(infraPurpose), `infra description must be AI authored, got ${infraPurpose.description_source || 'missing'} (${infraPurpose.description_generation?.origin_source || 'unknown origin'})`);
  invariant(/order/.test(String(appPurpose.primary_domain || '')), `app primary domain must preserve its evidenced order semantics, got ${appPurpose.primary_domain || 'missing'}`);
  invariant(/infrastructure|deployment|platform/.test(String(infraPurpose.primary_domain || '')), `infra primary domain must preserve its infrastructure semantics, got ${infraPurpose.primary_domain || 'missing'}`);

  const appDescription = String(appPurpose.inferred_description || '').toLowerCase();
  const infraDescription = String(infraPurpose.inferred_description || '').toLowerCase();
  invariant(/order/.test(appDescription), `app description omitted its evidenced order-management purpose: ${appDescription}`);
  invariant(!/\bworkspace navigation\b|\bnavigate(?:s|d|ing)? workspaces?\b/.test(appDescription), `app description invented workspace navigation: ${appDescription}`);
  invariant(!/allowed list|allowed frameworks?|supplied facts?|descriptioncontract|terminaloutputs|distinctiveentities/.test(appDescription), `app description leaked prompt vocabulary: ${appDescription}`);
  invariant(!/\b(?:dat that|teh|tht)\b/.test(appDescription), `app description contains malformed prose: ${appDescription}`);
  invariant(!/\b(?:designed\s+to|to|and|or)\s+(?:and|or)\b|\bwithout\s+(?:it|them|this|that)\s*[.!?]|\b(?:it|the\s+(?:system|app|application|service))\s+also\s+(?:a|an|the)\b/.test(appDescription), `app description contains a malformed clause: ${appDescription}`);
  invariant(!/\bhttp requests?\b|\b(?:dedicated|specific|internal|route|request)?\s*handlers?\b/.test(appDescription), `app description leaked source implementation mechanics: ${appDescription}`);
  invariant(!/\bhandle(?:s|d|ing)?\s+(?:these\s+|incoming\s+)?requests?\b|\brouter\s+to\s+(?:direct|route)\b/.test(appDescription), `app description explains source mechanics instead of product behavior: ${appDescription}`);
  invariant(!/\b(?:utiliz(?:e|es|ing)|leverag(?:e|es|ing))\s+(?:frameworks?|libraries?)\b|\bframeworks?\s+(?:like|such as)\b|\bbuilt\s+using\s+(?:a\s+)?combination\s+of\s+frameworks?\b/.test(appDescription), `app description is a framework inventory instead of a product explanation: ${appDescription}`);
  invariant(!/\b(?:combination of technologies|multiple programming languages|multi-language (?:backend )?development|flexibility in how)\b/.test(appDescription), `app description contains implementation-stack filler: ${appDescription}`);
  invariant(!/\bread[- ]only (?:mode|surface)\b|\bfocus(?:es|ed|ing)? on presenting\b/.test(appDescription), `app description narrates analysis constraints instead of product behavior: ${appDescription}`);
  invariant(!/\s+[,.!?]/.test(appDescription), `app description contains malformed punctuation spacing: ${appDescription}`);
  invariant(!/\bgraph evidence\b/.test(appDescription), `app description contains analysis-product filler: ${appDescription}`);
  invariant(!/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(appDescription), `app description leaked an implementation identifier: ${appDescription}`);
  const provenShipUnits = (appCas.deployable_evidence || []).filter(item => item.tier === 1 && item.kind !== 'build-image' && !item.bundled_into);
  if (provenShipUnits.length === 0) {
    invariant(!/\bmultiple (?:separately )?deploy(?:able|ment) units?\b/.test(appDescription), `app description promoted deployable candidates to proven topology: ${appDescription}`);
  }
  invariant(/infrastructure|deployment|provision|resource|queue/.test(infraDescription), `infra description omitted its infrastructure purpose: ${infraDescription}`);
  invariant(!/deployment orders?|order management|process(?:es|ing)? orders?|customers?|business application|three independently deployable|three microservices?/.test(infraDescription), `infra description invented application semantics: ${infraDescription}`);
  invariant(!/\b(?:likely|possibly|perhaps|presumably|scripts?|source files?|streamlin\w*)\b/.test(infraDescription), `infra description contains hedging, source mechanics, or marketing filler: ${infraDescription}`);

  const primaryCapabilities = (appCas.capabilities || []).slice(0, 8);
  const appOperations = primaryCapabilities.flatMap(capability => capability.operations || []);
  const appHasRead = appOperations.some(operation => /^(?:view|read|list|get|show|access|analyze|review)$/i.test(operation.action || '') || /^(?:GET|HEAD|OPTIONS)$/i.test(operation.trigger?.method || ''));
  const appHasMutation = appOperations.some(operation => /^(?:create|update|delete|write|modify|submit|configure|manage|mutate)$/i.test(operation.action || '') || /^(?:POST|PUT|PATCH|DELETE)$/i.test(operation.trigger?.method || ''));
  const entryMethods = (appCas.entry_points || []).map(entry => String(entry.trigger?.method || '').toUpperCase()).filter(Boolean);
  const entrySurfaceIsReadOnly = entryMethods.length > 0 && entryMethods.every(method => ['GET', 'HEAD', 'OPTIONS'].includes(method));
  if ((appHasRead && !appHasMutation) || entrySurfaceIsReadOnly) {
    invariant(!/\b(?:creat(?:e|es|ing|ion)|updat(?:e|es|ing)|delet(?:e|es|ing|ion)|writ(?:e|es|ing)|modif(?:y|ies|ying|ication)|submits?|configur(?:e|es|ing|ation)|manag(?:e|es|ing|ement)|mutat(?:e|es|ing|ion))\b/i.test(appDescription), `read-only app description claims mutation: ${appDescription}`);
  }
  invariant(primaryCapabilities.length > 0, 'app CAS produced no primary capabilities');
  const springEntry = (appCas.entry_points || []).find(entry => entry.source_analyzer === 'spring-boot');
  invariant(springEntry?.handler?.file?.includes('java/src/main/java/proof/EnterpriseController.java'), `Spring entry point lost its source-file citation: ${JSON.stringify(springEntry?.handler)}`);
  for (const capability of primaryCapabilities) {
    const name = String(capability.name || '');
    const description = String(capability.description || '');
    invariant(isAiAuthored(capability), `capability ${name} must have an AI-authored description`);
    invariant(description.length >= 40, `capability ${name} has an unusably thin description: ${description}`);
    invariant(!/\bworkspace\b/i.test(name), `capability catalog invented an unsupported workspace capability: ${name}`);
    invariant(!/\bmetrics?\b|decision[- ]making|collaboration|tracking|monitoring|performance|comprehensive/i.test(description), `capability ${name} invented unsupported product behavior: ${description}`);
    const methods = (capability.operations || []).map(operation => String(operation.trigger?.method || '').toUpperCase()).filter(Boolean);
    if (methods.length > 0 && methods.every(method => ['GET', 'HEAD', 'OPTIONS'].includes(method))) {
      invariant(!/^(?:manage|create|update|delete|modify|write|submit|set|configure)\b/i.test(name), `read-only capability claims mutation: ${name}`);
      invariant(!/\b(?:manag(?:e|es|ing|ement)|creat(?:e|es|ing)|updat(?:e|es|ing)|delet(?:e|es|ing)|modif(?:y|ies|ying)|mutat(?:e|es|ing)|writ(?:e|es|ing)|submits?|configur(?:e|es|ing))\b/i.test(description), `read-only capability description claims mutation: ${description}`);
    }
    if (/^(?:view|access|list|read|show|retrieve)\b/i.test(name)) {
      invariant(!/\b(?:manag(?:e|es|ing|ement)|creat(?:e|es|ing)|updat(?:e|es|ing)|delet(?:e|es|ing)|modif(?:y|ies|ying)|mutat(?:e|es|ing)|writ(?:e|es|ing)|submits?|configur(?:e|es|ing))\b/i.test(description), `read-only capability description claims mutation: ${description}`);
    }
  }
  for (const capability of infraCas.capabilities || []) {
    invariant(!/\b(?:shell|script|command|handler|route)\b/i.test(capability.name), `infra capability exposes a mechanism instead of an operational responsibility: ${capability.name}`);
    invariant(!/\b(?:scripts?|source files?|streamlin\w*|likely|possibly)\b/i.test(String(capability.description || '')), `infra capability description contains mechanics or speculation: ${capability.description}`);
  }
  const invalidDomainPunctuation = (appCas.domain_concepts || []).map(concept => concept.name).filter(name => /[{}:\\]/.test(name));
  invariant(invalidDomainPunctuation.length === 0, `domain concepts contain parser artifacts: ${invalidDomainPunctuation.join(', ')}`);
  const coreTechnologyDomains = (appCas.domain_concepts || [])
    .filter(concept => concept.classification === 'core')
    .map(concept => concept.name)
    .filter(name => /^(?:dotnet|aspnet|mvc|sqlalchemy|microsoft|framework|schema|model|mapping)$/i.test(name));
  invariant(coreTechnologyDomains.length === 0, `domain concepts promoted technology vocabulary to core: ${coreTechnologyDomains.join(', ')}`);



  const primaryFlow = (appCas.flows || []).find(flow => flow.flow_id === appPurpose.primary_workflow_id);
  invariant(!/^(?:main|application|server|bootstrap)$/i.test(String(primaryFlow?.name || '')), `generic process bootstrap outranked the product workflow: ${primaryFlow?.name || 'missing'}`);
}

function assertWorkspaceSemanticQuality(workspace: any): void {
  invariant(workspace?.workspace_narrative?.source === 'ai', `WAS narrative must be AI generated, got ${workspace?.workspace_narrative?.source || 'missing'}`);
  const narrative = String(workspace.workspace_narrative.description || '');
  const narrativeWithoutProperNames = workspaceNarrativeWithoutMemberNames(workspace, narrative);
  invariant(narrative.length >= 100, `WAS narrative is too thin: ${narrative}`);
  invariant(/order/i.test(narrative), `WAS narrative omitted the order-management member: ${narrative}`);
  invariant(/infrastructure|deployment|queue|resource/i.test(narrative), `WAS narrative omitted the infrastructure member: ${narrative}`);
  invariant(!/account-project|\bprj[_-][a-z0-9_-]+|\bmain\.tf\b|\bdeploy\.sh\b/i.test(narrative), `WAS narrative leaked internal project ids or source files: ${narrative}`);
  invariant(!/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(narrative), `WAS narrative leaked an implementation identifier: ${narrative}`);
  invariant(!/\b(?:polyglot|multi[- ]language|language support|frameworks? and languages?|development needs|technology stack)\b/i.test(narrativeWithoutProperNames), `WAS narrative substitutes implementation diversity for product behavior: ${narrative}`);
  invariant(/\b(?:independent|separate|not connected)\b/i.test(narrative), `WAS narrative failed to state that unlinked members are independent: ${narrative}`);
  invariant(!/\b(?:manag(?:e|es|ing|ement)|process(?:es|ed|ing)?|handl(?:e|es|ed|ing))\s+(?:enterprise\s+)?orders?\b|\borders?\s+(?:management|processing|lifecycle)\b/i.test(`${narrative} ${workspace.workspace_narrative.product_value_summary || ''}`), `WAS narrative assigned mutation semantics to the read-only order surface: ${narrative}`);
  invariant(!workspaceNarrativeMisattributionReason(workspace, narrative), `WAS narrative misattributed member-owned facts: ${workspaceNarrativeMisattributionReason(workspace, narrative)}`);

  const technologyOnly = /^(typescript|javascript|node|nodejs|python|java|kotlin|scala|dotnet|\.net|csharp|rust|golang|go|php|ruby|dart|flutter|swift|objective c|cpp|c\+\+|terraform|docker|kubernetes|react|angular|vue|svelte|express|fastapi|django|flask|laravel|spring|nestjs|aspnet|framework|frameworks)$/i;
  const domains = workspace.workspace_domains || [];
  const capabilities = workspace.workspace_capabilities || [];
  invariant(domains.length > 0, 'WAS produced no business domains');
  const domainOwners = new Set(domains.flatMap((domain: any) => domain.project_ids || []));
  for (const codebase of workspace.codebases || []) {
    invariant(domainOwners.has(codebase.id), `WAS omitted the primary domain for member ${codebase.name}`);
  }
  for (const item of [...domains.slice(0, 6), ...capabilities.slice(0, 8)]) {
    invariant(item.description_source === 'ai', `WAS ${item.name} must have an AI description`);
    const description = String(item.description || '');
    invariant(description.length >= 68, `WAS ${item.name} has an unusably thin description: ${description}`);
    invariant(!/connects? .* evidence .* agents|so agents can understand|change impact at (?:the )?workspace level/i.test(description), `WAS ${item.name} contains meta-analysis filler: ${description}`);
    invariant(!/\baccount-project[-_:]|\b(?:prj|wsp|acct|proj|org|usr)[-_][a-z0-9_-]{6,}|\b(?:account|project|workspace|organization|user)\s+(?=[a-z0-9_-]{10,}\b)(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/i.test(description), `WAS ${item.name} leaked an internal identifier: ${description}`);
    invariant(!/\/(?:[A-Za-z0-9_.~-]+\/)*(?::|\{)[A-Za-z_][A-Za-z0-9_]*(?:\}|\b)/.test(description), `WAS ${item.name} leaked raw parameterized route syntax: ${description}`);
  }
  for (const domain of domains) {
    invariant(!technologyOnly.test(String(domain.name || '').trim()), `WAS promoted technology to business domain: ${domain.name}`);
    if (/deploy|infrastructure/i.test(String(domain.name || ''))) {
      invariant(!/order management|process(?:es|ing)? orders?|customer|account management/i.test(String(domain.description || '')), `WAS infrastructure domain borrowed unrelated product semantics: ${domain.description}`);
    }
  }
  const orderDomain = domains.find((domain: any) => /order/i.test(String(domain.name || '')));
  const appCodebase = (workspace.codebases || []).find((codebase: any) => codebase.name === 'enterprise-polyglot-app');
  const infraCodebase = (workspace.codebases || []).find((codebase: any) => codebase.name === 'enterprise-platform-infra');
  invariant(orderDomain && appCodebase, 'WAS omitted the app-owned order domain');
  invariant(JSON.stringify([...(orderDomain.project_ids || [])].sort()) === JSON.stringify([appCodebase.id]), `WAS assigned the order domain to the wrong members: ${JSON.stringify(orderDomain.project_ids)}`);
  invariant(!(workspace.workspace_narrative?.key_capabilities || []).some((name: string) => /shell deploy/i.test(name)), 'WAS promoted infrastructure mechanics into primary product capabilities');
  invariant(!(workspace.workspace_narrative?.value_drivers || []).some((value: string) => /multi[- ]language|polyglot|language support|framework|development needs|modular infrastructure/i.test(value)), `WAS emitted implementation trivia as value drivers: ${JSON.stringify(workspace.workspace_narrative?.value_drivers)}`);
  invariant((capabilities.filter((capability: any) => capability.project_ids?.includes(infraCodebase?.id)) || []).every((capability: any) => capability.semantic_role === 'infrastructure'), 'WAS failed to classify infrastructure-member capabilities as infrastructure');
  invariant((workspace.application_links || []).length === 0, 'independent proof projects must not be fabricated as connected applications');

  const deployables = workspace.deployables || [];
  invariant(workspace.summary?.applications === deployables.length, `WAS application summary counts non-canonical surfaces (${workspace.summary?.applications} vs ${deployables.length})`);
  const subCasNodeIds = deployables.map((item: any) => item.source_sub_cas_node_id).filter(Boolean);
  invariant(new Set(subCasNodeIds).size === subCasNodeIds.length, 'WAS exposed the same DAS deployable more than once');
  invariant(!deployables.some((item: any) => item.name === 'enterprise-platform-infra'), 'WAS promoted a Terraform-only repository root to an application deployable');
  const duplicateDasSurfaces = (workspace.applications || []).filter((item: any) =>
    item.source_sub_cas_node_id &&
    (workspace.applications || []).some((other: any) =>
      other.id !== item.id && other.source_sub_cas_node_id === item.source_sub_cas_node_id));
  invariant(duplicateDasSurfaces.every((item: any) => item.merged_into || duplicateDasSurfaces.some((other: any) => other.id !== item.id && other.merged_into === item.id)), 'WAS left duplicate DAS application surfaces uncanonicalized');
}

export function workspaceNarrativeWithoutMemberNames(workspace: any, narrative: string): string {
  const names = [
    workspace?.name,
    workspace?.workspace_narrative?.title,
    ...(workspace?.codebases || []).map((codebase: any) => codebase?.name),
    ...(workspace?.applications || []).map((application: any) => application?.name),
  ].filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  let redacted = String(narrative || '');
  for (const name of names.sort((left, right) => right.length - left.length)) {
    const pattern = name.trim().split(/[\s_-]+/).filter(Boolean)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s_-]+');
    if (pattern) redacted = redacted.replace(new RegExp(`\\b${pattern}\\b`, 'gi'), ' project ');
  }
  return redacted;
}

function assertCall(cas: CASOutput, fromName: string, toName: string): void {
  const fromIds = new Set((cas.nodes || []).filter(node => node.name === fromName).map(node => node.id));
  const toIds = new Set((cas.nodes || []).filter(node => node.name === toName).map(node => node.id));
  invariant(fromIds.size > 0, `missing caller node ${fromName}`);
  invariant(toIds.size > 0, `missing callee node ${toName}`);
  const direct = (cas.edges || []).some(edge => fromIds.has(edge.source) && toIds.has(edge.target));
  const method = (cas.method_calls || []).some(call => fromIds.has(call.caller_node) && toIds.has(call.target_node || ''));
  invariant(direct || method, `missing logical call ${fromName} -> ${toName}`);
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=enterprise-proof@klauro.invalid', '-c', 'user.name=Klauro Enterprise Proof', 'commit', '-qm', message]);
}

function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  writeFiles(repo, files);
  git(repo, ['init', '-q', '-b', 'main']);
  commitAll(repo, 'enterprise proof baseline');
  return repo;
}

export function enterpriseAppFiles(): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: 'enterprise-polyglot-app', private: true,
      dependencies: { express: '^5.0.0', react: '^19.0.0', '@prisma/client': '^6.0.0', zod: '^4.0.0' },
    }, null, 2),
    'src/order-service.ts': `export function calculateEnterpriseTotal(lines: number[]): number {\n  return lines.reduce((sum, line) => sum + line, 0);\n}\n`,
    'src/server.ts': `import express from 'express';\nimport { calculateEnterpriseTotal } from './order-service';\nconst app = express();\nexport function enterpriseTsHandler(id: string) { return { id, total: calculateEnterpriseTotal([10, 20]) }; }\napp.get('/ts/orders/:id', (req, res) => res.json(enterpriseTsHandler(req.params.id)));\nexport default app;\n`,
    'src/EnterpriseDashboard.tsx': `import React from 'react';\nexport function EnterpriseDashboard() { return <main>Enterprise orders</main>; }\n`,
    'prisma/schema.prisma': `datasource db { provider = "postgresql" url = env("DATABASE_URL") }\ngenerator client { provider = "prisma-client-js" }\nmodel EnterpriseOrder { id Int @id @default(autoincrement()) total Int }\n`,
    'python/requirements.txt': 'fastapi==0.115.0\nsqlalchemy==2.0.36\n',
    'python/api.py': `from fastapi import FastAPI\nfrom sqlalchemy.orm import declarative_base\nfrom sqlalchemy import Column, Integer\napp = FastAPI()\nBase = declarative_base()\nclass EnterprisePythonOrder(Base):\n    __tablename__ = "enterprise_orders"\n    id = Column(Integer, primary_key=True)\ndef enterprise_python_handler(order_id: int):\n    return {"id": order_id}\n@app.get("/python/orders/{order_id}")\ndef get_enterprise_order(order_id: int):\n    return enterprise_python_handler(order_id)\n`,
    'java/pom.xml': `<project><modelVersion>4.0.0</modelVersion><groupId>proof</groupId><artifactId>enterprise-java</artifactId><version>1.0.0</version><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.4.0</version></dependency></dependencies></project>`,
    'java/src/main/java/proof/EnterpriseController.java': `package proof;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class EnterpriseController {\n  @GetMapping("/java/orders/{id}")\n  public String enterpriseJavaHandler(@PathVariable String id) { return id; }\n}\n`,
    'dotnet/Enterprise.Api.csproj': `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
    'dotnet/Controllers/EnterpriseOrdersController.cs': `using Microsoft.AspNetCore.Mvc;\nnamespace Enterprise.Api.Controllers;\n[ApiController]\npublic class EnterpriseOrdersController : ControllerBase {\n  [HttpGet("/dotnet/orders/{id}")]\n  public string EnterpriseDotnetHandler(string id) => id;\n}\n`,
    'go/go.mod': `module enterprise/proof\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n`,
    'go/main.go': `package main\nimport "github.com/gin-gonic/gin"\nfunc enterpriseGoHandler(c *gin.Context) { c.JSON(200, gin.H{"id": c.Param("id")}) }\nfunc main() { r := gin.Default(); r.GET("/go/orders/:id", enterpriseGoHandler); r.Run() }\n`,
    'rust/Cargo.toml': `[package]\nname = "enterprise-rust"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\naxum = "0.8"\ntokio = { version = "1", features = ["full"] }\n`,
    'rust/src/main.rs': `use axum::{routing::get, Router};\nasync fn enterprise_rust_handler() -> &'static str { "order" }\n#[tokio::main]\nasync fn main() { let _app = Router::new().route("/rust/orders/:id", get(enterprise_rust_handler)); }\n`,
    'php/composer.json': JSON.stringify({ name: 'proof/enterprise-php', require: { 'laravel/framework': '^11.0' } }, null, 2),
    'php/routes/web.php': `<?php\nuse Illuminate\\Support\\Facades\\Route;\nfunction EnterprisePhpHandler(string $id): array { return ['id' => $id]; }\nRoute::get('/php/orders/{id}', fn (string $id) => EnterprisePhpHandler($id));\n`,
    'dart/pubspec.yaml': `name: enterprise_flutter\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n`,
    'dart/lib/main.dart': `import 'package:flutter/material.dart';\nclass EnterpriseFlutterDashboard extends StatelessWidget {\n  const EnterpriseFlutterDashboard({super.key});\n  @override Widget build(BuildContext context) => const Text('Enterprise orders');\n}\nvoid main() => runApp(const MaterialApp(home: EnterpriseFlutterDashboard()));\n`,
  };
}

export function enterpriseInfraFiles(): Record<string, string> {
  return {
    'deploy.sh': `#!/usr/bin/env bash\nset -euo pipefail\ndeploy_enterprise_stack() { terraform apply -auto-approve; }\ndeploy_enterprise_stack\n`,
    'main.tf': `terraform { required_version = ">= 1.6.0" }\nresource "aws_sqs_queue" "enterprise_queue" { name = "enterprise-orders" }\n`,
    'Dockerfile': `FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n`,
    'docker-compose.yml': `services:\n  enterprise-api:\n    build: .\n    ports: ["8080:8080"]\n`,
    'k8s/deployment.yaml': `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: EnterpriseQueue\nspec:\n  replicas: 2\n  selector:\n    matchLabels: { app: enterprise-queue }\n  template:\n    metadata:\n      labels: { app: enterprise-queue }\n    spec:\n      containers:\n        - name: enterprise-queue\n          image: example.invalid/enterprise-queue:proof\n`,
  };
}

interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

async function requestJson<T>(baseUrl: string, route: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 120_000),
  });
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route} returned ${response.status}: ${text.slice(0, 500)}`);
  return payload as T;
}

export function assertEnterpriseHostedProofUrl(raw: string | undefined): string {
  invariant(process.env.KLAURO_ENTERPRISE_HOSTED_PROOF === '1', 'KLAURO_ENTERPRISE_HOSTED_PROOF=1 is required');
  invariant(raw, 'KLAURO_ENTERPRISE_PROOF_URL is required');
  const url = new URL(raw);
  invariant(url.protocol === 'https:', 'enterprise proof requires an HTTPS hosted analyzer');
  invariant(!['localhost', '127.0.0.1', '::1'].includes(url.hostname), 'enterprise proof refuses loopback/local analyzers');
  return raw.replace(/\/+$/, '');
}

async function authenticate(baseUrl: string): Promise<{ token: string; workspaceId: string }> {
  const secret = process.env.KLAURO_ENTERPRISE_PROOF_SECRET;
  invariant(secret && secret.length >= 16, 'KLAURO_ENTERPRISE_PROOF_SECRET (16+ chars) is required');
  const email = process.env.KLAURO_ENTERPRISE_PROOF_EMAIL || 'enterprise-hosted-proof@klauro.invalid';
  const password = `${crypto.createHash('sha256').update(`enterprise-proof:${secret}`).digest('hex')}Aa1!`;
  let auth: any;
  try {
    auth = await requestJson<any>(baseUrl, '/api/auth/register', {
      body: { email, password, workspace_name: 'Enterprise Hosted Proof' },
    });
  } catch (error) {
    auth = await requestJson<any>(baseUrl, '/api/auth/login', { body: { email, password } });
  }
  invariant(auth.token, 'enterprise proof authentication returned no token');
  const workspaces = await requestJson<any>(baseUrl, '/api/workspaces', { token: auth.token });
  let workspace = (workspaces.workspaces || []).find((item: any) => item.name === 'Enterprise Hosted Proof');
  if (!workspace) {
    workspace = (await requestJson<any>(baseUrl, '/api/workspaces', {
      method: 'POST', token: auth.token, body: { name: 'Enterprise Hosted Proof' },
    })).workspace;
  }
  invariant(workspace?.id, 'enterprise proof workspace was not available');
  return { token: auth.token, workspaceId: workspace.id };
}

async function ensureProject(baseUrl: string, token: string, workspaceId: string, name: string): Promise<{ id: string; name: string }> {
  const listed = await requestJson<any>(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, { token });
  const existing = (listed.projects || []).find((project: any) => project.name === name);
  if (existing) return existing;
  const created = await requestJson<any>(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    method: 'POST', token, body: { name, repo_url: `https://example.invalid/klauro/${name}` },
  });
  return created.project;
}

interface ProjectState {
  status?: string;
  analysis_error?: string;
  failed_layers?: string[];
  summary?: {
    analysis_timestamp?: string;
    layers_ready?: {
      complete?: boolean;
      layers?: Array<{ layer?: string; status?: string; error?: string }>;
    };
  };
  last_attempt?: { state?: string; started_at?: string; reason?: string };
}

async function waitForProject(
  baseUrl: string,
  token: string,
  projectId: string,
  options: { previousTimestamp?: string; attemptStartedAfter?: number; timeoutMs?: number } = {},
): Promise<ProjectState> {
  const deadline = Date.now() + (options.timeoutMs || 600_000);
  let last: ProjectState = {};
  while (Date.now() < deadline) {
    last = await requestJson<ProjectState>(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/analysis-status`, { token });
    if (last.status === 'failed' || last.last_attempt?.state === 'failed') {
      throw new Error(`hosted analysis failed for ${projectId}: ${last.analysis_error || last.last_attempt?.reason || JSON.stringify(last.failed_layers || [])}`);
    }
    const failedLayer = last.summary?.layers_ready?.layers?.find(layer => layer.status === 'error');
    if (failedLayer) {
      throw new Error(`hosted analysis layer failed for ${projectId}: ${failedLayer.layer || 'unknown'}: ${failedLayer.error || 'unknown error'}`);
    }
    const timestamp = last.summary?.analysis_timestamp;
    const timestampAdvanced = !options.previousTimestamp || Boolean(options.attemptStartedAfter) || (timestamp && timestamp !== options.previousTimestamp);
    const attemptDone = !options.attemptStartedAfter || (
      last.last_attempt?.state === 'succeeded' &&
      Date.parse(last.last_attempt.started_at || '') >= options.attemptStartedAfter - 2_000
    );
    const logicalCasComplete = last.summary?.layers_ready?.complete === true;
    if (last.status === 'ready' && logicalCasComplete && timestamp && timestampAdvanced && attemptDone) return last;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for hosted analysis ${projectId}; last state=${JSON.stringify(last)}`);
}

async function fetchCas(baseUrl: string, token: string, projectId: string): Promise<CASOutput> {
  const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/cas/export`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180_000),
  });
  invariant(response.ok, `hosted CAS export unavailable for ${projectId}: HTTP ${response.status}`);
  const codec = response.headers.get('x-klauro-cas-codec') || 'none';
  const compressed = Buffer.from(await response.arrayBuffer());
  let json = compressed;
  if (codec === 'zstd') {
    const decompressed = spawnSync('zstd', ['-q', '-d', '-c'], {
      input: compressed,
      maxBuffer: 1024 * 1024 * 1024,
    });
    invariant(decompressed.status === 0, `zstd failed to decode hosted CAS export for ${projectId}`);
    json = decompressed.stdout;
  }
  return JSON.parse(json.toString('utf8')) as CASOutput;
}

async function submitCold(baseUrl: string, token: string, projectId: string, repo: string): Promise<{ cas: CASOutput; elapsedMs: number; timestamp: string }> {
  const snapshot = await buildSourceSnapshot(repo);
  const started = Date.now();
  const accepted = await requestJson<any>(baseUrl, '/v1/analyze', {
    method: 'POST', token,
    body: { protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION, project_id: projectId, project_path: repo, snapshot, async: true },
  });
  invariant(accepted.status === 'accepted', `cold analyze was not accepted: ${JSON.stringify(accepted)}`);
  const state = await waitForProject(baseUrl, token, projectId);
  const timestamp = state.summary?.analysis_timestamp;
  invariant(timestamp, 'cold analysis produced no timestamp');
  return { cas: await fetchCas(baseUrl, token, projectId), elapsedMs: Date.now() - started, timestamp };
}

async function queryWarm(baseUrl: string, token: string, projectId: string, previousTimestamp: string): Promise<{ cas: CASOutput; elapsedMs: number; timestamp: string }> {
  const started = Date.now();
  const state = await requestJson<ProjectState>(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/analysis-status`, { token });
  invariant(state.status === 'ready' && state.summary?.layers_ready?.complete === true, 'warm query did not return a complete ready analysis');
  const timestamp = state.summary?.analysis_timestamp;
  invariant(timestamp === previousTimestamp, 'warm query unexpectedly changed the stored analysis revision');
  return { cas: await fetchCas(baseUrl, token, projectId), elapsedMs: Date.now() - started, timestamp: previousTimestamp };
}

async function submitIncremental(baseUrl: string, token: string, projectId: string, repo: string, previousTimestamp: string): Promise<{ cas: CASOutput; elapsedMs: number; timestamp: string }> {
  const changes = await buildWorkingTreeChangeContext(repo);
  invariant(changes.changed_files.length === 1, `incremental proof requires exactly one changed file, got ${changes.changed_files.map(file => file.path).join(', ')}`);
  const started = Date.now();
  const accepted = await requestJson<any>(baseUrl, '/v1/sync', {
    method: 'POST', token,
    body: { protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION, analysis_id: projectId, project_id: projectId, project_path: repo, changes, async: true },
  });
  invariant(accepted.status === 'accepted', `incremental sync was not accepted: ${JSON.stringify(accepted)}`);
  const state = await waitForProject(baseUrl, token, projectId, { previousTimestamp });
  const timestamp = state.summary?.analysis_timestamp;
  invariant(timestamp, 'incremental analysis produced no timestamp');
  return { cas: await fetchCas(baseUrl, token, projectId), elapsedMs: Date.now() - started, timestamp };
}

async function waitForWorkspace(baseUrl: string, token: string, workspaceId: string, projectIds: string[]): Promise<any> {
  const started = Date.now();
  const projectStates = await Promise.all(projectIds.map(projectId =>
    requestJson<ProjectState>(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/analysis-status`, { token })));
  const newestMemberAnalysisAt = Math.max(...projectStates.map(state => Date.parse(state.summary?.analysis_timestamp || '')));
  const deadline = Date.now() + 600_000;
  let last: any = {};
  while (Date.now() < deadline) {
    last = await requestJson<any>(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/analysis`, { token });
    const exactMembers = JSON.stringify([...(last.member_project_ids || [])].sort()) === JSON.stringify([...projectIds].sort());
    const generatedAfterMembers = Number.isFinite(newestMemberAnalysisAt) && Date.parse(last.generated_at || '') >= newestMemberAnalysisAt;
    const comprehensionReady = last.enrichment?.status === 'ai' && last.analysis?.workspace_narrative?.source === 'ai';
    if (last.status === 'ready' && generatedAfterMembers && exactMembers && comprehensionReady) {
      return { body: last, elapsedMs: Date.now() - started };
    }
    if (last.enrichment?.status === 'degraded' || last.enrichment?.status === 'error') {
      throw new Error(`workspace enrichment failed: ${last.enrichment.reason || last.enrichment.status}`);
    }
    if (last.last_attempt?.state === 'failed') throw new Error(`workspace analysis failed: ${last.last_attempt.reason || 'unknown'}`);
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for workspace analysis: ${JSON.stringify(last).slice(0, 1000)}`);
}

function budget(name: string, fallback: number): number {
  const raw = Number(process.env[`KLAURO_ENTERPRISE_${name.toUpperCase().replace(/-/g, '_')}_BUDGET_MS`]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function assertBudget(name: string, elapsedMs: number, budgetMs: number): void {
  invariant(elapsedMs <= budgetMs, `${name} took ${elapsedMs}ms, exceeding ${budgetMs}ms budget`);
}

export async function runEnterpriseHostedParityProof(): Promise<EnterpriseHostedParityReport> {
  const baseUrl = assertEnterpriseHostedProofUrl(process.env.KLAURO_ENTERPRISE_PROOF_URL);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-enterprise-hosted-proof-'));
  const phases: PhaseTiming[] = [];
  try {
    const appRepo = makeRepo(root, 'enterprise-polyglot-app', enterpriseAppFiles());
    const infraRepo = makeRepo(root, 'enterprise-platform-infra', enterpriseInfraFiles());
    const { token, workspaceId } = await authenticate(baseUrl);
    const appProject = await ensureProject(baseUrl, token, workspaceId, 'enterprise-polyglot-app');
    const infraProject = await ensureProject(baseUrl, token, workspaceId, 'enterprise-platform-infra');

    const appColdBudget = budget('app-cold', 180_000);
    const appCold = await submitCold(baseUrl, token, appProject.id, appRepo);
    assertBudget('app-cold', appCold.elapsedMs, appColdBudget);
    assertCompleteCas(appCold.cas, 'app cold');
    assertSurfaceTokens(appCold.cas, ENTERPRISE_SURFACES.filter(surface => !surface.name.startsWith('shell-')), 'app cold');
    phases.push({ name: 'app-cold', elapsed_ms: appCold.elapsedMs, budget_ms: appColdBudget, logical_hash: logicalCasHash(appCold.cas), nodes: appCold.cas.nodes.length, edges: appCold.cas.edges.length });

    const infraColdBudget = budget('infra-cold', 120_000);
    const infraCold = await submitCold(baseUrl, token, infraProject.id, infraRepo);
    assertBudget('infra-cold', infraCold.elapsedMs, infraColdBudget);
    assertCompleteCas(infraCold.cas, 'infra cold');
    assertSurfaceTokens(infraCold.cas, ENTERPRISE_SURFACES.filter(surface => surface.name.startsWith('shell-')), 'infra cold');
    assertProjectSemanticQuality(appCold.cas, infraCold.cas);
    phases.push({ name: 'infra-cold', elapsed_ms: infraCold.elapsedMs, budget_ms: infraColdBudget, logical_hash: logicalCasHash(infraCold.cas), nodes: infraCold.cas.nodes.length, edges: infraCold.cas.edges.length });

    const workspaceBudget = budget('workspace-analysis', 120_000);
    const workspace = await waitForWorkspace(baseUrl, token, workspaceId, [appProject.id, infraProject.id]);
    assertBudget('workspace-analysis', workspace.elapsedMs, workspaceBudget);
    invariant(workspace.body.analysis?.codebase_count === 2, `WAS codebase_count expected 2, got ${workspace.body.analysis?.codebase_count}`);
    const workspaceJson = JSON.stringify(workspace.body.analysis).toLowerCase();
    invariant(workspaceJson.includes('enterprise-polyglot-app') && workspaceJson.includes('enterprise-platform-infra'), 'WAS omitted a member project');
    assertWorkspaceSemanticQuality(workspace.body.analysis);
    phases.push({ name: 'workspace-analysis', elapsed_ms: workspace.elapsedMs, budget_ms: workspaceBudget });

    const warmBudget = budget('unchanged-warm', Math.min(appColdBudget, 90_000));
    const warm = await queryWarm(baseUrl, token, appProject.id, appCold.timestamp);
    assertBudget('unchanged-warm', warm.elapsedMs, warmBudget);
    assertCompleteCas(warm.cas, 'unchanged warm');
    invariant(logicalCasHash(warm.cas) === logicalCasHash(appCold.cas), 'unchanged warm logical CAS differs from cold CAS');
    invariant(warm.elapsedMs <= appCold.elapsedMs, `unchanged warm ${warm.elapsedMs}ms was slower than cold ${appCold.elapsedMs}ms`);
    phases.push({ name: 'unchanged-warm', elapsed_ms: warm.elapsedMs, budget_ms: warmBudget, logical_hash: logicalCasHash(warm.cas), nodes: warm.cas.nodes.length, edges: warm.cas.edges.length });

    const serverFile = path.join(appRepo, 'src/server.ts');
    fs.appendFileSync(serverFile, `\nexport function enterpriseSummaryHandler() { return { total: calculateEnterpriseTotal([5, 6]) }; }\napp.get('/ts/orders/summary', (_req, res) => res.json(enterpriseSummaryHandler()));\n`);
    const incrementalBudget = budget('one-file-incremental', 60_000);
    const oneFile = await submitIncremental(baseUrl, token, appProject.id, appRepo, warm.timestamp);
    assertBudget('one-file-incremental', oneFile.elapsedMs, incrementalBudget);
    assertCompleteCas(oneFile.cas, 'one-file incremental');
    const oneFileOmissions = unrelatedNodeOmissions(warm.cas, oneFile.cas, ['src/server.ts']);
    invariant(oneFileOmissions.length === 0, `one-file incremental omitted ${oneFileOmissions.length} unrelated nodes: ${oneFileOmissions.slice(0, 5).join(', ')}`);
    const oneFileCollectionOmissions = collectionOmissions(warm.cas, oneFile.cas);
    invariant(oneFileCollectionOmissions.length === 0, `one-file incremental reduced logical CAS collections: ${oneFileCollectionOmissions.join(', ')}`);
    assertSurfaceTokens(oneFile.cas, [{ name: 'one-file-route', required_tokens: ['enterpriseSummaryHandler', '/ts/orders/summary'] }], 'one-file incremental');
    phases.push({ name: 'one-file-incremental', elapsed_ms: oneFile.elapsedMs, budget_ms: incrementalBudget, logical_hash: logicalCasHash(oneFile.cas), nodes: oneFile.cas.nodes.length, edges: oneFile.cas.edges.length });

    commitAll(appRepo, 'add summary route');
    const serviceFile = path.join(appRepo, 'src/order-service.ts');
    fs.writeFileSync(serviceFile, `export function normalizeEnterpriseCurrency(value: number): number { return Math.round(value * 100) / 100; }\nexport function calculateEnterpriseTotal(lines: number[]): number {\n  return normalizeEnterpriseCurrency(lines.reduce((sum, line) => sum + line, 0));\n}\n`);
    const dependencyBudget = budget('dependency-invalidation', 75_000);
    const dependency = await submitIncremental(baseUrl, token, appProject.id, appRepo, oneFile.timestamp);
    assertBudget('dependency-invalidation', dependency.elapsedMs, dependencyBudget);
    assertCompleteCas(dependency.cas, 'dependency invalidation');
    const dependencyOmissions = unrelatedNodeOmissions(oneFile.cas, dependency.cas, ['src/order-service.ts']);
    invariant(dependencyOmissions.length === 0, `dependency invalidation omitted ${dependencyOmissions.length} unrelated nodes: ${dependencyOmissions.slice(0, 5).join(', ')}`);
    const dependencyCollectionOmissions = collectionOmissions(oneFile.cas, dependency.cas);
    invariant(dependencyCollectionOmissions.length === 0, `dependency invalidation reduced logical CAS collections: ${dependencyCollectionOmissions.join(', ')}`);
    assertCall(dependency.cas, 'calculateEnterpriseTotal', 'normalizeEnterpriseCurrency');
    assertCall(dependency.cas, 'enterpriseTsHandler', 'calculateEnterpriseTotal');
    assertSurfaceTokens(dependency.cas, ENTERPRISE_SURFACES.filter(surface => !surface.name.startsWith('shell-')), 'dependency invalidation');
    assertProjectSemanticQuality(dependency.cas, infraCold.cas);
    phases.push({ name: 'dependency-invalidation', elapsed_ms: dependency.elapsedMs, budget_ms: dependencyBudget, logical_hash: logicalCasHash(dependency.cas), nodes: dependency.cas.nodes.length, edges: dependency.cas.edges.length });

    const finalWorkspaceBudget = budget('post-incremental-workspace', 120_000);
    const finalWorkspace = await waitForWorkspace(baseUrl, token, workspaceId, [appProject.id, infraProject.id]);
    assertBudget('post-incremental-workspace', finalWorkspace.elapsedMs, finalWorkspaceBudget);
    assertWorkspaceSemanticQuality(finalWorkspace.body.analysis);
    phases.push({ name: 'post-incremental-workspace', elapsed_ms: finalWorkspace.elapsedMs, budget_ms: finalWorkspaceBudget });

    const report: EnterpriseHostedParityReport = {
      status: 'pass',
      server_url: baseUrl,
      generated_at: new Date().toISOString(),
      projects: { app: appProject.id, infra: infraProject.id },
      workspace_id: workspaceId,
      surfaces_proven: ENTERPRISE_SURFACES.map(surface => surface.name),
      phases,
      parity: {
        unchanged_warm_exact: true,
        one_file_unrelated_omissions: 0,
        dependency_unrelated_omissions: 0,
        dependency_call_recomputed: true,
      },
      cas_completeness: { app: true, infra: true, final_app: true },
      was_completeness: { exact_membership: true, codebase_count: 2 },
      semantic_quality: {
        artifact_identity_grounded: true,
        capability_catalog_grounded: true,
        workspace_narrative_ai_generated: true,
        workspace_domains_business_semantic: true,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
