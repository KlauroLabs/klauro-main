import * as path from 'path';

export function codebaseId(repositoryPath: string): string {
  return slugify(repositoryPath.split(path.sep).filter(Boolean).slice(-2).join('-')) || slugify(repositoryPath) || 'codebase';
}

export function interfaceId(codebase: string, prefix: string, value: string): string {
  return `${codebase}:${prefix}:${slugify(stripLocalPathPrefix(value))}`;
}

export function runtimeComponentId(codebase: string, nodeId: string): string {
  return `${codebase}:runtime:${slugify(stripLocalPathPrefix(nodeId))}`;
}

export function linkId(kind: string, source: string, target: string): string {
  return `link:${kind}:${slugify(stripLocalPathPrefix(source))}:${slugify(stripLocalPathPrefix(target))}`;
}

export function stripLocalPathPrefix(value: string): string {
  return String(value || '')
    .replace(/\/Users\/[^/]+\/dev\//gi, '')
    .replace(/\/home\/[^/]+\/dev\//gi, '')
    .replace(/[A-Z]:\\Users\\[^\\]+\\dev\\/gi, '')
    .replace(/\\/g, '/');
}

export function slugify(input: string): string {
  return String(input || '')
    .replace(/[^a-zA-Z0-9@/._-]/g, '-')
    .replace(/[/.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 120);
}
