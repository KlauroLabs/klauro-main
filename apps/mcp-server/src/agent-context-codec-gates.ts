import type { AgentContextCodecBenchmarkGate, AgentContextCodecBenchmarkResult } from './agent-context-codec';

export function measureValidationFidelity(candidate: { decodeValidation?: (encoded: string) => unknown }, output: string, expected: string[]): AgentContextCodecBenchmarkResult['validation_fidelity'] {
  if (expected.length === 0) return 'exact';
  if (!candidate.decodeValidation) return 'unverified';
  try {
    const decoded = candidate.decodeValidation(output);
    return Array.isArray(decoded) && decoded.length === expected.length && decoded.every((command, index) => command === expected[index]) ? 'exact' : 'lossy';
  } catch {
    return 'lossy';
  }
}

export function buildBenchmarkGates(results: AgentContextCodecBenchmarkResult[], recommendation: string): AgentContextCodecBenchmarkGate[] {
  const k14 = resultByName(results, 'k14-agent-context-language');
  const k15 = resultByName(results, 'k15-agent-context-language');
  const minJson = resultByName(results, 'min-json');
  const jsonb = resultByName(results, 'jsonb-rowset');
  const protobuf = resultByName(results, 'protobuf-text');
  const toonish = resultByName(results, 'toonish-table');
  const yaml = resultByName(results, 'yaml-brief');
  const xml = resultByName(results, 'xml-tags');
  const gzipK7 = resultByName(results, 'gzip-k7-base64');
  const msgpack = resultByName(results, 'messagepack-base64-proxy');
  return [
    codecGate('agent-context-codec:validation-fidelity',
      resultByName(results, recommendation)?.validation_fidelity === 'exact',
      `recommended ${recommendation}; validation must round trip exactly`),
    codecGate('agent-context-codec:default-k15',
      recommendation === 'k15-agent-context-language',
      `recommendation ${recommendation}`),
    codecGate('agent-context-codec:k15-token-budget',
      Boolean(k15) && k15!.estimated_tokens <= 97 && k15!.token_reduction_vs_min_json >= 72,
      k15 ? `${k15.estimated_tokens} tokens, ${k15.token_reduction_vs_min_json}% reduction vs min JSON` : 'missing K15 result'),
    codecGate('agent-context-codec:k15-promptish-budget',
      Boolean(k15 && minJson) &&
        k15!.promptish_token_reduction_vs_min_json >= 77 &&
        k15!.context_slots_per_100_promptish_tokens > (k14?.context_slots_per_100_promptish_tokens || 0),
      k15 ? `${k15.promptish_tokens} promptish tokens, ${k15.promptish_token_reduction_vs_min_json}% reduction vs min JSON, ${k15.context_slots_per_100_promptish_tokens} slots-per-100` : 'missing K15 result'),
    codecGate('agent-context-codec:k15-beats-k14',
      Boolean(k15 && k14) && k15!.estimated_tokens < k14!.estimated_tokens && k15!.context_slots_per_100_tokens > k14!.context_slots_per_100_tokens,
      k15 && k14 ? `K15 ${k15.estimated_tokens} tokens / ${k15.context_slots_per_100_tokens} slots-per-100 vs K14 ${k14.estimated_tokens} / ${k14.context_slots_per_100_tokens}` : 'missing K15/K14 result'),
    codecGate('agent-context-codec:k15-beats-structured-text-baselines',
      Boolean(k15 && jsonb && protobuf && toonish && yaml && xml && minJson) &&
        [jsonb!, protobuf!, toonish!, yaml!, xml!, minJson!].every(result => k15!.balanced_score > result.balanced_score),
      k15 ? `K15 score ${k15.balanced_score}; JSONB ${jsonb?.balanced_score ?? 'missing'}, protobuf ${protobuf?.balanced_score ?? 'missing'}, TOON-ish ${toonish?.balanced_score ?? 'missing'}, YAML ${yaml?.balanced_score ?? 'missing'}, XML ${xml?.balanced_score ?? 'missing'}, JSON ${minJson?.balanced_score ?? 'missing'}` : 'missing K15 result'),
    codecGate('agent-context-codec:opaque-binary-not-default',
      Boolean(k15 && gzipK7 && msgpack) &&
        k15!.balanced_score > gzipK7!.balanced_score &&
        k15!.balanced_score > msgpack!.balanced_score &&
        gzipK7!.prompt_native <= 10 &&
        msgpack!.prompt_native <= 10,
      k15 ? `K15 score ${k15.balanced_score}; gzip/base64 score ${gzipK7?.balanced_score ?? 'missing'}, MessagePack/base64 score ${msgpack?.balanced_score ?? 'missing'}` : 'missing K15 result'),
  ];
}

function codecGate(id: string, ok: boolean, detail: string): AgentContextCodecBenchmarkGate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

export function resultByName(results: AgentContextCodecBenchmarkResult[], name: string): AgentContextCodecBenchmarkResult | undefined {
  return results.find(result => result.name === name);
}
