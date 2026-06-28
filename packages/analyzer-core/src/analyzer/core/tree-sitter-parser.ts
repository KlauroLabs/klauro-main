import * as fs from 'fs';
import type { CSharpASTNode, GoASTNode, PHPASTNode, RustASTNode, TypeScriptASTNode } from './ast-types';

let ParserClass: any = null;
let grammars: Record<string, any> = {};

function loadParser(): any {
  if (!ParserClass) {
    ParserClass = require('tree-sitter');
  }
  return ParserClass;
}

function loadGrammar(language: string): any {
  if (!grammars[language]) {
    switch (language) {
      case 'csharp':
        grammars[language] = require('tree-sitter-c-sharp');
        break;
      case 'go':
        grammars[language] = require('tree-sitter-go');
        break;
      case 'php': {
        const phpModule = require('tree-sitter-php');
        grammars[language] = phpModule.php || phpModule;
        break;
      }
      case 'rust':
        grammars[language] = require('tree-sitter-rust');
        break;
      case 'typescript': {
        const tsModule = require('tree-sitter-typescript');
        grammars[language] = tsModule.typescript;
        break;
      }
      case 'tsx': {
        const tsModule = require('tree-sitter-typescript');
        grammars[language] = tsModule.tsx;
        break;
      }
      case 'javascript':
        grammars[language] = require('tree-sitter-javascript');
        break;
      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }
  return grammars[language];
}

function collectByType(node: any, type: string): any[] {
  const results: any[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === type) {
      results.push(current);
    }
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      stack.push(current.namedChild(i));
    }
  }
  return results;
}

function collectByTypes(node: any, types: Set<string>): any[] {
  const results: any[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (types.has(current.type)) {
      results.push(current);
    }
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      stack.push(current.namedChild(i));
    }
  }
  return results;
}

function findFirst(node: any, type: string): any | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const found = findFirst(node.namedChild(i), type);
    if (found) return found;
  }
  return null;
}

function getFieldText(node: any, fieldName: string): string | undefined {
  const child = node.childForFieldName(fieldName);
  return child?.text;
}

export class TreeSitterParser {
  private parsers: Map<string, any> = new Map();

  private getParser(language: string): any {
    if (this.parsers.has(language)) {
      return this.parsers.get(language);
    }

    const Parser = loadParser();
    const parser = new Parser();
    parser.setLanguage(loadGrammar(language));
    this.parsers.set(language, parser);
    return parser;
  }

  private parse(language: string, filePath: string): any {
    const source = fs.readFileSync(filePath, 'utf-8');
    const parser = this.getParser(language);
    return parser.parse(source);
  }

  async parseCSharpAST(filePath: string): Promise<CSharpASTNode | null> {
    try {
      const tree = this.parse('csharp', filePath);
      const root = tree.rootNode;

      let namespace: string | undefined;
      const nsDecl = findFirst(root, 'namespace_declaration') ||
                     findFirst(root, 'file_scoped_namespace_declaration');
      if (nsDecl) {
        namespace = getFieldText(nsDecl, 'name');
      }

      const methodTypes = new Set(['method_declaration', 'constructor_declaration']);
      const methods = collectByTypes(root, methodTypes);

      const children: CSharpASTNode[] = [];

      for (const method of methods) {
        const nameNode = method.childForFieldName('name');
        const methodName = nameNode?.text ||
          (method.type === 'constructor_declaration' ? '.ctor' : undefined);
        if (!methodName) continue;

        const invocations: Array<{ target?: string; method: string; line: number }> = [];
        const body = method.childForFieldName('body');
        if (body) {
          const invocationNodes = collectByType(body, 'invocation_expression');

          for (const inv of invocationNodes) {
            const func = inv.childForFieldName('function') || inv.namedChild(0);
            if (!func) continue;

            if (func.type === 'member_access_expression') {
              const expr = func.childForFieldName('expression');
              const name = func.childForFieldName('name');
              if (name) {
                invocations.push({
                  target: expr?.text,
                  method: name.text,
                  line: inv.startPosition.row + 1
                });
              }
            } else if (func.type === 'identifier_name' || func.type === 'identifier' || func.type === 'generic_name') {
              invocations.push({
                method: func.text.replace(/<.*>$/, ''),
                line: inv.startPosition.row + 1
              });
            } else if (func.type === 'qualified_name') {
              const parts = func.text.split('.');
              const methodPart = parts.pop()!;
              invocations.push({
                target: parts.length > 0 ? parts.join('.') : undefined,
                method: methodPart,
                line: inv.startPosition.row + 1
              });
            }
          }
        }

        children.push({
          kind: 'Method',
          name: methodName,
          invocations: invocations.length > 0 ? invocations : undefined
        });
      }

      return {
        kind: 'CompilationUnit',
        namespace,
        children: children.length > 0 ? children : undefined
      };
    } catch (error) {
      return null;
    }
  }

