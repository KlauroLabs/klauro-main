












































export const SCAFFOLD_DIR_NAMES: readonly string[] = [
  'fixtures',
  '__fixtures__',
  'testdata',
  'cas-tests',
  '__tests__',
];




export const SCAFFOLD_GLOBS: string[] = SCAFFOLD_DIR_NAMES.flatMap(name => [`${name}/**`, `**/${name}/**`]);

export function isScaffoldDirName(name: string): boolean {
  return SCAFFOLD_DIR_NAMES.includes(name);
}


export function pathHasScaffoldSegment(relativePath: string): boolean {
  const normalized = (relativePath || '').replace(/\\/g, '/');
  return normalized.split('/').some(isScaffoldDirName);
}












const TEST_FILE_NAME_PATTERN = /(\.(test|spec)\.[a-z0-9]+$)|(^test_[^/]*\.py$)|(_test\.(py|go|rb)$)|(\.test\.rb$)/i;

export function isTestFileName(fileName: string): boolean {
  return TEST_FILE_NAME_PATTERN.test(fileName || '');
}



export function isScaffoldOrTestPath(relativePath: string): boolean {
  const normalized = (relativePath || '').replace(/\\/g, '/');
  if (pathHasScaffoldSegment(normalized)) return true;
  const basename = normalized.split('/').pop() || '';
  return isTestFileName(basename);
}
