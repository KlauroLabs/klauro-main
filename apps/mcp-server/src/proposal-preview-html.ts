#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { getPreviewAnalysis } from './proposal-preview';
import { isDirectCliInvocation } from './cli-invocation';

interface Args {
  previewId: string;
  output: string;
}

interface CardItem {
  label: string;
  value: string | number;
  tone?: 'blue' | 'green' | 'pink' | 'yellow' | 'muted';
}

function parseArgs(argv: string[]): Args {
  let previewId = 'latest';
  let output = path.join(process.cwd(), '.klauro-proposal-preview', 'latest.html');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--preview-id') previewId = argv[++i];
    else if (arg === '--output') output = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { previewId, output };
}

function printHelp(): void {
  process.stdout.write([
    'Usage: npm run proposal-preview-html -- [--preview-id id] [--output file.html]',
    '',
    'Generates a self-contained local HTML proposal preview.',
  ].join('\n') + '\n');
}

export async function renderProposalPreviewHtml(options: Args): Promise<{ output: string; preview_id: string }> {
  const payload = await getPreviewAnalysis(options.previewId);
  const html = buildHtml(payload);
  await fs.ensureDir(path.dirname(options.output));
  await fs.writeFile(options.output, html, 'utf8');
  return { output: options.output, preview_id: payload.preview.id };
}

