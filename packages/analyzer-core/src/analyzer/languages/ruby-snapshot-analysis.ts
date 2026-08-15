import type { CASNode } from '../../types/cas.types';
import type { RubyClass, RubyFileAnalysis, RubyMethod, RubyModule } from './ruby-analyzer';

export function buildRubySnapshotAnalysis(nodes: CASNode[], currentFile: string): RubyFileAnalysis {
  const methodsByParent = new Map<string, CASNode[]>();
  for (const node of nodes) {
    if (node.type !== 'method' || !node.parent) continue;
    const methods = methodsByParent.get(node.parent) || [];
    methods.push(node);
    methodsByParent.set(node.parent, methods);
  }
  const methodFromNode = (node: CASNode): RubyMethod => ({
    name: node.name,
    visibility: (node.metadata?.attributes?.visibility as RubyMethod['visibility']) || 'public',
    isSingleton: Boolean(node.metadata?.attributes?.singleton),
    parameters: (node.signature?.parameters || []).map(parameter => parameter.name),
    lineStart: node.source?.line || 0,
    lineEnd: node.source?.end_line || node.source?.line || 0,
    calls: [],
    ivarTypes: {},
    localVarTypes: {},
  });
  const classes: RubyClass[] = [];
  const modules: RubyModule[] = [];
  for (const node of nodes) {
    if (node.type !== 'class' && node.type !== 'module') continue;
    if (!node.source?.file || node.source.file === currentFile) continue;
    const attributes = node.metadata?.attributes || {};
    const owner = {
      name: node.name,
      qualifiedName: String(attributes.qualified_name || node.name),
      filePath: node.source.file,
      lineStart: node.source.line || 0,
      lineEnd: node.source.end_line || node.source.line || 0,
      methods: (methodsByParent.get(node.id) || []).map(methodFromNode),
      constants: [],
      stateMachines: [],
    };
    if (node.type === 'class') {
      classes.push({
        ...owner,
        superclass: typeof attributes.superclass === 'string' ? attributes.superclass : undefined,
        attributes: [],
        includedModules: Array.isArray(attributes.included_modules) ? attributes.included_modules.map(String) : [],
        extendedModules: Array.isArray(attributes.extended_modules) ? attributes.extended_modules.map(String) : [],
      });
    } else {
      modules.push(owner);
    }
  }
  return { classes, modules, topLevelMethods: [], topLevelConstants: [], requires: [] };
}
