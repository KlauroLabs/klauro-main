import type { AnalyzeRemotelyResult } from './remote-sync-client';

/**
 * Shared by cli.ts and installed-cli.ts (task #129): the human-readable
 * rendering of an `analyze` / `remote-analyze` / `remote-sync` result MUST
 * say plainly whether the analysis is still running or actually finished —
 * `status: 'accepted'` alone reads exactly like a completed result when
 * dumped as JSON (it carries `reuse_decision`, `manifest`, `analysis_id`,
 * the same shape a finished response has), which is precisely what let
 * `klauro analyze` LOOK done to a customer/harness the instant the upload
 * was accepted, seconds before the server-side analysis actually finished.
 *
 * Before this was shared, cli.ts (never shipped to customers — see
 * scripts/build-bundle.mjs) had this honest rendering and installed-cli.ts
 * (the ONLY entry point customers run) did not: its `analyze` handler piped
 * the raw result object straight through `output()`, which JSON.stringifies
 * ANY non-string value even in non-`--json` mode. A customer running plain
 * `klauro analyze .` therefore saw a raw JSON dump with `reuse_decision`
 * inside it and nothing that said "this is still running" — the exact
 * "worst way round" shape this repo's own constraints warn about (a defect
 * class present only in the shipped surface). Both entry points now render
 * through this one function so they can't diverge again.
 */
export function formatRemoteResult(result: AnalyzeRemotelyResult): string {
  if (result.status === 'accepted') {
    // Fast path (the default): the snapshot is uploaded in seconds and the
    // analysis runs entirely on the server, landing on the project
    // progressively (deterministic layers first, AI enrichment after).
    const lines = [
      `Uploaded ${result.manifest.file_count} files (${result.manifest.total_bytes} bytes).`,
      `Analysis is running on the Klauro server (id: ${result.analysis_id}) — results appear on your project as they land.`,
      `Check progress any time with \`klauro status\`; this command has already returned and did NOT wait for the analysis to finish.`,
    ];
    // Reuse visibility (task #132): `reused: true` with no reason is exactly
    // what made --force's silence invisible for months — always say what
    // happened and why, on every path, not just in --json output.
    if (result.reuse_decision) {
      const decision = result.reuse_decision;
      if (decision.reused) {
        lines.push(`Reused a prior analysis: ${decision.reason}`);
      } else if (decision.source === 'forced') {
        lines.push(`Forced a fresh analysis: ${decision.reason}`);
      } else if (decision.source === 'analyzer_upgrade') {
        lines.push(`Re-analyzed (analyzer upgraded since the last run): ${decision.reason}`);
      }
      if (decision.ai_cache_bypassed) {
        lines.push('AI-generated names/descriptions are also being regenerated (AI response cache bypassed by --force).');
      }
    }
    if (result.snapshot_source === 'committed-head') {
      const shortSha = (result.base_commit || '').slice(0, 7) || 'HEAD';
      lines.push(`Shared revision = committed HEAD (${shortSha}); working-tree changes ${result.in_flight?.status === 'completed' ? 'uploaded separately as in-flight context' : `in-flight pass ${result.in_flight?.status || 'skipped'}`}.`);
    }
    lines.push('');
    return lines.join('\n');
  }
  const changedFiles = result.change_report
    ? result.change_report.summary.filesAdded + result.change_report.summary.filesModified + result.change_report.summary.filesDeleted
    : 0;
  const lines = [
    `Klauro remote analysis: ${result.status.toUpperCase()}`,
    `Analysis id: ${result.analysis_id}`,
    `Revision: ${result.analysis_revision}`,
    `Type: ${result.analysis_type}`,
    `Files sent: ${result.manifest.file_count}`,
    `Bytes sent: ${result.manifest.total_bytes}`,
    `Nodes: ${result.cas?.nodes.length ?? 0}`,
    `Edges: ${result.cas?.edges.length ?? 0}`,
    `Changed files: ${changedFiles}`,
  ];
  if (result.snapshot_source === 'committed-head') {
    const shortSha = (result.base_commit || '').slice(0, 7) || 'HEAD';
    if (result.in_flight?.status === 'completed') {
      lines.push(`Analyzed committed HEAD (${shortSha}) as the shared revision; working-tree changes analyzed separately as in-flight context${result.in_flight.changed_files != null ? ` (${result.in_flight.changed_files} changed files)` : ''}.`);
    } else {
      lines.push(`Analyzed committed HEAD (${shortSha}) as the shared revision; uncommitted working-tree changes were NOT included.`);
      lines.push(`In-flight (working-tree) context pass ${result.in_flight?.status || 'skipped'}${result.in_flight?.detail ? `: ${result.in_flight.detail}` : ''}.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Explicit machine-readable completion state (task #129) — layered ON TOP of
 * the existing `status: 'accepted' | 'success'` field rather than replacing
 * it (every existing consumer of `status` keeps working unchanged). Added so
 * a `--json` caller — a script, a test harness, an agent — has one boolean
 * question to ask ("is this actually done?") instead of having to already
 * know that `status: 'accepted'` means "not finished" while `'success'`
 * means "finished," a distinction that reads backwards on first encounter
 * and is exactly what let two measurement efforts mistake acceptance for
 * completion on 2026-08-09/10 (see this file's header comment).
 */
export function withAnalysisState<T extends Pick<AnalyzeRemotelyResult, 'status'>>(
  result: T,
): T & { analysis_state: 'running' | 'complete' } {
  return { ...result, analysis_state: result.status === 'accepted' ? 'running' : 'complete' };
}
