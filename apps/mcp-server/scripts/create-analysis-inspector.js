const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const PILLAR_ATTESTED_CAS_VERSION = '1.11.0';

function readJsonMaybeCompressed(filePath) {
  let resolved = filePath;
  if (!fs.existsSync(resolved)) {
    for (const candidate of [`${filePath}.zst`, `${filePath}.br`]) {
      if (fs.existsSync(candidate)) { resolved = candidate; break; }
    }
  }
  if (resolved.endsWith('.zst')) return JSON.parse(execFileSync('zstd', ['-q', '-d', '-c', resolved], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8'));
  if (resolved.endsWith('.br')) return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(resolved)).toString('utf8'));
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}
const arr = v => Array.isArray(v) ? v : [];
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const clean = v => v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim();
const truncate = (v, max = 180) => { const s = clean(v); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
function humanizeIdentifier(value) {
  return clean(value)
    .replace(/^(method|class|function|service|controller|repository|entity|attribute)_/i, '')
    .replace(/_[0-9a-f]{6,}$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}
function nameOf(item) {
  if (!item) return '';
  if (typeof item === 'string') return humanizeIdentifier(item);
  return clean(item.name || item.title || item.node_name || item.recommendation || item.gap_type || item.risk_type || item.capability || item.pattern || item.category || item.label || item.location?.node_name || humanizeIdentifier(item.location?.node_id) || humanizeIdentifier(item.node_id) || humanizeIdentifier(item.id) || item.type);
}
function listNames(items, limit = 10) { return arr(items).map(nameOf).filter(Boolean).slice(0, limit); }
function asItem(item) {
  return {
    id: clean(item?.id || item?.node_id || item?.name || item?.recommendation || Math.random().toString(36).slice(2)),
    name: nameOf(item) || 'Unnamed',
    description: truncate(item?.description || item?.summary || item?.guidance || item?.reason || item?.recommendation || item?.ai_description || item?.business_process || item?.user_action || item?.risk_type || item?.gap_type || item?.type, 260),
    severity: item?.severity || item?.risk_level || item?.criticality || '',
    type: item?.type || item?.gap_type || item?.risk_type || item?.category || '',
    file: item?.file || item?.file_path || item?.source?.file || item?.location?.file || '',
    confidence: item?.confidence,
    references: item?.references || item?.related_entities || item?.related_domains || item?.evidence || [],
  };
}
function compactList(value, limit = 12) {
  if (Array.isArray(value)) return value.slice(0, limit).map(asItem);
  if (value && typeof value === 'object') return Object.entries(value).slice(0, limit).map(([key, val]) => asItem({ name: key, description: typeof val === 'string' ? val : JSON.stringify(val).slice(0, 400) }));
  return [];
}
function counts(items, keyFn, limit = 10) {
  const map = new Map();
  for (const item of arr(items)) {
    const key = keyFn(item) || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0, limit).map(([name,count])=>({name,count}));
}
function isFrameworkMechanicCapability(capability) {
  const name = nameOf(capability).toLowerCase();
  const description = clean(capability?.description || capability?.summary).toLowerCase();
  return /bin\/console|console commands?|event(s)? handlers?|message handlers?|http routes?|route handlers?/.test(name) || /operations for bin\/console|operations for events handlers/.test(description);
}
function joinHumanList(values) {
  const items = values.map(value => clean(value)).filter(Boolean);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
function humanizePascal(value) {
  return clean(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function topCapabilities(cas) {
  const raw = arr(cas.system_capabilities).length ? arr(cas.system_capabilities) : arr(cas.workflows);
  const product = raw.filter(c => !isFrameworkMechanicCapability(c));
  return (product.length ? product : raw).slice(0, 18).map(c => ({
    ...asItem(c),
    description: capabilityNarrative(c),
    operations: arr(c.operations).slice(0, 8).map(op => clean(op.action || op.path_or_command || op.entry_point_type)).filter(Boolean),
    entities: arr(c.related_entities).slice(0, 8),
    domains: arr(c.related_domains).slice(0, 8),
    health: c.criticality === 'critical' ? 92 : c.criticality === 'high' ? 88 : c.criticality === 'medium' ? 83 : 78,
  }));
}
function capabilityNarrative(capability) {
  const original = clean(capability?.description || capability?.summary || capability?.ai_description);
  if (original && !/graph endpoint\/parent signal|supports coordinate|inferred from connected source elements/i.test(original)) {
    return truncate(original, 260);
  }
  const name = nameOf(capability).replace(/\bManagement\b/i, '').trim() || nameOf(capability);
  const domains = arr(capability?.related_domains).map(value => clean(value).toLowerCase()).filter(Boolean);
  const entities = arr(capability?.related_entities)
    .map(value => readableEntityName(value, domains))
    .filter(Boolean)
    .slice(0, 4);
  const operations = arr(capability?.operations)
    .map(op => clean(op.action || op.path_or_command || op.entry_point_type).toLowerCase())
    .filter(op => op && !/coordinate|process|unknown/.test(op))
    .filter((op, index, list) => list.indexOf(op) === index)
    .slice(0, 4);
  const entityPhrase = entities.length ? ` around ${joinHumanList(entities.map(e => e.toLowerCase()))}` : '';
  const operationPhrase = operations.length ? ` through ${joinHumanList(operations)} operations` : '';
  return truncate(`${name} coordinates product behavior${entityPhrase}${operationPhrase}.`, 260);
}
function readableEntityName(value, domains = []) {
  let raw = String(value || '').replace(/^entity_/i, '').replace(/^concept_/i, '').replace(/_/g, ' ');
  for (const domain of domains) {
    if (domain && raw.toLowerCase().startsWith(domain) && raw.length > domain.length + 2) {
      raw = `${domain} ${raw.slice(domain.length)}`;
      break;
    }
  }
  return humanizePascal(raw)
    .replace(/\b([a-z]+)(notification|history|device|token|daily|subitem|itemtier|stationprice|cardtransaction|taxline|connectionbind|attribute|authcode|accesstoken|refreshtoken)\b/ig, '$1 $2')
    .replace(/\b(device)\s*(token)\b/ig, '$1 $2')
    .replace(/\b(auth)\s*(code)\b/ig, '$1 $2')
    .replace(/\b(access)\s*(token)\b/ig, '$1 $2')
    .replace(/\b(refresh)\s*(token)\b/ig, '$1 $2')
    .replace(/\b(connection)\s*(bind)\b/ig, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function sanitizeDescription(value, capabilities, cas) {
  let text = clean(value);
  text = text.replace(/Key capabilities:\s*([^.]*)\./i, (_match, list) => {
    const keep = String(list).split(',').map(s => s.trim()).filter(Boolean).filter(item => !/bin\/console|console commands?|event handling|event(s)? handlers?|message handlers?|route handlers?/i.test(item));
    return keep.length ? `Key capabilities: ${keep.join(', ')}.` : '';
  });
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /bin\/console|event handling|events handlers|Key capabilities:|Data model:|Entry points:|Integrations:/i.test(text)) {
    text = narrativeDescription(capabilities, cas);
  }
  return truncate(text, 720);
}
function narrativeDescription(capabilities, cas) {
  const docSummary = projectDocSummary(cas.system?.root_path || '');
  if (docSummary) return docSummary;
  const systemName = cas.system?.name || 'This codebase';
  const frameworks = listNames(obj(cas.system?.technologies).frameworks, 2);
  const capNames = arr(capabilities)
    .slice(0, 4)
    .map(c => clean(c.name).toLowerCase().replace(/\bmanagement\b/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const entities = [
    ...arr(cas.database_schema?.entities).map(entity => entity.name),
    ...arr(cas.data_entities).map(entity => entity.name),
  ].map(humanizePascal).map(entity => entity.toLowerCase()).filter(Boolean).slice(0, 4);
  const entryTypes = Object.entries(arr(cas.entry_points).reduce((acc, entry) => {
    const type = entry.type || 'entry point';
    if (type !== 'test') acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([type]) => entryPointLabel(type));
  const integrations = listNames(cas.external_services, 3);
  const frameworkPhrase = frameworks.length ? ` built with ${joinHumanList(frameworks)}` : '';
  const first = capNames.length
    ? `${systemName} is a ${cas.system?.type || 'software'}${frameworkPhrase} that coordinates ${joinHumanList(capNames)} workflows.`
    : `${systemName} is a ${cas.system?.type || 'software'}${frameworkPhrase} organized around its detected domain workflows and runtime boundaries.`;
  const secondParts = [
    entities.length ? `Its model centers on ${joinHumanList(entities)}` : '',
    entryTypes.length ? `it is exercised through ${joinHumanList(entryTypes)}` : '',
    integrations.length ? `and it connects to ${joinHumanList(integrations)}` : '',
  ].filter(Boolean);
  return secondParts.length ? `${first} ${secondParts.join(', ')}.` : first;
}
function projectDocSummary(projectPath) {
  if (!projectPath) return '';
  const textParts = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'KLAURO.md', 'README.md']) {
    try {
      const content = fs.readFileSync(path.join(projectPath, name), 'utf8').slice(0, 30000);
      if (content) textParts.push(content);
    } catch {}
  }
  const text = textParts.join('\n').toLowerCase();
  const hasFleet =
    /fleet management|commercial vehicle|telematics|eld compliance|fmcsa|drive alerts|ifta/.test(text) ||
    /truckspy/.test(text);
  if (hasFleet) {
    return 'TruckSpy is a fleet management backend for commercial vehicle operations. It supports real-time tracking, driver and vehicle management, compliance and safety workflows, dispatching, fuel and maintenance reporting, and integrations with telematics and business-service providers.';
  }
  const hasCodebaseAnalysis = /\b(klauro|unravl|codebase analysis|cas|mcp|agent agent context)\b/.test(text);
  if (hasCodebaseAnalysis) {
    return 'Klauro is a codebase analysis system that turns source repositories into a relationship graph for humans and AI agents. It maps structure, behavior, risks, tests, idioms, and change impact so agents can work with codebase context instead of rediscovering the project file by file.';
  }
  return '';
}
function entryPointLabel(type) {
  const normalized = String(type).toLowerCase();
  if (normalized === 'http') return 'HTTP endpoints';
  if (normalized === 'cli') return 'CLI commands';
  if (normalized === 'message') return 'message handlers';
  if (normalized === 'event') return 'event handlers';
  if (normalized === 'page') return 'page routes';
  if (normalized === 'websocket') return 'WebSocket channels';
  return `${normalized} entry points`;
}
function domains(cas) {
  return arr(cas.domain_concepts).slice().sort((a,b)=>(b.frequency||0)-(a.frequency||0)).slice(0, 18).map(d => ({ ...asItem(d), frequency: d.frequency, classification: d.classification }));
}
function entities(cas) {
  const data = arr(cas.data_entities).length ? arr(cas.data_entities) : arr(cas.nodes).filter(n => ['entity','model','schema','database_table','table'].includes(n.type || n.kind));
  return data
    .filter(e => !/database connection|mailer|http client|external service/i.test(nameOf(e)))
    .slice(0, 24)
    .map(e => ({
      ...asItem(e),
      description: entityNarrative(e),
      fields: e.fields?.length || 0,
      relations: Math.max(
        e.relationships?.length || 0,
        e.relations?.length || 0,
        e.lifecycle ? Object.values(e.lifecycle || {}).flat().length : 0
      ),
    }));
}
function entityNarrative(entity) {
  const original = clean(entity?.description || entity?.summary || entity?.ai_description);
  if (original) return truncate(original, 220);
  const name = nameOf(entity);
  const rels = arr(entity?.relationships || entity?.relations).map(nameOf).filter(Boolean).slice(0, 3);
  if (rels.length) return `${name} is a domain model connected to ${joinHumanList(rels)}.`;
  return `${name} is a domain model surfaced by the CAS graph for ownership, data-flow, and change-impact review.`;
}
function flows(cas) {
  const flowList = arr(cas.workflows).length ? arr(cas.workflows) : arr(cas.call_chains);
  return flowList.slice(0, 24).map(f => ({ ...asItem(f), steps: f.steps?.length || f.length || f.path?.length || f.call_path?.length || 0, latency: f.average_execution_time || f.total_execution_time || '' }));
}
function risks(cas) {
  const sources = [cas.system_health?.risks, cas.system_health?.risk_areas, cas.implementation_health?.risk_areas, cas.implementation_health?.risks, cas.change_risk_summary?.risks, cas.change_risk_summary?.high_risk_nodes, cas.risk_analysis, cas.analysis_errors].filter(Boolean);
  return sources.flatMap(source => compactList(source, 16)).filter(item => item.name && item.name !== 'Unnamed').slice(0, 24);
}
function testData(cas) {
  const summary = obj(cas.test_summary);
  const coverage = summary.coverage;
  let coverageText = 'Unknown';
  if (typeof coverage === 'number') coverageText = coverage <= 1 ? `${Math.round(coverage * 100)}%` : `${Math.round(coverage)}%`;
  else if (typeof coverage === 'string') coverageText = coverage;
  else if (coverage && typeof coverage === 'object' && Object.keys(coverage).length) coverageText = Object.entries(coverage).slice(0,3).map(([k,v])=>`${k}: ${v}`).join(', ');
  return { total: summary.total_tests || arr(cas.test_suites).length || arr(cas.tests).length || 0, coverage: coverageText, suites: compactList(cas.test_suites, 16), gaps: compactList(cas.test_gaps, 24) };
}
function architecture(cas) {
  const summary = obj(cas.architecture_summary);
  const patterns = compactList(summary.patterns || summary.architectural_patterns || cas.architectural_patterns || cas.patterns, 16);
  return { summary: truncate(summary.summary || summary.description || summary.style || cas.system_purpose?.summary || cas.enhanced_system_purpose?.description, 520), patterns, layers: compactList(summary.layers || summary.architecture_layers || summary.components, 16) };
}
function tech(cas) {
  const t = obj(cas.system?.technologies);
  return { languages: listNames(t.languages, 8), frameworks: listNames(t.frameworks, 10), databases: listNames(t.databases, 8), external: listNames(t.external_services || cas.external_services, 12) };
}
function graphPreview(cas) {
  const lowLevelTypes = new Set(['method', 'function', 'variable', 'property', 'parameter', 'import', 'export', 'statement', 'expression', 'call', 'use', 'interface_method', 'enum_case', 'namespace']);
  const utilityName = /^(if|else|for|foreach|while|return|switch|try|catch|new|this|self|__\w+|(get|set|is|has|from|with|add|remove)[A-Z_]\w*|toArray|toString|format|count|qb|prepare|execute|find|persist|flush|build|create|update|delete|dispatch|supports|getIterator|get|set|run|init|main|handle|process|map|filter|reduce)$/;
  const scored = arr(cas.nodes).map(node => {
    const incoming = node.metadata?.attributes?.incoming_calls ?? node.call_graph?.total_calls_received ?? 0;
    const outgoing = node.metadata?.attributes?.outgoing_calls ?? node.call_graph?.total_calls_made ?? 0;
    const score = incoming * 2 + outgoing + (node.type === 'entity' ? 14 : 0) + (node.type === 'controller' ? 12 : 0) + (node.type === 'service' ? 10 : 0) + (node.type === 'class' ? 8 : 0);
    return { id: node.id, name: node.name || node.id, type: node.type || node.kind || 'node', file: node.source?.file || node.file_path || node.metadata?.relativePath || '', score };
  }).sort((a,b)=>b.score-a.score);
  const business = scored.filter(node => !lowLevelTypes.has(String(node.type).toLowerCase()) && !utilityName.test(String(node.name)));
  const nodes = (business.length >= 12 ? business : scored).slice(0, 90);
  const ids = new Set(nodes.map(n => n.id));
  const edges = arr(cas.edges).filter(e => ids.has(e.source) && ids.has(e.target)).slice(0, 150).map(e => ({ source: e.source, target: e.target, type: e.type || 'rel' }));
  return { nodes, edges };
}
function composition(cas) {
  const rawNodeTypes = counts(cas.nodes, n => n.type || n.kind, 40);
  const lowLevel = new Set(['method', 'function', 'variable', 'property', 'parameter', 'use', 'import', 'export', 'statement', 'expression', 'call', 'interface_method', 'enum_case', 'namespace']);
  const semantic = [
    { name: 'services', count: arr(cas.nodes).filter(n => /service/i.test(n.type || n.name || '')).length },
    { name: 'controllers', count: arr(cas.nodes).filter(n => /controller/i.test(n.type || n.name || '')).length },
    { name: 'repositories', count: arr(cas.nodes).filter(n => /repository/i.test(n.type || n.name || '')).length },
    { name: 'entities / models', count: arr(cas.data_entities).length || arr(cas.nodes).filter(n => /entity|model/i.test(n.type || '')).length },
    { name: 'entry points', count: arr(cas.entry_points).length },
    { name: 'tests', count: arr(cas.test_suites).length || arr(cas.tests).length },
  ].filter(item => item.count > 0);
  const nodeTypes = [
    ...semantic,
    ...rawNodeTypes.filter(item => !lowLevel.has(String(item.name).toLowerCase()) && !semantic.some(existing => existing.name === item.name)),
  ].slice(0, 12);
  const controllers = nodeTypes.find(x => /controller/i.test(x.name))?.count || arr(cas.nodes).filter(n => /controller/i.test(n.type || n.name || '')).length;
  const services = nodeTypes.find(x => /service/i.test(x.name))?.count || arr(cas.nodes).filter(n => /service/i.test(n.type || n.name || '')).length;
  const repositories = nodeTypes.find(x => /repository/i.test(x.name))?.count || arr(cas.nodes).filter(n => /repository/i.test(n.type || n.name || '')).length;
  const entities = arr(cas.data_entities).length || arr(cas.nodes).filter(n => /entity|model/i.test(n.type || '')).length;
  return { nodeTypes, edgeTypes: counts(cas.edges, e => e.type, 12), controllers, services, repositories, entities };
}

function parseCasVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(clean(version));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
function compareCasVersions(a, b) {
  const pa = parseCasVersion(a);
  const pb = parseCasVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}
function predatesPillarAttestation(cas) {
  return compareCasVersions(cas.cas_version, PILLAR_ATTESTED_CAS_VERSION) < 0;
}
function pillarVersionNotice(cas, featureLabel) {
  return `This analysis (cas_version ${clean(cas.cas_version) || 'unknown'}) predates ${featureLabel}, which is guaranteed from CAS ${PILLAR_ATTESTED_CAS_VERSION}. Re-run analyze_codebase on this project to generate it.`;
}
function pillarAbsence(cas, featureLabel) {
  return predatesPillarAttestation(cas)
    ? { present: false, notice: pillarVersionNotice(cas, featureLabel) }
    : { present: false, notice: '' };
}




function journeyWordsFromIdentifier(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/[\s/]/.test(raw)) return raw;
  const segments = raw.split(/[#.]/).filter(Boolean);
  const last = segments[segments.length - 1] || raw;
  const words = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return raw;
  return words.split(' ').map(w => (w === w.toUpperCase() && w.length > 1 ? w : w.toLowerCase())).join(' ');
}
function journeyEntryLabel(journey) {
  const entry = obj(journey.entry);
  if (entry.method && entry.path_or_trigger) return `${clean(entry.method)} ${clean(entry.path_or_trigger)}`;
  if (entry.path_or_trigger) return clean(entry.path_or_trigger);
  return clean(entry.name);
}
function journeyTitle(journey) {
  const stored = clean(journey.name);
  const beforeArrow = stored.split('->')[0].trim();
  const withoutEntrySuffix = beforeArrow.replace(/\s*\((GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s[^)]*\)\s*$/i, '').trim();
  if (withoutEntrySuffix) return withoutEntrySuffix.charAt(0).toUpperCase() + withoutEntrySuffix.slice(1);
  const fallback = journeyWordsFromIdentifier(journeyEntryLabel(journey));
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : 'Journey';
}
function joinJourneyNames(names, cap) {
  if (names.length <= cap) return names.join(', ');
  return `${names.slice(0, cap).join(', ')} +${names.length - cap} more`;
}
function journeyOutcomePhrase(journey) {
  const verbs = { created: 'creates', updated: 'updates', deleted: 'deletes' };
  const byAccess = new Map();
  for (const terminal of arr(journey.terminal_entities)) {
    if (!terminal || !terminal.name) continue;
    const names = byAccess.get(terminal.access) || [];
    if (!names.includes(terminal.name)) names.push(terminal.name);
    byAccess.set(terminal.access, names);
  }
  const writes = [];
  for (const access of ['created', 'updated', 'deleted']) {
    const names = byAccess.get(access);
    if (names && names.length) writes.push(`${verbs[access]} ${joinJourneyNames(names, 3)}`);
  }
  if (writes.length) return writes.join(', ');
  const written = arr(obj(journey.terminal_effects).entities_written);
  if (written.length) return `writes ${joinJourneyNames(written, 3)}`;
  const readNames = byAccess.get('read') || arr(obj(journey.terminal_effects).entities_read);
  if (readNames.length) return `reads ${joinJourneyNames(readNames, 3)}`;
  return '';
}
function classifyGuardKind(guardName) {
  const name = String(guardName || '').toLowerCase();
  if (!name) return 'unknown';
  if (/throttl|rate[-_]?limit/.test(name)) return 'rate-limiting';
  if (/authoriz|role|permission|policy|policies|acl|rbac|abac|grant|tenant|organization|owner|scope/.test(name)) return 'authorization';
  if (/csrf|xsrf|recaptcha|captcha/.test(name)) return 'validation';
  if (/auth|jwt|session|api[-_]?key|apikey|oauth|sso|login|signin|sign[-_]?in|token|bearer|passport|credential|identity/.test(name)) return 'authentication';
  if (/valid|sanitiz|schema/.test(name)) return 'validation';
  return 'unknown';
}
const GUARD_KIND_ORDER = ['authentication', 'authorization', 'rate-limiting', 'validation', 'unknown'];
const GUARD_KIND_LABELS = { authentication: 'auth', authorization: 'authorization', 'rate-limiting': 'rate-limited', validation: 'validation', unknown: '' };
function journeyGuardPhrase(journey) {
  const byKind = new Map();
  const seen = new Set();
  for (const boundary of arr(journey.security_boundaries)) {
    const name = clean(boundary && boundary.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const kind = (boundary && boundary.kind) || classifyGuardKind(name);
    const names = byKind.get(kind) || [];
    names.push(name);
    byKind.set(kind, names);
  }
  if (!seen.size) return 'unguarded';
  const hasAuth = byKind.has('authentication');
  const kindsPresent = GUARD_KIND_ORDER.filter(kind => byKind.has(kind));
  if (!hasAuth && kindsPresent.length === 1 && kindsPresent[0] === 'rate-limiting') {
    return `rate-limited (${joinJourneyNames(byKind.get('rate-limiting'), 2)}), no auth guard`;
  }
  const segments = kindsPresent.map(kind => {
    const names = joinJourneyNames(byKind.get(kind), 2);
    const label = GUARD_KIND_LABELS[kind];
    return label ? `${label}: ${names}` : names;
  });
  return `guarded (${segments.join('; ')})${hasAuth ? '' : ', no auth guard'}`;
}
function journeyTestPhrase(journey) {
  const count = arr(journey.tests_covering).length;
  if (count === 0) return 'no tests';
  return count === 1 ? '1 test' : `${count} tests`;
}
function journeyHeadline(journey) {
  const chain = [journeyEntryLabel(journey), journeyOutcomePhrase(journey)].filter(Boolean).join(' -> ');
  const stepCount = arr(journey.steps).length;
  const facts = [
    stepCount > 0 ? `${stepCount} step${stepCount === 1 ? '' : 's'}` : '',
    journeyGuardPhrase(journey),
    journeyTestPhrase(journey),
  ].filter(Boolean).join(', ');
  return `${journeyTitle(journey)}: ${chain}${facts ? `; ${facts}` : ''}`;
}
function displayJourneySteps(journey) {
  const entryLabel = journeyEntryLabel(journey).toLowerCase();
  const result = [];
  let previousLabel = '';
  for (const step of arr(journey.steps)) {
    const label = journeyWordsFromIdentifier(step.name).toLowerCase();
    if (!label || label === entryLabel || label === previousLabel) continue;
    result.push(step);
    previousLabel = label;
  }
  return result.length ? result : arr(journey.steps);
}
function compressJourneySteps(steps) {
  if (steps.length <= 7) return { leading: steps, omitted: 0, trailing: [] };
  return { leading: steps.slice(0, 3), omitted: steps.length - 5, trailing: steps.slice(-2) };
}

function storedJourneyNameParts(name) {
  const raw = clean(name);
  const entryMatch = /\(((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s[^)]*)\)\s*$/i.exec(raw);
  const entry = entryMatch ? entryMatch[1] : '';
  const withoutEntry = entryMatch ? raw.slice(0, entryMatch.index).trim() : raw;
  const arrowIndex = withoutEntry.indexOf('->');
  if (arrowIndex === -1) return { title: withoutEntry, outcome: '', entry };
  return {
    title: withoutEntry.slice(0, arrowIndex).trim(),
    outcome: withoutEntry.slice(arrowIndex + 2).trim().replace(/\(\+(\d+) more\)/, '+$1 more'),
    entry,
  };
}
function storedJourneyNameHeadline(name) {
  const { title, outcome, entry } = storedJourneyNameParts(name);
  const chain = [entry, outcome].filter(Boolean).join(' -> ');
  return chain ? `${title}: ${chain}` : title;
}

function journeyData(cas) {
  const journeys = arr(cas.user_journeys);
  if (!journeys.length) return { ...pillarAbsence(cas, 'user journeys'), summary: null, items: [] };
  const items = journeys.slice(0, 50).map(j => ({
    id: clean(j.id),
    name: clean(j.name),
    title: journeyTitle(j),
    headline: journeyHeadline(j),
    kind: clean(j.journey_kind),
    criticality: clean(j.criticality),
    risk: clean(j.risk),
    entry: {
      type: clean(j.entry?.type),
      name: clean(j.entry?.name),
      method: clean(j.entry?.method),
      path_or_trigger: clean(j.entry?.path_or_trigger),
      handler_node_id: clean(j.entry?.handler_node_id),
    },
    steps: arr(j.steps).slice(0, 40).map(s => ({ name: clean(s.name), label: journeyWordsFromIdentifier(s.name), layer: clean(s.layer), depth: s.depth, node_id: clean(s.node_id) })),
    display_steps: (() => {
      const visible = displayJourneySteps(j).slice(0, 40).map(s => ({ label: journeyWordsFromIdentifier(s.name), layer: clean(s.layer) }));
      const { leading, omitted, trailing } = compressJourneySteps(visible);
      return { leading, omitted, trailing, total: visible.length };
    })(),
    step_count: arr(j.steps).length,
    terminal_entities: arr(j.terminal_entities).slice(0, 10).map(t => ({ name: clean(t.name), access: clean(t.access), kind: clean(t.terminal_kind) })),
    effects: {
      written: arr(j.terminal_effects?.entities_written).slice(0, 8).map(clean),
      read: arr(j.terminal_effects?.entities_read).slice(0, 8).map(clean),
      external: arr(j.terminal_effects?.external_services).slice(0, 8).map(clean),
      messages: arr(j.terminal_effects?.messages_emitted).slice(0, 8).map(clean),
    },
    boundaries: arr(j.security_boundaries).slice(0, 8).map(b => ({ name: clean(b.name), mechanism: clean(b.mechanism), kind: clean(b.kind) || classifyGuardKind(b.name) })),
    tests_covering: arr(j.tests_covering).length,
    provenance: {
      entry_point_id: clean(j.entry_point_id),
      call_chains: arr(j.call_chain_ids).length,
      exit_points: arr(j.exit_point_ids).length,
    },
  }));
  const rawSummary = obj(cas.user_journey_summary);
  const summary = Object.keys(rawSummary).length
    ? {
        total_discovered: rawSummary.total_discovered || journeys.length,
        included: rawSummary.included || items.length,
        by_kind: obj(rawSummary.by_kind),
      }
    : { total_discovered: journeys.length, included: items.length, by_kind: {} };
  return { present: true, notice: '', summary, items };
}

function conformanceData(cas) {
  const conformance = arr(cas.paradigm_conformance);
  if (!conformance.length) return { ...pillarAbsence(cas, 'paradigm conformance'), items: [] };
  const items = conformance.slice(0, 12).map(p => ({
    paradigm: clean(p.paradigm),
    description: truncate(p.description, 400),
    adoption: {
      following_count: obj(p.adoption).following_count || 0,
      comparable_count: obj(p.adoption).comparable_count || 0,
      adoption_rate: obj(p.adoption).adoption_rate || 0,
      evidence_files: arr(obj(p.adoption).evidence_files).slice(0, 6).map(clean),
    },
    deviations: arr(p.deviations).slice(0, 40).map(d => ({
      file: clean(d.file),
      node_id: clean(d.node_id),
      kind: clean(d.kind),
      detail: truncate(d.detail, 300),
      severity: clean(d.severity),
    })),
    deviation_count: arr(p.deviations).length,
  }));
  return { present: true, notice: '', items };
}

function lineageData(cas) {
  const lineage = arr(cas.data_lineage);
  if (!lineage.length) return { ...pillarAbsence(cas, 'data lineage'), items: [] };
  const items = lineage.slice(0, 80).map(l => ({
    entity_id: clean(l.entity_id),
    entity_name: clean(l.entity_name),
    sensitive_fields: arr(l.sensitive_fields).slice(0, 12).map(clean),
    writers: arr(l.writers).length,
    readers: arr(l.readers).length,
    writer_samples: arr(l.writers).slice(0, 5).map(w => ({ node_id: clean(w.node_id), file: clean(w.file), via: clean(w.via) })),
    reader_samples: arr(l.readers).slice(0, 5).map(r => ({ node_id: clean(r.node_id), file: clean(r.file), via: clean(r.via) })),
    external_recipients: arr(l.external_recipients).slice(0, 8).map(x => ({ service: clean(x.service), via_node: clean(x.via_node), exit_point_id: clean(x.exit_point_id) })),
    boundaries_crossed: arr(l.boundaries_crossed).slice(0, 8).map(b => ({ boundary: clean(b.boundary), guarded: !!b.guarded, ...(arr(b.guard_kinds).length ? { guard_kinds: arr(b.guard_kinds).slice(0, 5).map(clean) } : {}) })),
    journeys_carrying: arr(l.journeys_carrying).length,
    exposure: {
      unguarded_paths: obj(l.exposure).unguarded_paths || 0,
      non_auth_guarded_paths: obj(l.exposure).non_auth_guarded_paths || 0,
      external_transfer: !!obj(l.exposure).external_transfer,
      sensitive: !!obj(l.exposure).sensitive,
    },
  }));
  items.sort((a, b) => (Number(b.exposure.sensitive) - Number(a.exposure.sensitive)) || (b.exposure.unguarded_paths - a.exposure.unguarded_paths) || ((b.writers + b.readers) - (a.writers + a.readers)));
  const sensitiveCount = items.filter(i => i.exposure.sensitive).length;
  const externalCount = items.filter(i => i.exposure.external_transfer).length;
  return { present: true, notice: '', total: lineage.length, sensitive_count: sensitiveCount, external_transfer_count: externalCount, items };
}

function productMapData(cas) {
  const map = cas.product_map && typeof cas.product_map === 'object' ? cas.product_map : null;
  if (!map) return { ...pillarAbsence(cas, 'the stored product map'), map: null };
  const identity = obj(map.identity);
  const journeys = obj(map.journeys);
  const data = obj(map.data);
  const conventions = obj(map.conventions);
  const health = obj(map.health);
  return {
    present: true,
    notice: '',
    map: {
      identity: {
        name: clean(identity.name),
        domain: clean(identity.domain),
        domain_source: clean(identity.domain_source),
        description: truncate(identity.description, 720),
        description_source: clean(identity.description_source),
        unanalyzed_languages: arr(identity.unanalyzed_languages).slice(0, 8).map(l => ({ name: clean(l.name), files: l.files || 0, share_of_source: l.share_of_source || 0 })),
      },
      capabilities: arr(map.capabilities).slice(0, 60).map(c => ({
        name: clean(c.name),
        description: truncate(c.description, 280),
        description_source: clean(c.description_source),
        category: clean(c.category),
        criticality: clean(c.criticality),
        journeys: arr(c.journeys).slice(0, 6).map(j => ({ id: clean(j.id), name: clean(j.name) })),
        entities: arr(c.entities).slice(0, 8).map(clean),
        tests_present: !!c.tests_present,
        risk_level: clean(c.risk_level),
      })),
      journeys: {
        total: journeys.total || 0,
        user_facing: journeys.user_facing || 0,
        system: journeys.system || 0,
        scheduled: journeys.scheduled || 0,
        top: arr(journeys.top).slice(0, 12).map(j => ({ id: clean(j.id), name: clean(j.name), title: storedJourneyNameParts(j.name).title || clean(j.name), headline: storedJourneyNameHeadline(j.name), kind: clean(j.kind), criticality: clean(j.criticality), boundaries: [...new Set(arr(j.boundaries).slice(0, 5).map(clean))], tests: j.tests || 0 })),
      },
      data: {
        entities: data.entities || 0,
        sensitive: arr(data.sensitive).slice(0, 16).map(clean),
        exposure_highlights: arr(data.exposure_highlights).slice(0, 12).map(x => ({
          entity: clean(x.entity),
          sensitive_fields: arr(x.sensitive_fields).slice(0, 8).map(clean),
          unguarded_paths: x.unguarded_paths || 0,
          non_auth_guarded_paths: x.non_auth_guarded_paths || 0,
          external_transfer: !!x.external_transfer,
          external_recipients: arr(x.external_recipients).slice(0, 6).map(clean),
        })),
      },
      conventions: {
        paradigms: arr(conventions.paradigms).slice(0, 10).map(p => ({ paradigm: clean(p.paradigm), description: truncate(p.description, 240), adoption_rate: p.adoption_rate || 0, following_count: p.following_count || 0, comparable_count: p.comparable_count || 0 })),
        open_deviations: obj(conventions.open_deviations),
      },
      health: {
        status: clean(health.status),
        score: health.score,
        tests: obj(health.tests),
        implementation: obj(health.implementation),
        top_risks: arr(health.top_risks).slice(0, 8).map(r => ({ name: clean(r.name), level: clean(r.level), type: clean(r.type), recommendation: truncate(r.recommendation, 240) })),
      },
      coverage_caveats: arr(map.coverage_caveats).slice(0, 8).map(clean),
    },
  };
}

function explicitCrossCodebaseData(cas) {
  const rawLinks = [
    ...arr(cas.cross_repo_links),
    ...arr(cas.cross_codebase_links),
    ...arr(cas.workspace_connections),
    ...arr(cas.project_connections),
    ...arr(cas.cross_repo_contracts?.links),
    ...arr(cas.cross_repo_contracts?.provided_contracts),
    ...arr(cas.cross_repo_contracts?.consumed_contracts),
  ];
  return {
    links: rawLinks.slice(0, 80).map(link => ({
      id: clean(link.id || link.link_id || link.contract_id || link.name || link.source || link.provider || link.consumer),
      name: nameOf(link) || clean(link.contract || link.endpoint || link.topic || link.database || link.library) || 'Workspace link',
      source: clean(link.source || link.provider || link.from || link.source_codebase || link.repository),
      target: clean(link.target || link.consumer || link.to || link.target_codebase || link.remote_repository),
      kind: clean(link.kind || link.type || link.contract_type || link.protocol || link.interface_type),
      evidence: arr(link.evidence).slice(0, 6).map(e => typeof e === 'string' ? clean(e) : clean(e.file || e.detail || e.name || JSON.stringify(e).slice(0, 160))),
      confidence: link.confidence,
      description: truncate(link.description || link.summary || link.reason || link.endpoint || link.topic || link.database || link.library, 260),
    })).filter(link => link.name || link.source || link.target),
  };
}

function buildAnalysisEntry(cas, entry, projectPath) {
  const capabilities = topCapabilities(cas);
  const description = sanitizeDescription(cas.enhanced_system_purpose?.inferred_description || cas.system?.description || cas.architecture_summary?.summary || '', capabilities, cas);
  return {
    id: entry.file.replace(/\.json(\.zst|\.br)?$/, ''), name: entry.name || cas.system?.name || path.basename(projectPath), path: projectPath, file: entry.file,
    analyzed_at: entry.analyzed_at, system_type: entry.system_type || cas.system?.type,
    cas_version: clean(cas.cas_version),
    description, description_source: cas.enhanced_system_purpose?.inferred_description ? 'enhanced_system_purpose.inferred_description' : 'summary fallback', description_confidence: cas.enhanced_system_purpose?.confidence ?? cas.system_purpose?.confidence,
    counts: { nodes: arr(cas.nodes).length, edges: arr(cas.edges).length, entry_points: arr(cas.entry_points).length, exit_points: arr(cas.exit_points).length, tests: arr(cas.test_suites).length || arr(cas.tests).length, errors: arr(cas.analysis_errors).length, capabilities: arr(cas.system_capabilities).length },
    tech: tech(cas), capabilities, domains: domains(cas), entities: entities(cas), flows: flows(cas), risks: risks(cas), tests: testData(cas), architecture: architecture(cas), composition: composition(cas), idioms: { summary: truncate(cas.idiom_summary?.summary || cas.idiom_summary?.description || '', 360), items: compactList(cas.codebase_idioms, 18) }, graph: graphPreview(cas), facts: compactList(cas.analysis_facts, 16), integrations: compactList(cas.external_services, 18),
    journeys: journeyData(cas),
    lineage: lineageData(cas),
    conformance: conformanceData(cas),
    product_map: productMapData(cas),
    cross_codebase: explicitCrossCodebaseData(cas),
  };
}

function readStoredCrossCodebaseGraphs(root) {
  const directories = ['workspace-analyses', 'cross-codebase-analyses']
    .map(name => path.join(root, name))
    .filter(directory => fs.existsSync(directory));
  return directories
    .flatMap(directory => fs.readdirSync(directory)
      .filter(file => file.endsWith('.json') || file.endsWith('.json.zst') || file.endsWith('.json.br'))
      .map(file => {
        try {
          return readJsonMaybeCompressed(path.join(directory, file));
        } catch {
          return null;
        }
      }))
    .filter(Boolean)
    .sort((a, b) => clean(b.saved_at || b.generated_at).localeCompare(clean(a.saved_at || a.generated_at)));
}

function compactCrossCodebaseGraph(graph) {
  const codebaseName = new Map(arr(graph.codebases).map(codebase => [clean(codebase.id), clean(codebase.name || codebase.id)]));
  const applicationName = new Map(arr(graph.applications).map(app => [clean(app.id), clean(app.name || app.id)]));
  const interfaces = new Map(arr(graph.interfaces).map(item => [clean(item.id), item]));
  const runtimeComponents = new Map(arr(graph.runtime_components).map(item => [clean(item.id), item]));
  const links = arr(graph.links).slice(0, 120).map(link => {
    const source = interfaces.get(clean(link.source_interface_id));
    const target = interfaces.get(clean(link.target_interface_id));
    return {
      id: clean(link.id),
      name: `${clean(source?.name || link.source_interface_id)} → ${clean(target?.name || link.target_interface_id)}`,
      description: `${clean(link.kind)} over ${clean(link.mode)} from ${applicationName.get(clean(link.source_application_id)) || codebaseName.get(clean(link.source_codebase_id)) || clean(link.source_codebase_id)} to ${applicationName.get(clean(link.target_application_id)) || codebaseName.get(clean(link.target_codebase_id)) || clean(link.target_codebase_id)}.`,
      source: codebaseName.get(clean(link.source_codebase_id)) || clean(link.source_codebase_id),
      target: codebaseName.get(clean(link.target_codebase_id)) || clean(link.target_codebase_id),
      source_application: applicationName.get(clean(link.source_application_id)) || '',
      target_application: applicationName.get(clean(link.target_application_id)) || '',
      source_interface: clean(source?.name || link.source_interface_id),
      target_interface: clean(target?.name || link.target_interface_id),
      kind: clean(link.kind),
      mode: clean(link.mode),
      confidence: link.confidence,
      evidence: arr(link.evidence).slice(0, 6).map(clean),
    };
  });
  const runtimeLinks = arr(graph.runtime_links).slice(0, 160).map(link => {
    const source = runtimeComponents.get(clean(link.source_component_id));
    const target = runtimeComponents.get(clean(link.target_component_id));
    return {
      id: clean(link.id),
      name: `${clean(source?.name || link.source_component_id)} → ${clean(target?.name || link.target_component_id)}`,
      description: `${clean(link.kind)} within ${codebaseName.get(clean(link.codebase_id)) || clean(link.codebase_id)} runtime topology.`,
      codebase_name: codebaseName.get(clean(link.codebase_id)) || clean(link.codebase_id),
      source: clean(source?.name || link.source_component_id),
      target: clean(target?.name || link.target_component_id),
      kind: clean(link.kind),
      mode: clean(link.mode),
      confidence: link.confidence,
      evidence: arr(link.evidence).slice(0, 6).map(clean),
    };
  });
  const applicationLinks = arr(graph.application_links || graph.integration_links).slice(0, 180).map(link => ({
    id: clean(link.id),
    name: `${applicationName.get(clean(link.source_application_id)) || clean(link.source_application_id)} → ${applicationName.get(clean(link.target_application_id)) || clean(link.target_application_id)}`,
    description: `${clean(link.kind)} over ${clean(link.mode)} from ${applicationName.get(clean(link.source_application_id)) || codebaseName.get(clean(link.source_codebase_id)) || clean(link.source_codebase_id)} to ${applicationName.get(clean(link.target_application_id)) || codebaseName.get(clean(link.target_codebase_id)) || clean(link.target_codebase_id)}.`,
    source: codebaseName.get(clean(link.source_codebase_id)) || clean(link.source_codebase_id),
    target: codebaseName.get(clean(link.target_codebase_id)) || clean(link.target_codebase_id),
    source_application: applicationName.get(clean(link.source_application_id)) || '',
    target_application: applicationName.get(clean(link.target_application_id)) || '',
    kind: clean(link.kind),
    mode: clean(link.mode),
    confidence: link.confidence,
    evidence: arr(link.evidence).slice(0, 6).map(clean),
  }));
  return {
    id: clean(graph.id),
    name: clean(graph.name),
    generated_at: clean(graph.generated_at),
    saved_at: clean(graph.saved_at),
    counts: {
      codebases: arr(graph.codebases).length,
      applications: arr(graph.applications).length,
      interfaces: arr(graph.interfaces).length,
      links: Math.max(arr(graph.links).length, applicationLinks.length),
      data_flows: arr(graph.data_flow_paths).length,
      runtime_components: arr(graph.runtime_components).length,
      runtime_links: arr(graph.runtime_links).length,
      application_links: applicationLinks.length,
      unmatched: arr(graph.unmatched_interfaces).length,
    },
    codebases: arr(graph.codebases).map(codebase => ({
      id: clean(codebase.id),
      name: clean(codebase.name || codebase.id),
      path: clean(codebase.path),
      languages: arr(codebase.languages).slice(0, 6).map(clean),
      frameworks: arr(codebase.frameworks).slice(0, 6).map(clean),
    })),
    applications: arr(graph.applications).map(app => ({
      id: clean(app.id),
      codebase_id: clean(app.codebase_id),
      codebase_name: codebaseName.get(clean(app.codebase_id)) || clean(app.codebase_id),
      name: clean(app.name || app.id),
      kind: clean(app.kind),
      path_hint: clean(app.path_hint),
      service_aliases: arr(app.service_aliases).slice(0, 8).map(clean),
      ports: arr(app.ports).slice(0, 8).map(clean),
      interface_count: arr(app.interface_ids).length,
      runtime_component_count: arr(app.runtime_component_ids).length,
    })),
    interfaces: arr(graph.interfaces).slice(0, 240).map(item => ({
      id: clean(item.id),
      codebase_id: clean(item.codebase_id),
      codebase_name: codebaseName.get(clean(item.codebase_id)) || clean(item.codebase_id),
      application_name: applicationName.get(clean(item.application_id)) || '',
      direction: clean(item.role),
      kind: clean(item.kind),
      mode: clean(item.mode),
      name: clean(item.name),
      description: clean([item.method, item.endpoint || item.topic || item.package_name || item.resource].filter(Boolean).join(' ')),
      evidence: arr(item.refs).map(ref => clean(ref.file || ref.name || ref.id)).filter(Boolean).slice(0, 3).join(', '),
    })),
    data_flows: arr(graph.data_flow_paths).slice(0, 160).map(flow => ({
      id: clean(flow.id),
      codebase_id: clean(flow.source_codebase_id),
      codebase_name: codebaseName.get(clean(flow.source_codebase_id)) || clean(flow.source_codebase_id),
      entity: clean(flow.description || flow.id),
      path: arr(flow.via).map(clean).filter(Boolean),
      destination: codebaseName.get(clean(flow.target_codebase_id)) || clean(flow.target_codebase_id),
      source_application: applicationName.get(clean(flow.source_application_id)) || '',
      target_application: applicationName.get(clean(flow.target_application_id)) || '',
      sensitivity: clean(flow.mode),
      guard: `${Math.round(Number(flow.confidence || 0) * 100)}% confidence`,
      evidence: clean(flow.target_interface_id),
    })),
    links: links.length ? links : applicationLinks,
    application_links: applicationLinks,
    runtime_links: runtimeLinks,
    unmatched: arr(graph.unmatched_interfaces).slice(0, 160).map(item => ({
      id: clean(item.interface_id),
      name: clean(item.name),
      codebase_name: codebaseName.get(clean(item.codebase_id)) || clean(item.codebase_id),
      kind: clean(item.kind),
      role: clean(item.role),
      mode: clean(item.mode),
      reason: clean(item.reason),
    })),
  };
}

function projectOverviewData(analyses, crossCodebaseGraphs = []) {
  const codebases = arr(analyses).map(analysis => ({
    id: clean(analysis.id),
    name: clean(analysis.name),
    path: clean(analysis.path),
    system_type: clean(analysis.system_type),
    description: truncate(analysis.description, 260),
    framework: clean(arr(analysis.tech?.frameworks)[0] || analysis.system_type || 'analysis'),
    language: clean(arr(analysis.tech?.languages)[0] || ''),
    counts: {
      nodes: analysis.counts?.nodes || 0,
      edges: analysis.counts?.edges || 0,
      entry_points: analysis.counts?.entry_points || 0,
      exit_points: analysis.counts?.exit_points || 0,
      tests: analysis.counts?.tests || 0,
      capabilities: analysis.counts?.capabilities || 0,
    },
    capabilities: arr(analysis.capabilities).slice(0, 4).map(capability => ({ name: capability.name, description: truncate(capability.description, 160) })),
    risks: arr(analysis.risks).slice(0, 3).map(risk => ({ name: risk.name, severity: risk.severity || risk.type || '' })),
  }));
  const systemGraphs = arr(crossCodebaseGraphs).map(compactCrossCodebaseGraph);
  const primarySystemGraph = systemGraphs[0] || null;
  const interfaces = primarySystemGraph ? [...primarySystemGraph.interfaces] : [];
  const dataFlows = primarySystemGraph ? [...primarySystemGraph.data_flows] : [];
  const links = primarySystemGraph ? [...primarySystemGraph.links] : [];
  const runtimeLinks = primarySystemGraph ? [...primarySystemGraph.runtime_links] : [];
  for (const analysis of arr(analyses)) {
    const codebaseId = clean(analysis.id);
    const codebaseName = clean(analysis.name);
    for (const entry of arr(analysis.flows).slice(0, 10)) {
      interfaces.push({
        id: `${codebaseId}:flow:${interfaces.length}`,
        codebase_id: codebaseId,
        codebase_name: codebaseName,
        direction: 'entry',
        kind: clean(entry.type || 'workflow'),
        name: clean(entry.name),
        description: truncate(entry.description, 220),
        evidence: clean(entry.file || entry.severity || ''),
      });
    }
    for (const service of arr(analysis.integrations).slice(0, 10)) {
      interfaces.push({
        id: `${codebaseId}:integration:${interfaces.length}`,
        codebase_id: codebaseId,
        codebase_name: codebaseName,
        direction: 'external',
        kind: clean(service.type || service.category || 'integration'),
        name: clean(service.name),
        description: truncate(service.description, 220),
        evidence: clean(service.file || service.severity || ''),
      });
    }
    for (const lineage of arr(analysis.lineage?.items).slice(0, 12)) {
      for (const recipient of arr(lineage.external_recipients)) {
        dataFlows.push({
          id: `${codebaseId}:lineage:${dataFlows.length}`,
          codebase_id: codebaseId,
          codebase_name: codebaseName,
          entity: clean(lineage.entity_name),
          path: [clean(lineage.entity_name), clean(recipient.via_node), clean(recipient.service)].filter(Boolean),
          destination: clean(recipient.service),
          sensitivity: lineage.exposure?.sensitive ? 'sensitive' : 'standard',
          guard: lineage.exposure?.unguarded_paths ? `${lineage.exposure.unguarded_paths} unguarded paths` : 'guarded or not recorded',
          evidence: clean(recipient.exit_point_id || recipient.via_node),
        });
      }
    }
    for (const journey of arr(analysis.journeys?.items).slice(0, 8)) {
      for (const external of arr(journey.effects?.external)) {
        dataFlows.push({
          id: `${codebaseId}:journey:${dataFlows.length}`,
          codebase_id: codebaseId,
          codebase_name: codebaseName,
          entity: clean(journey.title || journey.name),
          path: [clean(journey.entry?.path_or_trigger || journey.entry?.name), clean(journey.title || journey.name), clean(external)].filter(Boolean),
          destination: clean(external),
          sensitivity: 'behavior',
          guard: arr(journey.boundaries).length ? 'entry boundary recorded' : 'no entry guards recorded',
          evidence: clean(journey.provenance?.entry_point_id),
        });
      }
    }
    if (!primarySystemGraph) for (const link of arr(analysis.cross_codebase?.links)) {
      links.push({ ...link, codebase_id: codebaseId, codebase_name: codebaseName });
    }
  }
  return {
    title: 'Workspace Overview',
    counts: {
      codebases: codebases.length,
      nodes: codebases.reduce((sum, item) => sum + item.counts.nodes, 0),
      edges: codebases.reduce((sum, item) => sum + item.counts.edges, 0),
      entry_points: codebases.reduce((sum, item) => sum + item.counts.entry_points, 0),
      exit_points: codebases.reduce((sum, item) => sum + item.counts.exit_points, 0),
      tests: codebases.reduce((sum, item) => sum + item.counts.tests, 0),
      interfaces: interfaces.length,
      data_flows: dataFlows.length,
      links: links.length,
      applications: primarySystemGraph?.counts.applications || 0,
      runtime_components: primarySystemGraph?.counts.runtime_components || 0,
      runtime_links: runtimeLinks.length,
      unmatched: primarySystemGraph?.counts.unmatched || 0,
    },
    codebases,
    applications: primarySystemGraph ? primarySystemGraph.applications : [],
    system_graph: primarySystemGraph,
    system_graphs: systemGraphs.slice(0, 12),
    interfaces,
    data_flows: dataFlows,
    links,
    runtime_links: runtimeLinks,
    notices: primarySystemGraph
      ? [`Project view is using persisted Klauro Workspace analysis "${primarySystemGraph.name}" generated ${primarySystemGraph.generated_at || 'unknown time'}.`]
      : (links.length ? [] : ['No persisted Workspace analysis was found. Run run_workspace_analysis or the workspace analysis gauntlet so this view can show matched project and runtime links without browser-side guessing.']),
  };
}

function renderHtml(payload, options = {}) {
  const generatorCommandPath = options.generatorCommandPath || __filename;
  const htmlPayload = { ...payload, project_overview: payload.project_overview || projectOverviewData(payload.analyses || []) };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Klauro Analysis Dashboard</title><style>
:root{--bg:#22242b;--sidebar:#2a2c36;--card:#2a2c36;--card2:#303340;--deep:#12131a;--stroke:#3f414a;--stroke2:#45455a;--text:#fff;--muted:#9ba3c0;--muted2:#717680;--purple:#8b5cf6;--pink:#ff3d66;--green:#7ed957;--blue:#3fa7ff;--amber:#ffb74d;--red:#ff4f6d;--radius:12px;--font:Urbanist,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;letter-spacing:0}.app{display:grid;grid-template-columns:258px 1fr;min-height:100vh}.side{background:var(--sidebar);border-right:.5px solid rgba(69,69,90,.35);min-height:100vh;display:flex;flex-direction:column;justify-content:space-between;position:sticky;top:0}.side-top{padding:32px 16px 24px}.brand{display:flex;align-items:center;gap:8px;padding:0 8px 28px;border-bottom:.5px solid var(--stroke2);margin:0 -16px 20px 0}.brand-mark{width:29px;height:30px;border-radius:8px;background:linear-gradient(135deg,#ff494f,#c13bff);position:relative}.brand-text{font-weight:800;font-size:24px}.nav{display:flex;flex-direction:column;gap:2px}.nav-row{height:40px;border-radius:6px;display:flex;align-items:center;gap:10px;padding:8px 12px;color:#a4a7ae}.nav-row.active{background:var(--stroke2);color:#fff;font-weight:700}.nav-icon{width:16px;height:16px;border:1.5px solid currentColor;border-radius:4px;opacity:.8}.badge{margin-left:auto;border:1px solid var(--stroke2);border-radius:16px;min-width:24px;height:24px;display:grid;place-items:center;font-size:12px;font-weight:700}.work-label{font-size:11px;color:#717680;text-transform:uppercase;margin:26px 8px 8px}.repo-search{width:100%;background:#23252e;border:1px solid var(--stroke);color:#fff;border-radius:8px;padding:10px 12px;margin:0 0 10px}.repo-list{display:flex;flex-direction:column;gap:6px;max-height:56vh;overflow:auto}.repo{border:0;background:transparent;color:#a4a7ae;text-align:left;border-radius:6px;padding:8px 10px;cursor:pointer}.repo.active{background:#45455a;color:#fff}.repo b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.repo span{font-size:11px;color:#828690}.side-bottom{padding:20px 16px}.main{padding:24px 32px 48px;max-width:1500px}.crumb{display:flex;gap:10px;align-items:center;color:#828690;font-size:12px;margin-bottom:24px}.crumb .current{color:#a78bfa;background:#342f52;border-radius:4px;padding:2px 6px}.topbar{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:28px}.status{font-size:11px;color:var(--green);margin-bottom:6px}.title{display:flex;align-items:center;gap:10px}.title h1{font-size:30px;line-height:1.08;margin:0}.source-pill{border:1px solid var(--stroke2);border-radius:16px;padding:4px 9px;color:#fff;font-size:12px}.desc{color:#d9dce7;line-height:1.45;max-width:920px;margin-top:10px}.actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end}.btn{border:0;border-radius:24px;padding:10px 16px;font-weight:700;color:#fff;background:#353743;cursor:pointer}.btn.primary{background:var(--purple)}.btn.small{padding:7px 10px;border-radius:12px;font-size:12px}.reanalyze-panel{display:none;background:#303340;border:.5px solid var(--stroke);border-radius:12px;margin:-10px 0 24px;padding:18px}.reanalyze-panel.active{display:block}.reanalyze-panel h3{margin:0 0 8px}.reanalyze-panel p{color:#9ba3c0;line-height:1.45;margin:0 0 12px}.command-row{display:flex;gap:10px;align-items:center}.cmd{flex:1;background:#171922;border:.5px solid var(--stroke);border-radius:8px;padding:10px 12px;color:#dfe3f0;white-space:nowrap;overflow:auto}.bridge-status{font-size:12px;color:#9ba3c0;margin-top:10px}.summary{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}.summary-card{background:var(--card);border:.5px solid var(--stroke);border-radius:12px;padding:20px}.eyebrow{font-size:11px;color:var(--green);font-weight:800;text-transform:uppercase;margin-bottom:10px}.summary-card.alt .eyebrow{color:#79c7ff}.summary-card h2{font-size:21px;margin:0 0 8px}.summary-card p{margin:0;color:#9ba3c0;line-height:1.45}.tabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}.tab{border:0;background:#2a2c36;color:#a4a7ae;border-radius:999px;padding:9px 14px;cursor:pointer}.tab.active{background:#45455a;color:#fff}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.card{background:var(--card);border:.5px solid var(--stroke);border-radius:12px;padding:24px;overflow:hidden}.card.dark{background:var(--deep)}.span-3{grid-column:span 3}.span-4{grid-column:span 4}.span-5{grid-column:span 5}.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}.span-12{grid-column:span 12}.card-head{display:flex;align-items:center;gap:8px;margin-bottom:18px}.card-head h2{font-size:22px;margin:0}.card-head small{color:#9ba3c0}.mini-icon{width:18px;height:18px;border-radius:4px;border:1.5px solid var(--pink)}.cap-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.cap{background:transparent;border-radius:10px;padding:8px;min-height:126px;cursor:pointer}.cap:hover{background:rgba(69,69,90,.35)}.cap .icon{width:18px;height:18px;border-radius:5px;background:rgba(139,92,246,.18);color:var(--purple);display:grid;place-items:center;font-size:11px;margin-bottom:10px}.cap h3{font-size:15px;margin:0 0 6px}.cap p{font-size:12px;line-height:1.4;color:#9ba3c0;margin:0}.health{display:flex;justify-content:space-between;margin-top:14px;font-size:11px;color:#9ba3c0}.health b{color:#d5ffe1}.entity-row{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.entity{background:#303340;border:.5px solid var(--stroke);border-radius:8px;padding:14px;cursor:pointer}.entity:hover{border-color:#6f58d9}.entity h3{font-size:14px;margin:0 0 8px}.entity .tag{display:inline-block;color:#d9b4ff;background:rgba(139,92,246,.14);font-size:11px;border-radius:999px;padding:3px 7px}.entity-stats{display:flex;gap:20px;margin-top:18px;font-size:11px;color:#828690}.composition{display:grid;grid-template-columns:280px 1fr;gap:20px}.metric{display:grid;grid-template-columns:1fr auto;gap:10px;padding:7px 0;border-bottom:.5px solid rgba(69,69,90,.6);color:#9ba3c0}.metric b{color:#fff}.bars{margin:18px 0}.bar{height:5px;background:#45455a;border-radius:99px;overflow:hidden;margin:7px 0 12px}.bar i{display:block;height:100%;background:linear-gradient(90deg,#f7c1a1,#e7f6d4,#7dd3fc)}.diagram{height:280px;background:#101118;border-radius:12px;position:relative;overflow:hidden}.nodebox{position:absolute;min-width:120px;background:#151821;border:.5px solid #30394a;border-radius:8px;padding:10px 12px}.nodebox b{font-size:12px}.nodebox span{display:block;font-size:10px;color:#828690;margin-top:4px}.nodebox.green{border-color:#285d3c}.nodebox.blue{border-color:#245f85}.nodebox.purple{border-color:#5b4489}.nodebox.amber{border-color:#74592d}.link{position:absolute;height:1px;background:#454b5a;transform-origin:left center}.integration-tabs{display:flex;gap:18px;border-bottom:.5px solid var(--stroke);margin:0 -24px 18px;padding:0 24px}.integration-tabs span{padding:0 0 12px;color:#a4a7ae}.integration-tabs .active{color:#fff;border-bottom:2px solid #fff}.item-list{display:grid;gap:10px}.item{background:#303340;border-left:3px solid var(--purple);border-radius:8px;padding:12px;cursor:pointer}.item.red{border-left-color:var(--red)}.item.amber{border-left-color:var(--amber)}.item.green{border-left-color:var(--green)}.item.blue{border-left-color:var(--blue)}.item h3{margin:0 0 5px;font-size:15px}.item p{margin:0;color:#9ba3c0;line-height:1.4}.item .meta{font-size:11px;color:#828690;margin-top:8px}.detail{display:none}.detail.active{display:block}.back{color:#a78bfa;cursor:pointer;margin-bottom:18px;display:inline-block}.detail-hero{background:var(--card);border:.5px solid var(--stroke);border-radius:12px;padding:28px;margin-bottom:18px}.detail-hero h1{margin:0 0 10px}.table{width:100%;border-collapse:collapse}.table th,.table td{border-bottom:.5px solid var(--stroke);text-align:left;padding:10px;color:#d9dce7}.table th{color:#828690;font-size:11px;text-transform:uppercase}.graph{height:620px;background:#101118;border-radius:12px;border:.5px solid var(--stroke);overflow:hidden}.graph svg{width:100%;height:100%}.edge{stroke:#454b5a;stroke-width:1;opacity:.6}.node-label{fill:#dfe3f0;font-size:10px;pointer-events:none}.empty{color:#828690;font-style:italic}.kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.notice{background:rgba(255,183,77,.1);border:.5px solid #74592d;color:#ffd9a0;border-radius:8px;padding:14px;line-height:1.5;margin:0 0 16px}
.journey{background:#303340;border:.5px solid var(--stroke);border-radius:10px;padding:16px;margin-bottom:14px}.journey h3{margin:0 0 8px;font-size:16px}.journey .headline{font-size:13px;color:#aeb6cf;margin:0 0 10px;line-height:1.5}.steps .step.marker{border-style:dashed;color:#8d93a5;font-style:italic}.fullchain{margin:2px 0 8px}.fullchain summary{font-size:11px;color:#828690;cursor:pointer}.journey .pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.pill{border:1px solid var(--stroke2);border-radius:999px;padding:2px 8px;font-size:11px;color:#c9cede}.pill.crit{border-color:#8a3040;color:#ff9cae}.pill.guard{border-color:#285d3c;color:#a9e8b9}.pill.kindpill{border-color:#5b4489;color:#d9b4ff}.steps{font-size:12px;line-height:2;color:#c9cede;margin:6px 0 10px}.steps .step{background:#23252e;border:.5px solid var(--stroke);border-radius:6px;padding:2px 7px;white-space:nowrap}.steps .step.entry{border-color:#245f85}.steps .step.business{border-color:#5b4489}.steps .step.data{border-color:#285d3c}.steps .step.infrastructure{border-color:#74592d}.steps .arrow{color:#717680;padding:0 3px}.effects{font-size:12px;color:#9ba3c0;line-height:1.6}.effects b{color:#d5ffe1}.effects .read b{color:#a8d2ff}.provenance{font-size:11px;color:#828690;margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.lineage-flags{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.flag{border-radius:6px;padding:2px 8px;font-size:11px}.flag.sensitive{background:rgba(255,79,109,.14);color:#ff9cae}.flag.external{background:rgba(255,183,77,.14);color:#ffd9a0}.flag.unguarded{background:rgba(255,79,109,.1);color:#ffb3c0}.flag.guarded{background:rgba(126,217,87,.12);color:#a9e8b9}
.adoption-rate{font-size:26px;font-weight:800}.adoption-rate small{font-size:12px;color:#9ba3c0;font-weight:400}.project-hero{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:16px;margin-bottom:16px}.project-card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.project-card{background:#303340;border:.5px solid var(--stroke);border-radius:10px;padding:16px;cursor:pointer;min-height:172px}.project-card:hover{border-color:#6f58d9}.project-card h3{margin:0 0 8px;font-size:17px}.project-card p{margin:0;color:#9ba3c0;line-height:1.4}.project-card .meta{font-size:11px;color:#828690;margin-top:12px}.project-map{height:420px;background:#101118;border-radius:12px;border:.5px solid var(--stroke);position:relative;overflow:auto}.project-node{position:absolute;width:210px;min-height:112px;background:#171b25;border:.5px solid #475166;border-left:4px solid var(--blue);border-radius:8px;padding:12px;cursor:pointer}.project-node:nth-child(3n+1){border-left-color:var(--green)}.project-node:nth-child(3n+2){border-left-color:var(--amber)}.project-node h3{font-size:14px;margin:0 0 5px}.project-node p{font-size:12px;color:#aeb6cf;margin:0}.project-node .meta{font-size:11px;color:#828690;margin-top:8px}.pathline{font-size:12px;color:#cbd2e6;line-height:1.7}.pathline .hop{display:inline-block;background:#23252e;border:.5px solid var(--stroke);border-radius:6px;padding:2px 7px;margin:2px}.project-notice{background:rgba(63,167,255,.09);border:.5px solid #245f85;color:#b8ddff;border-radius:8px;padding:14px;line-height:1.5;margin-bottom:16px}@media(max-width:1100px){.project-hero,.project-card-grid{grid-template-columns:1fr}.project-map{height:auto;min-height:580px}.project-node{position:relative!important;left:auto!important;top:auto!important;margin:12px}}
</style></head><body><div class="app"><aside class="side"><div class="side-top"><div class="brand"><div class="brand-mark"></div><div class="brand-text">klauro</div></div><nav class="nav"><div class="nav-row"><span class="nav-icon"></span>Dashboard</div><div class="nav-row"><span class="nav-icon"></span>Inbox<span class="badge">10</span></div><div class="nav-row"><span class="nav-icon"></span>Activity</div></nav><div class="work-label">Workspace</div><div class="nav-row active"><span class="nav-icon"></span>Local Analyses<span class="badge" id="analysisCount"></span></div><input id="search" class="repo-search" placeholder="Search repositories"><div id="repoList" class="repo-list"></div></div><div class="side-bottom"><div class="nav-row"><span class="nav-icon"></span>Help</div><div class="nav-row"><span class="nav-icon"></span>Settings</div></div></aside><main class="main"><section id="dashboard"></section><section id="detail" class="detail"></section></main></div><script id="payload" type="application/json">${JSON.stringify(htmlPayload).replace(/</g,'\\u003c')}</script><script>
const DATA=JSON.parse(document.getElementById('payload').textContent);let current=DATA.analyses[0];let view='overview';const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const num=v=>Number(v||0).toLocaleString();const pct=v=>Math.round(Number(v||0)*100)+'%';
function route(){const parts=location.hash.replace(/^#/,'').split('/').filter(Boolean);if(parts[0]==='project'){view=parts[1]||'overview';if(parts[2])return renderProjectDetail(parts[1],Number(parts[2]));return renderProject()}if(parts[0]==='analysis'){current=DATA.analyses.find(a=>a.id===parts[1])||current;view=parts[2]||'overview';if(parts[3])return renderDetail(parts[2],Number(parts[3]));}renderDashboard()}
function setRoute(nextView,index){location.hash='analysis/'+current.id+'/'+nextView+(index!==undefined?'/'+index:'')}
function setProjectRoute(nextView,index){location.hash='project/'+nextView+(index!==undefined?'/'+index:'')}
function repos(){const q=$('#search').value.toLowerCase();const projectActive=location.hash.startsWith('#project');$('#analysisCount').textContent=DATA.analysis_count;const overview='<button class="repo '+(projectActive?'active':'')+'" data-project="1"><b>Workspace Overview</b><span>'+num(DATA.project_overview?.counts?.codebases||DATA.analysis_count)+' codebases · '+num(DATA.project_overview?.counts?.interfaces||0)+' interfaces</span></button>';$('#repoList').innerHTML=overview+DATA.analyses.filter(a=>(a.name+' '+a.path+' '+(a.tech?.frameworks||[]).join(' ')).toLowerCase().includes(q)).map(a=>'<button class="repo '+(!projectActive&&a.id===current.id?'active':'')+'" data-id="'+esc(a.id)+'"><b>'+esc(a.name)+'</b><span>'+num(a.counts.nodes)+' nodes · '+esc((a.tech?.frameworks||[])[0]||a.system_type||'analysis')+'</span></button>').join('');document.querySelectorAll('.repo').forEach(b=>b.onclick=()=>{if(b.dataset.project){setProjectRoute('overview');return;}current=DATA.analyses.find(a=>a.id===b.dataset.id);setRoute('overview')})}
function pillList(items){return (items||[]).slice(0,6).map(x=>'<span class="source-pill">'+esc(x)+'</span>').join('')||'<span class="empty">None detected</span>'}
function metrics(rows){return rows.map(([k,v])=>'<div class="metric"><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>').join('')}
function bars(rows){const max=Math.max(1,...(rows||[]).map(r=>r.count));return (rows||[]).map(r=>'<div class="metric"><span>'+esc(r.name)+'</span><b>'+num(r.count)+'</b></div><div class="bar"><i style="width:'+Math.max(4,r.count/max*100)+'%"></i></div>').join('')}
function shellQuote(value){return "'"+String(value||'').replace(/'/g,"'\\\\''")+"'";}
function reanalysisCommand(){return 'cd /Users/michaelshattuck/dev/unravl/proof-of-concept/apps/mcp-server && npm run analyze -- '+shellQuote(current.path)+' --analysis-focus ui-overview --force --json && node ${generatorCommandPath}';}
function reanalyzePanel(){return '<div id="reanalyzePanel" class="reanalyze-panel"><h3>Reanalyze '+esc(current.name)+'</h3><p>Run a fresh Klauro analysis for this repository, then regenerate this inspector. Copy the command, or start the optional local bridge and trigger it from here.</p><div class="command-row"><code id="reanalyzeCommand" class="cmd">'+esc(reanalysisCommand())+'</code><button class="btn small" onclick="copyReanalysisCommand()">Copy</button><button class="btn small primary" onclick="triggerReanalysis()">Run via bridge</button></div><div id="bridgeStatus" class="bridge-status">Bridge command: <span class="kbd">cd /Users/michaelshattuck/dev/unravl/proof-of-concept/apps/mcp-server && npm run analysis-inspector-bridge</span></div></div>'}
function showReanalysisPanel(){const panel=$('#reanalyzePanel');if(panel)panel.classList.toggle('active');}
async function copyReanalysisCommand(){const text=reanalysisCommand();try{await navigator.clipboard.writeText(text);setBridgeStatus('Copied reanalysis command.')}catch{setBridgeStatus(text);}}
function setBridgeStatus(text){const el=$('#bridgeStatus');if(el)el.textContent=text;}
async function triggerReanalysis(){setBridgeStatus('Contacting local bridge...');try{const res=await fetch('http://127.0.0.1:48731/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:current.path})});const body=await res.json();if(!res.ok||!body.ok){setBridgeStatus('Bridge error: '+(body.error||res.status));return;}setBridgeStatus('Analysis started. Log: '+body.logPath+'. This page will not update until the job completes; reload after completion.');pollReanalysisJob(body.id);}catch(error){setBridgeStatus('Bridge not running. Start it with: cd /Users/michaelshattuck/dev/unravl/proof-of-concept/apps/mcp-server && npm run analysis-inspector-bridge');}}
async function pollReanalysisJob(id){for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,2000));try{const res=await fetch('http://127.0.0.1:48731/jobs/'+encodeURIComponent(id));const job=await res.json();if(job.status==='complete'){setBridgeStatus('Analysis complete. Reloading inspector...');setTimeout(()=>location.reload(),800);return;}if(job.status==='failed'){setBridgeStatus('Analysis failed: '+(job.error||'see log')+'. Log: '+job.logPath);return;}setBridgeStatus('Analysis '+job.status+'. Log: '+job.logPath);}catch{return;}}setBridgeStatus('Analysis is still running. Reload this page after it completes.');}
function itemList(items,kind){return (items||[]).length?(items||[]).map((x,i)=>'<div class="item '+(kind||'')+'" onclick="setRoute(\\''+(kind||'items')+'\\','+i+')"><h3>'+esc(x.name)+'</h3><p>'+esc(x.description||'No description available.')+'</p><div class="meta">'+esc([x.type,x.severity,x.file].filter(Boolean).join(' · '))+'</div></div>').join(''):'<div class="empty">No data in this section.</div>'}
function capCards(){return current.capabilities.slice(0,6).map((c,i)=>'<div class="cap" onclick="setRoute(\\'capabilities\\','+i+')"><div class="icon">↗</div><h3>'+esc(c.name)+'</h3><p>'+esc(c.description)+'</p><div class="health"><span>♡ '+c.health+'% healthy</span><span>'+esc(c.severity||'')+'</span></div></div>').join('')}
function entityCards(){return current.entities.slice(0,5).map((e,i)=>'<div class="entity" onclick="setRoute(\\'entities\\','+i+')"><h3>'+esc(e.name)+'</h3><span class="tag">'+esc(e.type||'Core')+'</span><div class="entity-stats"><span>'+num(e.fields||e.references?.length||0)+' fields</span><span>'+num(e.relations||0)+' rel</span></div></div>').join('')}
function pillarFallback(pillar,label){if(pillar&&pillar.notice)return '<div class="notice">'+esc(pillar.notice)+'</div>';return '<div class="empty">No '+esc(label)+' detected in this analysis.</div>'}
function pillarSummaryRows(){const j=current.journeys||{},l=current.lineage||{},c=current.conformance||{},p=current.product_map||{};return [['User journeys',j.present?num(j.summary?.included)+' of '+num(j.summary?.total_discovered)+' discovered':(j.notice?'predates pillars':'none')],['Data lineage',l.present?num(l.total)+' entities ('+num(l.sensitive_count)+' sensitive)':(l.notice?'predates pillars':'none')],['Paradigm conformance',c.present?num((c.items||[]).length)+' paradigms':(c.notice?'predates pillars':'none')],['Product map',p.present?'stored':(p.notice?'predates pillars':'none')]]}
function stepChip(s){return '<span class="step '+esc(s.layer)+'">'+esc(s.label||s.name)+'</span>'}
function journeyCard(j){const entry=[j.entry.method,j.entry.path_or_trigger||j.entry.name].filter(Boolean).join(' ');const ds=j.display_steps||{leading:(j.steps||[]).map(s=>({label:s.label||s.name,layer:s.layer})),omitted:0,trailing:[]};const arrow='<span class="arrow">→</span>';let steps=ds.leading.map(stepChip).join(arrow);if(ds.omitted>0){steps+=arrow+'<span class="step marker">'+num(ds.omitted)+' intermediate step'+(ds.omitted===1?'':'s')+'</span>'+arrow+ds.trailing.map(stepChip).join(arrow)}const fullChain=ds.omitted>0&&(j.steps||[]).length?'<details class="fullchain"><summary>Full chain ('+num(j.step_count)+' steps)</summary><div class="steps">'+(j.steps||[]).map(stepChip).join(arrow)+'</div></details>':'';const terminals=(j.terminal_entities||[]).map(t=>'<b>'+esc(t.name)+'</b> '+esc(t.access)).join(', ');const eff=j.effects||{};const boundaries=(j.boundaries||[]).map(b=>'<span class="pill guard">'+esc(b.name)+(b.mechanism?' · '+esc(b.mechanism):'')+'</span>').join(' ');return '<div class="journey"><h3>'+esc(j.title||j.name)+'</h3><div class="headline">'+esc(j.headline||j.name)+'</div><div class="pills"><span class="pill kindpill">'+esc(j.kind)+'</span><span class="pill '+(j.criticality==='critical'||j.criticality==='high'?'crit':'')+'">'+esc(j.criticality)+'</span>'+(j.risk?'<span class="pill crit">risk: '+esc(j.risk)+'</span>':'')+'<span class="pill">'+esc(j.entry.type)+(entry?' · '+esc(entry):'')+'</span>'+(j.tests_covering?'<span class="pill guard">'+num(j.tests_covering)+' tests</span>':'<span class="pill">no tests</span>')+'</div>'+(steps?'<div class="steps">'+steps+'</div>'+fullChain:'')+'<div class="effects">'+(terminals?'<div>Terminal: '+terminals+'</div>':'')+((eff.written||[]).length?'<div>Writes: <b>'+esc(eff.written.join(', '))+'</b></div>':'')+((eff.read||[]).length?'<div class="read">Reads: <b>'+esc(eff.read.join(', '))+'</b></div>':'')+((eff.external||[]).length?'<div>External: '+esc(eff.external.join(', '))+'</div>':'')+((eff.messages||[]).length?'<div>Messages: '+esc(eff.messages.join(', '))+'</div>':'')+'</div>'+(boundaries?'<div class="pills" style="margin-top:10px">'+boundaries+'</div>':'<div class="pills" style="margin-top:10px"><span class="pill crit">no entry guards recorded</span></div>')+'<div class="provenance">entry_point: '+esc(j.provenance?.entry_point_id||'')+(j.entry.handler_node_id?' · handler: '+esc(j.entry.handler_node_id):'')+' · '+num(j.provenance?.call_chains)+' call chains · '+num(j.provenance?.exit_points)+' exit points · '+num(j.step_count)+' steps</div></div>'}
function journeysView(){const j=current.journeys||{};if(!j.present)return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>User Journeys</h2></div>'+pillarFallback(j,'user journeys')+'</div></div>';const s=j.summary||{};const kinds=s.by_kind||{};return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>User Journeys</h2><small>'+num(s.included)+' of '+num(s.total_discovered)+' discovered journeys included · '+num(kinds['user-facing'])+' user-facing · '+num(kinds.system)+' system · '+num(kinds.scheduled)+' scheduled</small></div>'+(j.items||[]).map(journeyCard).join('')+'</div></div>'}
function lineageCard(l){const nonAuthSuffix=l.exposure.non_auth_guarded_paths?' ('+num(l.exposure.non_auth_guarded_paths)+' with non-auth guards only)':'';const flags=[l.exposure.sensitive?'<span class="flag sensitive">sensitive</span>':'',l.exposure.external_transfer?'<span class="flag external">external transfer</span>':'',l.exposure.unguarded_paths?'<span class="flag unguarded">'+num(l.exposure.unguarded_paths)+' unguarded paths'+nonAuthSuffix+'</span>':''].filter(Boolean).join('');const boundaries=(l.boundaries_crossed||[]).map(b=>{const kinds=(b.guard_kinds||[]).length?' ['+b.guard_kinds.map(esc).join(', ')+']':'';return '<span class="flag '+(b.guarded?'guarded':'unguarded')+'">'+esc(b.boundary)+(b.guarded?' (auth-guarded)':' (no auth guard)')+kinds+'</span>'}).join('');const recipients=(l.external_recipients||[]).map(r=>esc(r.service)+(r.via_node?' via '+esc(r.via_node):'')).join(', ');return '<div class="journey"><h3>'+esc(l.entity_name)+'</h3>'+(flags?'<div class="lineage-flags">'+flags+'</div>':'')+((l.sensitive_fields||[]).length?'<div class="effects">Sensitive fields: <b>'+esc(l.sensitive_fields.join(', '))+'</b></div>':'')+'<div class="effects"><div>'+num(l.writers)+' writers · '+num(l.readers)+' readers · carried by '+num(l.journeys_carrying)+' journeys</div>'+(recipients?'<div>External receivers: <b>'+esc(recipients)+'</b></div>':'')+'</div>'+(boundaries?'<div class="lineage-flags" style="margin-top:8px">'+boundaries+'</div>':'')+((l.writer_samples||[]).length?'<div class="provenance">writes via '+esc(l.writer_samples.map(w=>w.via).filter(Boolean).slice(0,4).join(', '))+(l.writer_samples[0]?.file?' · e.g. '+esc(l.writer_samples[0].file):'')+'</div>':'')+'</div>'}
function lineageView(){const l=current.lineage||{};if(!l.present)return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Data Lineage</h2></div>'+pillarFallback(l,'data lineage')+'</div></div>';return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Data Lineage</h2><small>'+num(l.total)+' entities tracked · '+num(l.sensitive_count)+' sensitive · '+num(l.external_transfer_count)+' with external transfer</small></div>'+(l.items||[]).map(lineageCard).join('')+'</div></div>'}
function deviationRows(devs){return (devs||[]).map(d=>'<tr><td>'+esc(d.severity)+'</td><td>'+esc(d.kind)+'</td><td class="kbd">'+esc(d.file)+'</td><td>'+esc(d.detail)+'</td></tr>').join('')}
function conformanceCard(p){const a=p.adoption||{};return '<div class="journey"><h3>'+esc(p.paradigm)+'</h3><p class="desc" style="margin-top:0">'+esc(p.description)+'</p><div class="adoption-rate">'+pct(a.adoption_rate)+' <small>'+num(a.following_count)+' of '+num(a.comparable_count)+' comparable implementations follow this norm</small></div>'+((a.evidence_files||[]).length?'<div class="provenance">evidence: '+esc(a.evidence_files.join(', '))+'</div>':'')+((p.deviations||[]).length?'<h3 style="margin-top:16px">Deviations ('+num(p.deviation_count)+')</h3><table class="table"><thead><tr><th>Severity</th><th>Kind</th><th>File</th><th>Detail</th></tr></thead><tbody>'+deviationRows(p.deviations)+'</tbody></table>':'<div class="effects" style="margin-top:10px">No deviations recorded.</div>')+'</div>'}
function conformanceView(){const c=current.conformance||{};if(!c.present)return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Paradigm Conformance</h2></div>'+pillarFallback(c,'paradigm conformance')+'</div></div>';return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Paradigm Conformance</h2><small>'+num((c.items||[]).length)+' codebase norms with adoption evidence and deviations</small></div>'+(c.items||[]).map(conformanceCard).join('')+'</div></div>'}
function productView(){const p=current.product_map||{};if(!p.present)return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Product Map</h2></div>'+pillarFallback(p,'a stored product map')+'</div></div>';const m=p.map;const id=m.identity||{};const caps=(m.capabilities||[]).map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(c.category)+'</td><td>'+esc(c.criticality)+'</td><td>'+esc(c.risk_level)+'</td><td>'+(c.tests_present?'yes':'no')+'</td><td>'+esc(c.description)+'</td></tr>').join('');const topJourneys=(m.journeys.top||[]).map(j=>'<div class="item" style="cursor:default"><h3>'+esc(j.title||j.name)+'</h3>'+(j.headline&&j.headline!==(j.title||j.name)?'<p>'+esc(j.headline)+'</p>':'')+'<div class="meta">'+esc([j.kind,j.criticality,(j.boundaries||[]).length?'guarded ('+(j.boundaries||[]).join(', ')+')':'unguarded',j.tests===0?'no tests':num(j.tests)+' test'+(j.tests===1?'':'s')].join(' · '))+'</div></div>').join('');const exposure=(m.data.exposure_highlights||[]).map(x=>'<div class="journey"><h3>'+esc(x.entity)+'</h3><div class="effects">Sensitive fields: <b>'+esc((x.sensitive_fields||[]).join(', ')||'none listed')+'</b></div><div class="lineage-flags">'+(x.unguarded_paths?'<span class="flag unguarded">'+num(x.unguarded_paths)+' unguarded paths'+(x.non_auth_guarded_paths?' ('+num(x.non_auth_guarded_paths)+' with non-auth guards only)':'')+'</span>':'')+(x.external_transfer?'<span class="flag external">external transfer'+((x.external_recipients||[]).length?' → '+esc(x.external_recipients.join(', ')):'')+'</span>':'')+'</div></div>').join('');const paradigms=(m.conventions.paradigms||[]).map(x=>'<div class="metric"><span>'+esc(x.paradigm)+'</span><b>'+pct(x.adoption_rate)+' ('+num(x.following_count)+'/'+num(x.comparable_count)+')</b></div>').join('');const dev=m.conventions.open_deviations||{};const h=m.health||{};const risksHtml=(h.top_risks||[]).map(r=>'<div class="item red" style="cursor:default"><h3>'+esc(r.name)+'</h3><p>'+esc(r.recommendation)+'</p><div class="meta">'+esc([r.type,r.level].join(' · '))+'</div></div>').join('');const caveats=(m.coverage_caveats||[]).map(x=>'<div class="notice">'+esc(x)+'</div>').join('');const unanalyzed=(id.unanalyzed_languages||[]).map(l=>esc(l.name)+' ('+num(l.files)+' files, '+pct(l.share_of_source)+')').join(', ');return '<div class="grid">'+(caveats?'<div class="span-12">'+caveats+'</div>':'')+'<div class="card span-7"><div class="card-head"><span class="mini-icon"></span><h2>Identity</h2><small>'+esc(id.domain)+' · domain source: '+esc(id.domain_source)+'</small></div><p class="desc" style="margin-top:0">'+esc(id.description)+'</p><div class="provenance">description source: '+esc(id.description_source)+(unanalyzed?' · unanalyzed languages: '+unanalyzed:'')+'</div></div><div class="card span-5"><div class="card-head"><span class="mini-icon"></span><h2>Journeys</h2></div>'+metrics([['Total',num(m.journeys.total)],['User-facing',num(m.journeys.user_facing)],['System',num(m.journeys.system)],['Scheduled',num(m.journeys.scheduled)]])+'</div><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Capability Spec</h2><small>'+num((m.capabilities||[]).length)+' capabilities</small></div><table class="table"><thead><tr><th>Capability</th><th>Category</th><th>Criticality</th><th>Risk</th><th>Tests</th><th>Description</th></tr></thead><tbody>'+caps+'</tbody></table></div><div class="card span-6"><div class="card-head"><span class="mini-icon"></span><h2>Top Journeys</h2></div><div class="item-list">'+(topJourneys||'<div class="empty">None listed.</div>')+'</div></div><div class="card span-6"><div class="card-head"><span class="mini-icon"></span><h2>Data Exposure</h2><small>'+num(m.data.entities)+' entities · sensitive: '+esc((m.data.sensitive||[]).join(', ')||'none')+'</small></div>'+(exposure||'<div class="empty">No exposure highlights.</div>')+'</div><div class="card span-6"><div class="card-head"><span class="mini-icon"></span><h2>Conventions</h2><small>open deviations: '+num(dev.error)+' error · '+num(dev.warning)+' warning · '+num(dev.info)+' info</small></div>'+(paradigms||'<div class="empty">No paradigms recorded.</div>')+'</div><div class="card span-6"><div class="card-head"><span class="mini-icon"></span><h2>Health</h2><small>'+esc(h.status||'unknown')+(h.score!==undefined&&h.score!==null?' · score '+esc(h.score):'')+'</small></div>'+metrics([['Tests',num((h.tests||{}).total)],['Passing',num((h.tests||{}).passing)],['Failing',num((h.tests||{}).failing)],['Implementation complete',num((h.implementation||{}).complete)],['Partial',num((h.implementation||{}).partial)],['Stubs',num((h.implementation||{}).stubs)]])+(risksHtml?'<h3>Top Risks</h3><div class="item-list">'+risksHtml+'</div>':'')+'</div></div>'}
function projectStats(){const p=DATA.project_overview||{counts:{}};return metrics([['Codebases',num(p.counts.codebases)],['Apps / services',num(p.counts.applications)],['CAS nodes',num(p.counts.nodes)],['CAS relationships',num(p.counts.edges)],['Entry points',num(p.counts.entry_points)],['Exit points',num(p.counts.exit_points)],['Interfaces',num(p.counts.interfaces)],['Data-flow paths',num(p.counts.data_flows)],['Workspace links',num(p.counts.links)],['Runtime components',num(p.counts.runtime_components)],['Runtime links',num(p.counts.runtime_links)],['Unmatched surfaces',num(p.counts.unmatched)]])}
function projectCodebaseCards(){const p=DATA.project_overview||{};return (p.codebases||[]).map((c,i)=>'<div class="project-card" onclick="current=DATA.analyses.find(a=>a.id===\\''+esc(c.id)+'\\')||current;setRoute(\\'overview\\')"><h3>'+esc(c.name)+'</h3><p>'+esc(c.description||'No summary available.')+'</p><div class="meta">'+esc([c.framework,c.language,c.system_type].filter(Boolean).join(' · '))+'</div><div class="entity-stats"><span>'+num(c.counts.nodes)+' nodes</span><span>'+num(c.counts.entry_points)+' entry</span><span>'+num(c.counts.exit_points)+' exit</span></div></div>').join('')||'<div class="empty">No analyzed codebases in the payload.</div>'}
function projectMap(){const apps=(DATA.project_overview?.applications||[]);const nodes=apps.length?apps:(DATA.project_overview?.codebases||[]);if(!nodes.length)return '<div class="empty">No apps or codebases to render.</div>';const cols=Math.ceil(Math.sqrt(nodes.length));const graph=DATA.project_overview?.system_graph;const linkRows=(DATA.project_overview?.links||[]).slice(0,10).map(l=>'<div class="pathline"><span class="hop">'+esc(l.source_application||l.source)+'</span> → <span class="hop">'+esc(l.target_application||l.target)+'</span> '+esc(l.kind)+' · '+esc(l.mode||'')+'</div>').join('');return '<div class="project-map">'+nodes.map((c,i)=>{const col=i%cols,row=Math.floor(i/cols);const name=c.name||c.codebase_name;const meta=c.codebase_name?esc(c.codebase_name)+' · '+num(c.interface_count||0)+' interfaces · '+num(c.runtime_component_count||0)+' runtime':num(c.counts.nodes)+' nodes · '+num(c.counts.tests)+' tests';return '<div class="project-node" style="left:'+(32+col*250)+'px;top:'+(30+row*150)+'px"><h3>'+esc(name)+'</h3><p>'+esc(c.kind||c.framework||'Analyzed surface')+'</p><div class="meta">'+meta+'</div></div>'}).join('')+'</div>'+(graph?'<div class="notice" style="margin-top:12px">Graph: '+esc(graph.name)+' · '+num(graph.counts.applications||0)+' apps/services · '+num(graph.counts.links)+' cross-codebase links · '+num(graph.counts.runtime_links)+' runtime links</div>':'')+(linkRows?'<div style="margin-top:12px">'+linkRows+'</div>':'')}
function projectInterfaceRow(item,i){return '<div class="item blue" onclick="setProjectRoute(\\'interfaces\\','+i+')"><h3>'+esc(item.name||'Interface')+'</h3><p>'+esc(item.description||item.kind||'Interface evidence from the analysis payload.')+'</p><div class="meta">'+esc([item.codebase_name,item.direction,item.kind,item.evidence].filter(Boolean).join(' · '))+'</div></div>'}
function projectFlowRow(item,i){const path=(item.path||[]).map(h=>'<span class="hop">'+esc(h)+'</span>').join(' ');return '<div class="item green" onclick="setProjectRoute(\\'flows\\','+i+')"><h3>'+esc(item.entity||'Data path')+'</h3><div class="pathline">'+(path||esc(item.destination||'No path detail recorded'))+'</div><div class="meta">'+esc([item.codebase_name,item.sensitivity,item.guard,item.evidence].filter(Boolean).join(' · '))+'</div></div>'}
function projectLinkRow(item,i){return '<div class="item amber" onclick="setProjectRoute(\\'links\\','+i+')"><h3>'+esc(item.name||'Workspace link')+'</h3><p>'+esc(item.description||'Matched relationship from the persisted Klauro Workspace analysis.')+'</p><div class="meta">'+esc([item.source,item.target,item.kind,item.mode,item.confidence!==undefined?Math.round(item.confidence*100)+'% confidence':''].filter(Boolean).join(' · '))+'</div></div>'}
function projectRuntimeRow(item,i){return '<div class="item blue" onclick="setProjectRoute(\\'runtime\\','+i+')"><h3>'+esc(item.name||'Runtime link')+'</h3><p>'+esc(item.description||'Runtime topology relationship from container or deployment analysis.')+'</p><div class="meta">'+esc([item.codebase_name,item.kind,item.mode,item.confidence!==undefined?Math.round(item.confidence*100)+'% confidence':''].filter(Boolean).join(' · '))+'</div></div>'}
function projectOverviewHtml(){const p=DATA.project_overview||{counts:{},notices:[]};const notices=(p.notices||[]).map(n=>'<div class="project-notice">'+esc(n)+'</div>').join('');return '<div class="crumb">Workspace / <span class="current">Overview</span></div><div class="topbar"><div><div class="status">Workspace analysis · Generated '+esc(new Date(DATA.generated_at).toLocaleString())+'</div><div class="title"><h1>'+esc(p.title||'Workspace Overview')+'</h1><span class="source-pill">'+num(p.counts?.codebases)+' codebases</span></div><div class="desc">A local prototype view over stored CAS analyses plus persisted Klauro Workspace analysiss: codebase drilldown, matched communication interfaces, runtime topology, and data-flow evidence.</div></div><div class="actions"><button class="btn" onclick="setProjectRoute(\\'interfaces\\')">Interfaces</button><button class="btn" onclick="setProjectRoute(\\'runtime\\')">Runtime</button><button class="btn primary" onclick="setProjectRoute(\\'links\\')">Workspace Links</button></div></div>'+notices+'<div class="tabs">'+['overview','interfaces','flows','links','runtime'].map(v=>'<button class="tab '+(view===v?'active':'')+'" onclick="setProjectRoute(\\''+v+'\\')">'+(v==='flows'?'Data Flows':v==='links'?'Workspace Links':v.replace(/^./,c=>c.toUpperCase()))+'</button>').join('')+'</div>'+projectViewHtml()}
function projectViewHtml(){const p=DATA.project_overview||{};if(view==='interfaces')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Communication Interfaces</h2><small>'+num((p.interfaces||[]).length)+' provided, consumed, published, listened, and shared surfaces from Klauro graph facts</small></div><div class="item-list">'+((p.interfaces||[]).map(projectInterfaceRow).join('')||'<div class="empty">No communication interfaces found in the payload.</div>')+'</div></div></div>';if(view==='flows')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Data-Flow Paths</h2><small>'+num((p.data_flows||[]).length)+' workspace paths from matched graph links</small></div><div class="item-list">'+((p.data_flows||[]).map(projectFlowRow).join('')||'<div class="empty">No data-flow paths found in the payload.</div>')+'</div></div></div>';if(view==='links')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Workspace Links</h2><small>'+num((p.links||[]).length)+' matched deployable and project relationships from persisted Klauro analysis</small></div><div class="item-list">'+((p.links||[]).map(projectLinkRow).join('')||'<div class="empty">No Workspace links found. Run the Workspace analysis first.</div>')+'</div></div></div>';if(view==='runtime')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Runtime Topology</h2><small>'+num((p.runtime_links||[]).length)+' links across containers, compose services, and deployment surfaces</small></div><div class="item-list">'+((p.runtime_links||[]).map(projectRuntimeRow).join('')||'<div class="empty">No runtime topology links found in the persisted Workspace analysis.</div>')+'</div></div></div>';return '<div class="project-hero"><div class="card"><div class="card-head"><span class="mini-icon"></span><h2>Workspace Map</h2><small>Codebase nodes and matched system links from Klauro</small></div>'+projectMap()+'</div><div class="card"><div class="card-head"><span class="mini-icon"></span><h2>Workspace Facts</h2></div>'+projectStats()+'</div></div><div class="card"><div class="card-head"><span class="mini-icon"></span><h2>Codebases</h2><small>Open any node to drill into its normal analysis dashboard</small></div><div class="project-card-grid">'+projectCodebaseCards()+'</div></div>'}
function renderProject(){repos();$('#detail').classList.remove('active');$('#dashboard').style.display='block';$('#dashboard').innerHTML=projectOverviewHtml()}
function renderProjectDetail(type,index){repos();$('#dashboard').style.display='none';$('#detail').classList.add('active');const p=DATA.project_overview||{};const map={interfaces:p.interfaces||[],flows:p.data_flows||[],links:p.links||[],runtime:p.runtime_links||[]};const item=(map[type]||[])[index]||{};const back=type==='flows'?'flows':type==='links'?'links':type==='runtime'?'runtime':'interfaces';const evidence=Array.isArray(item.evidence)?item.evidence:(item.evidence?[item.evidence]:[]);$('#detail').innerHTML='<span class="back" onclick="setProjectRoute(\\''+back+'\\')">← Back</span><div class="detail-hero"><div class="status">Project '+esc(type)+'</div><h1>'+esc(item.name||item.entity||'Project detail')+'</h1><p class="desc">'+esc(item.description||item.destination||'Detail supplied by the persisted Klauro project graph.')+'</p><div style="margin-top:16px">'+pillList([item.codebase_name,item.direction,item.kind,item.mode,item.sensitivity,item.guard].filter(Boolean))+'</div></div><div class="grid"><div class="card span-7"><div class="card-head"><span class="mini-icon"></span><h2>Path and Evidence</h2></div>'+((item.path||[]).length?'<div class="pathline">'+item.path.map(h=>'<span class="hop">'+esc(h)+'</span>').join(' ')+'</div>':'')+(item.source_interface||item.target_interface?'<div class="pathline"><span class="hop">'+esc(item.source_interface||item.source)+'</span> → <span class="hop">'+esc(item.target_interface||item.target)+'</span></div>':'')+(evidence.length?'<table class="table"><tbody>'+evidence.map(e=>'<tr><td>'+esc(e)+'</td></tr>').join('')+'</tbody></table>':'<p class="desc">No additional evidence recorded in compact payload.</p>')+'</div><div class="card span-5"><div class="card-head"><span class="mini-icon"></span><h2>Source Codebase</h2></div>'+metrics([['Codebase',item.codebase_name||item.source||'unknown'],['Target',item.target||item.destination||'not recorded'],['Type',item.kind||type],['Mode',item.mode||'not recorded']])+'</div></div>'}
function diagram(){const c=current.composition||{};return '<div class="diagram"><div class="nodebox green" style="left:36px;top:108px"><b>Web App</b><span>Primary client</span></div><div class="nodebox blue" style="left:230px;top:70px"><b>Controllers</b><span>'+num(c.controllers)+' REST/API</span></div><div class="nodebox blue" style="left:230px;top:160px"><b>Auth Guards</b><span>Access boundaries</span></div><div class="nodebox purple" style="left:430px;top:116px"><b>Services</b><span>'+num(c.services)+' business logic</span></div><div class="nodebox amber" style="left:630px;top:116px"><b>Repositories</b><span>'+num(c.repositories)+' data access</span></div><div class="nodebox purple" style="right:36px;top:78px"><b>Data Store</b><span>'+num(c.entities)+' entities</span></div><div class="nodebox purple" style="right:36px;top:174px"><b>External APIs</b><span>'+(current.tech.external.length||0)+' integrations</span></div><div class="link" style="left:156px;top:130px;width:74px"></div><div class="link" style="left:350px;top:138px;width:80px"></div><div class="link" style="left:550px;top:138px;width:80px"></div><div class="link" style="left:750px;top:138px;width:130px"></div></div>'}
function dashboardHtml(){return '<div class="crumb">⌂ › '+esc(current.name)+' › <span class="current">Backend</span></div><div class="topbar"><div><div class="status">● Analysis complete · Updated '+esc(new Date(current.analyzed_at).toLocaleString())+(current.cas_version?' · CAS '+esc(current.cas_version):'')+'</div><div class="title"><h1>'+esc(current.name)+'</h1><span class="source-pill">'+esc((current.tech.frameworks||[])[0]||current.system_type)+'</span></div><div class="desc">'+esc(current.description||'No description found in this analysis.')+'</div></div><div class="actions"><button class="btn" onclick="showReanalysisPanel()">Reanalyze</button><button class="btn" onclick="setRoute(\\'quality\\')">System Health</button><button class="btn primary" onclick="setRoute(\\'graph\\')">See Diagram</button></div></div>'+reanalyzePanel()+'<div class="summary"><div class="summary-card"><div class="eyebrow">What it does</div><h2>'+esc(current.capabilities[0]?.name||'Mapped codebase behavior')+'</h2><p>'+esc(current.capabilities[0]?.description||current.description)+'</p></div><div class="summary-card alt"><div class="eyebrow">How it fits</div><h2>'+esc(current.architecture?.patterns?.[0]?.name||current.system_type||'Application structure')+'</h2><p>'+esc(current.architecture?.summary||'CAS mapped the code structure, entities, flows, and boundaries for agent and human inspection.')+'</p></div></div><div class="tabs">'+['overview','capabilities','entities','journeys','lineage','conformance','product','architecture','quality','graph'].map(v=>'<button class="tab '+(view===v?'active':'')+'" onclick="setRoute(\\''+v+'\\')">'+(v==='product'?'Product Map':v.replace(/^./,c=>c.toUpperCase()))+'</button>').join('')+'</div>'+viewHtml()}
function viewHtml(){if(view==='capabilities')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Primary Capabilities</h2><small>Core business functions, not infrastructure plumbing</small></div><div class="cap-grid">'+current.capabilities.map((c,i)=>'<div class="cap" onclick="setRoute(\\'capabilities\\','+i+')"><div class="icon">↗</div><h3>'+esc(c.name)+'</h3><p>'+esc(c.description)+'</p><div class="health"><span>♡ '+c.health+'% healthy</span><span>'+esc(c.severity||'')+'</span></div></div>').join('')+'</div></div></div>';if(view==='entities')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Key Entities</h2><small>'+num(current.entities.length)+' concepts</small></div><div class="entity-row">'+current.entities.map((e,i)=>'<div class="entity" onclick="setRoute(\\'entities\\','+i+')"><h3>'+esc(e.name)+'</h3><span class="tag">'+esc(e.type||'Core')+'</span><p>'+esc(e.description||'Entity from CAS graph.')+'</p><div class="entity-stats"><span>'+num(e.fields||e.references?.length||0)+' fields</span><span>'+num(e.relations||0)+' rel</span></div></div>').join('')+'</div></div></div>';if(view==='journeys')return journeysView();if(view==='lineage')return lineageView();if(view==='conformance')return conformanceView();if(view==='product')return productView();if(view==='architecture')return '<div class="grid"><div class="card span-7"><div class="card-head"><span class="mini-icon"></span><h2>Architecture</h2></div><p class="desc">'+esc(current.architecture.summary||'No architecture summary present.')+'</p><h3>Patterns</h3>'+itemList(current.architecture.patterns,'architecture')+'</div><div class="card span-5"><div class="card-head"><span class="mini-icon"></span><h2>Idioms</h2></div><p class="desc">'+esc(current.idioms.summary||'Repo-local conventions and agent guidance.')+'</p>'+itemList(current.idioms.items,'idioms')+'</div></div>';if(view==='quality')return '<div class="grid"><div class="card span-4"><div class="card-head"><span class="mini-icon"></span><h2>Test Health</h2></div>'+metrics([['Tests / Suites',num(current.tests.total)],['Coverage',current.tests.coverage]])+'<h3>Suites</h3>'+itemList(current.tests.suites,'tests')+'</div><div class="card span-4"><div class="card-head"><span class="mini-icon"></span><h2>Risks</h2></div>'+itemList(current.risks,'risks')+'</div><div class="card span-4"><div class="card-head"><span class="mini-icon"></span><h2>Test Gaps</h2></div>'+itemList(current.tests.gaps,'gaps')+'</div></div>';if(view==='graph')return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Codebase Graph</h2><small>Top connected nodes</small></div><div class="graph"><svg id="graphSvg"></svg></div><div id="nodeInfo" class="desc"></div></div></div>';return '<div class="grid"><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Primary Capabilities</h2><small>Core business functions, not infrastructure plumbing</small></div><div class="cap-grid">'+capCards()+'</div></div><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Key Entities</h2><small>These entities represent the fundamental concepts that drive the system value.</small></div><div class="entity-row">'+entityCards()+'</div></div><div class="card span-4"><div class="card-head"><span class="mini-icon"></span><h2>System Composition</h2></div>'+bars(current.composition.nodeTypes)+'</div><div class="card span-4"><div class="card-head"><span class="mini-icon"></span><h2>Behavior Pillars</h2><small>Journeys, lineage, conformance, product map</small></div>'+metrics(pillarSummaryRows())+((current.journeys&&current.journeys.notice)?'<div class="notice" style="margin-top:14px">'+esc(current.journeys.notice)+'</div>':'')+'</div><div class="card span-4 dark"><div class="card-head"><span class="mini-icon"></span><h2>Codebase Visualization</h2><button class="btn primary" style="margin-left:auto" onclick="setRoute(\\'graph\\')">See Diagram</button></div>'+diagram()+'</div><div class="card span-12"><div class="card-head"><span class="mini-icon"></span><h2>Integrations</h2><small>Core business functions, not infrastructure plumbing</small></div><div class="integration-tabs"><span class="active">Upstream '+(current.integrations.length||current.tech.external.length)+'</span><span>Downstream</span><span>Workspace Connections</span></div><div class="entity-row">'+(current.integrations.length?current.integrations:current.tech.external.map(x=>({name:x,description:'External integration'}))).slice(0,5).map((x,i)=>'<div class="entity" onclick="setRoute(\\'integrations\\','+i+')"><h3>'+esc(x.name)+'</h3><p>'+esc(x.description||x.type||'External system')+'</p></div>').join('')+'</div></div></div>'}
function renderDashboard(){repos();$('#detail').classList.remove('active');$('#dashboard').style.display='block';$('#dashboard').innerHTML=dashboardHtml();if(view==='graph')setTimeout(drawGraph,0)}
function renderDetail(type,index){repos();$('#dashboard').style.display='none';$('#detail').classList.add('active');const map={capabilities:current.capabilities,entities:current.entities,risks:current.risks,gaps:current.tests.gaps,tests:current.tests.suites,architecture:current.architecture.patterns,idioms:current.idioms.items,integrations:current.integrations};const item=(map[type]||[])[index]||{};$('#detail').innerHTML='<span class="back" onclick="setRoute(\\''+(type==='gaps'||type==='risks'||type==='tests'?'quality':type)+'\\')">← Back</span><div class="detail-hero"><div class="status">'+esc(type)+'</div><h1>'+esc(item.name||'Detail')+'</h1><p class="desc">'+esc(item.description||'No description available.')+'</p><div style="margin-top:16px">'+pillList([item.type,item.severity,item.confidence!==undefined?Math.round(item.confidence*100)+'% confidence':''].filter(Boolean))+'</div></div><div class="grid"><div class="card span-7"><div class="card-head"><span class="mini-icon"></span><h2>Evidence and References</h2></div>'+((item.references||[]).length?'<table class="table"><tbody>'+item.references.slice(0,20).map(r=>'<tr><td>'+esc(typeof r==='string'?r:(r.name||r.id||r.kind||JSON.stringify(r).slice(0,80)))+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No direct references in compact payload.</div>')+'</div><div class="card span-5"><div class="card-head"><span class="mini-icon"></span><h2>Source</h2></div><p class="kbd">'+esc(item.file||current.path)+'</p>'+metrics([['Repository',current.name],['Nodes',num(current.counts.nodes)],['Edges',num(current.counts.edges)]])+'</div></div>'}
function drawGraph(){const svg=$('#graphSvg');if(!svg)return;const g=current.graph||{nodes:[],edges:[]};const w=svg.clientWidth||1000,h=svg.clientHeight||620;svg.setAttribute('viewBox','0 0 '+w+' '+h);svg.innerHTML='';const nodes=g.nodes.map((node,i)=>({...node,x:w/2+Math.cos(i/g.nodes.length*Math.PI*2)*(w*.39),y:h/2+Math.sin(i/g.nodes.length*Math.PI*2)*(h*.39)}));const byId=new Map(nodes.map(n=>[n.id,n]));for(const e of g.edges||[]){const s=byId.get(e.source),t=byId.get(e.target);if(!s||!t)continue;const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',s.x);line.setAttribute('y1',s.y);line.setAttribute('x2',t.x);line.setAttribute('y2',t.y);line.setAttribute('class','edge');svg.appendChild(line)}for(const node of nodes){const color=/entity|model/i.test(node.type)?'#7ed957':/controller/i.test(node.type)?'#3fa7ff':/service|class/i.test(node.type)?'#8b5cf6':'#ffb74d';const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',node.x);c.setAttribute('cy',node.y);c.setAttribute('r',Math.max(4,Math.min(13,4+(node.score||0)/22)));c.setAttribute('fill',color);c.style.cursor='pointer';c.onclick=()=>{$('#nodeInfo').textContent=node.name+' · '+node.type+' · '+(node.file||'')};svg.appendChild(c);const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('x',node.x+8);label.setAttribute('y',node.y+3);label.setAttribute('class','node-label');label.textContent=node.name.slice(0,34);svg.appendChild(label)}}
window.addEventListener('hashchange',route);$('#search').addEventListener('input',repos);if(!location.hash)location.hash=(DATA.analysis_count===1?'analysis/'+current.id+'/overview':'project/overview');else route();
</script></body></html>`;
}

function parseArgs(argv) {
  const options = { projects: [], out: '', systemGraph: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) { options.projects.push(argv[++i]); continue; }
    if (argv[i] === '--out' && argv[i + 1]) { options.out = argv[++i]; continue; }
    if (argv[i] === '--system-graph' && argv[i + 1]) { options.systemGraph = argv[++i]; continue; }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = process.env.KLAURO_STORAGE_PATH || path.join(process.env.HOME, '.klauro', 'analyses');
  const outPath = options.out || path.join(root, 'analysis-inspector.html');
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  const crossCodebaseGraphs = readStoredCrossCodebaseGraphs(root);
  const selectedGraphs = options.systemGraph
    ? crossCodebaseGraphs.filter(graph => clean(graph.id) === options.systemGraph || clean(graph.name) === options.systemGraph)
    : crossCodebaseGraphs;
  const selectedGraphPaths = new Set(arr(selectedGraphs[0]?.codebases).map(codebase => clean(codebase.path)).filter(Boolean));

  const analyses = [];
  for (const [projectPath, entry] of Object.entries(index.analyses || {})) {
    if (options.projects.length && !options.projects.some(p => projectPath.includes(p))) continue;
    if (selectedGraphPaths.size && !selectedGraphPaths.has(projectPath)) continue;
    try {
      const cas = readJsonMaybeCompressed(path.join(root, entry.file));
      analyses.push(buildAnalysisEntry(cas, entry, projectPath));
    } catch (error) {
      analyses.push({ id: entry.file, name: entry.name || path.basename(projectPath), path: projectPath, file: entry.file, error: error.message, counts: { nodes: entry.node_count || 0, edges: entry.edge_count || 0 } });
    }
  }
  analyses.sort((a,b)=>b.counts.nodes-a.counts.nodes);
  const payload = {
    generated_at: new Date().toISOString(),
    analysis_count: analyses.length,
    analyses,
    project_overview: projectOverviewData(analyses, selectedGraphs),
  };
  const html = renderHtml(payload);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(JSON.stringify({ outPath, analyses: analyses.length, bytes: Buffer.byteLength(html) }, null, 2));
  return { outPath, analyses: analyses.length };
}

module.exports = {
  PILLAR_ATTESTED_CAS_VERSION,
  compareCasVersions,
  parseCasVersion,
  pillarVersionNotice,
  journeyTitle,
  journeyHeadline,
  storedJourneyNameParts,
  storedJourneyNameHeadline,
  journeyData,
  lineageData,
  conformanceData,
  productMapData,
  explicitCrossCodebaseData,
  readStoredCrossCodebaseGraphs,
  compactCrossCodebaseGraph,
  projectOverviewData,
  buildAnalysisEntry,
  renderHtml,
  main,
};

if (require.main === module) {
  main();
}
