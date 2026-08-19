export interface HttpRouteMatchOptions {
  allowPatternSuffix?: boolean;
}

const PARAMETER_SEGMENT = /^(:[\w-]+|\{[\w-]+\}|\*)$/;

function routeSegments(value: string): string[] {
  const routePath = value.trim()
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, '')
    .split(/[?#]/, 1)[0];
  return routePath.split('/').filter(Boolean);
}

function segmentsMatch(left: string[], right: string[]): boolean {
  return left.every((segment, index) =>
    PARAMETER_SEGMENT.test(segment) ||
    PARAMETER_SEGMENT.test(right[index]) ||
    segment.toLowerCase() === right[index].toLowerCase()
  );
}

export function httpRoutePathsMatch(
  actualPath: string,
  patternPath: string,
  options: HttpRouteMatchOptions = {},
): boolean {
  const actual = routeSegments(actualPath);
  const pattern = routeSegments(patternPath);
  if (actual.length === 0 && pattern.length === 0) return true;
  if (actual.length === pattern.length) return segmentsMatch(actual, pattern);
  if (!options.allowPatternSuffix || actual.length >= pattern.length) return false;
  return segmentsMatch(actual, pattern.slice(pattern.length - actual.length));
}
