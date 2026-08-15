import type { RustASTNode } from './core/ast-types';
import { RustAnalyzer } from './languages/rust-analyzer';
import { CASNode, CASEdge, CASMethodCall, CASCallChain, generateNodeId } from '../types/cas.types';

type RustAST = RustASTNode;





export class EnhancedRustCallGraphExtractor {
  private nodes: CASNode[] = [];
  private methodToNodeMap = new Map<string, string>();
  private functionToNodeMap = new Map<string, string>();
  private crateToNodeMap = new Map<string, string>();
  private externalServiceMap = new Map<string, string>();
  private methodCalls: CASMethodCall[] = [];
  private callDepthMap = new Map<string, number>();
  private loopDepthMap = new Map<string, number>();
  private conditionalDepthMap = new Map<string, number>();

  constructor(
    private rustAnalyzer: RustAnalyzer,
    private astCache: Map<string, RustAST>
  ) {}




  extractCallGraph(nodes: CASNode[], edges: CASEdge[]): {
    methodCalls: CASMethodCall[];
    callChains: CASCallChain[];
    enhancedEdges: CASEdge[];
  } {
    this.nodes = nodes;
    this.buildNodeMaps();
    this.analyzeMethodCalls();

    const callChains = this.buildCallChains();
    const enhancedEdges = this.buildEnhancedEdges();

    return {
      methodCalls: this.methodCalls,
      callChains,
      enhancedEdges
    };
  }




  private buildNodeMaps(): void {
    this.nodes.forEach(node => {
      if (node.type === 'method' || node.type === 'function') {
        this.methodToNodeMap.set(node.name, node.id);
        this.functionToNodeMap.set(node.name, node.id);
      } else if (node.type === 'module' && node.name.startsWith('crate:')) {
        this.crateToNodeMap.set(node.name.replace('crate:', ''), node.id);
      }
    });
  }




  private analyzeMethodCalls(): void {
    const methodNodes = this.nodes.filter(n => n.type === 'method' || n.type === 'function');

    methodNodes.forEach(methodNode => {
      const sourceCode = this.getMethodSourceCode(methodNode);
      if (sourceCode) {
        this.analyzeCallsInMethod(methodNode, sourceCode);
      }
    });
  }




  private getMethodSourceCode(methodNode: CASNode): string | null {
    if (!methodNode.source?.file) return null;

    try {
      const ast = this.astCache.get(methodNode.source.file);
      if (!ast) return null;


      const method = this.findMethodInAST(methodNode.name, ast);
      return method?.body || null;
    } catch (error) {
      console.warn(`Failed to extract source for ${methodNode.name}:`, error);
      return null;
    }
  }




  private findMethodInAST(methodName: string, ast: RustAST): any {


    return {
      name: methodName,
      body: null
    };
  }




  private analyzeCallsInMethod(methodNode: CASNode, sourceCode: string): void {
    const lines = sourceCode.split('\n');
    let callDepth = 0;
    let loopDepth = 0;
    let conditionalDepth = 0;

    lines.forEach((line, index) => {

      callDepth = this.calculateCallDepth(line, callDepth);
      loopDepth = this.calculateLoopDepth(line, loopDepth);
      conditionalDepth = this.calculateConditionalDepth(line, conditionalDepth);


      const calls = this.extractCallsFromLine(line, index + 1, methodNode);
      this.methodCalls.push(...calls);
    });
  }




  private calculateCallDepth(line: string, currentDepth: number): number {

    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    return Math.max(0, currentDepth + openBraces - closeBraces);
  }




  private calculateLoopDepth(line: string, currentDepth: number): number {
    const loopKeywords = ['for ', 'while ', 'loop '];
    const hasLoopStart = loopKeywords.some(keyword => line.includes(keyword));
    return hasLoopStart ? currentDepth + 1 : currentDepth;
  }




