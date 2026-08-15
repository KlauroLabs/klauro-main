import type { AnalyzeRemotelyResult } from './remote-sync-client';
import type { UploadManifest } from './remote-source';






















export function formatRemoteResult(result: AnalyzeRemotelyResult): string {
  if (result.status === 'accepted') {



    const lines = [
      `Uploaded ${result.manifest.file_count} files (${result.manifest.total_bytes} bytes).`,
      `Analysis is running on the Klauro server (id: ${result.analysis_id}) — results appear on your project as they land.`,
      `Check progress any time with \`klauro status\`; this command has already returned and did NOT wait for the analysis to finish.`,
    ];



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












export function withAnalysisState<T extends Pick<AnalyzeRemotelyResult, 'status'>>(
  result: T,
): T & { analysis_state: 'running' | 'complete' } {
  return { ...result, analysis_state: result.status === 'accepted' ? 'running' : 'complete' };
}










export function formatUploadManifest(manifest: UploadManifest): string {
  const lines = [
    `Root: ${manifest.root}${manifest.mode === 'dirty-tree' ? ' (dirty-tree: uncommitted changes only)' : ''}`,
  ];
  if (manifest.branch || manifest.commit) {
    lines.push(`Revision: ${manifest.branch || 'detached'}${manifest.commit ? ` @ ${manifest.commit.slice(0, 7)}` : ''}${manifest.dirty ? ' (working tree dirty)' : ''}`);
  }
  lines.push(`Would upload ${manifest.summary.included_files} file(s), ${manifest.summary.included_bytes} bytes; ${manifest.summary.excluded_files} file(s) excluded.`);
  if (manifest.workspace_recommendation?.recommended) {
    lines.push(`Note: ${manifest.workspace_recommendation.reason}`);
  }
  lines.push('Run with --json for the full file-by-file manifest.');
  return lines.join('\n');
}
