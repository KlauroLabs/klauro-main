import type { CASEntryPoint } from '../../types/cas.types';

export function dedupeAdjacentWords(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.toLowerCase() === word.toLowerCase()) continue;
    out.push(word);
  }
  return out.join(' ');
}

export function titleCaseWords(raw: string): string {
  const words = (raw || '').replace(/[-_]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const title = words.split(' ').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  return dedupeAdjacentWords(title);
}

export function cleanRawFallbackName(raw: string): string {
  if (!raw) return raw;
  let value = raw.replace(/^(entry_|exit_|node:|flow::|chain:|synthflow:)+/i, '');
  const extensionTokens = /(^|_)(tsx|ts|jsx|js|py|rb|go|rs|java|kt|swift|php|cs|cpp|c|mjs|cjs|vue|svelte)_/i;
  const extension = extensionTokens.exec(value);
  if (extension) value = value.slice(extension.index + extension[0].length);
  value = value.replace(/(?:_[0-9a-f]{4,}|_\d+)+$/i, '');
  const title = titleCaseWords(value);
  return title || titleCaseWords(raw.replace(/^(entry_|exit_|node:|flow::|chain:|synthflow:)+/i, '')) || raw;
}

export function flowNameForEntryPoint(entryPoint: CASEntryPoint, handlerResolved = true): string {
  const metadataHandlerName = typeof entryPoint.metadata?.handler_name === 'string'
    ? entryPoint.metadata.handler_name
    : undefined;
  const handlerName = handlerResolved ? metadataHandlerName || entryPoint.handler?.method_name : undefined;
  if (handlerName?.trim()) {
    const formView = handlerName.match(/^(?:show|render|display)(Create|New|Edit|Update)(.+?)(?:Page|Form|View)?$/i);
    if (formView && entryPoint.trigger?.method?.toUpperCase() === 'GET') {
      const action = formView[1].toLowerCase();
      const entity = titleCaseWords(formView[2].replace(/(?:Page|Form|View)$/i, ''));
      if (entity) {
        return action === 'create' || action === 'new'
          ? `View ${entity} Creation Form`
          : `View ${entity} Editing Form`;
      }
    }
    const title = titleCaseWords(handlerName);
    if (title) return title;
  }
  if (entryPoint.trigger?.path) {
    const parts = entryPoint.trigger.path.split('/').filter(Boolean).filter(part => !part.startsWith(':') && !part.startsWith('{'));
    const title = titleCaseWords(parts[parts.length - 1] || entryPoint.name);
    return title || cleanRawFallbackName(entryPoint.name);
  }
  return titleCaseWords(entryPoint.name) || cleanRawFallbackName(entryPoint.name);
}
