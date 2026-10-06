export type CodebaseType =
  | 'web-backend'
  | 'web-frontend'
  | 'fullstack'
  | 'library'
  | 'cli'
  | 'desktop'
  | 'mobile'
  | 'data-ml'
  | 'infra'
  | 'systems'
  | 'game'
  | 'monorepo'
  | 'unknown';

export interface CodebaseTypeSignal {
  id: string;
  detail: string;
  supports: CodebaseType[];
  weight: number;
}
