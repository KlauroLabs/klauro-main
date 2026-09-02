import * as path from 'path';
import type { CASNode } from '../../../types/cas.types';

export interface ReactComponent {
  name: string;
  filePath: string;
  type: 'functional' | 'class';
  sourceStartLine: number;
  sourceEndLine: number;
  isDefaultExport: boolean;
  props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }>;
  state: Array<{ name: string; type: string; initialValue?: string }>;
  hooks: Array<{ name: string; type: string; dependencies?: string[]; hookUsageId?: string }>;
  lifecycle: string[];
  children: string[];
  imports: string[];
  importBindings: ReactImportBinding[];
  exports: string[];
  jsx: boolean;
  renderedComponents: ReactRenderedComponent[];
  eventHandlers: ReactEventHandler[];
  handlerBindings: ReactHandlerBinding[];
}

export interface ReactHandlerBinding {
  names: string[];
  kind: 'state-setter' | 'disclosure-controller';
  line: number;
  column: number;
  initializer: string;
}

export interface ReactImportBinding {
  localName: string;
  importedName: string;
  source: string;
}

export interface ReactEventHandler {
  event: string;
  handlerName?: string;
  handlerCallees: string[];
  localHandlerKind?: 'state-setter' | 'disclosure-controller';
  localSupportCallees: string[];
  jsxElement?: string;
  interactionLabel?: string;
  handlerStateTargets: string[];
  line: number;
  column: number;
}

export interface ReactRenderedComponent {
  name: string;
  line: number;
  props: string[];
  propReferences: Array<{ name: string; references: string[] }>;
}


export class ReactComponentAnalysis {
  constructor(private readonly looksLikeComponent: (node: any, content: string, name?: string) => boolean) {}

  extractLocalHandlerBindings(node: any, content: string): ReactHandlerBinding[] {
    const bindings: ReactHandlerBinding[] = [];
    this.walkOwnedComponentAst(node, content, current => {
      if (current.type !== 'VariableDeclarator' || current.init?.type !== 'CallExpression') return;
      const callee = current.init.callee;
      const hookName = callee?.type === 'Identifier'
        ? callee.name
        : callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier'
          ? callee.property.name
          : undefined;
      const state = hookName === 'useState' && current.id?.type === 'ArrayPattern';
      const disclosure = /^use(?:Disclosure|Modal|Dialog|Popover|Drawer)$/.test(String(hookName || '')) &&
        (current.id?.type === 'ObjectPattern' || current.id?.type === 'Identifier');
      if (!state && !disclosure) return;
      const names = state
        ? (current.id.elements || []).map((item: any) => item?.type === 'Identifier' ? item.name : undefined)
        : current.id.type === 'Identifier'
          ? [current.id.name]
          : (current.id.properties || []).map((property: any) => property.value?.type === 'Identifier' ? property.value.name : undefined);
      const exactNames = names.filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
      if (exactNames.length === 0) return;
      const start = current.init.range?.[0];
      const end = current.init.range?.[1];
      bindings.push({
        names: exactNames,
        kind: state ? 'state-setter' : 'disclosure-controller',
        line: current.loc?.start?.line || 1,
        column: current.loc?.start?.column || 0,
        initializer: typeof start === 'number' && typeof end === 'number' ? content.slice(start, end) : String(hookName),
      });
    });
    return bindings;
  }

