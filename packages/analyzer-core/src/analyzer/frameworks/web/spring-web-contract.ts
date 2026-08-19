export interface SpringEndpointParameter {
  name: string;
  type: string;
  annotation: string;
  location?: string;
  required: boolean;
  validations: string[];
}

function splitJavaParameters(source: string): string[] {
  const parameters: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of source) {
    if (character === '(' || character === '<' || character === '[') depth += 1;
    else if (character === ')' || character === '>' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      if (current.trim()) parameters.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) parameters.push(current.trim());
  return parameters;
}

export function extractSpringEndpointParameters(source: string): SpringEndpointParameter[] {
  return splitJavaParameters(source).flatMap(rawParameter => {
    const annotations = [...rawParameter.matchAll(/@(\w+)(?:\s*\(([^)]*)\))?/g)];
    const declaration = rawParameter.replace(/@\w+(?:\s*\([^)]*\))?\s*/g, '').replace(/\bfinal\b/g, '').trim();
    const parts = declaration.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return [];
    const annotationNames = annotations.map(match => match[1]);
    const location = annotationNames.includes('RequestBody') ? 'body'
      : annotationNames.includes('PathVariable') ? 'path'
        : annotationNames.includes('RequestParam') ? 'query'
          : annotationNames.includes('RequestHeader') ? 'header'
            : undefined;
    const validations = annotations
      .filter(match => !['RequestBody', 'PathVariable', 'RequestParam', 'RequestHeader'].includes(match[1]))
      .map(match => match[2] ? `${match[1]}(${match[2].trim()})` : match[1]);
    return [{
      name: parts[parts.length - 1],
      type: parts.slice(0, -1).join(' '),
      annotation: annotationNames.join(','),
      location,
      required: !/\brequired\s*=\s*false\b/.test(rawParameter) && !/^Optional\s*</.test(parts[0]),
      validations,
    }];
  });
}

const RESPONSE_STATUS_CODES = new Map([
  ['OK', 200], ['CREATED', 201], ['ACCEPTED', 202], ['NO_CONTENT', 204],
  ['BAD_REQUEST', 400], ['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['NOT_FOUND', 404],
  ['CONFLICT', 409], ['UNPROCESSABLE_ENTITY', 422], ['INTERNAL_SERVER_ERROR', 500],
]);

export function extractSpringResponseStatus(source: string): number | undefined {
  const match = source.match(/@ResponseStatus\s*\(\s*(?:value\s*=\s*)?(?:HttpStatus\.)?(\w+)/);
  if (!match) return undefined;
  return RESPONSE_STATUS_CODES.get(match[1]) || (/^\d{3}$/.test(match[1]) ? Number(match[1]) : undefined);
}
