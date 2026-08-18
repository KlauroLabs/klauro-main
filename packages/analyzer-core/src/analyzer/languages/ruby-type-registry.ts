export function createRubyTypeRegistry(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export function rubyTypeFor(registry: Record<string, string>, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
}