  async parseGoAST(filePath: string): Promise<GoASTNode | null> {
    try {
      const tree = this.parse('go', filePath);
      const root = tree.rootNode;

      let packageName: string | undefined;
      const pkgClause = findFirst(root, 'package_clause');
      if (pkgClause) {
        for (let i = 0; i < pkgClause.namedChildCount; i++) {
          const child = pkgClause.namedChild(i);
          if (child.type === 'package_identifier') {
            packageName = child.text;
            break;
          }
        }
      }

      const funcTypes = new Set(['function_declaration', 'method_declaration']);
      const functions = collectByTypes(root, funcTypes);

      const children: GoASTNode[] = [];

      for (const func of functions) {
        const nameNode = func.childForFieldName('name');
        const funcName = nameNode?.text;
        if (!funcName) continue;

        const calls: Array<{ package?: string; function: string; line: number; column: number }> = [];
        const body = func.childForFieldName('body');
        if (body) {
          const callNodes = collectByType(body, 'call_expression');

          for (const call of callNodes) {
            const callee = call.childForFieldName('function') || call.namedChild(0);
            if (!callee) continue;

            if (callee.type === 'selector_expression') {
              const operand = callee.childForFieldName('operand');
              const field = callee.childForFieldName('field');
              if (field) {
                calls.push({
                  package: operand?.text,
                  function: field.text,
                  line: call.startPosition.row + 1,
                  column: call.startPosition.column
                });
              }
            } else if (callee.type === 'identifier') {
              calls.push({
                function: callee.text,
                line: call.startPosition.row + 1,
                column: call.startPosition.column
              });
            } else if (callee.type === 'parenthesized_expression') {
              const inner = callee.namedChild(0);
              if (inner) {
                calls.push({
                  function: inner.text,
                  line: call.startPosition.row + 1,
                  column: call.startPosition.column
                });
              }
            }
          }
        }

        children.push({
          type: 'Function',
          name: funcName,
          package: packageName,
          calls: calls.length > 0 ? calls : undefined
        });
      }

      return {
        type: 'SourceFile',
        package: packageName,
        children: children.length > 0 ? children : undefined
      };
    } catch (error) {
      return null;
    }
  }

  async parsePHPAST(filePath: string): Promise<PHPASTNode | null> {
    try {
      const tree = this.parse('php', filePath);
      const root = tree.rootNode;

      let namespace: string | undefined;
      const nsDefn = findFirst(root, 'namespace_definition');
      if (nsDefn) {
        namespace = getFieldText(nsDefn, 'name');
      }

      const classRanges: Array<{ name: string; startRow: number; endRow: number }> = [];
      const classDecls = collectByType(root, 'class_declaration');
      for (const cls of classDecls) {
        const nameNode = cls.childForFieldName('name');
        if (nameNode) {
          classRanges.push({
            name: nameNode.text,
            startRow: cls.startPosition.row,
            endRow: cls.endPosition.row
          });
        }
      }

      const callTypes = new Set([
        'function_call_expression',
        'member_call_expression',
        'scoped_call_expression'
      ]);
      const callExpressions = collectByTypes(root, callTypes);

      const calls: Array<{ class?: string; method?: string; function?: string; receiver?: string; line: number }> = [];

      for (const expr of callExpressions) {
        const line = expr.startPosition.row + 1;
        const containingClass = classRanges.find(
          c => expr.startPosition.row >= c.startRow && expr.startPosition.row <= c.endRow
        );

        if (expr.type === 'function_call_expression') {
          const func = expr.childForFieldName('function');
          if (func) {
            calls.push({
              function: func.text,
              line,
              class: containingClass?.name
            });
          }
        } else if (expr.type === 'member_call_expression') {
          const name = expr.childForFieldName('name');
          if (name) {
            // Capture the RECEIVER (`$a` in `$a->save()`) so the analyzer can
            // type-resolve it to the receiver's class — not the containing class.
            const object = expr.childForFieldName('object');
            const receiver = object?.text?.replace(/^\$/, '');
            calls.push({
              class: containingClass?.name,
              method: name.text,
              receiver,
              line
            });
          }
        } else if (expr.type === 'scoped_call_expression') {
          const scope = expr.childForFieldName('scope');
          const name = expr.childForFieldName('name');
          if (name) {
            calls.push({
              class: scope?.text,
              method: name.text,
              line
            });
          }
        }
      }

      return {
        nodeType: 'Program',
        namespace,
        calls: calls.length > 0 ? calls : undefined
      };
    } catch (error) {
      return null;
    }
  }

