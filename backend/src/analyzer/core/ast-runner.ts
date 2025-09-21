import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export interface ASTParserResult {
  success: boolean;
  ast?: any;
  error?: string;
}

export interface GoASTNode {
  type: string;
  name?: string;
  package?: string;
  receiver?: {
    name: string;
    type: string;
    pointer: boolean;
  };
  params?: Array<{ name: string; type: string }>;
  returns?: string[];
  calls?: Array<{
    package?: string;
    function: string;
    line: number;
    column: number;
  }>;
  imports?: Array<{
    path: string;
    alias?: string;
  }>;
  fields?: Array<{
    name: string;
    type: string;
    tag?: string;
  }>;
  methods?: Array<{
    name: string;
    receiver?: string;
  }>;
  position?: {
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
  };
  children?: GoASTNode[];
}

export interface RustASTNode {
  kind: string;
  name?: string;
  visibility?: string;
  attributes?: string[];
  generics?: string[];
  parameters?: Array<{ name: string; type: string }>;
  returnType?: string;
  calls?: Array<{
    module?: string;
    function: string;
    line: number;
  }>;
  uses?: Array<{
    path: string;
    alias?: string;
  }>;
  fields?: Array<{
    name: string;
    type: string;
    visibility: string;
  }>;
  methods?: Array<{
    name: string;
    selfParam?: string;
  }>;
  span?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  children?: RustASTNode[];
}

export interface CSharpASTNode {
  kind: string;
  name?: string;
  namespace?: string;
  modifiers?: string[];
  baseTypes?: string[];
  parameters?: Array<{ name: string; type: string; modifiers?: string[] }>;
  returnType?: string;
  invocations?: Array<{
    target?: string;
    method: string;
    line: number;
  }>;
  usings?: Array<{
    namespace: string;
    alias?: string;
  }>;
  members?: Array<{
    kind: string;
    name: string;
    type?: string;
    modifiers?: string[];
  }>;
  location?: {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
  };
  children?: CSharpASTNode[];
}

export interface PHPASTNode {
  nodeType: string;
  name?: string;
  namespace?: string;
  visibility?: string;
  modifiers?: string[];
  extends?: string;
  implements?: string[];
  parameters?: Array<{
    name: string;
    type?: string;
    default?: string;
    byRef?: boolean;
    variadic?: boolean;
  }>;
  returnType?: string;
  calls?: Array<{
    class?: string;
    method?: string;
    function?: string;
    line: number;
  }>;
  uses?: Array<{
    name: string;
    alias?: string;
  }>;
  properties?: Array<{
    name: string;
    type?: string;
    visibility?: string;
    static?: boolean;
  }>;
  methods?: Array<{
    name: string;
    visibility?: string;
    static?: boolean;
    abstract?: boolean;
  }>;
  attributes?: {
    startLine: number;
    endLine: number;
    startFilePos?: number;
    endFilePos?: number;
  };
  children?: PHPASTNode[];
}