  localHandlerSupport(
    root: any,
    handlerName: string | undefined,
    stateSetters: ReadonlySet<string>,
    disclosureHandlers: ReadonlySet<string>,
  ): { kind?: 'state-setter' | 'disclosure-controller'; callees: string[] } {
    if (!handlerName) return { callees: [] };
    const declarations: any[] = [];
    const walk = (current: any): void => {
      if (!current || typeof current !== 'object') return;
      if ((current.type === 'FunctionDeclaration' && current.id?.name === handlerName) ||
          (current.type === 'VariableDeclarator' && current.id?.type === 'Identifier' && current.id.name === handlerName)) {
        declarations.push(current);
        return;
      }
      for (const [key, value] of Object.entries(current)) {
        if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    };
    walk(root);
    if (declarations.length !== 1) return { callees: [] };
    const callees = this.expressionCalleeNames(declarations[0]).filter(name => !['preventDefault', 'stopPropagation'].includes(name));
    if (callees.length === 0) return { callees: [] };
    if (callees.every(name => stateSetters.has(name))) return { kind: 'state-setter', callees: [...new Set(callees)] };
    if (callees.every(name => disclosureHandlers.has(name))) return { kind: 'disclosure-controller', callees: [...new Set(callees)] };
    return { callees: [] };
  }

  exactHandlerStateTargets(root: any, handlerName: string | undefined, bindings: readonly ReactHandlerBinding[]): string[] {
    if (!handlerName || handlerName.includes('.')) return [];
    const declarations: any[] = [];
    this.walkOwnedComponentAst(root, '', current => {
      if ((current.type === 'FunctionDeclaration' && current.id?.name === handlerName) ||
          (current.type === 'VariableDeclarator' && current.id?.type === 'Identifier' && current.id.name === handlerName)) declarations.push(current);
    });
    if (declarations.length !== 1) return [];
    const callees = new Set(this.expressionCalleeNames(declarations[0]));
    return [...new Set(bindings.filter(binding => binding.kind === 'state-setter' && binding.names.some(name => callees.has(name)))
      .flatMap(binding => binding.names.filter(name => !callees.has(name))))];
  }

  jsxInteractionLabel(ancestors: readonly any[], openingElement: any): string | undefined {
    const element = [...ancestors].reverse().find(candidate => candidate?.type === 'JSXElement' && candidate.openingElement === openingElement);
    if (!element) return undefined;
    const texts: string[] = [];
    const walk = (current: any): void => {
      if (!current || typeof current !== 'object') return;
      if (current.type === 'JSXText') texts.push(String(current.value || ''));
      for (const [key, value] of Object.entries(current)) {
        if (key === 'openingElement' || key === 'attributes' || key === 'parent' || key === 'loc' || key === 'range') continue;
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    };
    (element.children || []).forEach(walk);
    const label = texts.join(' ').replace(/\s+/g, ' ').trim();
    return label && label.split(/\s+/).length <= 8 ? label : undefined;
  }

  extractEventHandlers(node: any, content: string): ReactEventHandler[] {
    const handlers: ReactEventHandler[] = [];
    const bindings = this.extractLocalHandlerBindings(node, content);
    const stateSetters = new Set(bindings.filter(binding => binding.kind === 'state-setter').flatMap(binding => binding.names));
    const disclosureHandlers = new Set(bindings.filter(binding => binding.kind === 'disclosure-controller').flatMap(binding => binding.names));
    this.walkOwnedComponentAst(node, content, (current, parent, ancestors = []) => {
      if (current.type !== 'JSXAttribute' || !/^on[A-Z]/.test(String(current.name?.name || ''))) return;
      const expression = current.value?.type === 'JSXExpressionContainer' ? current.value.expression : undefined;
      if (!expression) return;
      const eventLabel = String(current.name.name).slice(2);
      const event = eventLabel.charAt(0).toLowerCase() + eventLabel.slice(1);
      let handlerName: string | undefined;
      if (expression.type === 'Identifier') handlerName = expression.name;
      if (expression.type === 'MemberExpression' && !expression.computed && expression.object?.type === 'Identifier' && expression.property?.type === 'Identifier') {
        handlerName = expression.object.name + '.' + expression.property.name;
      }
      const handlerCallees = handlerName ? [] : this.expressionCalleeNames(expression);
      const exactHandlers = handlerName ? [handlerName] : handlerCallees;
      const directBindingNames = exactHandlers.map(name => name.split('.')[0]);
      const directLocalHandlerKind = directBindingNames.length > 0 && directBindingNames.every(name => stateSetters.has(name))
        ? 'state-setter' as const
        : directBindingNames.length > 0 && directBindingNames.every(name => disclosureHandlers.has(name)) &&
            exactHandlers.every(name => !name.includes('.') || /\.(?:onOpen|onClose)$/.test(name))
          ? 'disclosure-controller' as const
          : undefined;
      const localHandlerName = handlerName || (handlerCallees.length === 1 ? handlerCallees[0] : undefined);
      const localSupport = directLocalHandlerKind ? { kind: directLocalHandlerKind, callees: [] } :
        this.localHandlerSupport(node, localHandlerName, stateSetters, disclosureHandlers);
      const jsxElement = parent?.type === 'JSXOpeningElement' ? this.jsxName(parent.name) : undefined;
      const interactionLabel = parent?.type === 'JSXOpeningElement' ? this.jsxInteractionLabel(ancestors, parent) : undefined;
      const handlerStateTargets = this.exactHandlerStateTargets(node, localHandlerName, bindings);
      handlers.push({ event, handlerName, handlerCallees, localHandlerKind: localSupport.kind, localSupportCallees: localSupport.callees, jsxElement, interactionLabel, handlerStateTargets,
        line: current.loc?.start?.line || 1, column: current.loc?.start?.column || 0 });
    });
    return handlers;
  }

  jsxName(node: any): string | undefined {
    if (node?.type === 'JSXIdentifier') return node.name;
    if (node?.type === 'JSXMemberExpression') {
      const object = this.jsxName(node.object);
      const property = this.jsxName(node.property);
      return object && property ? `${object}.${property}` : undefined;
    }
    return undefined;
  }

  expressionCalleeNames(expression: any): string[] {
    const names = new Set<string>();
    const walk = (current: any): void => {
      if (!current || typeof current !== 'object') return;
      if (current.type === 'CallExpression' || current.type === 'NewExpression') {
        const callee = current.callee;
        if (callee?.type === 'Identifier') names.add(callee.name);
        else if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
          names.add(callee.object?.type === 'Identifier'
            ? `${callee.object.name}.${callee.property.name}`
            : callee.property.name);
        }
      }
      for (const [key, value] of Object.entries(current)) {
        if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    };
    walk(expression);
    return [...names];
  }

  walkOwnedComponentAst(root: any, content: string, visit: (node: any, parent?: any, ancestors?: readonly any[]) => void): void {
    const walk = (current: any, parent?: any, isRoot = false, ancestors: readonly any[] = []): void => {
      if (!current || typeof current !== 'object') return;
      if (!isRoot && (current.type === 'FunctionDeclaration' || current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression')) {
        const name = current.id?.name || (parent?.type === 'VariableDeclarator' ? parent.id?.name : undefined);
        if (name && /^[A-Z]/.test(name) && this.looksLikeComponent(current, content, name)) return;
      }
      visit(current, parent, ancestors);
      for (const [key, value] of Object.entries(current)) {
        if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
        if (Array.isArray(value)) value.forEach(child => walk(child, current, false, [...ancestors, current]));
        else if (value && typeof value === 'object') walk(value, current, false, [...ancestors, current]);
      }
    };
    walk(root, undefined, true);
  }

  extractRenderedComponents(node: any, content: string): ReactRenderedComponent[] {
    const renderedComponents: ReactRenderedComponent[] = [];
    const seen = new Set<string>();
    this.walkOwnedComponentAst(node, content, current => {
      if (current.type !== 'JSXOpeningElement') return;
      const componentName = this.jsxName(current.name);
      if (!componentName || !/^[A-Z]/.test(componentName)) return;
      if (componentName.includes('.')) {
        const parts = componentName.split('.');
        if (parts[0] === 'React' || parts[1]?.toLowerCase() === parts[1]) return;
      }
      const attributes = (current.attributes || []).filter((attribute: any) => attribute.type === 'JSXAttribute' && attribute.name?.name);
      const props = attributes.map((attribute: any) => String(attribute.name.name));
      const propReferences = attributes.map((attribute: any) => {
        const expression = attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : undefined;
        const references = expression ? this.expressionCalleeNames(expression) : [];
        if (expression?.type === 'Identifier') references.push(expression.name);
        return { name: String(attribute.name.name), references: [...new Set(references)] };
      });
      const lineNumber = current.loc?.start?.line || 1;
      const key = `${componentName}:${lineNumber}:${current.loc?.start?.column || 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        renderedComponents.push({ name: componentName, line: lineNumber, props, propReferences });
      }
    });
    return renderedComponents;
  }

  extractImportBindings(content: string): ReactImportBinding[] {
    const bindings: ReactImportBinding[] = [];
    const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(content)) !== null) {
      const clause = match[1].trim();
      const source = match[2];
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        for (const item of named[1].split(',')) {
          const parts = item.trim().split(/\s+as\s+/);
          if (!parts[0]) continue;
          bindings.push({ importedName: parts[0].trim(), localName: (parts[1] || parts[0]).trim(), source });
        }
      }
      const defaultBinding = /^([A-Za-z_$][\w$]*)(?:\s*,|$)/.exec(clause);
      if (defaultBinding) bindings.push({ importedName: 'default', localName: defaultBinding[1], source });
    }
    return bindings;
  }

}

export class ReactBindingResolver {
  constructor(private readonly componentId: (component: ReactComponent) => string) {}

  normalizeDeclarationFile(file: unknown): string {
    return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  }

  moduleIdentity(file: string): string {
    return this.normalizeDeclarationFile(file).replace(/\.(?:[cm]?[jt]sx?)$/i, '').replace(/\/index$/i, '');
  }

  declarationBindingNames(node: CASNode): string[] {
    const exact = String(node.name || '').trim();
    if (!exact) return [];
    if (/^[A-Za-z_$][\w$]*$/.test(exact)) return [exact];
    if ((exact.startsWith('[') && exact.endsWith(']')) || (exact.startsWith('{') && exact.endsWith('}'))) {
      return [...exact.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]);
    }
    return [];
  }

  resolveReactHandlerBinding(component: ReactComponent, name: string, declarationNodes: readonly CASNode[]): string | undefined {
    const componentFile = this.normalizeDeclarationFile(component.filePath);
    const bindingName = name.includes('.') ? name.split('.')[0] : name;
    const sameFile = declarationNodes.filter(node =>
      this.normalizeDeclarationFile(node.source?.file) === componentFile &&
      (node.source?.line || 0) >= component.sourceStartLine &&
      (node.source?.line || 0) <= component.sourceEndLine &&
      this.declarationBindingNames(node).includes(bindingName)
    );
    const exactReactBindings = sameFile.filter(node => node.type === 'react_handler_binding');
    const lexicalCandidates = exactReactBindings.length > 0 ? exactReactBindings : sameFile;
    if (lexicalCandidates.length === 1) return lexicalCandidates[0].id;
    if (lexicalCandidates.length > 1) return undefined;

    const imports = component.importBindings.filter(binding => binding.localName === bindingName && binding.source.startsWith('.'));
    if (imports.length !== 1) return undefined;
    const binding = imports[0];
    const targetModule = this.moduleIdentity(path.posix.normalize(path.posix.join(path.posix.dirname(componentFile), binding.source)));
    const imported = declarationNodes.filter(node => {
      const nodeModule = this.moduleIdentity(this.normalizeDeclarationFile(node.source?.file));
      if (nodeModule !== targetModule) return false;
      if (binding.importedName === 'default') return Boolean(node.metadata?.attributes?.is_default_export);
      return this.declarationBindingNames(node).includes(binding.importedName);
    });
    return imported.length === 1 ? imported[0].id : undefined;
  }

  resolveRenderedComponent(parent: ReactComponent, rendered: ReactRenderedComponent, components: readonly ReactComponent[]): ReactComponent | undefined {
    const sameFile = components.filter(component =>
      component.name === rendered.name &&
      this.normalizeDeclarationFile(component.filePath) === this.normalizeDeclarationFile(parent.filePath)
    );
    if (sameFile.length === 1) return sameFile[0];
    if (sameFile.length > 1) return undefined;
    const imports = (parent.importBindings || []).filter(binding => binding.localName === rendered.name && binding.source.startsWith('.'));
    if (imports.length !== 1) return undefined;
    const binding = imports[0];
    const targetModule = this.moduleIdentity(path.posix.normalize(path.posix.join(path.posix.dirname(parent.filePath), binding.source)));
    const imported = components.filter(component =>
      this.moduleIdentity(component.filePath) === targetModule &&
      (binding.importedName === 'default' ? component.isDefaultExport : component.name === binding.importedName)
    );
    return imported.length === 1 ? imported[0] : undefined;
  }

  resolveReactPropBinding(
    component: ReactComponent,
    propName: string,
    components: readonly ReactComponent[],
    declarationNodes: readonly CASNode[],
    visited = new Set<string>()
  ): { bindingNodeId: string; bindingName: string; componentPath: string[]; originComponentId: string } | undefined {
    const componentId = this.componentId(component);
    if (!componentId || visited.has(componentId)) return undefined;
    const nextVisited = new Set(visited).add(componentId);
    const [propRoot, ...memberPath] = propName.split('.').filter(Boolean);
    if (!propRoot || memberPath.length > 1) return undefined;
    const matches: Array<{ bindingNodeId: string; bindingName: string; componentPath: string[]; originComponentId: string }> = [];
    for (const parent of components) {
      const parentId = this.componentId(parent);
      if (!parentId || nextVisited.has(parentId)) continue;
      for (const rendered of parent.renderedComponents.filter(item => this.resolveRenderedComponent(parent, item, components) === component)) {
        const prop = rendered.propReferences.find(item => item.name === propRoot);
        if (!prop || prop.references.length !== 1) continue;
        const parentReference = prop.references[0];
        const bindingName = memberPath.length > 0 ? `${parentReference}.${memberPath[0]}` : parentReference;
        const bindingNodeId = this.resolveReactHandlerBinding(parent, bindingName, declarationNodes);
        if (bindingNodeId) {
          matches.push({ bindingNodeId, bindingName: parentReference.split('.')[0], componentPath: [componentId, parentId], originComponentId: parentId });
          continue;
        }
        const upstream = this.resolveReactPropBinding(parent, bindingName, components, declarationNodes, nextVisited);
        if (upstream) matches.push({ ...upstream, componentPath: [componentId, ...upstream.componentPath] });
      }
    }
    const unique = [...new Map(matches.map(match => [`${match.componentPath.join('>')}:${match.bindingNodeId}`, match])).values()];
    const terminalBindings = [...new Set(unique.map(match => `${match.originComponentId}:${match.bindingNodeId}`))];
    return terminalBindings.length === 1 ? unique.sort((left, right) => left.componentPath.length - right.componentPath.length)[0] : undefined;
  }

}
