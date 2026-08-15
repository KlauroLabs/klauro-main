export function estimatedJsonTokens(value: unknown): number {
  return Math.ceil(estimatedJsonCharacters(value, new WeakSet<object>(), false) / 4);
}

function estimatedJsonCharacters(value: unknown, ancestors: WeakSet<object>, arrayItem: boolean): number {
  if (value === null) return 4;
  if (typeof value === 'string') return JSON.stringify(value).length;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'bigint') throw new TypeError('Cannot estimate JSON tokens for BigInt values');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return arrayItem ? 4 : 0;
  if (typeof value !== 'object') return 0;

  const object = value as Record<string, unknown>;
  if (ancestors.has(object)) throw new TypeError('Cannot estimate JSON tokens for circular values');
  const toJson = object.toJSON;
  if (typeof toJson === 'function') return estimatedJsonCharacters(toJson.call(object), ancestors, arrayItem);

  ancestors.add(object);
  let characters = 2;
  let included = 0;
  if (Array.isArray(object)) {
    for (const item of object) {
      if (included > 0) characters += 1;
      characters += estimatedJsonCharacters(item, ancestors, true);
      included += 1;
    }
  } else {
    for (const [key, item] of Object.entries(object)) {
      const itemCharacters = estimatedJsonCharacters(item, ancestors, false);
      if (itemCharacters === 0 && (item === undefined || typeof item === 'function' || typeof item === 'symbol')) continue;
      if (included > 0) characters += 1;
      characters += JSON.stringify(key).length + 1 + itemCharacters;
      included += 1;
    }
  }
  ancestors.delete(object);
  return characters;
}
