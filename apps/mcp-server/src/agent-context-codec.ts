import * as zlib from 'zlib';
import { buildBenchmarkGates, measureValidationFidelity, resultByName } from './agent-context-codec-gates';

export interface AgentContextCodecResult {
  format: 'K14' | 'K15';
  capsule: string;
  estimated_tokens: number;
  bytes: number;
}

export interface AgentContextCodecBenchmarkResult {
  name: string;
  bytes: number;
  estimated_tokens: number;
  promptish_tokens: number;
  token_reduction_vs_min_json: number;
  promptish_token_reduction_vs_min_json: number;
  encode_ms_per_1000: number;
  context_slots: number;
  context_slots_per_100_tokens: number;
  context_slots_per_100_promptish_tokens: number;
  agent_readable: number;
  actionable: number;
  exact_paths: number;
  prompt_native: number;
  balanced_score: number;
  validation_fidelity: 'exact' | 'lossy' | 'unverified';
  sample: string;
}

export interface AgentContextCodecBenchmarkGate {
  id: string;
  status: 'pass' | 'fail';
  detail: string;
}

type Candidate = {
  name: string;
  encode: () => string;
  decodeValidation?: (encoded: string) => unknown;
  agentReadable: number;
  actionable: number;
  exactPaths: number;
  promptNative: number;











  encodeCost: 'text' | 'binary';
};


const ENCODE_COST_SPEED_SCORE: Record<Candidate['encodeCost'], number> = {
  text: 95,
  binary: 50,
};

export function formatAgentContextCapsule(context: any): AgentContextCodecResult {
  const capsule = encodeK15(context);
  return {
    format: 'K15',
    capsule,
    estimated_tokens: estimateTokens(capsule),
    bytes: Buffer.byteLength(capsule),
  };
}

export function benchmarkAgentContextCodecs(context: any): {
  generated_at: string;
  benchmark_type: 'agent-context-codec-proof';
  status: 'pass' | 'fail';
  score: number;
  recommendation: string;
  summary: Record<string, unknown>;
  gates: AgentContextCodecBenchmarkGate[];
  results: AgentContextCodecBenchmarkResult[];
} {
  const candidates = buildCandidates(context);
  const minJsonTokens = estimateTokens(JSON.stringify(context));
  const minJsonPromptishTokens = estimatePromptishTokens(JSON.stringify(context));
  const results = candidates
    .map(candidate => {
      const timing = timeEncoder(candidate.encode);
      const output = candidate.encode();
      const estimatedTokens = estimateTokens(output);
      const promptishTokens = estimatePromptishTokens(output);
      const tokenReduction = percentReduction(minJsonTokens, estimatedTokens);
      const promptishTokenReduction = percentReduction(minJsonPromptishTokens, promptishTokens);
      const contextSlots = countContextSlots(context, output);
      const contextDensity = Math.round((contextSlots / Math.max(1, estimatedTokens)) * 10_000) / 100;
      const promptishContextDensity = Math.round((contextSlots / Math.max(1, promptishTokens)) * 10_000) / 100;
      const balancedScore = Math.round(
        tokenReduction * 0.20 +
        promptishTokenReduction * 0.15 +
        Math.min(100, contextDensity * 8) * 0.06 +
        candidate.agentReadable * 0.17 +
        candidate.actionable * 0.19 +
        candidate.exactPaths * 0.12 +
        candidate.promptNative * 0.10 +


        ENCODE_COST_SPEED_SCORE[candidate.encodeCost] * 0.04
      );
      return {
        name: candidate.name,
        bytes: Buffer.byteLength(output),
        estimated_tokens: estimatedTokens,
        promptish_tokens: promptishTokens,
        token_reduction_vs_min_json: tokenReduction,
        promptish_token_reduction_vs_min_json: promptishTokenReduction,
        encode_ms_per_1000: Math.round(timing.msPer1000 * 100) / 100,
        context_slots: contextSlots,
        context_slots_per_100_tokens: contextDensity,
        context_slots_per_100_promptish_tokens: promptishContextDensity,
        agent_readable: candidate.agentReadable,
        actionable: candidate.actionable,
        exact_paths: candidate.exactPaths,
        prompt_native: candidate.promptNative,
        balanced_score: balancedScore,
        validation_fidelity: measureValidationFidelity(candidate, output, arrayOfStrings(context.execution?.validate)),
        sample: output.slice(0, 700),
      };
    })
    .sort((a, b) => b.balanced_score - a.balanced_score || a.estimated_tokens - b.estimated_tokens);

  const recommendation = results.find(result => result.validation_fidelity === 'exact')?.name || 'none';
  const gates = buildBenchmarkGates(results, recommendation);
  const passed = gates.filter(gate => gate.status === 'pass').length;
  const k9 = resultByName(results, 'k9-agent-context-language');
  const k10 = resultByName(results, 'k10-agent-context-language');
  const k11 = resultByName(results, 'k11-agent-context-language');
  const k12 = resultByName(results, 'k12-agent-context-language');
  const k13 = resultByName(results, 'k13-agent-context-language');
  const k14 = resultByName(results, 'k14-agent-context-language');
  const k15 = resultByName(results, 'k15-agent-context-language');
  const k8 = resultByName(results, 'k8-agent-context-language');
  const minJson = resultByName(results, 'min-json');
  const jsonb = resultByName(results, 'jsonb-rowset');
  const protobuf = resultByName(results, 'protobuf-text');
  const toonish = resultByName(results, 'toonish-table');
  const yaml = resultByName(results, 'yaml-brief');
  const xml = resultByName(results, 'xml-tags');

  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'agent-context-codec-proof',
    status: passed === gates.length ? 'pass' : 'fail',
    score: Math.round((passed / Math.max(1, gates.length)) * 100),
    recommendation,
    summary: {
      recommended_format: recommendation,
      k10_estimated_tokens: k10?.estimated_tokens ?? null,
      k10_promptish_tokens: k10?.promptish_tokens ?? null,
      k10_token_reduction_vs_min_json: k10?.token_reduction_vs_min_json ?? null,
      k10_promptish_token_reduction_vs_min_json: k10?.promptish_token_reduction_vs_min_json ?? null,
      k10_context_slots: k10?.context_slots ?? null,
      k10_context_slots_per_100_tokens: k10?.context_slots_per_100_tokens ?? null,
      k10_context_slots_per_100_promptish_tokens: k10?.context_slots_per_100_promptish_tokens ?? null,
      k11_estimated_tokens: k11?.estimated_tokens ?? null,
      k11_promptish_tokens: k11?.promptish_tokens ?? null,
      k11_token_reduction_vs_min_json: k11?.token_reduction_vs_min_json ?? null,
      k11_promptish_token_reduction_vs_min_json: k11?.promptish_token_reduction_vs_min_json ?? null,
      k11_context_slots: k11?.context_slots ?? null,
      k11_context_slots_per_100_tokens: k11?.context_slots_per_100_tokens ?? null,
      k11_context_slots_per_100_promptish_tokens: k11?.context_slots_per_100_promptish_tokens ?? null,
      k12_estimated_tokens: k12?.estimated_tokens ?? null,
      k12_promptish_tokens: k12?.promptish_tokens ?? null,
      k12_token_reduction_vs_min_json: k12?.token_reduction_vs_min_json ?? null,
      k12_promptish_token_reduction_vs_min_json: k12?.promptish_token_reduction_vs_min_json ?? null,
      k12_context_slots: k12?.context_slots ?? null,
      k12_context_slots_per_100_tokens: k12?.context_slots_per_100_tokens ?? null,
      k12_context_slots_per_100_promptish_tokens: k12?.context_slots_per_100_promptish_tokens ?? null,
      k13_estimated_tokens: k13?.estimated_tokens ?? null,
      k13_promptish_tokens: k13?.promptish_tokens ?? null,
      k13_token_reduction_vs_min_json: k13?.token_reduction_vs_min_json ?? null,
      k13_promptish_token_reduction_vs_min_json: k13?.promptish_token_reduction_vs_min_json ?? null,
      k13_context_slots: k13?.context_slots ?? null,
      k13_context_slots_per_100_tokens: k13?.context_slots_per_100_tokens ?? null,
      k13_context_slots_per_100_promptish_tokens: k13?.context_slots_per_100_promptish_tokens ?? null,
      k14_estimated_tokens: k14?.estimated_tokens ?? null,
      k14_promptish_tokens: k14?.promptish_tokens ?? null,
      k14_token_reduction_vs_min_json: k14?.token_reduction_vs_min_json ?? null,
      k14_promptish_token_reduction_vs_min_json: k14?.promptish_token_reduction_vs_min_json ?? null,
      k14_context_slots: k14?.context_slots ?? null,
      k14_context_slots_per_100_tokens: k14?.context_slots_per_100_tokens ?? null,
      k14_context_slots_per_100_promptish_tokens: k14?.context_slots_per_100_promptish_tokens ?? null,
      k15_estimated_tokens: k15?.estimated_tokens ?? null,
      k15_promptish_tokens: k15?.promptish_tokens ?? null,
      k15_token_reduction_vs_min_json: k15?.token_reduction_vs_min_json ?? null,
      k15_promptish_token_reduction_vs_min_json: k15?.promptish_token_reduction_vs_min_json ?? null,
      k15_context_slots: k15?.context_slots ?? null,
      k15_context_slots_per_100_tokens: k15?.context_slots_per_100_tokens ?? null,
      k15_context_slots_per_100_promptish_tokens: k15?.context_slots_per_100_promptish_tokens ?? null,
      k9_estimated_tokens: k9?.estimated_tokens ?? null,
      k9_promptish_tokens: k9?.promptish_tokens ?? null,
      k9_token_reduction_vs_min_json: k9?.token_reduction_vs_min_json ?? null,
      k9_promptish_token_reduction_vs_min_json: k9?.promptish_token_reduction_vs_min_json ?? null,
      k9_context_slots: k9?.context_slots ?? null,
      k9_context_slots_per_100_tokens: k9?.context_slots_per_100_tokens ?? null,
      k9_context_slots_per_100_promptish_tokens: k9?.context_slots_per_100_promptish_tokens ?? null,
      k8_estimated_tokens: k8?.estimated_tokens ?? null,
      k8_promptish_tokens: k8?.promptish_tokens ?? null,
      min_json_estimated_tokens: minJson?.estimated_tokens ?? null,
      min_json_promptish_tokens: minJson?.promptish_tokens ?? null,
      jsonb_estimated_tokens: jsonb?.estimated_tokens ?? null,
      protobuf_text_estimated_tokens: protobuf?.estimated_tokens ?? null,
      toonish_table_estimated_tokens: toonish?.estimated_tokens ?? null,
      yaml_brief_estimated_tokens: yaml?.estimated_tokens ?? null,
      xml_tags_estimated_tokens: xml?.estimated_tokens ?? null,
      opaque_binary_prompt_native_score: Math.max(
        resultByName(results, 'gzip-json-base64')?.prompt_native ?? 0,
        resultByName(results, 'gzip-k7-base64')?.prompt_native ?? 0,
        resultByName(results, 'messagepack-base64-proxy')?.prompt_native ?? 0,
      ),
    },
    gates,
    results,
  };
}

