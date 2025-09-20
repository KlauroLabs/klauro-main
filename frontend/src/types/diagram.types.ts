import { CASNode } from './cas.types';

export interface Component {
  id: string;
  name: string;
  type: string;
  level: number;
  level_name: string;
  source: {
    file: string;
    line: number;
    end_line: number;
  };
  path?: string;
  layer?: string;
  metadata?: any;
  connections?: number;
  critical?: boolean;
  orphaned?: boolean;
  metrics?: {
    complexity: number;
    lines: number;
    dependencies: number;
  };
}

export interface Connection {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
}

export interface DrillLevel {
  name: string;
  components: Component[];
  sections: ArchSection[];
}

export interface ArchSection {
  id: string;
  name: string;
  components: Component[];
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  connections: Connection[];
}

export interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

export interface ConnectionGroup {
  type: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  components: Array<{ node: CASNode; count: number }>;
}