function buildHtml(payload: Awaited<ReturnType<typeof getPreviewAnalysis>>): string {
  const preview = payload.preview as any;
  const verdict = preview.verdict || {};
  const comparison = payload.comparison as any;
  const visualization = payload.visualization as any;
  const proposed = payload.proposed_cas as any;
  const baseline = payload.baseline_cas as any | undefined;
  const proposedView = visualization.proposed || {};
  const baselineView = visualization.baseline || null;
  const changedContracts = comparison.changed_contracts || [];
  const changedFiles = comparison.impacted_files || [];
  const requiredChecks = comparison.required_checks || [];
  const reasons = verdict.reasons || [];
  const delta = comparison.graph_delta || {};
  const proposedCounts = proposedView.counts || {};
  const baselineCounts = baselineView?.counts || {};
  const systemName = proposed?.system?.name || preview.title || 'Proposed codebase';
  const summary = proposalSummary(preview, proposed, comparison);
  const architecture = architectureItems(proposed);
  const entries = entryItems(proposed);
  const outputs = outputItems(proposed);
  const entities = criticalEntities(proposed, comparison);
  const flows = criticalFlows(proposed);
  const facts: CardItem[] = [
    { label: 'Elements', value: proposedCounts.nodes || proposed?.nodes?.length || 0, tone: 'yellow' },
    { label: 'Files touched', value: changedFiles.length, tone: 'blue' },
    { label: 'Contracts changed', value: changedContracts.length, tone: changedContracts.length ? 'pink' : 'green' },
    { label: 'Tests detected', value: proposed?.test_summary?.total_tests || proposedCounts.tests || 0, tone: proposed?.test_summary?.total_tests ? 'green' : 'yellow' },
  ];
  const beforeAfter: CardItem[] = [
    { label: 'Baseline nodes', value: baselineCounts.nodes ?? 'none', tone: 'muted' },
    { label: 'Proposed nodes', value: proposedCounts.nodes || proposed?.nodes?.length || 0, tone: 'blue' },
    { label: 'Nodes added', value: delta.nodes_added || 0, tone: 'green' },
    { label: 'Edges added', value: delta.edges_added || 0, tone: 'green' },
    { label: 'Nodes removed', value: delta.nodes_removed || 0, tone: delta.nodes_removed ? 'pink' : 'muted' },
    { label: 'Edges removed', value: delta.edges_removed || 0, tone: delta.edges_removed ? 'pink' : 'muted' },
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(preview.title || 'Klauro Proposal Preview')}</title>
  <style>${css()}</style>
</head>
<body>
  <aside class="rail">
    <div class="brand"><span class="mark"></span><strong>Klauro</strong></div>
    <nav>
      <span>Overview</span>
      <span>Proposal</span>
      <span>Architecture</span>
      <span>Impact</span>
    </nav>
    <div class="rail-section">
      <small>PREVIEW</small>
      <strong>${escapeHtml(preview.type === 'greenfield_codebase' ? 'Greenfield' : 'Iteration')}</strong>
      <span>${escapeHtml(String(verdict.status || 'unknown'))}</span>
    </div>
  </aside>

  <main>
    <header>
      <div>
        <div class="crumb">Home / Proposal Preview / ${escapeHtml(systemName)}</div>
        <h1>${escapeHtml(preview.title || systemName)}</h1>
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="header-actions">
        <span class="pill ${verdictClass(verdict.status)}">${escapeHtml(String(verdict.status || 'unknown'))}</span>
        <span class="pill">Private preview</span>
      </div>
    </header>

    <section class="top-cards">
      ${insightCard('What it is', proposalTypeTitle(preview), proposalTypeBody(preview, proposed, comparison), 'blue')}
      ${insightCard('What it does', primaryCapability(proposed), primaryCapabilityBody(proposed), 'green')}
      ${insightCard('What changes', changeHeadline(comparison), changeBody(comparison), 'pink')}
    </section>

    <section class="layout">
      <div class="left-stack">
        <article class="panel hero-panel">
          <div class="panel-head">
            <div>
              <h2>${preview.type === 'greenfield_codebase' ? 'Proposed System Shape' : 'Iteration Impact Map'}</h2>
              <p>${preview.type === 'greenfield_codebase' ? 'The codebase Klauro can see from the proposed files.' : 'What the proposed iteration changes compared with the baseline.'}</p>
            </div>
            <a class="mini-link" href="#raw">Raw payload</a>
          </div>
          ${renderArchitectureMap(proposed, comparison)}
        </article>

        <div class="two-col">
          ${listPanel('Critical entities', `${entities.length} entities`, entities.map(entity =>
            entityRow(entity.name, entity.subtitle, entity.meta, entity.tone)
          ), 'pink')}
          ${listPanel('Critical flows', `${flows.length} flows`, flows.map(flow =>
            flowRow(flow.name, flow.meta, flow.detail)
          ), 'green')}
        </div>

        <article class="panel" id="raw">
          <div class="panel-head">
            <div>
              <h2>Preview payload</h2>
              <p>Stored outside CAS. Baseline and proposed analyses remain normal CAS outputs.</p>
            </div>
          </div>
          <details>
            <summary>Comparison JSON</summary>
            <pre>${escapeHtml(JSON.stringify(comparison, null, 2))}</pre>
          </details>
          <details>
            <summary>Visualization JSON</summary>
            <pre>${escapeHtml(JSON.stringify(visualization, null, 2))}</pre>
          </details>
        </article>
      </div>

      <div class="right-stack">
        ${statPanel('System facts', 'Facts over proposed structure.', facts)}
        ${statPanel('Before / after', 'CAS graph delta for this proposal.', beforeAfter)}
        ${listPanel('Entry / input', `${entries.length} detected`, entries.map(item =>
          compactRow(item.name, item.meta, item.tone)
        ), 'blue')}
        ${listPanel('External / output', `${outputs.length} detected`, outputs.map(item =>
          compactRow(item.name, item.meta, item.tone)
        ), 'yellow')}
        ${listPanel('Fit checks', `${requiredChecks.length || reasons.length} signals`, [
          ...reasons.map((reason: string) => compactRow(reason, 'Verdict reason', verdict.status === 'fits' ? 'green' : 'yellow')),
          ...requiredChecks.slice(0, 6).map((check: string) => compactRow(check, 'Required check', 'blue')),
          ...(reasons.length || requiredChecks.length ? [] : [compactRow('No warnings recorded', 'Advisory verdict', 'green')]),
        ], 'green')}
        ${listPanel('Touched files', `${changedFiles.length} files`, changedFiles.slice(0, 10).map((file: string) =>
          compactRow(file, 'Impacted by proposal', 'muted')
        ), 'pink')}
      </div>
    </section>
  </main>
</body>
</html>`;
}

function css(): string {
  return `
    :root {
      color-scheme: dark;
      --bg: #171920;
      --rail: #282b36;
      --panel: #2d303b;
      --panel-2: #383c49;
      --panel-3: #242731;
      --line: #454a59;
      --text: #f4f5f8;
      --muted: #a3a8b4;
      --faint: #787f8e;
      --blue: #4bb8ff;
      --green: #8bed54;
      --pink: #ff2768;
      --purple: #9468ff;
      --yellow: #ffb43d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: grid;
      grid-template-columns: 196px minmax(0, 1fr);
    }
    .rail {
      min-height: 100vh;
      background: var(--rail);
      border-right: 1px solid #353947;
      padding: 24px 14px;
      position: sticky;
      top: 0;
    }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 34px; font-size: 17px; }
    .mark { width: 28px; height: 28px; border-radius: 8px; background: #ff4d5f; display: inline-block; }
    nav { display: grid; gap: 6px; color: var(--muted); margin-bottom: 34px; }
    nav span { padding: 9px 11px; border-radius: 7px; }
    nav span:nth-child(2) { background: #5d4a8e; color: white; }
    .rail-section { border-top: 1px solid #3a3f4e; padding-top: 18px; display: grid; gap: 6px; }
    .rail-section small { color: var(--faint); font-size: 10px; letter-spacing: .08em; }
    .rail-section span { color: var(--muted); }
    main { padding: 28px 34px 40px; min-width: 0; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: start; margin-bottom: 24px; }
    .crumb { color: var(--faint); font-size: 12px; margin-bottom: 16px; }
    h1, h2, h3, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 32px; line-height: 1.1; margin-bottom: 10px; }
    h2 { font-size: 18px; }
    h3 { font-size: 16px; }
    p { color: var(--muted); }
    .header-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .pill {
      min-height: 30px;
      padding: 6px 12px;
      border-radius: 999px;
      background: #363a47;
      color: var(--text);
      border: 1px solid var(--line);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.good { color: var(--green); border-color: rgba(139,237,84,.45); }
    .pill.warn { color: var(--yellow); border-color: rgba(255,180,61,.45); }
    .pill.bad { color: var(--pink); border-color: rgba(255,39,104,.5); }
    .top-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 18px; }
    .insight, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .insight { padding: 18px; min-height: 108px; border-left: 4px solid var(--blue); }
    .insight.green { border-left-color: var(--green); }
    .insight.pink { border-left-color: var(--pink); }
    .insight small { color: var(--faint); text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
    .insight h3 { margin: 8px 0 6px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 18px; align-items: start; }
    .left-stack, .right-stack { display: grid; gap: 18px; }
    .two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .panel { padding: 16px; }
    .hero-panel { min-height: 360px; }
    .panel-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; margin-bottom: 14px; }
    .mini-link { color: #bda4ff; text-decoration: none; font-size: 12px; }
    .map {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      align-items: center;
      gap: 12px;
      min-height: 260px;
      padding: 22px;
      border-radius: 7px;
      background: #333743;
      border-left: 3px solid var(--green);
      overflow: auto;
    }
    .stage {
      background: #3a3f4d;
      border: 1px solid #4a5060;
      border-radius: 7px;
      padding: 12px;
      min-height: 92px;
      display: grid;
      align-content: start;
      gap: 8px;
    }
    .stage h3 { font-size: 14px; }
    .stage small { color: var(--muted); }
    .stage.blue { border-left: 3px solid var(--blue); }
    .stage.green { border-left: 3px solid var(--green); }
    .stage.pink { border-left: 3px solid var(--pink); }
    .stage.yellow { border-left: 3px solid var(--yellow); }
    .connector { height: 1px; min-width: 36px; background: #697184; position: relative; }
    .connector:after { content: ""; position: absolute; right: 0; top: -3px; width: 7px; height: 7px; border-top: 1px solid #697184; border-right: 1px solid #697184; transform: rotate(45deg); }
    .stat-grid { display: grid; gap: 8px; }
    .stat {
      background: var(--panel-2);
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
    }
    .stat strong, .row strong { color: var(--text); }
    .tone-blue { color: var(--blue) !important; }
    .tone-green { color: var(--green) !important; }
    .tone-pink { color: var(--pink) !important; }
    .tone-yellow { color: var(--yellow) !important; }
    .tone-muted { color: var(--muted) !important; }
    .rows { display: grid; gap: 8px; }
    .row {
      background: var(--panel-2);
      border-radius: 7px;
      padding: 12px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    .row p { overflow-wrap: anywhere; }
    .row .meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .tag { border-radius: 999px; padding: 5px 9px; background: #454a57; font-size: 12px; white-space: nowrap; }
    details { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 10px; }
    summary { cursor: pointer; color: var(--muted); margin-bottom: 10px; }
    pre {
      margin: 0;
      max-height: 360px;
      overflow: auto;
      background: #1f222b;
      padding: 14px;
      border-radius: 7px;
      color: #d9e2ec;
      font-size: 12px;
    }
    @media (max-width: 1120px) {
      body { grid-template-columns: 1fr; }
      .rail { display: none; }
      .layout, .top-cards, .two-col { grid-template-columns: 1fr; }
      main { padding: 20px; }
      .map { grid-template-columns: 1fr; }
      .connector { width: 1px; height: 28px; justify-self: center; }
    }
  `;
}

function insightCard(label: string, title: string, body: string, tone: 'blue' | 'green' | 'pink'): string {
  return `<article class="insight ${tone}"><small>${escapeHtml(label)}</small><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></article>`;
}

function statPanel(title: string, subtitle: string, items: CardItem[]): string {
  return `<article class="panel"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div></div><div class="stat-grid">${items.map(item => `<div class="stat"><span>${escapeHtml(item.label)}</span><strong class="tone-${item.tone || 'muted'}">${escapeHtml(String(item.value))}</strong></div>`).join('')}</div></article>`;
}

function listPanel(title: string, subtitle: string, rows: string[], tone: 'blue' | 'green' | 'pink' | 'yellow'): string {
  return `<article class="panel ${tone}"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div></div><div class="rows">${rows.length ? rows.join('') : compactRow('Nothing detected', 'No CAS evidence in this preview', 'muted')}</div></article>`;
}

function compactRow(name: string, meta: string, tone: CardItem['tone'] = 'muted'): string {
  return `<div class="row"><div><strong>${escapeHtml(name)}</strong><div class="meta">${escapeHtml(meta)}</div></div><span class="tag tone-${tone}">${escapeHtml(tone || 'muted')}</span></div>`;
}

function entityRow(name: string, subtitle: string, meta: string, tone: CardItem['tone'] = 'muted'): string {
  return `<div class="row"><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(subtitle)}</p><div class="meta">${escapeHtml(meta)}</div></div><span class="tag tone-${tone}">${escapeHtml(tone || 'entity')}</span></div>`;
}

function flowRow(name: string, meta: string, detail: string): string {
  return `<div class="row"><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(detail)}</p></div><span class="tag tone-green">${escapeHtml(meta)}</span></div>`;
}

function renderArchitectureMap(proposed: any, comparison: any): string {
  const entries = entryItems(proposed).slice(0, 1);
  const services = nodesByType(proposed, ['service', 'provider', 'module']).slice(0, 1);
  const repos = nodesByType(proposed, ['repository', 'model', 'entity']).slice(0, 1);
  const outputs = outputItems(proposed).slice(0, 1);
  const stages = [
    { title: entries[0]?.name || 'Entry surface', sub: entries[0]?.meta || 'Routes, handlers, or user inputs', tone: 'blue' },
    { title: services[0]?.name || 'Business logic', sub: services[0]?.source?.file || 'Services, workflows, and behavior', tone: 'green' },
    { title: repos[0]?.name || 'Data model', sub: repos[0]?.source?.file || 'Entities, repositories, and stores', tone: 'pink' },
    { title: outputs[0]?.name || 'External surface', sub: outputs[0]?.meta || 'Databases, APIs, queues, and side effects', tone: 'yellow' },
    { title: `${comparison.graph_delta?.nodes_added || 0} added`, sub: `${comparison.graph_delta?.edges_added || 0} new relationships`, tone: 'green' },
  ];
  return `<div class="map">${stages.map((stage, index) => `${index === 0 ? '' : '<div class="connector"></div>'}<div class="stage ${stage.tone}"><h3>${escapeHtml(stage.title)}</h3><small>${escapeHtml(stage.sub)}</small></div>`).join('')}</div>`;
}

function proposalSummary(preview: any, proposed: any, comparison: any): string {
  const kind = preview.type === 'greenfield_codebase' ? 'new codebase proposal' : 'codebase iteration';
  const nodes = proposed?.nodes?.length || 0;
  const added = comparison.graph_delta?.nodes_added || 0;
  const contracts = comparison.changed_contracts?.length || 0;
  return `Klauro analyzed this ${kind} as a normal CAS output: ${nodes} visible elements, ${added} added elements, and ${contracts} changed contracts.`;
}

function proposalTypeTitle(preview: any): string {
  return preview.type === 'greenfield_codebase' ? 'A proposed new system' : 'A proposed future iteration';
}

function proposalTypeBody(preview: any, proposed: any, comparison: any): string {
  if (preview.type === 'greenfield_codebase') {
    return `Creates a synthetic codebase with ${proposed?.nodes?.length || 0} detected elements and ${proposed?.edges?.length || 0} relationships.`;
  }
  return `Applies the proposal in a temporary workspace and compares it against the current analysis. ${comparison.impacted_files?.length || 0} files are in scope.`;
}

function primaryCapability(proposed: any): string {
  return proposed?.system_capabilities?.[0]?.name || proposed?.system?.description || proposed?.system?.type || 'System behavior';
}

function primaryCapabilityBody(proposed: any): string {
  const entries = proposed?.entry_points?.length || 0;
  const exits = proposed?.exit_points?.length || 0;
  return `CAS sees ${entries} entry surfaces and ${exits} output surfaces in the proposed structure.`;
}

function changeHeadline(comparison: any): string {
  const delta = comparison.graph_delta || {};
  if ((delta.nodes_removed || 0) > 0 || (delta.entry_points_removed || 0) > 0) return 'Removes existing surface area';
  if ((delta.nodes_added || 0) > 0) return 'Adds new behavior surface';
  return 'No major graph delta';
}

function changeBody(comparison: any): string {
  const delta = comparison.graph_delta || {};
  return `${delta.nodes_added || 0} nodes added, ${delta.edges_added || 0} edges added, ${delta.nodes_removed || 0} nodes removed, ${delta.edges_removed || 0} edges removed.`;
}

function architectureItems(proposed: any): CardItem[] {
  return [
    { label: 'Languages', value: proposed?.system?.technologies?.languages?.length || 0, tone: 'blue' },
    { label: 'Frameworks', value: proposed?.system?.technologies?.frameworks?.length || 0, tone: 'green' },
    { label: 'Modules', value: nodesByType(proposed, ['module']).length, tone: 'yellow' },
    { label: 'Services', value: nodesByType(proposed, ['service', 'provider']).length, tone: 'green' },
  ];
}

function entryItems(proposed: any): Array<{ name: string; meta: string; tone: CardItem['tone'] }> {
  return (proposed?.entry_points || []).slice(0, 8).map((entry: any) => ({
    name: entry.name || entry.id,
    meta: `${entry.type || 'entry'} ${entry.path || entry.file || ''}`.trim(),
    tone: entry.auth_required ? 'yellow' : 'green',
  }));
}

function outputItems(proposed: any): Array<{ name: string; meta: string; tone: CardItem['tone'] }> {
  const exits = (proposed?.exit_points || []).slice(0, 8).map((exit: any) => ({
    name: exit.name || exit.id,
    meta: `${exit.type || 'output'} ${exit.target || exit.destination || ''}`.trim(),
    tone: 'yellow' as CardItem['tone'],
  }));
  if (exits.length) return exits;
  return (proposed?.external_services || []).slice(0, 8).map((service: any) => ({
    name: service.name || service.id,
    meta: service.type || 'external service',
    tone: 'yellow' as CardItem['tone'],
  }));
}

function criticalEntities(proposed: any, comparison: any): Array<{ name: string; subtitle: string; meta: string; tone: CardItem['tone'] }> {
  const changedFiles = new Set<string>((comparison.impacted_files || []).map((file: string) => file.toLowerCase()));
  const nodes = [...(proposed?.nodes || [])]
    .sort((left: any, right: any) => scoreNode(right, changedFiles) - scoreNode(left, changedFiles))
    .slice(0, 8);
  return nodes.map((node: any) => ({
    name: node.name || node.id,
    subtitle: node.description || node.responsibility || node.type || 'Detected code element',
    meta: node.source?.file || node.type || 'CAS node',
    tone: changedFiles.has(String(node.source?.file || '').toLowerCase()) ? 'pink' : node.type === 'service' ? 'green' : 'blue',
  }));
}

function criticalFlows(proposed: any): Array<{ name: string; meta: string; detail: string }> {
  const chains = (proposed?.call_chains || []).slice(0, 6).map((chain: any) => ({
    name: chain.business_process || chain.user_action || chain.chain_id || 'Call chain',
    meta: `${chain.length || chain.path?.length || 0} steps`,
    detail: chain.risk_level ? `Risk ${chain.risk_level}` : 'Connected behavior path',
  }));
  if (chains.length) return chains;
  return (proposed?.entry_points || []).slice(0, 6).map((entry: any) => ({
    name: entry.name || entry.id,
    meta: entry.type || 'entry',
    detail: entry.description || entry.path || 'Entry surface detected by CAS',
  }));
}

function nodesByType(proposed: any, types: string[]): any[] {
  const wanted = new Set(types);
  return (proposed?.nodes || []).filter((node: any) => wanted.has(node.type));
}

function scoreNode(node: any, changedFiles: Set<string>): number {
  let score = 0;
  if (changedFiles.has(String(node.source?.file || '').toLowerCase())) score += 100;
  if (['controller', 'route', 'service', 'repository', 'entity', 'component'].includes(node.type)) score += 30;
  if (node.relationships?.length) score += Math.min(20, node.relationships.length);
  return score;
}

function verdictClass(status: string): string {
  if (status === 'fits') return 'good';
  if (status === 'high_risk' || status === 'needs_revision') return 'bad';
  return 'warn';
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

if (isDirectCliInvocation('proposal-preview-html')) {
  renderProposalPreviewHtml(parseArgs(process.argv.slice(2)))
    .then(result => {
      process.stdout.write(`Wrote proposal preview HTML: ${result.output}\n`);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