  private calculateConditionalDepth(line: string, currentDepth: number): number {
    const conditionalKeywords = ['if ', 'match ', 'else if'];
    const hasConditionalStart = conditionalKeywords.some(keyword => line.includes(keyword));
    return hasConditionalStart ? currentDepth + 1 : currentDepth;
  }




  private extractCallsFromLine(line: string, lineNumber: number, callerNode: CASNode): CASMethodCall[] {
    const calls: CASMethodCall[] = [];
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*')) {
      return calls;
    }


    const methodCallRegex = /(\w+)\s*\(([^)]*)\)/g;
    let match;

    while ((match = methodCallRegex.exec(trimmedLine)) !== null) {
      const call = this.createMethodCall(
        match[1],
        match[2],
        lineNumber,
        callerNode,
        trimmedLine
      );
      if (call) {
        calls.push(call);
      }
    }


    const objectMethodRegex = /(\w+)\.(\w+)\s*\(([^)]*)\)/g;
    while ((match = objectMethodRegex.exec(trimmedLine)) !== null) {
      const call = this.createMethodCall(
        match[2],
        match[3],
        lineNumber,
        callerNode,
        trimmedLine,
        match[1]
      );
      if (call) {
        calls.push(call);
      }
    }


    const crateCallRegex = /(\w+)::(\w+)::(\w+)\s*\(([^)]*)\)/g;
    while ((match = crateCallRegex.exec(trimmedLine)) !== null) {
      const crateName = match[1];
      const moduleName = match[2];
      const functionName = match[3];

      const call = this.createExternalCall(
        functionName,
        match[4],
        lineNumber,
        callerNode,
        trimmedLine,
        crateName,
        moduleName
      );
      if (call) {
        calls.push(call);
      }
    }

    return calls;
  }




  private createMethodCall(
    methodName: string,
    argsStr: string,
    lineNumber: number,
    callerNode: CASNode,
    fullLine: string,
    objectContext?: string
  ): CASMethodCall | null {
    const targetNodeId = this.resolveMethodTarget(methodName, objectContext);
    const parsedArgs = this.parseArguments(argsStr);

    const call: CASMethodCall = {
      id: `call_${callerNode.id}_to_${targetNodeId || 'external'}_${lineNumber}`,
      caller_node: callerNode.id,
      target_node: targetNodeId,
      call_details: {
        method_name: methodName,
        signature: this.buildSignature(methodName, parsedArgs),
        location: {
          file: callerNode.source?.file || '',
          line: lineNumber,
          column: fullLine.indexOf(methodName)
        },
        call_type: this.determineCallType(methodName, objectContext),
        resolution_type: targetNodeId ? 'static' : 'external'
      },
      execution_context: {
        is_async: this.isAsyncCall(fullLine),
        is_conditional: this.isInConditional(fullLine),
        is_in_loop: this.isInLoop(fullLine),
        is_recursive: this.isRecursiveCall(methodName, callerNode.name),
        call_depth: this.callDepthMap.get(callerNode.id) || 0,
        conditional_depth: this.conditionalDepthMap.get(callerNode.id) || 0,
        loop_depth: this.loopDepthMap.get(callerNode.id) || 0,
        enclosing_function: callerNode.name,
        enclosing_class: this.findEnclosingClass(callerNode)
      },
      arguments: parsedArgs,
      performance_hints: {
        is_hot_path: this.isHotPath(methodName),
        is_potential_bottleneck: this.isPotentialBottleneck(methodName, parsedArgs),
        is_critical_path: this.isCriticalPath(methodName)
      }
    };


    if (!targetNodeId) {
      call.external_details = this.createExternalDetails(methodName, objectContext);
    }


    const frameworkInfo = this.detectFrameworkSemantics(methodName, fullLine, callerNode);
    if (frameworkInfo) {
      call.framework_semantics = frameworkInfo;
    }

    return call;
  }




  private createExternalCall(
    functionName: string,
    argsStr: string,
    lineNumber: number,
    callerNode: CASNode,
    fullLine: string,
    crateName: string,
    moduleName: string
  ): CASMethodCall | null {
    const parsedArgs = this.parseArguments(argsStr);

    const call: CASMethodCall = {
      id: `call_${callerNode.id}_to_${crateName}_${moduleName}_${functionName}_${lineNumber}`,
      caller_node: callerNode.id,
      target_node: undefined,
      call_details: {
        method_name: functionName,
        signature: this.buildSignature(functionName, parsedArgs),
        location: {
          file: callerNode.source?.file || '',
          line: lineNumber,
          column: fullLine.indexOf(functionName)
        },
        call_type: 'direct',
        resolution_type: 'external'
      },
      execution_context: {
        is_async: this.isAsyncCall(fullLine),
        is_conditional: this.isInConditional(fullLine),
        is_in_loop: this.isInLoop(fullLine),
        is_recursive: false,
        call_depth: this.callDepthMap.get(callerNode.id) || 0,
        conditional_depth: this.conditionalDepthMap.get(callerNode.id) || 0,
        loop_depth: this.loopDepthMap.get(callerNode.id) || 0,
        enclosing_function: callerNode.name,
        enclosing_class: this.findEnclosingClass(callerNode)
      },
      arguments: parsedArgs,
      external_details: {
        library: crateName,
        module: moduleName,
        is_builtin: this.isBuiltinCrate(crateName),
        is_sdk: this.isStdCrate(crateName)
      },
      performance_hints: {
        is_hot_path: false,
        is_potential_bottleneck: this.isPotentialExternalBottleneck(crateName, functionName),
        is_critical_path: false
      }
    };

    return call;
  }




  private parseArguments(argsStr: string): Array<{ position: number; type?: string; value?: string; is_literal: boolean; is_variable: boolean }> {
    if (!argsStr.trim()) return [];

    const args = argsStr.split(',').map(arg => arg.trim());
    return args.map((arg, index) => ({
      position: index,
      is_literal: this.isLiteral(arg),
      is_variable: !this.isLiteral(arg),
      value: arg,
      type: this.inferType(arg)
    }));
  }




  private resolveMethodTarget(methodName: string, objectContext?: string): string | undefined {

    const targetId = this.methodToNodeMap.get(methodName);
    if (targetId) return targetId;


    if (objectContext) {
      const objectNodeId = this.methodToNodeMap.get(objectContext);
      if (objectNodeId) {

        const structNode = this.nodes.find(n => n.id === objectNodeId);
        if (structNode) {
          const methodId = `${structNode.id}_${methodName}`;
          const methodNode = this.nodes.find(n => n.id === methodId);
          if (methodNode) return methodNode.id;
        }
      }
    }

    return undefined;
  }




  private determineCallType(methodName: string, objectContext?: string): 'direct' | 'method' | 'constructor' | 'abstract' | 'interface' | 'callback' | 'hook' | 'dynamic' {
    if (methodName === 'new' || objectContext?.startsWith(methodName)) return 'constructor';
    if (objectContext) return 'method';
    if (methodName.startsWith('on_') || methodName.endsWith('_handler')) return 'callback';
    if (methodName.includes('_hook')) return 'hook';
    return 'direct';
  }




  private createExternalDetails(methodName: string, objectContext?: string): any {
    const isBuiltin = this.isBuiltinMethod(methodName);
    const isStdLibrary = this.isStdLibraryMethod(methodName);

    return {
      library: objectContext || 'unknown',
      module: 'unknown',
      is_builtin: isBuiltin,
      is_sdk: isStdLibrary
    };
  }




  private buildSignature(methodName: string, args: any[]): string {
    const argsStr = args.map(arg => arg.type || arg.value || 'unknown').join(', ');
    return `${methodName}(${argsStr})`;
  }




  private detectFrameworkSemantics(methodName: string, fullLine: string, callerNode: CASNode): any {

    if (fullLine.includes('HttpResponse')) {
      return {
        framework: 'actix-web',
        semantic_meaning: 'HTTP response generation',
        affects_runtime: true
      };
    }


    if (methodName.includes('save') || methodName.includes('update') || methodName.includes('delete')) {
      return {
        framework: 'database',
        semantic_meaning: 'Database operation',
        affects_runtime: true
      };
    }


    if (methodName === 'spawn' || methodName === 'tokio::spawn') {
      return {
        framework: 'tokio',
        semantic_meaning: 'Async task spawning',
        affects_runtime: true
      };
    }

    return null;
  }


  private isAsyncCall(line: string): boolean {
    return line.includes('.await') || line.includes('async ') || line.includes('tokio::');
  }

  private isInConditional(line: string): boolean {
    return line.includes('if ') || line.includes('match ') || line.includes('return if');
  }

  private isInLoop(line: string): boolean {
    return line.includes('for ') || line.includes('while ') || line.includes('loop ');
  }

  private isRecursiveCall(methodName: string, callerName: string): boolean {
    return methodName === callerName;
  }

  private isHotPath(methodName: string): boolean {
    const hotPathMethods = ['handle', 'process', 'execute', 'run'];
    return hotPathMethods.some(hot => methodName.toLowerCase().includes(hot));
  }

  private isPotentialBottleneck(methodName: string, _args: any[]): boolean {
    const bottleneckKeywords = ['load', 'save', 'query', 'fetch', 'calculate'];
    return bottleneckKeywords.some(keyword => methodName.toLowerCase().includes(keyword));
  }

  private isCriticalPath(methodName: string): boolean {
    const criticalKeywords = ['validate', 'authenticate', 'authorize'];
    return criticalKeywords.some(keyword => methodName.toLowerCase().includes(keyword));
  }

  private isLiteral(arg: string): boolean {
    return /^".*"$/.test(arg) || /^\d+(\.\d+)?$/.test(arg) || /^(true|false)$/.test(arg);
  }

  private inferType(arg: string): string | undefined {
    if (/^".*"$/.test(arg)) return 'string';
    if (/^\d+$/.test(arg)) return 'integer';
    if (/^\d+\.\d+$/.test(arg)) return 'float';
    if (/^(true|false)$/.test(arg)) return 'boolean';
    return undefined;
  }

  private isBuiltinMethod(methodName: string): boolean {
    const builtins = ['to_string', 'clone', 'into', 'expect', 'unwrap', 'len', 'push', 'pop'];
    return builtins.includes(methodName);
  }

  private isStdLibraryMethod(methodName: string): boolean {
    const stdMethods = ['println', 'eprintln', 'format', 'dbg'];
    return stdMethods.includes(methodName);
  }

  private isBuiltinCrate(crateName: string): boolean {
    const builtins = ['core', 'alloc', 'std'];
    return builtins.includes(crateName);
  }

  private isStdCrate(crateName: string): boolean {
    const stdCrates = ['std', 'core', 'alloc'];
    return stdCrates.includes(crateName);
  }

  private isPotentialExternalBottleneck(crateName: string, functionName: string): boolean {
    const bottleneckCrates = ['reqwest', 'sqlx', 'diesel', 'tokio'];
    return bottleneckCrates.includes(crateName);
  }

  private findEnclosingClass(node: CASNode): string | undefined {

    const parentNode = this.nodes.find(n => n.id === node.parent);
    return parentNode?.type === 'struct' ? parentNode.name : undefined;
  }




  private buildCallChains(): CASCallChain[] {
    const chains: CASCallChain[] = [];
    const entryPoints = this.nodes.filter(n =>
      (n.metadata as any)?.is_entry_point ||
      n.tags?.includes('entry-point') ||
      n.name === 'main'
    );

    entryPoints.forEach(entryPoint => {
      const chain = this.buildChainFromEntryPoint(entryPoint);
      if (chain) {
        chains.push(chain);
      }
    });

    return chains;
  }




  private buildChainFromEntryPoint(entryPoint: CASNode): CASCallChain | null {
    const callsFromEntry = this.methodCalls.filter(call => call.caller_node === entryPoint.id);

    if (callsFromEntry.length === 0) return null;

    const callPath = this.traceCallPath(entryPoint.id);

    return {
      id: `chain_from_${entryPoint.id}`,
      chain_type: 'entry-to-exit',
      entry_point: {
        node_id: entryPoint.id,
        method_name: entryPoint.name,
        entry_point_id: (entryPoint.metadata as any)?.entry_point_id
      },
      call_path: callPath,
      characteristics: {
        total_calls: callPath.length,
        max_depth: Math.max(...callPath.map(p => p.depth)),
        has_external_calls: callPath.some(p => {
          const call = this.methodCalls.find(c => c.id === p.call_id);
          return call?.external_details !== undefined;
        }),
        has_database_calls: callPath.some(p => {
          const call = this.methodCalls.find(c => c.id === p.call_id);
          return call?.external_details?.library?.includes('sqlx') ||
                 call?.external_details?.library?.includes('diesel');
        }),
        has_async_calls: callPath.some(p => {
          const call = this.methodCalls.find(c => c.id === p.call_id);
          return call?.execution_context?.is_async;
        }),
        is_circular: this.hasCircularCall(callPath),
        is_recursive: this.hasRecursiveCall(callPath),
        complexity_score: this.calculateComplexityScore(callPath)
      },
      risk_analysis: {
        risk_level: 'low',
        risk_factors: []
      }
    };
  }




  private traceCallPath(entryPointId: string): Array<{ call_id: string; node_id: string; method_name: string; depth: number }> {
    const path: Array<{ call_id: string; node_id: string; method_name: string; depth: number }> = [];
    const visited = new Set<string>();

    this.traceCallsRecursive(entryPointId, 0, path, visited);

    return path;
  }




  private traceCallsRecursive(nodeId: string, depth: number, path: any[], visited: Set<string>): void {
    if (visited.has(nodeId) || depth > 10) return;

    visited.add(nodeId);

    const callsFromNode = this.methodCalls.filter(call => call.caller_node === nodeId);

    callsFromNode.forEach(call => {
      const targetNode = this.nodes.find(n => n.id === call.target_node);
      if (targetNode) {
        path.push({
          call_id: call.id,
          node_id: targetNode.id,
          method_name: call.call_details.method_name,
          depth
        });

        this.traceCallsRecursive(targetNode.id, depth + 1, path, visited);
      }
    });
  }




  private buildEnhancedEdges(): CASEdge[] {
    const edges: CASEdge[] = [];

    this.methodCalls.forEach(call => {
      if (call.target_node) {

        edges.push({
          id: `edge_${call.id}`,
          source: call.caller_node,
          target: call.target_node,
          type: 'calls',
          metadata: {
            async: call.execution_context.is_async,
            attributes: {
              analyzer: 'rust-call-graph-extractor',
              call_type: call.call_details.call_type,
              external: call.external_details !== undefined
            }
          }
        });
      }
    });

    return edges;
  }


  private hasCircularCall(path: any[]): boolean {
    const nodeIds = path.map(p => p.node_id);
    return new Set(nodeIds).size !== nodeIds.length;
  }

  private hasRecursiveCall(path: any[]): boolean {
    return path.some((p, index) =>
      path.slice(index + 1).some(p2 => p2.node_id === p.node_id)
    );
  }

  private calculateComplexityScore(path: any[]): number {
    let score = 0;

    this.methodCalls.forEach(call => {
      if (call.execution_context.is_async) score += 1;
      if (call.execution_context.is_in_loop) score += 2;
      if (call.execution_context.is_conditional) score += 1;
      if (call.external_details) score += 1;
    });

    return score;
  }
}