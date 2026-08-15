

































export function appendAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}









export function replaceArrayContents<T>(target: T[], source: readonly T[]): void {
  if (source === target) return;
  const snapshot = Array.isArray(source) && sharesBacking(target, source) ? source.slice() : source;
  target.length = 0;
  appendAll(target, snapshot);
}





function sharesBacking<T>(target: readonly T[], source: readonly T[]): boolean {
  return (target as unknown) === (source as unknown);
}