export class ASTRunner {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'unravl-ast');
    fs.ensureDirSync(this.tempDir);
  }

  async parseGoAST(filePath: string): Promise<GoASTNode | null> {
    try {
      const goParserScript = `
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
)

type Position struct {
	File      string \`json:"file"\`
	Line      int    \`json:"line"\`
	Column    int    \`json:"column"\`
	EndLine   int    \`json:"endLine,omitempty"\`
	EndColumn int    \`json:"endColumn,omitempty"\`
}

type Call struct {
	Package  string \`json:"package,omitempty"\`
	Function string \`json:"function"\`
	Line     int    \`json:"line"\`
	Column   int    \`json:"column"\`
}

type ASTNode struct {
	Type     string    \`json:"type"\`
	Name     string    \`json:"name,omitempty"\`
	Package  string    \`json:"package,omitempty"\`
	Position *Position \`json:"position,omitempty"\`
	Calls    []Call    \`json:"calls,omitempty"\`
	Children []ASTNode \`json:"children,omitempty"\`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: %s <file.go>\\n", os.Args[0])
		os.Exit(1)
	}

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, os.Args[1], nil, parser.ParseComments)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Parse error: %v\\n", err)
		os.Exit(1)
	}

	result := extractAST(fset, node)
	data, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintf(os.Stderr, "JSON error: %v\\n", err)
		os.Exit(1)
	}

	fmt.Println(string(data))
}

func extractAST(fset *token.FileSet, node ast.Node) ASTNode {
	result := ASTNode{Children: []ASTNode{}}

	ast.Inspect(node, func(n ast.Node) bool {
		if n == nil {
			return false
		}

		switch x := n.(type) {
		case *ast.File:
			result.Type = "File"
			result.Package = x.Name.Name
		case *ast.FuncDecl:
			child := ASTNode{
				Type: "Function",
				Name: x.Name.Name,
			}
			if pos := fset.Position(x.Pos()); pos.IsValid() {
				child.Position = &Position{
					Line:   pos.Line,
					Column: pos.Column,
				}
			}
			extractCalls(fset, x.Body, &child)
			result.Children = append(result.Children, child)
		case *ast.CallExpr:
			call := extractCallInfo(x)
			if call != nil && call.Function != "" {
				if pos := fset.Position(x.Pos()); pos.IsValid() {
					call.Line = pos.Line
					call.Column = pos.Column
				}
				result.Calls = append(result.Calls, *call)
			}
		}
		return true
	})

	return result
}

func extractCalls(fset *token.FileSet, block *ast.BlockStmt, node *ASTNode) {
	if block == nil {
		return
	}

	ast.Inspect(block, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			if callInfo := extractCallInfo(call); callInfo != nil {
				if pos := fset.Position(call.Pos()); pos.IsValid() {
					callInfo.Line = pos.Line
					callInfo.Column = pos.Column
				}
				node.Calls = append(node.Calls, *callInfo)
			}
		}
		return true
	})
}

func extractCallInfo(call *ast.CallExpr) *Call {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		return &Call{Function: fun.Name}
	case *ast.SelectorExpr:
		result := &Call{Function: fun.Sel.Name}
		if ident, ok := fun.X.(*ast.Ident); ok {
			result.Package = ident.Name
		}
		return result
	}
	return nil
}
`;

      const scriptPath = path.join(this.tempDir, 'parse_go.go');
      await fs.writeFile(scriptPath, goParserScript);

      const binaryPath = path.join(this.tempDir, 'parse_go');

      await execAsync(`go build -o ${binaryPath} ${scriptPath}`, {
        maxBuffer: 10 * 1024 * 1024
      });

      const { stdout, stderr } = await execAsync(`${binaryPath} ${filePath}`, {
        maxBuffer: 10 * 1024 * 1024
      });

      if (stderr && !stderr.includes('warning')) {
        console.error('Go AST parser stderr:', stderr);
        return null;
      }

      return JSON.parse(stdout);
    } catch (error) {
      console.error('Failed to parse Go AST:', error);
      return null;
    }
  }

  async parseRustAST(filePath: string): Promise<RustASTNode | null> {
    try {
      const rustParserScript = `
use std::env;
use std::fs;
use std::process;
use syn::{parse_file, Item, Expr, visit::Visit};
use serde_json::json;

struct CallExtractor {
    calls: Vec<serde_json::Value>,
}

impl<'ast> Visit<'ast> for CallExtractor {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        if let syn::Expr::Path(path_expr) = &*node.func {
            let path = path_expr.path.segments.iter()
                .map(|seg| seg.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");

            self.calls.push(json!({
                "function": path,
                "line": 0  // Would need span info for actual line
            }));
        }
        syn::visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        self.calls.push(json!({
            "function": node.method.to_string(),
            "line": 0
        }));
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <file.rs>", args[0]);
        process::exit(1);
    }

    let content = fs::read_to_string(&args[1])
        .expect("Failed to read file");

    let syntax = parse_file(&content)
        .expect("Failed to parse file");

    let mut result = json!({
        "kind": "File",
        "children": []
    });

    for item in syntax.items {
        match item {
            Item::Fn(func) => {
                let mut extractor = CallExtractor { calls: vec![] };
                extractor.visit_item_fn(&func);

                result["children"].as_array_mut().unwrap().push(json!({
                    "kind": "Function",
                    "name": func.sig.ident.to_string(),
                    "calls": extractor.calls
                }));
            }
            Item::Struct(s) => {
                result["children"].as_array_mut().unwrap().push(json!({
                    "kind": "Struct",
                    "name": s.ident.to_string(),
                    "fields": s.fields.iter().map(|f| json!({
                        "name": f.ident.as_ref().map(|i| i.to_string()).unwrap_or_default(),
                        "type": "unknown"
                    })).collect::<Vec<_>>()
                }));
            }
            Item::Impl(impl_block) => {
                let type_name = if let syn::Type::Path(type_path) = &*impl_block.self_ty {
                    type_path.path.segments.last()
                        .map(|seg| seg.ident.to_string())
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                for item in &impl_block.items {
                    if let syn::ImplItem::Fn(method) = item {
                        let mut extractor = CallExtractor { calls: vec![] };
                        extractor.visit_impl_item_fn(&method);

                        result["children"].as_array_mut().unwrap().push(json!({
                            "kind": "Method",
                            "name": method.sig.ident.to_string(),
                            "type": type_name,
                            "calls": extractor.calls
                        }));
                    }
                }
            }
            _ => {}
        }
    }

    println!("{}", result);
}
`;

      const cargoToml = `
[package]
name = "rust_ast_parser"
version = "0.1.0"
edition = "2021"

[dependencies]
syn = { version = "2.0", features = ["full", "visit", "extra-traits"] }
serde_json = "1.0"
`;

      const projectDir = path.join(this.tempDir, 'rust_parser');
      const srcDir = path.join(projectDir, 'src');
      await fs.ensureDir(srcDir);
      await fs.writeFile(path.join(projectDir, 'Cargo.toml'), cargoToml);
      await fs.writeFile(path.join(srcDir, 'main.rs'), rustParserScript);

      const buildResult = await execAsync(`cd ${projectDir} && cargo build --release 2>/dev/null`, {
        maxBuffer: 10 * 1024 * 1024
      });

      const { stdout } = await execAsync(
        `${projectDir}/target/release/rust_ast_parser ${filePath}`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      return JSON.parse(stdout);
    } catch (error) {
      console.error('Failed to parse Rust AST:', error);
      return null;
    }
  }

  async parseCSharpAST(filePath: string): Promise<CSharpASTNode | null> {
    try {
      const csharpParserScript = `
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Newtonsoft.Json;

public class CallInfo
{
    public string Target { get; set; }
    public string Method { get; set; }
    public int Line { get; set; }
}

public class ASTNode
{
    public string Kind { get; set; }
    public string Name { get; set; }
    public string Namespace { get; set; }
    public List<CallInfo> Invocations { get; set; } = new List<CallInfo>();
    public List<ASTNode> Children { get; set; } = new List<ASTNode>();
}

public class ASTParser : CSharpSyntaxWalker
{
    private ASTNode root = new ASTNode { Kind = "CompilationUnit" };
    private Stack<ASTNode> nodeStack = new Stack<ASTNode>();
    private SemanticModel semanticModel;

    public ASTParser(SemanticModel model) : base(SyntaxWalkerDepth.Node)
    {
        semanticModel = model;
        nodeStack.Push(root);
    }

    public override void VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        var methodNode = new ASTNode
        {
            Kind = "Method",
            Name = node.Identifier.Text
        };

        nodeStack.Peek().Children.Add(methodNode);
        nodeStack.Push(methodNode);
        base.VisitMethodDeclaration(node);
        nodeStack.Pop();
    }

    public override void VisitInvocationExpression(InvocationExpressionSyntax node)
    {
        var callInfo = new CallInfo
        {
            Line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1
        };

        if (node.Expression is MemberAccessExpressionSyntax memberAccess)
        {
            callInfo.Target = memberAccess.Expression.ToString();
            callInfo.Method = memberAccess.Name.Identifier.Text;
        }
        else if (node.Expression is IdentifierNameSyntax identifier)
        {
            callInfo.Method = identifier.Identifier.Text;
        }

        if (!string.IsNullOrEmpty(callInfo.Method))
        {
            nodeStack.Peek().Invocations.Add(callInfo);
        }

        base.VisitInvocationExpression(node);
    }

    public override void VisitClassDeclaration(ClassDeclarationSyntax node)
    {
        var classNode = new ASTNode
        {
            Kind = "Class",
            Name = node.Identifier.Text
        };

        var symbol = semanticModel.GetDeclaredSymbol(node);
        if (symbol != null)
        {
            classNode.Namespace = symbol.ContainingNamespace?.ToDisplayString();
        }

        nodeStack.Peek().Children.Add(classNode);
        nodeStack.Push(classNode);
        base.VisitClassDeclaration(node);
        nodeStack.Pop();
    }

    public ASTNode GetRoot() => root;
}

class Program
{
    static void Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("Usage: parser <file.cs>");
            Environment.Exit(1);
        }

        var code = File.ReadAllText(args[0]);
        var tree = CSharpSyntaxTree.ParseText(code);

        var compilation = CSharpCompilation.Create("Analysis")
            .AddReferences(MetadataReference.CreateFromFile(typeof(object).Assembly.Location))
            .AddSyntaxTrees(tree);

        var semanticModel = compilation.GetSemanticModel(tree);
        var parser = new ASTParser(semanticModel);
        parser.Visit(tree.GetRoot());

        var json = JsonConvert.SerializeObject(parser.GetRoot(), Formatting.None);
        Console.WriteLine(json);
    }
}
`;

      const projectFile = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="4.8.0" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`;

      const projectDir = path.join(this.tempDir, 'csharp_parser');
      await fs.ensureDir(projectDir);
      await fs.writeFile(path.join(projectDir, 'Program.cs'), csharpParserScript);
      await fs.writeFile(path.join(projectDir, 'parser.csproj'), projectFile);

      await execAsync(`cd ${projectDir} && dotnet build -c Release 2>/dev/null`, {
        maxBuffer: 10 * 1024 * 1024
      });

      const { stdout } = await execAsync(
        `dotnet ${projectDir}/bin/Release/net6.0/parser.dll ${filePath}`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      return JSON.parse(stdout);
    } catch (error) {
      console.error('Failed to parse C# AST:', error);
      return null;
    }
  }

  async parsePHPAST(filePath: string): Promise<PHPASTNode | null> {
    try {
      const phpParserScript = `<?php
require_once 'vendor/autoload.php';

use PhpParser\\ParserFactory;
use PhpParser\\NodeTraverser;
use PhpParser\\NodeVisitorAbstract;
use PhpParser\\Node;

class CallExtractor extends NodeVisitorAbstract {
    public $calls = [];
    public $currentClass = null;
    public $currentMethod = null;

    public function enterNode(Node $node) {
        if ($node instanceof Node\\Stmt\\Class_) {
            $this->currentClass = $node->name->toString();
        } elseif ($node instanceof Node\\Stmt\\ClassMethod) {
            $this->currentMethod = $node->name->toString();
        } elseif ($node instanceof Node\\Expr\\MethodCall) {
            $this->calls[] = [
                'method' => $node->name instanceof Node\\Identifier ? $node->name->toString() : 'dynamic',
                'line' => $node->getStartLine(),
                'class' => $this->currentClass,
                'inMethod' => $this->currentMethod
            ];
        } elseif ($node instanceof Node\\Expr\\FuncCall) {
            if ($node->name instanceof Node\\Name) {
                $this->calls[] = [
                    'function' => $node->name->toString(),
                    'line' => $node->getStartLine(),
                    'class' => $this->currentClass,
                    'inMethod' => $this->currentMethod
                ];
            }
        } elseif ($node instanceof Node\\Expr\\StaticCall) {
            $class = $node->class instanceof Node\\Name ? $node->class->toString() : 'dynamic';
            $method = $node->name instanceof Node\\Identifier ? $node->name->toString() : 'dynamic';
            $this->calls[] = [
                'class' => $class,
                'method' => $method,
                'line' => $node->getStartLine(),
                'inClass' => $this->currentClass,
                'inMethod' => $this->currentMethod
            ];
        }
    }

    public function leaveNode(Node $node) {
        if ($node instanceof Node\\Stmt\\Class_) {
            $this->currentClass = null;
        } elseif ($node instanceof Node\\Stmt\\ClassMethod) {
            $this->currentMethod = null;
        }
    }
}

if ($argc < 2) {
    fwrite(STDERR, "Usage: php parser.php <file.php>\\n");
    exit(1);
}

$code = file_get_contents($argv[1]);
$parser = (new ParserFactory)->create(ParserFactory::PREFER_PHP7);

try {
    $ast = $parser->parse($code);

    $traverser = new NodeTraverser;
    $extractor = new CallExtractor;
    $traverser->addVisitor($extractor);
    $traverser->traverse($ast);

    $result = [
        'nodeType' => 'File',
        'calls' => $extractor->calls,
        'children' => []
    ];

    foreach ($ast as $node) {
        if ($node instanceof Node\\Stmt\\Class_) {
            $classData = [
                'nodeType' => 'Class',
                'name' => $node->name->toString(),
                'methods' => [],
                'properties' => []
            ];

            foreach ($node->stmts as $stmt) {
                if ($stmt instanceof Node\\Stmt\\ClassMethod) {
                    $classData['methods'][] = [
                        'name' => $stmt->name->toString(),
                        'visibility' => $stmt->isPublic() ? 'public' : ($stmt->isProtected() ? 'protected' : 'private'),
                        'static' => $stmt->isStatic()
                    ];
                } elseif ($stmt instanceof Node\\Stmt\\Property) {
                    foreach ($stmt->props as $prop) {
                        $classData['properties'][] = [
                            'name' => $prop->name->toString(),
                            'visibility' => $stmt->isPublic() ? 'public' : ($stmt->isProtected() ? 'protected' : 'private'),
                            'static' => $stmt->isStatic()
                        ];
                    }
                }
            }

            $result['children'][] = $classData;
        } elseif ($node instanceof Node\\Stmt\\Function_) {
            $result['children'][] = [
                'nodeType' => 'Function',
                'name' => $node->name->toString()
            ];
        }
    }

    echo json_encode($result);
} catch (Exception $e) {
    fwrite(STDERR, "Parse Error: " . $e->getMessage() . "\\n");
    exit(1);
}
`;

      const composerJson = `{
    "require": {
        "nikic/php-parser": "^4.17"
    }
}`;

      const projectDir = path.join(this.tempDir, 'php_parser');
      await fs.ensureDir(projectDir);
      await fs.writeFile(path.join(projectDir, 'composer.json'), composerJson);
      await fs.writeFile(path.join(projectDir, 'parser.php'), phpParserScript);

      await execAsync(`cd ${projectDir} && composer install --quiet 2>/dev/null`, {
        maxBuffer: 10 * 1024 * 1024
      });

      const { stdout } = await execAsync(
        `php ${projectDir}/parser.php ${filePath}`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      return JSON.parse(stdout);
    } catch (error) {
      console.error('Failed to parse PHP AST:', error);
      return null;
    }
  }

  async cleanup(): Promise<void> {
    try {
      await fs.remove(this.tempDir);
    } catch (error) {
      console.error('Failed to cleanup temp directory:', error);
    }
  }
}