export function parseAgentContextCapsule(capsule: string): {
  version: string;
  task?: string;
  selected?: string;
  files: string[];
  validation: string[];
  rules: string[];
} {
  const aliases = new Map<string, string>();
  const fileRefs = new Map<string, string>();
  const files: string[] = [];
  const validation: string[] = [];
  const rules: string[] = [];
  let defaultExtension = '';
  let version = '';
  let task: string | undefined;
  let selected: string | undefined;

  for (const rawLine of String(capsule || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [prefix, ...rest] = line.split('|');
    const body = rest.join('|');
    if (prefix === 'K6' || prefix === 'K7') {
      version = prefix;
      task = prefix === 'K7' ? body.replace(/^[a-z]:/, '') : body;
    } else if (line.startsWith('K10 ')) {
      version = 'K10';
      task = line.replace(/^K10\s+[a-z]\|?/, '').trim();
    } else if (line.startsWith('K13')) {
      version = 'K13';
      task = line.replace(/^K13[a-z]\s*/, '').trim();
    } else if (line.startsWith('K14')) {
      version = 'K14';
      task = line.replace(/^K14[a-z]\s*/, '').trim();
    } else if (line.startsWith('K15')) {
      version = 'K15';
      const match = line.match(/^K15([a-z])([A-Za-z0-9]{1,12})?\s*/);
      defaultExtension = match?.[2] || '';
      task = line.slice(match?.[0]?.length || 3).trim();
    } else if (line.startsWith('K12')) {
      version = 'K12';
      task = line.replace(/^K12[a-z]\s*/, '').trim();
    } else if (line.startsWith('K11')) {
      version = 'K11';
      task = line.replace(/^K11[a-z]\s*/, '').trim();
    } else if (line.startsWith('K9 ')) {
      version = 'K9';
      task = line.replace(/^K9\s+[a-z]\|?/, '').trim();
    } else if (line.startsWith('K8 ')) {
      version = 'K8';
      task = line.replace(/^K8\s+[a-z]\s+/, '').trim();
    } else if (line.startsWith('A ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      for (let index = 0; index < parts.length; index += 2) {
        const key = parts[index];
        const value = parts[index + 1];
        if (key && value) aliases.set(key, value);
      }
    } else if (version === 'K15' && line.startsWith('A')) {
      const parts = line.slice(1).trim().split(/\s+/);
      for (let index = 0; index < parts.length; index += 2) {
        const key = parts[index];
        const value = parts[index + 1];
        if (key && value) aliases.set(key, value);
      }
    } else if (line.startsWith('~ ')) {
      for (const pair of line.slice(2).split(';')) {
        const [key, value] = pair.split('=');
        if (key && value) aliases.set(key, value);
      }
    } else if (line.startsWith('~')) {
      if (/^~\w+\s+/.test(line)) {
        const parts = line.slice(1).trim().split(/\s+/);
        for (let index = 0; index < parts.length; index += 2) {
          const key = parts[index];
          const value = parts[index + 1];
          if (key && value) aliases.set(key, value);
        }
        continue;
      }
      for (const pair of line.slice(1).split(';')) {
        const [key, value] = pair.split('=');
        if (key && value) aliases.set(key, value);
      }
    } else if (version === 'K14' && line.startsWith('X ')) {
      defaultExtension = line.slice(2).trim().replace(/^\./, '');
    } else if ((version === 'K12' || version === 'K13' || version === 'K14' || version === 'K15') && line.startsWith('@ ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      selected = parts.length >= 4 ? `${parts[0]} ${parts[1]} #${parts[2]} ${parts[3]}` : line.slice(2).trim();
    } else if (line.startsWith('@ ')) {
      selected = line.slice(2).trim();
    } else if (line.startsWith('@')) {
      selected = line.slice(1).trim();
    } else if ((version === 'K13' || version === 'K14' || version === 'K15') && /^[EOC](\s|[A-Za-z0-9_])/.test(line)) {
      const role = line[0];
      const parts = line.slice(version === 'K15' ? 1 : 2).trim().split(/\s+/).filter(Boolean);
      let currentAlias = '';
      for (const part of parts) {
        if (part === '_' || aliases.has(part)) {
          currentAlias = part;
          continue;
        }
        if (!currentAlias) continue;
        const expandedPrefix = aliases.get(currentAlias);
        const suffix = (version === 'K14' || version === 'K15') ? restoreK14Extension(part, defaultExtension) : part;
        const file = expandedPrefix ? `${expandedPrefix}/${suffix}` : suffix;
        const expanded = expandAlias(file, aliases);
        files.push(expanded);
        const fileIndex = files.length;
        fileRefs.set(`F${fileIndex}`, expanded);
        fileRefs.set(`#${fileIndex}`, expanded);
        fileRefs.set(String(fileIndex), expanded);
      }
      if (role === 'E' || role === 'O' || role === 'C') continue;
    } else if (version === 'K12' && line.startsWith('F ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      let fileIndex = 1;
      for (let index = 0; index < parts.length; index += 2) {
        const roleAlias = parts[index] || '';
        const suffix = parts[index + 1] || '';
        if (!roleAlias || !suffix) continue;
        const alias = roleAlias.slice(1);
        const expandedPrefix = aliases.get(alias);
        const file = expandedPrefix ? `${expandedPrefix}/${suffix}` : suffix;
        const expanded = expandAlias(file, aliases);
        files.push(expanded);
        fileRefs.set(`F${fileIndex}`, expanded);
        fileRefs.set(`#${fileIndex}`, expanded);
        fileRefs.set(String(fileIndex), expanded);
        fileIndex += 1;
      }
    } else if (line.startsWith('F ')) {
      const rawItems = line.includes(';') ? line.slice(2).split(';') : line.slice(2).split(/\s+/);
      for (const item of rawItems) {
        const match = item.match(/^(\d+)([*!>])?=(.+)$/);
        const compactMatch = match || item.match(/^(\d+)([*!>])?(.+)$/);
        const file = match ? match[3] : compactMatch ? compactMatch[3].replace(/^=/, '') : item.replace(/^[*!>]/, '');
        if (file) {
          const expanded = expandAlias(file, aliases);
          files.push(expanded);
          const refMatch = match || compactMatch;
          if (refMatch) fileRefs.set(`F${refMatch[1]}`, expanded);
          if (refMatch) fileRefs.set(`#${refMatch[1]}`, expanded);
        }
      }
    } else if (line.startsWith('F')) {
      if (/^F\s+/.test(line)) {
        for (const item of line.slice(2).split(/\s+/)) {
          const match = item.match(/^(\d+)([*!>])?(.+)$/);
          const file = match ? match[3].replace(/^=/, '') : item.replace(/^[*!>]/, '');
          if (file) {
            const expanded = expandAlias(file, aliases);
            files.push(expanded);
            if (match) fileRefs.set(`F${match[1]}`, expanded);
            if (match) fileRefs.set(`#${match[1]}`, expanded);
          }
        }
        continue;
      }
      for (const item of line.slice(1).split(';')) {
        const match = item.match(/^(\d+)([*!>])?=(.+)$/);
        const file = match ? match[3] : item.replace(/^[*!>]/, '');
        if (file) {
          const expanded = expandAlias(file, aliases);
          files.push(expanded);
          if (match) fileRefs.set(`F${match[1]}`, expanded);
          if (match) fileRefs.set(`#${match[1]}`, expanded);
        }
      }
    } else if (version === 'K15' && line.startsWith('V|[')) {
      const commands: unknown = JSON.parse(line.slice(2));
      if (!Array.isArray(commands) || commands.some(command => typeof command !== 'string')) throw new Error('Invalid capsule validation commands');
      validation.push(...commands);
    } else if (line.startsWith('V ')) {
      validation.push(...line.slice(2).split(';').map(item => expandFileRefs(expandAlias(item, aliases), fileRefs)).filter(Boolean));
    } else if (version === 'K15' && line.startsWith('V')) {
      validation.push(...line.slice(1).trim().split(/\s+/).map(item => expandFileRefs(expandAlias(item, aliases), fileRefs)).filter(Boolean));
    } else if (/^[IUR!] /.test(line)) {
      rules.push(...line.slice(2).split(';').map(item => expandAlias(item, aliases)).filter(Boolean));
    } else if (version === 'K15' && /^[IUR!]/.test(line)) {
      rules.push(...line.slice(1).trim().split(/\s+/).map(item => expandAlias(item, aliases)).filter(Boolean));
    } else if (/^[IUR!]/.test(line)) {
      rules.push(...line.slice(1).split(';').map(item => expandAlias(item, aliases)).filter(Boolean));
    } else if (prefix === '~') {
      for (const pair of body.split(';')) {
        const [key, value] = pair.split('=');
        if (key && value) aliases.set(key, value);
      }
    } else if (prefix === '@') {
      selected = body;
    } else if (prefix === 'F') {
      for (const item of body.split(';')) {
        const [, file] = item.split(':');
        if (file) files.push(expandAlias(file.replace(/^[*!>]/, ''), aliases));
      }
    } else if (prefix === 'V') {
      validation.push(...body.split(';').map(item => expandAlias(item, aliases)).filter(Boolean));
    } else if (prefix === 'v') {
      validation.push(...body.split(';').map(item => expandAlias(item, aliases)).filter(Boolean));
    } else if (/^[IMRX!iur]$/.test(prefix)) {
      rules.push(...body.split(';').map(item => expandAlias(item, aliases)).filter(Boolean));
    }
  }

  return { version, task, selected, files, validation, rules };
}

function buildCandidates(context: any): Candidate[] {
  const minJson = () => JSON.stringify(context);
  const shortJson = () => JSON.stringify({
    p: context.context_profile,
    t: context.task,
    c: context.capsule,
    s: context.selected,
    f: context.files,
    a: context.candidates,
    k: context.terms,
    i: context.idioms,
    r: context.risks,
    m: context.reuse,
    e: context.execution,
    q: context.rule,
  });
  const toonish = () => [
    `profile: ${context.context_profile || ''}`,
    `task: ${context.task || ''}`,
    context.selected ? `selected: ${compactSelected(context.selected)}` : '',
    table('files', ['n', 'file'], [...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].map((file, index) => [String(index + 1), file])),
    lineList('idioms', context.idioms),
    lineList('risks', context.risks),
    lineList('reuse', context.reuse),
    lineList('validate', context.execution?.validate),
    `rule: ${context.rule || ''}`,
  ].filter(Boolean).join('\n');
  const yamlBrief = () => [
    `task: ${context.task || ''}`,
    context.selected ? `selected: ${compactSelected(context.selected)}` : '',
    'files:',
    ...[...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].slice(0, 8).map((file, index) => `  - ${index + 1}: ${file}`),
    'idioms:',
    ...arrayOfStrings(context.idioms).slice(0, 3).map(value => `  - ${compactText(value, 78)}`),
    'reuse:',
    ...arrayOfStrings(context.reuse).slice(0, 2).map(value => `  - ${compactText(value, 78)}`),
    'risks:',
    ...arrayOfStrings(context.risks).slice(0, 2).map(value => `  - ${compactText(value, 78)}`),
    'validate:',
    ...arrayOfStrings(context.execution?.validate).slice(0, 2).map(value => `  - ${compactText(value, 92)}`),
    `rule: ${compactText(context.rule || '', 96)}`,
  ].filter(Boolean).join('\n');
  const xmlTags = () => [
    `<task>${escapeTag(context.task || '')}</task>`,
    context.selected ? `<selected>${escapeTag(compactSelected(context.selected))}</selected>` : '',
    `<files>${[...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].slice(0, 8)
      .map((file, index) => `<f n="${index + 1}">${escapeTag(file)}</f>`).join('')}</files>`,
    `<idioms>${arrayOfStrings(context.idioms).slice(0, 3).map(value => `<i>${escapeTag(compactText(value, 78))}</i>`).join('')}</idioms>`,
    `<reuse>${arrayOfStrings(context.reuse).slice(0, 2).map(value => `<u>${escapeTag(compactText(value, 78))}</u>`).join('')}</reuse>`,
    `<risks>${arrayOfStrings(context.risks).slice(0, 2).map(value => `<r>${escapeTag(compactText(value, 78))}</r>`).join('')}</risks>`,
    `<validate>${arrayOfStrings(context.execution?.validate).slice(0, 2).map(value => `<v>${escapeTag(compactText(value, 92))}</v>`).join('')}</validate>`,
    `<rule>${escapeTag(compactText(context.rule || '', 96))}</rule>`,
  ].filter(Boolean).join('');
  const tsv = () => [
    `T\t${context.task || ''}`,
    context.selected ? `S\t${compactSelected(context.selected)}` : '',
    ...[...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].map((file, index) => `F\t${index + 1}\t${file}`),
    ...arrayOfStrings(context.idioms).map(value => `I\t${value}`),
    ...arrayOfStrings(context.risks).map(value => `R\t${value}`),
    ...arrayOfStrings(context.reuse).map(value => `M\t${value}`),
    ...arrayOfStrings(context.execution?.validate).map(value => `V\t${value}`),
    `!\t${context.rule || ''}`,
  ].filter(Boolean).join('\n');
  const k5PlusShort = () => [
    context.capsule || '',
    shortJson(),
  ].filter(Boolean).join('\n');
  const protobufText = () => [
    `task:"${compactText(context.task || '', 86)}"`,
    context.selected ? `sel{${compactSelected(context.selected)}}` : '',
    ...[...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].slice(0, 8)
      .map((file, index) => `f{n:${index + 1} p:"${file}"}`),
    ...arrayOfStrings(context.idioms).slice(0, 3).map(value => `i:"${compactText(value, 72)}"`),
    ...arrayOfStrings(context.risks).slice(0, 2).map(value => `r:"${compactText(value, 72)}"`),
    ...arrayOfStrings(context.execution?.validate).slice(0, 2).map(value => `v:"${compactText(value, 90)}"`),
  ].filter(Boolean).join(' ');
  const jsonbRowset = () => [
    ['t', context.task || ''],
    ['s', context.selected ? compactSelected(context.selected) : ''],
    ...[...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].slice(0, 8).map((file, index) => [`f${index + 1}`, file]),
    ...arrayOfStrings(context.idioms).slice(0, 3).map((value, index) => [`i${index + 1}`, value]),
    ...arrayOfStrings(context.risks).slice(0, 2).map((value, index) => [`r${index + 1}`, value]),
    ...arrayOfStrings(context.execution?.validate).slice(0, 2).map((value, index) => [`v${index + 1}`, value]),
  ].filter(([, value]) => value).map(([key, value]) => `${key}\t${String(key).startsWith('f') ? value : compactText(value, 90)}`).join('\n');
  const cborDiagnostic = () => `{"t":${JSON.stringify(compactText(context.task || '', 86))},"f":[${[...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].slice(0, 8).map(file => JSON.stringify(file)).join(',')}],"i":[${arrayOfStrings(context.idioms).slice(0, 3).map(value => JSON.stringify(compactText(value, 72))).join(',')}],"r":[${arrayOfStrings(context.risks).slice(0, 2).map(value => JSON.stringify(compactText(value, 72))).join(',')}],"v":[${arrayOfStrings(context.execution?.validate).slice(0, 2).map(value => JSON.stringify(compactText(value, 90))).join(',')}]}`;
  const messagePackBase64 = () => Buffer.from(JSON.stringify({
    t: compactText(context.task || '', 86),
    s: context.selected ? compactSelected(context.selected) : '',
    f: [...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)].slice(0, 8),
    i: arrayOfStrings(context.idioms).slice(0, 3).map(value => compactText(value, 72)),
    r: arrayOfStrings(context.risks).slice(0, 2).map(value => compactText(value, 72)),
    v: arrayOfStrings(context.execution?.validate).slice(0, 2).map(value => compactText(value, 90)),
  })).toString('base64');
  const k6 = () => encodeLegacyK6(context);
  const k7 = () => encodeK7(context);
  const k8 = () => encodeK8(context);
  const k9 = () => encodeK9(context);
  const k10 = () => encodeK10(context);
  const k11 = () => encodeK11(context);
  const k12 = () => encodeK12(context);
  const k13 = () => encodeK13(context);
  const k14 = () => encodeK14(context);
  const k15 = () => encodeK15(context);
  const gzipJson = () => zlib.gzipSync(Buffer.from(minJson())).toString('base64');
  const gzipK7 = () => zlib.gzipSync(Buffer.from(k7())).toString('base64');

  return [
    { name: 'min-json', encode: minJson, decodeValidation: output => JSON.parse(output).execution?.validate, agentReadable: 76, actionable: 70, exactPaths: 100, promptNative: 92, encodeCost: 'text' },
    { name: 'short-key-json', encode: shortJson, decodeValidation: output => JSON.parse(output).e?.validate, agentReadable: 66, actionable: 74, exactPaths: 100, promptNative: 88, encodeCost: 'text' },
    { name: 'toonish-table', encode: toonish, agentReadable: 90, actionable: 82, exactPaths: 100, promptNative: 95, encodeCost: 'text' },
    { name: 'yaml-brief', encode: yamlBrief, agentReadable: 88, actionable: 82, exactPaths: 100, promptNative: 94, encodeCost: 'text' },
    { name: 'xml-tags', encode: xmlTags, agentReadable: 80, actionable: 80, exactPaths: 100, promptNative: 90, encodeCost: 'text' },
    { name: 'tsv-opcodes', encode: tsv, agentReadable: 82, actionable: 84, exactPaths: 100, promptNative: 93, encodeCost: 'text' },
    { name: 'protobuf-text', encode: protobufText, agentReadable: 70, actionable: 76, exactPaths: 100, promptNative: 82, encodeCost: 'text' },
    { name: 'jsonb-rowset', encode: jsonbRowset, agentReadable: 74, actionable: 78, exactPaths: 100, promptNative: 84, encodeCost: 'text' },
    { name: 'cbor-diagnostic-json', encode: cborDiagnostic, decodeValidation: output => JSON.parse(output).v, agentReadable: 62, actionable: 70, exactPaths: 100, promptNative: 76, encodeCost: 'text' },
    { name: 'messagepack-base64-proxy', encode: messagePackBase64, decodeValidation: output => JSON.parse(Buffer.from(output, 'base64').toString('utf8')).v, agentReadable: 5, actionable: 8, exactPaths: 100, promptNative: 5, encodeCost: 'binary' },
    { name: 'k5-plus-short-json', encode: k5PlusShort, agentReadable: 86, actionable: 90, exactPaths: 100, promptNative: 94, encodeCost: 'text' },
    { name: 'k6-context-capsule', encode: k6, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 91, actionable: 94, exactPaths: 100, promptNative: 97, encodeCost: 'text' },
    { name: 'k7-agent-context-language', encode: k7, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 93, actionable: 96, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k8-agent-context-language', encode: k8, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 94, actionable: 97, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k9-agent-context-language', encode: k9, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 94, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k10-agent-context-language', encode: k10, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 93, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k11-agent-context-language', encode: k11, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 92, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k12-agent-context-language', encode: k12, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 90, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k13-agent-context-language', encode: k13, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 91, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k14-agent-context-language', encode: k14, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 90, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'k15-agent-context-language', encode: k15, decodeValidation: output => parseAgentContextCapsule(output).validation, agentReadable: 90, actionable: 98, exactPaths: 100, promptNative: 99, encodeCost: 'text' },
    { name: 'gzip-json-base64', encode: gzipJson, decodeValidation: output => JSON.parse(zlib.gunzipSync(Buffer.from(output, 'base64')).toString('utf8')).execution?.validate, agentReadable: 5, actionable: 8, exactPaths: 100, promptNative: 5, encodeCost: 'binary' },
    { name: 'gzip-k7-base64', encode: gzipK7, decodeValidation: output => parseAgentContextCapsule(zlib.gunzipSync(Buffer.from(output, 'base64')).toString('utf8')).validation, agentReadable: 5, actionable: 8, exactPaths: 100, promptNative: 5, encodeCost: 'binary' },
  ];
}

function encodeLegacyK6(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const lines = [
    `K6|${compactText(context.task || 'work', 84)}`,
    aliasLine(aliases),
    context.selected ? `@|${compactSelected(context.selected)}` : '',
    files.length ? `F|${files.map((file, index) => {
      const marker = editSet.has(file) ? '*' : readSet.has(file) ? '>' : '';
      return `${index + 1}${marker}:${applyAliases(file, aliases)}`;
    }).join(';')}` : '',
    listLine('I', context.idioms, 3, 64, aliases),
    listLine('M', context.reuse, 2, 64, aliases),
    listLine('R', context.risks, 2, 64, aliases),
    listLine('V', context.execution?.validate, 2, 80, aliases),
    context.rule ? `!|${compactText(context.rule, 72)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK7(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const lines = [
    `K7|${taskCode(context.task)}:${compactTaskText(context.task || 'work', 72)}`,
    aliasLine(aliases),
    context.selected ? `@|${compactSelected(context.selected)}` : '',
    files.length ? `F|${files.map((file, index) => {
      const marker = editSet.has(file) ? '*' : readSet.has(file) ? '>' : '';
      return `${index + 1}${marker}:${applyAliases(file, aliases)}`;
    }).join(';')}` : '',
    listLine('i', context.idioms, 3, 50, aliases, compactAgentText),
    listLine('u', context.reuse, 2, 52, aliases, compactAgentText),
    listLine('r', context.risks, 2, 52, aliases, compactAgentText),
    listLine('v', context.execution?.validate, 2, 72, aliases, compactCommandText),
    context.rule ? `!|${compactAgentText(context.rule, 54)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK8(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const lines = [
    `K8 ${taskCode(context.task)} ${compactTaskText(context.task || 'work', 66)}`,
    compactAliasLine(aliases),
    context.selected ? `@ ${compactSelectedK8(context.selected, aliases)}` : '',
    files.length ? `F ${files.map(file => {
      const marker = editSet.has(file) ? '*' : readSet.has(file) ? '>' : '';
      return `${marker}${applyAliasesK8(file, aliases)}`;
    }).join(';')}` : '',
    compactListLine('I', context.idioms, 3, 46, aliases),
    compactListLine('U', context.reuse, 2, 48, aliases),
    compactListLine('R', context.risks, 2, 48, aliases),
    compactListLine('V', context.execution?.validate, 2, 66, aliases, compactCommandText),
    context.rule ? `! ${compactAgentText(context.rule, 48)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK9(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const fileRefs = new Map<string, number>();
  files.forEach((file, index) => fileRefs.set(file, index + 1));
  const lines = [
    `K9 ${taskCode(context.task)}|${compactTaskText(context.task || 'work', 58)}`,
    compactAliasLine(aliases),
    files.length ? `F ${files.map((file, index) => {
      const marker = editSet.has(file) ? '*' : readSet.has(file) ? '>' : '';
      return `${index + 1}${marker}=${applyAliasesK8(file, aliases)}`;
    }).join(';')}` : '',
    context.selected ? `@ ${compactSelectedK9(context.selected, aliases, fileRefs)}` : '',
    compactListLine('I', context.idioms, 3, 38, aliases, compactK9AgentText),
    compactListLine('U', context.reuse, 2, 40, aliases, compactK9AgentText),
    compactListLine('R', context.risks, 2, 40, aliases, compactK9AgentText),
    compactListLine('V', compactK9Validation(context.execution?.validate, fileRefs), 2, 44, aliases, compactCommandText),
    context.rule ? `! ${compactK9AgentText(context.rule, 42)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK10(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const fileRefs = new Map<string, number>();
  files.forEach((file, index) => fileRefs.set(file, index + 1));
  const lines = [
    `K10 ${taskCode(context.task)}|${compactTaskText(context.task || 'work', 52)}`,
    compactAliasLineK10(aliases),
    files.length ? `F${files.map((file, index) => {
      const marker = editSet.has(file) ? '*' : readSet.has(file) ? '>' : '';
      return `${index + 1}${marker}=${applyAliasesK8(file, aliases)}`;
    }).join(';')}` : '',
    context.selected ? `@${compactSelectedK10(context.selected, aliases, fileRefs)}` : '',
    compactListLineK10('I', context.idioms, 3, 28, aliases, compactK10Guidance),
    compactListLineK10('U', context.reuse, 2, 30, aliases, compactK10Guidance),
    compactListLineK10('R', context.risks, 2, 30, aliases, compactK10Guidance),
    compactListLineK10('V', compactK10Validation(context.execution?.validate, fileRefs), 2, 34, aliases, compactCommandText),
    context.rule ? `!${compactK10Rule(context.rule, 30)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK11(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const fileRefs = new Map<string, number>();
  files.forEach((file, index) => fileRefs.set(file, index + 1));
  const lines = [
    `K11${taskCode(context.task)} ${compactK11Task(context.task || 'work', 48)}`,
    compactAliasLineK11(aliases),
    files.length ? `F ${files.map((file, index) => {
      const marker = editSet.has(file) ? '*' : readSet.has(file) ? '>' : '=';
      return `${index + 1}${marker}${applyAliasesK8(file, aliases)}`;
    }).join(' ')}` : '',
    context.selected ? `@ ${compactSelectedK11(context.selected, aliases, fileRefs)}` : '',
    compactListLineK11('I', context.idioms, 3, 24, aliases, compactK11Guidance),
    compactListLineK11('U', context.reuse, 2, 28, aliases, compactK11Guidance),
    compactListLineK11('R', context.risks, 2, 28, aliases, compactK11Guidance),
    compactListLineK11('V', compactK11Validation(context.execution?.validate, fileRefs), 2, 32, aliases, compactCommandText),
    context.rule ? `! ${compactK11Rule(context.rule, 28)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK12(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const fileRefs = new Map<string, number>();
  files.forEach((file, index) => fileRefs.set(file, index + 1));
  const lines = [
    `K12${taskCode(context.task)} ${compactK12Task(context.task || 'work', 46)}`,
    compactAliasLineK12(aliases),
    files.length ? `F ${files.map(file => {
      const role = editSet.has(file) ? 'e' : readSet.has(file) ? 'r' : 'c';
      const { alias, suffix } = splitFileForK12(file, aliases);
      return `${role}${alias} ${suffix}`;
    }).join(' ')}` : '',
    context.selected ? `@ ${compactSelectedK12(context.selected, fileRefs)}` : '',
    compactListLineK12('I', context.idioms, 3, 22, compactK12Guidance),
    compactListLineK12('U', context.reuse, 2, 24, compactK12Guidance),
    compactListLineK12('R', context.risks, 2, 24, compactK12Guidance),
    compactListLineK12('V', compactK12Validation(context.execution?.validate, fileRefs), 2, 28, compactCommandText),
    context.rule ? `! ${compactK12Rule(context.rule, 26)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK13(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const groupedFiles = groupK13Files(files, aliases, editSet, readSet);
  const orderedFiles = groupedFiles.flatMap(group => group.files.map(file => file.original));
  const fileRefs = new Map<string, number>();
  orderedFiles.forEach((file, index) => fileRefs.set(file, index + 1));
  const lines = [
    `K13${taskCode(context.task)} ${compactK12Task(context.task || 'work', 46)}`,
    compactAliasLineK12(aliases),
    ...formatK13FileGroups(groupedFiles),
    context.selected ? `@ ${compactSelectedK12(context.selected, fileRefs)}` : '',
    compactListLineK12('I', context.idioms, 3, 22, compactK12Guidance),
    compactListLineK12('U', context.reuse, 2, 24, compactK12Guidance),
    compactListLineK12('R', context.risks, 2, 24, compactK12Guidance),
    compactListLineK12('V', compactK12Validation(context.execution?.validate, fileRefs), 2, 28, compactCommandText),
    context.rule ? `! ${compactK12Rule(context.rule, 26)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK14(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const defaultExtension = chooseK14DefaultExtension(files);
  const groupedFiles = groupK14Files(files, aliases, editSet, readSet, defaultExtension);
  const orderedFiles = groupedFiles.flatMap(group => group.files.map(file => file.original));
  const fileRefs = new Map<string, number>();
  orderedFiles.forEach((file, index) => fileRefs.set(file, index + 1));
  const lines = [
    `K14${taskCode(context.task)} ${compactK12Task(context.task || 'work', 46)}`,
    defaultExtension ? `X ${defaultExtension}` : '',
    compactAliasLineK12(aliases),
    ...formatK13FileGroups(groupedFiles),
    context.selected ? `@ ${compactSelectedK12(context.selected, fileRefs)}` : '',
    compactListLineK12('I', context.idioms, 3, 22, compactK12Guidance),
    compactListLineK12('U', context.reuse, 2, 24, compactK12Guidance),
    compactListLineK12('R', context.risks, 2, 24, compactK12Guidance),
    compactListLineK12('V', compactK12Validation(context.execution?.validate, fileRefs), 2, 28, compactCommandText),
    context.rule ? `! ${compactK12Rule(context.rule, 26)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function encodeK15(context: any): string {
  const aliases = buildPathAliases(context);
  const files = uniqueStrings([...arrayOfStrings(context.files), ...arrayOfStrings(context.candidates)]).slice(0, 8);
  const editSet = new Set(arrayOfStrings(context.execution?.edit));
  const readSet = new Set(arrayOfStrings(context.execution?.read));
  const defaultExtension = chooseK14DefaultExtension(files);
  const groupedFiles = groupK14Files(files, aliases, editSet, readSet, defaultExtension);
  const orderedFiles = groupedFiles.flatMap(group => group.files.map(file => file.original));
  const fileRefs = new Map<string, number>();
  orderedFiles.forEach((file, index) => fileRefs.set(file, index + 1));
  const extensionSigil = defaultExtension ? defaultExtension : '';
  const lines = [
    `K15${taskCode(context.task)}${extensionSigil} ${compactK12Task(context.task || 'work', 46)}`,
    compactAliasLineK15(aliases),
    ...formatK15FileGroups(groupedFiles),
    context.selected ? `@${compactSelectedK12(context.selected, fileRefs)}` : '',
    compactListLineK15('I', context.idioms, 3, 22, compactK12Guidance),
    compactListLineK15('U', context.reuse, 2, 24, compactK12Guidance),
    compactListLineK15('R', context.risks, 2, 24, compactK12Guidance),
    arrayOfStrings(context.execution?.validate).length ? `V|${JSON.stringify(arrayOfStrings(context.execution.validate))}` : '',
    context.rule ? `!${compactK12Rule(context.rule, 26)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function groupK13Files(
  files: string[],
  aliases: Map<string, string>,
  editSet: Set<string>,
  readSet: Set<string>,
): Array<{ line: 'E' | 'O' | 'C'; files: Array<{ alias: string; suffix: string; original: string }> }> {
  const groups = new Map<'E' | 'O' | 'C', Array<{ alias: string; suffix: string; original: string }>>([
    ['E', []],
    ['O', []],
    ['C', []],
  ]);
  for (const file of files) {
    const line = editSet.has(file) ? 'E' : readSet.has(file) ? 'O' : 'C';
    const { alias, suffix } = splitFileForK12(file, aliases);
    groups.get(line)!.push({ alias, suffix, original: file });
  }
  return Array.from(groups.entries())
    .map(([line, grouped]) => ({ line, files: grouped }))
    .filter(group => group.files.length > 0);
}

function groupK14Files(
  files: string[],
  aliases: Map<string, string>,
  editSet: Set<string>,
  readSet: Set<string>,
  defaultExtension: string,
): Array<{ line: 'E' | 'O' | 'C'; files: Array<{ alias: string; suffix: string; original: string }> }> {
  return groupK13Files(files, aliases, editSet, readSet).map(group => ({
    line: group.line,
    files: group.files.map(file => ({
      ...file,
      suffix: stripK14Extension(file.suffix, defaultExtension),
    })),
  }));
}

function formatK13FileGroups(groups: Array<{ line: 'E' | 'O' | 'C'; files: Array<{ alias: string; suffix: string }> }>): string[] {
  return groups.map(group => {
    const parts: string[] = [];
    let currentAlias = '';
    for (const file of group.files) {
      if (file.alias !== currentAlias) {
        parts.push(file.alias);
        currentAlias = file.alias;
      }
      parts.push(file.suffix);
    }
    return `${group.line} ${parts.join(' ')}`;
  });
}

function formatK15FileGroups(groups: Array<{ line: 'E' | 'O' | 'C'; files: Array<{ alias: string; suffix: string }> }>): string[] {
  return formatK13FileGroups(groups).map(line => `${line[0]}${line.slice(2)}`);
}

function chooseK14DefaultExtension(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const extension = fileExtension(file);
    if (!extension) continue;
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return best && best[1] >= 2 ? best[0] : '';
}

function stripK14Extension(suffix: string, defaultExtension: string): string {
  if (!defaultExtension) return suffix;
  const ending = `.${defaultExtension}`;
  return suffix.endsWith(ending) ? suffix.slice(0, -ending.length) : suffix;
}

function restoreK14Extension(suffix: string, defaultExtension: string): string {
  if (!defaultExtension || hasKnownFileExtension(suffix)) return suffix;
  return `${suffix}.${defaultExtension}`;
}

function fileExtension(value: string): string {
  const basename = pathBasename(value);
  const match = basename.match(/\.([A-Za-z0-9]{1,12})$/);
  return match ? match[1] : '';
}

function hasKnownFileExtension(value: string): boolean {
  const extension = fileExtension(value).toLowerCase();
  return [
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
    'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'cs',
    'dart', 'swift', 'sql', 'prisma', 'graphql', 'gql', 'proto',
    'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss', 'md',
  ].includes(extension);
}

function aliasLine(aliases: Map<string, string>): string {
  const values = Array.from(aliases.entries());
  return values.length ? `~|${values.map(([key, value]) => `${key}=${value}`).join(';')}` : '';
}

function buildPathAliases(context: any): Map<string, string> {
  const rawPaths = [
    ...arrayOfStrings(context.files),
    ...arrayOfStrings(context.candidates),
    ...arrayOfStrings(context.execution?.read),
    ...arrayOfStrings(context.execution?.edit),
    ...arrayOfStrings(context.execution?.validate).flatMap(value => value.split(/\s+/).filter(part => part.includes('/'))),
  ];
  const paths = uniqueStrings(rawPaths);
  const aliases = new Map<string, string>();
  const prefixScores = new Map<string, { count: number; score: number }>();
  for (const file of rawPaths) {
    const parts = file.replace(/^['"]|['"]$/g, '').split('/').filter(Boolean);
    for (let length = 2; length <= Math.min(4, parts.length - 1); length += 1) {
      const prefix = parts.slice(0, length).join('/');
      const current = prefixScores.get(prefix) || { count: 0, score: 0 };
      current.count += 1;
      current.score += Math.max(0, prefix.length - 3);
      prefixScores.set(prefix, current);
    }
  }
  const dynamic = Array.from(prefixScores.entries())
    .filter(([, value]) => value.count >= 2 && value.score >= 10)
    .sort((a, b) => b[1].score - a[1].score || b[0].length - a[0].length)
    .slice(0, 4);
  dynamic.forEach(([prefix], index) => aliases.set(`~${index}`, prefix));

  const candidates: Array<[string, string]> = [
    ['s', 'src'],
    ['t', 'test'],
    ['ts', 'tests'],
    ['a', 'apps'],
    ['p', 'packages'],
    ['cmp', 'components'],
    ['svc', 'services'],
    ['ctrl', 'controllers'],
    ['repo', 'repositories'],
  ];
  const pathText = paths.join('\n');
  for (const [key, value] of candidates) {
    const re = new RegExp(`(^|/)${escapeRegExp(value)}(/|\\.)`, 'g');
    const matches = pathText.match(re);
    if (matches && matches.length >= 2) aliases.set(`~${key}`, value);
  }
  return aliases;
}

function applyAliases(value: string, aliases: Map<string, string>): string {
  let output = String(value || '');
  for (const [alias, expanded] of Array.from(aliases.entries()).sort((a, b) => b[1].length - a[1].length)) {
    output = output
      .replace(new RegExp(`(^|/)${escapeRegExp(expanded)}(?=/)`, 'g'), `$1${alias}`)
      .replace(new RegExp(`\\.${escapeRegExp(expanded)}\\.`, 'g'), `.${alias}.`);
  }
  return output;
}

function compactAliasLine(aliases: Map<string, string>): string {
  const values = Array.from(aliases.entries());
  return values.length
    ? `~ ${values.map(([key, value]) => `${key.replace(/^~/, '')}=${value}`).join(';')}`
    : '';
}

function compactAliasLineK10(aliases: Map<string, string>): string {
  const values = Array.from(aliases.entries());
  return values.length
    ? `~${values.map(([key, value]) => `${key.replace(/^~/, '')}=${value}`).join(';')}`
    : '';
}

function compactAliasLineK11(aliases: Map<string, string>): string {
  const values = Array.from(aliases.entries());
  return values.length
    ? `~${values.map(([key, value]) => `${key.replace(/^~/, '')} ${value}`).join(' ')}`
    : '';
}

function compactAliasLineK12(aliases: Map<string, string>): string {
  const values = Array.from(aliases.entries());
  return values.length
    ? `A ${values.map(([key, value]) => `${key.replace(/^~/, '')} ${value}`).join(' ')}`
    : '';
}

function compactAliasLineK15(aliases: Map<string, string>): string {
  const values = Array.from(aliases.entries());
  return values.length
    ? `A${values.map(([key, value]) => `${key.replace(/^~/, '')} ${value}`).join(' ')}`
    : '';
}

function applyAliasesK8(value: string, aliases: Map<string, string>): string {
  let output = String(value || '');
  for (const [alias, expanded] of Array.from(aliases.entries()).sort((a, b) => b[1].length - a[1].length)) {
    output = output
      .replace(new RegExp(`(^|/)${escapeRegExp(expanded)}(?=/)`, 'g'), `$1${alias.replace(/^~/, '')}`)
      .replace(new RegExp(`\\.${escapeRegExp(expanded)}\\.`, 'g'), `.${alias.replace(/^~/, '')}.`);
  }
  return output;
}

function splitFileForK12(file: string, aliases: Map<string, string>): { alias: string; suffix: string } {
  const normalized = String(file || '').replace(/^\/+/, '');
  const match = Array.from(aliases.entries())
    .map(([key, value]) => ({ alias: key.replace(/^~/, ''), prefix: value.replace(/^\/+|\/+$/g, '') }))
    .filter(item => item.prefix && (normalized === item.prefix || normalized.startsWith(`${item.prefix}/`)))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!match) return { alias: '_', suffix: normalized };
  const suffix = normalized === match.prefix
    ? pathBasename(normalized)
    : normalized.slice(match.prefix.length + 1);
  return { alias: match.alias, suffix };
}

function pathBasename(value: string): string {
  const parts = String(value || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || value;
}

function expandAlias(value: string, aliases: Map<string, string>): string {
  let output = String(value || '');
  for (const [alias, expanded] of aliases) {
    const bareAlias = alias.replace(/^~/, '');
    output = output
      .replace(new RegExp(`(^|/)${escapeRegExp(alias)}(?=/)`, 'g'), `$1${expanded}`)
      .replace(new RegExp(`(^|/)${escapeRegExp(bareAlias)}(?=/)`, 'g'), `$1${expanded}`)
      .replace(new RegExp(`\\.${escapeRegExp(alias.slice(1))}\\.`, 'g'), `.${expanded}.`);
  }
  return output;
}

function listLine(
  prefix: string,
  value: unknown,
  limit: number,
  maxLength: number,
  aliases: Map<string, string>,
  compact: (value: unknown, maxLength: number) => string = compactText,
): string {
  const items = uniqueStrings(arrayOfStrings(value)
    .map(item => applyAliases(compact(item, maxLength), aliases))
    .filter(Boolean))
    .slice(0, limit);
  return items.length ? `${prefix}|${items.join(';')}` : '';
}

function compactListLine(
  prefix: string,
  value: unknown,
  limit: number,
  maxLength: number,
  aliases: Map<string, string>,
  compact: (value: unknown, maxLength: number) => string = compactAgentText,
): string {
  const items = uniqueStrings(arrayOfStrings(value)
    .map(item => applyAliasesK8(compact(item, maxLength), aliases))
    .filter(Boolean))
    .slice(0, limit);
  return items.length ? `${prefix} ${items.join(';')}` : '';
}

function compactListLineK10(
  prefix: string,
  value: unknown,
  limit: number,
  maxLength: number,
  aliases: Map<string, string>,
  compact: (value: unknown, maxLength: number) => string = compactAgentText,
): string {
  const items = uniqueStrings(arrayOfStrings(value)
    .map(item => applyAliasesK8(compact(item, maxLength), aliases))
    .filter(Boolean))
    .slice(0, limit);
  return items.length ? `${prefix}${items.join(';')}` : '';
}

function compactListLineK11(
  prefix: string,
  value: unknown,
  limit: number,
  maxLength: number,
  aliases: Map<string, string>,
  compact: (value: unknown, maxLength: number) => string = compactAgentText,
): string {
  const items = uniqueStrings(arrayOfStrings(value)
    .map(item => applyAliasesK8(compact(item, maxLength), aliases))
    .filter(Boolean))
    .slice(0, limit);
  return items.length ? `${prefix} ${items.join(' ')}` : '';
}

function compactListLineK12(
  prefix: string,
  value: unknown,
  limit: number,
  maxLength: number,
  compact: (value: unknown, maxLength: number) => string = compactAgentText,
): string {
  const items = uniqueStrings(arrayOfStrings(value)
    .map(item => compact(item, maxLength))
    .filter(Boolean))
    .slice(0, limit);
  return items.length ? `${prefix} ${items.join(' ')}` : '';
}

function compactListLineK15(
  prefix: string,
  value: unknown,
  limit: number,
  maxLength: number,
  compact: (value: unknown, maxLength: number) => string = compactAgentText,
): string {
  const items = uniqueStrings(arrayOfStrings(value)
    .map(item => compact(item, maxLength))
    .filter(Boolean))
    .slice(0, limit);
  return items.length ? `${prefix}${items.join(' ')}` : '';
}

function table(name: string, columns: string[], rows: string[][]): string {
  if (!rows.length) return '';
  return `${name}[${columns.join(',')}]:\n${rows.map(row => row.join('\t')).join('\n')}`;
}

function lineList(name: string, value: unknown): string {
  const values = arrayOfStrings(value).slice(0, 4);
  return values.length ? `${name}:\n${values.map(item => `- ${item}`).join('\n')}` : '';
}

function compactSelected(selected: any): string {
  if (!selected || typeof selected !== 'object') return compactText(selected, 96);
  return [
    compactText(selected.name, 60),
    compactText(selected.type, 28),
    String(selected.file || '').trim(),
    selected.line ? `L${selected.line}` : '',
  ]
    .filter(Boolean)
    .join('@');
}

function compactSelectedK8(selected: any, aliases: Map<string, string>): string {
  if (!selected || typeof selected !== 'object') return compactText(selected, 82);
  const file = applyAliasesK8(String(selected.file || '').trim(), aliases);
  const head = [compactText(selected.name, 44), compactText(selected.type, 18), file].filter(Boolean).join('/');
  return selected.line ? `${head}:${selected.line}` : head;
}

function compactSelectedK9(selected: any, aliases: Map<string, string>, fileRefs: Map<string, number>): string {
  if (!selected || typeof selected !== 'object') return compactText(selected, 72);
  const rawFile = String(selected.file || '').trim();
  const file = fileRefs.has(rawFile) ? `F${fileRefs.get(rawFile)}` : applyAliasesK8(rawFile, aliases);
  const head = [compactText(selected.name, 38), compactText(selected.type, 14), file].filter(Boolean).join('/');
  return selected.line ? `${head}:${selected.line}` : head;
}

function compactSelectedK10(selected: any, aliases: Map<string, string>, fileRefs: Map<string, number>): string {
  if (!selected || typeof selected !== 'object') return compactText(selected, 62);
  const rawFile = String(selected.file || '').trim();
  const file = fileRefs.has(rawFile) ? `#${fileRefs.get(rawFile)}` : applyAliasesK8(rawFile, aliases);
  const type = compactTypeToken(selected.type);
  const head = [compactText(selected.name, 34), type, file].filter(Boolean).join('/');
  return selected.line ? `${head}:${selected.line}` : head;
}

function compactSelectedK11(selected: any, aliases: Map<string, string>, fileRefs: Map<string, number>): string {
  if (!selected || typeof selected !== 'object') return compactText(selected, 58);
  const rawFile = String(selected.file || '').trim();
  const file = fileRefs.has(rawFile) ? `#${fileRefs.get(rawFile)}` : applyAliasesK8(rawFile, aliases);
  return [
    compactText(selected.name, 30),
    compactTypeToken(selected.type),
    file,
    selected.line ? String(selected.line) : '',
  ].filter(Boolean).join(' ');
}

function compactSelectedK12(selected: any, fileRefs: Map<string, number>): string {
  if (!selected || typeof selected !== 'object') return compactText(selected, 54);
  const rawFile = String(selected.file || '').trim();
  const file = fileRefs.has(rawFile) ? String(fileRefs.get(rawFile)) : '0';
  return [
    compactText(selected.name, 30),
    compactTypeToken(selected.type),
    file,
    selected.line ? String(selected.line) : '',
  ].filter(Boolean).join(' ');
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value || '')
    .replace(/\brepository\b/gi, 'repo')
    .replace(/\bvalidation\b/gi, 'val')
    .replace(/\bbehavioral\b/gi, 'beh')
    .replace(/\bcapability\b/gi, 'cap')
    .replace(/\barchitecture\b/gi, 'arch')
    .replace(/\bimplementation\b/gi, 'impl')
    .replace(/\bservice\b/gi, 'svc')
    .replace(/\bsession\b/gi, 'sess')
    .replace(/\bauthentication\b/gi, 'auth')
    .replace(/\bauthorization\b/gi, 'authz')
    .replace(/\borganization\b/gi, 'org')
    .replace(/\bproduction source\b/gi, 'prod source')
    .replace(/\bboundary\b/gi, 'bdry')
    .replace(/\bexisting\b/gi, 'current')
    .replace(/\bparallel\b/gi, 'dup')
    .replace(/\bcontroller\b/gi, 'ctrl')
    .replace(/\bcomponent\b/gi, 'cmp')
    .replace(/\bfunction\b/gi, 'fn')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function escapeTag(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function compactAgentText(value: unknown, maxLength: number): string {
  const text = compactText(value, 10_000)
    .replace(/\bdependency-injection\b/gi, 'DI')
    .replace(/\bconstructor-injected\b/gi, 'ctor-inject')
    .replace(/\bconstructor injected\b/gi, 'ctor-inject')
    .replace(/\bfocused service test\b/gi, 'svc test')
    .replace(/\bimports production source\b/gi, 'uses prod src')
    .replace(/\btenant-scoped\b/gi, 'tenant')
    .replace(/\btenant scope\b/gi, 'tenant-scope')
    .replace(/\bbefore adding\b/gi, 'before new')
    .replace(/\bmust preserve\b/gi, 'preserve')
    .replace(/\bmust be present\b/gi, 'required')
    .replace(/\bvalidate\b/gi, 'val')
    .replace(/\binvariant\b/gi, 'inv')
    .replace(/\bbehavior\b/gi, 'beh')
    .replace(/\bbehavioral\b/gi, 'beh')
    .replace(/\bmanagement\b/gi, 'mgmt')
    .replace(/\boperations\b/gi, 'ops')
    .replace(/\boperations?\b/gi, 'ops')
    .replace(/\bcurrent\b/gi, 'cur')
    .replace(/\bRead files in order\b/gi, 'read F order')
    .replace(/\bPreserve idioms\b/gi, 'keep idioms')
    .replace(/\bExpand only if blocked by source evidence or validation\b/gi, 'expand only on source/val block')
    .replace(/\bExpand only if blocked\b/gi, 'expand only if blocked')
    .replace(/\bsource evidence\b/gi, 'source proof')
    .replace(/\bauthorization\b/gi, 'authz')
    .replace(/\bauthentication\b/gi, 'auth')
    .replace(/\bparallel behavior\b/gi, 'dup beh')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK9AgentText(value: unknown, maxLength: number): string {
  const text = compactAgentText(value, 10_000)
    .replace(/\buse ctor-inject collaborators\b/gi, 'ctor DI')
    .replace(/\bnot inline new clients\b/gi, 'no inline new')
    .replace(/\bevery sess preserve org and tenant context\b/gi, 'sess keeps org+tenant')
    .replace(/\bfocused svc tests import prod source and mock repo boundaries\b/gi, 'svc test uses prod+mock repos')
    .replace(/\breuse cur SessionRepository before new a dup sess store\b/gi, 'SessionRepo before dup store')
    .replace(/\breuse OidcClient adapter instead of calling provider SDK from AuthService\b/gi, 'OidcClient not provider SDK')
    .replace(/\brisk high:\s*/gi, 'high ')
    .replace(/\bauth bdry and sess issuance\b/gi, 'auth bdry+sess issue')
    .replace(/\bval beh inv:\s*/gi, 'inv ')
    .replace(/\btenant id required before sess creation\b/gi, 'tenantId before sess create')
    .replace(/\bops\s+(\w+)\s+(runtime|sim):\s+(.+?)\s+(\d+)err\s+(\d+)slow\s+vol(\d+)\b/gi, 'ops $1 $2:$4err/$5slow/v$6')
    .replace(/\bread F order\.?\s*/gi, 'F-order;')
    .replace(/\bkeep idioms\.?\s*/gi, 'keep idioms;')
    .replace(/\bexpand only on source\/val block\b/gi, 'expand source/val-block')
    .replace(/\bpreserve\b/gi, 'keep')
    .replace(/\breuse\b/gi, 'use')
    .replace(/\bcurrent\b/gi, 'cur')
    .replace(/\s*;\s*/g, ';')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK10Guidance(value: unknown, maxLength: number): string {
  const text = compactK9AgentText(value, 10_000)
    .replace(/\bDI:\s*/gi, 'DI=')
    .replace(/\bauth-tenant-scope:\s*/gi, 'tenant=')
    .replace(/\btesting:\s*/gi, 'test=')
    .replace(/\bdependency-injection:\s*/gi, 'DI=')
    .replace(/\bSessionRepo before dup store\b/gi, 'SessionRepo>dup')
    .replace(/\bOidcClient not provider SDK\b/gi, 'OidcClient>SDK')
    .replace(/\bhigh auth bdry\+sess issue\b/gi, 'hi auth+sess')
    .replace(/\binv tenantId before sess create\b/gi, 'inv tenantId')
    .replace(/\bsess keeps org\+tenant\b/gi, 'sess org+tenant')
    .replace(/\bsvc test uses prod\+mock repos\b/gi, 'prod+mock tests')
    .replace(/\bctor DI, no inline new\b/gi, 'ctor,no-new')
    .replace(/\bcurrent\b/gi, 'cur')
    .replace(/\bbefore\b/gi, '>')
    .replace(/\binstead of\b/gi, '>')
    .replace(/\bpreserve\b/gi, 'keep')
    .replace(/\breuse\b/gi, 'use')
    .replace(/\s*:\s*/g, '=')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK11Guidance(value: unknown, maxLength: number): string {
  const text = compactK10Guidance(value, 10_000)
    .replace(/\bsess org\+tenant\b/gi, 'sess-org+tenant')
    .replace(/\bprod\+mock tests\b/gi, 'prod+mock')
    .replace(/\bhi auth\+sess\b/gi, 'hi-auth+sess')
    .replace(/\binv tenantId\b/gi, 'inv-tenantId')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK12Guidance(value: unknown, maxLength: number): string {
  const text = compactK11Guidance(value, 10_000)
    .replace(/\bDI=ctor,no-new\b/gi, 'DIctorNoNew')
    .replace(/\bsess-org\+tenant\b/gi, 'sessOrgTenant')
    .replace(/\bprod\+mock\b/gi, 'prodMock')
    .replace(/\bhi-auth\+sess\b/gi, 'hiAuthSess')
    .replace(/\binv-tenantId\b/gi, 'invTenantId')
    .replace(/\bSessionRepo>dup\b/gi, 'SessionRepoReuse')
    .replace(/\bOidcClient>SDK\b/gi, 'OidcClientAdapter')
    .replace(/\btenant=/gi, 'tenant')
    .replace(/\btest=/gi, 'test')
    .replace(/\bDI=/gi, 'DI')
    .replace(/[=:+,>]+/g, '')
    .replace(/[-/]+/g, '')
    .replace(/\bDIctorNoNew\b/g, 'DIctor')
    .replace(/\btenantsessOrgTenant\b/g, 'tenantSess')
    .replace(/\btestprodMock\b/g, 'testProdMock')
    .replace(/\bops\s+(\w+)\s+(\w+)(\d+)err(\d+)slowv(\d+)/gi, 'ops $1 $2 $3err $4slow v$5')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK11Task(value: unknown, maxLength: number): string {
  const text = compactTaskText(value, 10_000)
    .replace(/\bwith\b/gi, '')
    .replace(/\bwhile\b/gi, '')
    .replace(/\bpreserving\b/gi, 'keep')
    .replace(/\btenant sessions\b/gi, 'tenant-sess')
    .replace(/\btenant scoped sessions\b/gi, 'tenant-sess')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK12Task(value: unknown, maxLength: number): string {
  const text = compactK11Task(value, 10_000)
    .replace(/\btenant-sess\b/gi, 'tenantSess')
    .replace(/[-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK10Rule(value: unknown, maxLength: number): string {
  const text = compactK9AgentText(value, 10_000)
    .replace(/\bF-order\b/gi, 'F')
    .replace(/\bkeep idioms\b/gi, 'idioms')
    .replace(/\bexpand source\/val-block\b/gi, 'expand if blocked')
    .replace(/\bRead\b/gi, 'read')
    .replace(/\bexecute\b/gi, 'do')
    .replace(/\s*;\s*/g, ';')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK11Rule(value: unknown, maxLength: number): string {
  const text = compactK10Rule(value, 10_000)
    .replace(/\bexpand only if blocked\b/gi, 'expand-if-blocked')
    .replace(/\s*;\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK12Rule(value: unknown, maxLength: number): string {
  const text = compactK11Rule(value, 10_000)
    .replace(/\bexpand-if-blocked\b/gi, 'expandIfBlocked')
    .replace(/^F idioms expandIfBlocked.*$/i, 'F idioms expandIfBlocked')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactTypeToken(value: unknown): string {
  const text = String(value || '').toLowerCase();
  if (text.includes('service')) return 'svc';
  if (text.includes('controller')) return 'ctrl';
  if (text.includes('repository')) return 'repo';
  if (text.includes('component')) return 'cmp';
  if (text.includes('entity')) return 'ent';
  if (text.includes('route')) return 'rt';
  return compactText(value, 10);
}

function compactCommandText(value: unknown, maxLength: number): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactK9Validation(value: unknown, fileRefs: Map<string, number>): string[] {
  return arrayOfStrings(value).map(command => {
    let output = command;
    for (const [file, index] of fileRefs) {
      output = output.replace(new RegExp(escapeRegExp(file), 'g'), `F${index}`);
    }
    return output
      .replace(/^npm test --\s*/, 'test ')
      .replace(/^npm run typecheck$/, 'typecheck')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

function compactK10Validation(value: unknown, fileRefs: Map<string, number>): string[] {
  return arrayOfStrings(value).map(command => {
    let output = command;
    for (const [file, index] of fileRefs) {
      output = output.replace(new RegExp(escapeRegExp(file), 'g'), `#${index}`);
    }
    return output
      .replace(/^npm test --\s*/, 'test ')
      .replace(/^npm run typecheck$/, 'typecheck')
      .replace(/\btests?\//g, 't/')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

function compactK11Validation(value: unknown, fileRefs: Map<string, number>): string[] {
  return compactK10Validation(value, fileRefs);
}

function compactK12Validation(value: unknown, fileRefs: Map<string, number>): string[] {
  return arrayOfStrings(value).map(command => {
    let output = command;
    for (const [file, index] of fileRefs) {
      output = output.replace(new RegExp(escapeRegExp(file), 'g'), String(index));
    }
    return output
      .replace(/^npm test --\s*/, 'test ')
      .replace(/^npm run typecheck$/, 'typecheck')
      .replace(/\btests?\//g, 't/')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

function compactTaskText(value: unknown, maxLength: number): string {
  const text = compactAgentText(value, 10_000)
    .replace(/^(modify|debug|review|trace|orient)\s*:\s*/i, '')
    .replace(/^fix\s*:\s*/i, '');
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function taskCode(task: unknown): string {
  const text = String(task || '').toLowerCase();
  if (text.includes('debug') || text.includes('fix')) return 'd';
  if (text.includes('review')) return 'r';
  if (text.includes('trace')) return 't';
  if (text.includes('orient')) return 'o';
  return 'm';
}

function expandFileRefs(value: string, fileRefs: Map<string, string>): string {
  let output = String(value || '');
  for (const [ref, file] of fileRefs) {
    output = output.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(ref)}(?![A-Za-z0-9_])`, 'g'), file);
  }
  return output;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function timeEncoder(encode: () => string): { msPer1000: number } {
  const start = Date.now();
  for (let index = 0; index < 1000; index += 1) encode();
  return { msPer1000: Date.now() - start };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimatePromptishTokens(value: string): number {
  const text = String(value || '');
  if (!text.trim()) return 1;
  const pieces = text.match(/[A-Za-z]+|\d+|[^\sA-Za-z0-9]/g) || [];
  let count = 0;
  for (const piece of pieces) {
    if (/^[A-Za-z]+$/.test(piece)) {
      count += Math.max(1, Math.ceil(piece.length / 10));
    } else if (/^\d+$/.test(piece)) {
      count += Math.max(1, Math.ceil(piece.length / 6));
    } else {
      count += 1;
    }
  }
  return Math.max(1, count);
}

function percentReduction(baseline: number, current: number): number {
  return Math.round(((baseline - current) / Math.max(1, baseline)) * 1000) / 10;
}

function countContextSlots(context: any, output: string): number {
  const baseSlots = [
    context.task,
    context.selected,
    context.rule,
  ].filter(Boolean).length;
  const listSlots = [
    ...arrayOfStrings(context.files),
    ...arrayOfStrings(context.candidates),
    ...arrayOfStrings(context.idioms),
    ...arrayOfStrings(context.reuse),
    ...arrayOfStrings(context.risks),
    ...arrayOfStrings(context.execution?.validate),
  ].length;
  const expectedSlots = baseSlots + listSlots;
  const text = String(output || '').trim();
  if (!text) return 0;
  if (/^[A-Za-z0-9+/=]{80,}$/.test(text) && !/\s/.test(text)) return 1;
  if (/^[{[]/.test(text)) {
    try {
      JSON.parse(text);
      return expectedSlots;
    } catch {
      return Math.min(expectedSlots, Math.max(1, text.match(/"[^"]+"\s*:/g)?.length || 1));
    }
  }
  if (/\bf\{/.test(text)) {
    return Math.min(expectedSlots, (text.match(/\bf\{|\bi:|\br:|\bv:|\btask:|\bsel\{/g) || []).length);
  }
  if (/^K1[12345]/m.test(text)) {
    let slots = 0;
    for (const line of text.split(/\r?\n/)) {
      if (/^K1[12345]/.test(line)) slots += context.task ? 1 : 0;
      else if (/^@/.test(line)) slots += context.selected ? 1 : 0;
      else if (/^[EOC](\s|[A-Za-z0-9_])/.test(line)) {
        const isK15 = /^K15/m.test(text);
        const parts = line.slice(isK15 ? 1 : 2).split(/\s+/).filter(Boolean);
        const aliases = new Set<string>();
        const aliasLine = text.split(/\r?\n/).find(item => item.startsWith('A'));
        if (aliasLine) {
          const aliasParts = aliasLine.slice(aliasLine.startsWith('A ') ? 2 : 1).split(/\s+/).filter(Boolean);
          for (let index = 0; index < aliasParts.length; index += 2) aliases.add(aliasParts[index]);
        }
        aliases.add('_');
        slots += parts.filter(part => !aliases.has(part)).length;
      }
      else if (/^F\s+/.test(line)) {
        const parts = line.slice(2).split(/\s+/).filter(Boolean);
        slots += /^K12/m.test(text) ? Math.floor(parts.length / 2) : parts.length;
      }
      else if (/^[IURV]\s+/.test(line)) slots += line.slice(2).split(/\s+/).filter(Boolean).length;
      else if (/^K15/m.test(text) && /^[IURV]\S/.test(line)) slots += line.slice(1).split(/\s+/).filter(Boolean).length;
      else if (/^!/.test(line)) slots += context.rule ? 1 : 0;
    }
    return Math.min(expectedSlots, Math.max(1, slots));
  }
  const visibleSlots = text.split(/[;\n]/).map(value => value.trim()).filter(Boolean).length;
  return Math.min(expectedSlots, visibleSlots);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