  async parseRustAST(filePath: string): Promise<RustASTNode | null> {
    try {
      const tree = this.parse('rust', filePath);
      const root = tree.rootNode;

      const funcNodes = collectByType(root, 'function_item');

      const children: RustASTNode[] = [];

      for (const func of funcNodes) {
        const nameNode = func.childForFieldName('name');
        const funcName = nameNode?.text;
        if (!funcName) continue;

        const calls: Array<{ module?: string; function: string; line: number }> = [];
        const body = func.childForFieldName('body');
        if (body) {
          const callNodes = collectByType(body, 'call_expression');

          for (const call of callNodes) {
            const callee = call.childForFieldName('function') || call.namedChild(0);
            if (!callee) continue;

            if (callee.type === 'field_expression') {
              const field = callee.childForFieldName('field');
              const value = callee.childForFieldName('value');
              if (field) {
                calls.push({
                  module: value?.text,
                  function: field.text,
                  line: call.startPosition.row + 1
                });
              }
            } else if (callee.type === 'scoped_identifier') {
              const path = callee.childForFieldName('path');
              const name = callee.childForFieldName('name');
              if (name) {
                calls.push({
                  module: path?.text,
                  function: name.text,
                  line: call.startPosition.row + 1
                });
              }
            } else if (callee.type === 'identifier') {
              calls.push({
                function: callee.text,
                line: call.startPosition.row + 1
              });
            }
          }
        }

        children.push({
          kind: 'Function',
          name: funcName,
          calls: calls.length > 0 ? calls : undefined
        });
      }

      return {
        kind: 'SourceFile',
        children: children.length > 0 ? children : undefined
      };
    } catch (error) {
      return null;
    }
  }

