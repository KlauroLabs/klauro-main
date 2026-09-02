import type { CASEntryPoint } from '../../types/cas.types';

export const FILESYSTEM_EXECUTABLE_CLI_ORIGIN = 'filesystem-executable';
export const REGISTERED_PRODUCT_CLI_ROLE = 'product-command';

export function isStructuralExecutableCliEntry(entryPoint: CASEntryPoint | undefined): boolean {
  if (!entryPoint || entryPoint.type !== 'cli') return false;
  const sourceAnalyzer = entryPoint.source_analyzer || entryPoint.metadata?.source_analyzer;
  const file = String(entryPoint.metadata?.file || entryPoint.handler?.file || '').replace(/\\/g, '/').toLowerCase();
  const command = String(entryPoint.metadata?.command || entryPoint.trigger?.pattern || '').trim().toLowerCase();
  const kind = String(entryPoint.metadata?.kind || '').trim().toLowerCase();
  if (kind === 'command-group' || /^(?:--?help|--?version|completion|help|version)$/.test(command)) return true;
  if (entryPoint.metadata?.cli_product_role === REGISTERED_PRODUCT_CLI_ROLE) return false;
  if (sourceAnalyzer === 'shell') return entryPoint.metadata?.cli_origin === FILESYSTEM_EXECUTABLE_CLI_ORIGIN;
  return entryPoint.metadata?.framework === 'generic' && command === 'main' &&
    /(?:^|\/)(?:internal|tests?|testdata|tools?)(?:\/|$)/.test(file);
}

export function isProductCliEntry(entryPoint: CASEntryPoint | undefined): boolean {
  if (!entryPoint || entryPoint.type !== 'cli') return false;
  if (isStructuralExecutableCliEntry(entryPoint)) return false;
  return entryPoint.metadata?.cli_product_role === REGISTERED_PRODUCT_CLI_ROLE ||
    Boolean(entryPoint.trigger?.pattern || entryPoint.metadata?.command || entryPoint.metadata?.subcommand);
}
