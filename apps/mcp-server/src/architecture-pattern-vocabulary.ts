const VOCABULARY: Record<string, string[]> = {
  'MVC': ['model-view-controller'],
  'MVVM': ['model-view-viewmodel'],
  'Repository': ['repository'],
  'Unit of Work': ['unit of work'],
  'Singleton / Registry': ['singleton'],
  'Mediator / Handler': ['mediator', 'command handlers', 'query handlers', 'event handlers'],
  'Layered Architecture': ['layered architecture', 'service layer'],
  'Service Layer': ['service layer'],
  'Component/Page UI': ['server-side rendering', 'component-based ui'],
  'Command Script / Automation': ['scheduled jobs', 'background jobs'],
};

function normalised(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function patternNamed(engineNames: string[], expected: string): boolean {
  const accepted = new Set([expected, ...(VOCABULARY[expected] ?? [])].map(normalised));
  return engineNames.some(name => accepted.has(normalised(name)));
}