  parseTypeScriptFromSource(source: string, isTsx: boolean = false): TypeScriptASTNode | null {
    try {
      const language = isTsx ? 'tsx' : 'typescript';
      const parser = this.getParser(language);
      const tree = parser.parse(source);
      const root = tree.rootNode;

      const imports: TypeScriptASTNode['imports'] = [];
      const importNodes = collectByType(root, 'import_statement');
      for (const imp of importNodes) {
        const sourceNode = imp.childForFieldName('source') || findFirst(imp, 'string');
        if (!sourceNode) continue;
        const sourcePath = sourceNode.text.replace(/['"]/g, '');

        const specifiers: Array<{ name: string; alias?: string }> = [];
        let isDefault = false;
        let isNamespace = false;

        const clause = findFirst(imp, 'import_clause');
        if (clause) {
          for (let i = 0; i < clause.namedChildCount; i++) {
            const child = clause.namedChild(i);
            if (child.type === 'identifier') {
              isDefault = true;
              specifiers.push({ name: child.text });
            } else if (child.type === 'namespace_import') {
              isNamespace = true;
              const name = child.namedChild(0);
              if (name) specifiers.push({ name: name.text });
            } else if (child.type === 'named_imports') {
              const specs = collectByType(child, 'import_specifier');
              for (const spec of specs) {
                const name = spec.childForFieldName('name');
                const alias = spec.childForFieldName('alias');
                if (name) {
                  specifiers.push({
                    name: name.text,
                    alias: alias?.text
                  });
                }
              }
            }
          }
        }

        imports.push({ source: sourcePath, specifiers, isDefault, isNamespace });
      }

      const children: TypeScriptASTNode[] = [];

      const funcTypes = new Set([
        'function_declaration',
        'method_definition',
        'arrow_function',
        'function_expression'
      ]);
      const functions = collectByTypes(root, funcTypes);

      for (const func of functions) {
        const nameNode = func.childForFieldName('name');
        let funcName = nameNode?.text;

        if (!funcName && func.parent?.type === 'variable_declarator') {
          const varName = func.parent.childForFieldName('name');
          funcName = varName?.text;
        }

        if (!funcName && func.parent?.type === 'pair') {
          const key = func.parent.childForFieldName('key');
          funcName = key?.text;
        }

        if (!funcName) continue;

        const isAsync = func.text.startsWith('async') ||
                       func.children?.some((c: any) => c.type === 'async');

        let className: string | undefined;
        let parent = func.parent;
        while (parent) {
          if (parent.type === 'class_declaration' || parent.type === 'class') {
            const classNameNode = parent.childForFieldName('name');
            className = classNameNode?.text;
            break;
          }
          parent = parent.parent;
        }

        const calls: Array<{ target?: string; method: string; line: number; isAsync?: boolean }> = [];
        const body = func.childForFieldName('body');
        if (body) {
          const callNodes = collectByType(body, 'call_expression');
          for (const call of callNodes) {
            const callee = call.childForFieldName('function') || call.namedChild(0);
            if (!callee) continue;

            const isAwait = call.parent?.type === 'await_expression';

            if (callee.type === 'member_expression') {
              const obj = callee.childForFieldName('object');
              const prop = callee.childForFieldName('property');
              if (prop) {
                calls.push({
                  target: obj?.text,
                  method: prop.text,
                  line: call.startPosition.row + 1,
                  isAsync: isAwait
                });
              }
            } else if (callee.type === 'identifier') {
              calls.push({
                method: callee.text,
                line: call.startPosition.row + 1,
                isAsync: isAwait
              });
            }
          }
        }

        const decorators: string[] = [];
        if (func.previousNamedSibling?.type === 'decorator') {
          let dec = func.previousNamedSibling;
          while (dec && dec.type === 'decorator') {
            const name = findFirst(dec, 'identifier') || findFirst(dec, 'call_expression');
            if (name) decorators.unshift(name.text.split('(')[0]);
            dec = dec.previousNamedSibling;
          }
        }

        children.push({
          kind: func.type === 'method_definition' ? 'Method' : 'Function',
          name: funcName,
          className,
          isAsync,
          decorators: decorators.length > 0 ? decorators : undefined,
          calls: calls.length > 0 ? calls : undefined,
          location: {
            startLine: func.startPosition.row + 1,
            endLine: func.endPosition.row + 1,
            startColumn: func.startPosition.column,
            endColumn: func.endPosition.column
          }
        });
      }

      const classNodes = collectByType(root, 'class_declaration');
      for (const cls of classNodes) {
        const nameNode = cls.childForFieldName('name');
        const className = nameNode?.text;
        if (!className) continue;

        const decorators: string[] = [];
        if (cls.previousNamedSibling?.type === 'decorator') {
          let dec = cls.previousNamedSibling;
          while (dec && dec.type === 'decorator') {
            const name = findFirst(dec, 'identifier') || findFirst(dec, 'call_expression');
            if (name) decorators.unshift(name.text.split('(')[0]);
            dec = dec.previousNamedSibling;
          }
        }

        const properties: TypeScriptASTNode['properties'] = [];
        const body = cls.childForFieldName('body');
        if (body) {
          const propDefs = collectByTypes(body, new Set(['public_field_definition', 'field_definition']));
          for (const prop of propDefs) {
            const name = prop.childForFieldName('name');
            const type = prop.childForFieldName('type');
            if (name) {
              properties.push({
                name: name.text,
                type: type?.text
              });
            }
          }
        }

        children.push({
          kind: 'Class',
          name: className,
          decorators: decorators.length > 0 ? decorators : undefined,
          properties: properties.length > 0 ? properties : undefined,
          location: {
            startLine: cls.startPosition.row + 1,
            endLine: cls.endPosition.row + 1,
            startColumn: cls.startPosition.column,
            endColumn: cls.endPosition.column
          }
        });
      }

      return {
        kind: 'SourceFile',
        imports: imports.length > 0 ? imports : undefined,
        children: children.length > 0 ? children : undefined
      };
    } catch (error) {
      return null;
    }
  }

  parseTypeScriptFile(filePath: string): TypeScriptASTNode | null {
    try {
      const source = fs.readFileSync(filePath, 'utf-8');
      const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
      return this.parseTypeScriptFromSource(source, isTsx);
    } catch (error) {
      return null;
    }
  }

  async cleanup(): Promise<void> {}
}
