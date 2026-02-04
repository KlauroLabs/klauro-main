import * as fs from 'fs';
import type { CSharpASTNode, GoASTNode, PHPASTNode, RustASTNode } from './ast-types';

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

      const calls: Array<{ class?: string; method?: string; function?: string; line: number }> = [];

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
            calls.push({
              class: containingClass?.name,
              method: name.text,
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

  async cleanup(): Promise<void> {}
}
