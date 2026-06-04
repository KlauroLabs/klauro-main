import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { FunctionCall } from '../../database/entities/function-call.entity';
import { CallChain } from '../../database/entities/call-chain.entity';
import { Component } from '../../database/entities/component.entity';
import { AnalysisRun } from '../../database/entities/analysis-run.entity';
import { ExtractedFunction, ExtractedCall } from '../enhanced-call-graph-extractor';

@Injectable()
export class FunctionCallService {
  private readonly logger = new Logger(FunctionCallService.name);

  constructor(
    @InjectRepository(FunctionCall)
    private readonly functionCallRepository: EntityRepository<FunctionCall>,
    @InjectRepository(CallChain)
    private readonly callChainRepository: EntityRepository<CallChain>,
    @InjectRepository(Component)
    private readonly componentRepository: EntityRepository<Component>,
    private readonly em: EntityManager
  ) {}

  async storeFunctionCalls(
    analysisRunId: string,
    functions: ExtractedFunction[],
    componentMap: Map<string, Component>
  ): Promise<void> {
    const analysisRun = await this.em.findOneOrFail(AnalysisRun, { id: analysisRunId });
    const functionCallMap = new Map<string, FunctionCall>();

    // Process all functions and their calls
    for (const func of functions) {
      const callerComponent = componentMap.get(func.file);
      if (!callerComponent) {
        this.logger.warn(`Component not found for file: ${func.file}`);
        continue;
      }

      for (const call of func.calls) {
        const functionCall = await this.createFunctionCall(
          analysisRun,
          callerComponent,
          func,
          call,
          componentMap
        );

        if (functionCall) {
          const key = this.generateCallKey(functionCall);
          functionCallMap.set(key, functionCall);
        }
      }
    }

    // Persist all function calls
    if (functionCallMap.size > 0) {
      await this.em.persistAndFlush(Array.from(functionCallMap.values()));
      this.logger.log(`Stored ${functionCallMap.size} function calls`);
    }

    // Build and store call chains
    await this.buildAndStoreCallChains(analysisRun, functionCallMap, componentMap);
  }

  private async createFunctionCall(
    analysisRun: AnalysisRun,
    callerComponent: Component,
    func: ExtractedFunction,
    call: ExtractedCall,
    componentMap: Map<string, Component>
  ): Promise<FunctionCall | null> {
    try {
      const targetComponent = this.resolveTargetComponent(call, componentMap);

      const functionCallData = {
        analysisRun,
        callerComponent,
        callerFunction: func.name,
        callerSignature: func.signature,
        targetComponent,
        targetFunction: call.target,
        targetSignature: call.resolvedTarget?.functionName,
        line: call.line,
        column: call.column,
        callLocation: `${call.line}:${call.column}`,
        callType: this.determineCallType(call),
        argumentCount: call.argumentCount,
        isAsync: call.isAsync,
        isConditional: call.isConditional,
        isInLoop: call.isInLoop,
        isRecursive: func.name === call.target,
        context: this.extractContext(call),
        depth: call.context.blockDepth,
        frequency: 1,
        isPotentialBottleneck: false,
        isHotPath: false,
        metadata: {
          parentFunction: call.context.enclosingFunction,
          enclosingClass: call.context.enclosingClass,
          isEventHandler: func.name.startsWith('on') || func.name.startsWith('handle'),
          isLifecycleHook: this.isLifecycleHook(func.name),
          isUtilityCall: this.isUtilityCall(call.target),
          framework: this.detectFramework(call.target),
          tags: this.generateTags(func, call)
        }
      };

      const functionCall = this.functionCallRepository.create(functionCallData as any);

      // Analyze for performance hints
      if (call.isInLoop && call.targetType !== 'external') {
        functionCall.isPotentialBottleneck = true;
      }

      return functionCall;
    } catch (error) {
      this.logger.error(`Error creating function call: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async buildAndStoreCallChains(
    analysisRun: AnalysisRun,
    functionCallMap: Map<string, FunctionCall>,
    componentMap: Map<string, Component>
  ): Promise<void> {
    const chains = new Map<string, CallChain>();
    const visited = new Set<string>();

    // Find entry points
    const entryPoints = this.findEntryPoints(functionCallMap);

    for (const entry of entryPoints) {
      const chain = await this.buildCallChain(
        entry,
        functionCallMap,
        visited,
        analysisRun
      );

      if (chain && chain.length > 1) {
        const chainId = this.generateChainId(chain);
        if (!chains.has(chainId)) {
          const callChain = await this.createCallChainEntity(
            chain,
            analysisRun,
            functionCallMap,
            componentMap
          );
          chains.set(chainId, callChain);
        }
      }
    }

    // Find circular dependencies
    const circularChains = this.findCircularDependencies(functionCallMap);
    for (const circular of circularChains) {
      const chainId = `circular_${this.generateChainId(circular)}`;
      if (!chains.has(chainId)) {
        const callChain = await this.createCallChainEntity(
          circular,
          analysisRun,
          functionCallMap,
          componentMap,
          'circular'
        );
        chains.set(chainId, callChain);
      }
    }

    // Find hot paths (frequently called chains)
    const hotPaths = this.identifyHotPaths(functionCallMap);
    for (const hotPath of hotPaths) {
      const chainId = `hot_${this.generateChainId(hotPath)}`;
      if (!chains.has(chainId)) {
        const callChain = await this.createCallChainEntity(
          hotPath,
          analysisRun,
          functionCallMap,
          componentMap,
          'hot-path'
        );
        chains.set(chainId, callChain);
      }
    }

    if (chains.size > 0) {
      await this.em.persistAndFlush(Array.from(chains.values()));
      this.logger.log(`Stored ${chains.size} call chains`);
    }
  }

  private async buildCallChain(
    startCall: FunctionCall,
    callMap: Map<string, FunctionCall>,
    visited: Set<string>,
    analysisRun: AnalysisRun,
    maxDepth: number = 50
  ): Promise<FunctionCall[]> {
    const chain: FunctionCall[] = [];
    const queue: Array<{ call: FunctionCall; depth: number }> = [{ call: startCall, depth: 0 }];

    while (queue.length > 0) {
      const { call, depth } = queue.shift()!;

      if (depth > maxDepth) break;

      const callKey = this.generateCallKey(call);
      if (visited.has(callKey)) continue;

      visited.add(callKey);
      chain.push(call);

      // Find all calls made by the target function
      const nextCalls = Array.from(callMap.values()).filter(fc =>
        fc.callerFunction === call.targetFunction &&
        fc.callerComponent.id === (call.targetComponent?.id || call.callerComponent.id)
      );

      for (const nextCall of nextCalls) {
        queue.push({ call: nextCall, depth: depth + 1 });
      }
    }

    return chain;
  }

  private async createCallChainEntity(
    chain: FunctionCall[],
    analysisRun: AnalysisRun,
    functionCallMap: Map<string, FunctionCall>,
    componentMap: Map<string, Component>,
    type?: CallChain['chainType']
  ): Promise<CallChain> {
    const entryCall = chain[0];
    const exitCall = chain[chain.length - 1];

    const componentIds = new Set<string>();
    const functionNames = new Set<string>();
    let hasExternalCalls = false;
    let hasDatabaseCalls = false;
    let hasAsyncCalls = false;
    let totalComplexity = 0;

    const path = chain.map((call, index) => {
      componentIds.add(call.callerComponent.id);
      functionNames.add(call.callerFunction);
      functionNames.add(call.targetFunction);

      if (call.isExternal) hasExternalCalls = true;
      if (call.metadata?.tags?.includes('database')) hasDatabaseCalls = true;
      if (call.isAsync) hasAsyncCalls = true;
      totalComplexity += call.complexity;

      return {
        componentId: call.callerComponent.id,
        componentName: call.callerComponent.name,
        functionName: call.callerFunction,
        line: call.line,
        callType: call.callType,
        depth: index
      };
    });

    const chainType = type || this.determineChainType(chain);
    const riskLevel = this.calculateRiskLevel(chain);
    const riskFactors = this.identifyRiskFactors(chain);
    const bottlenecks = this.identifyBottlenecks(chain);

    const callChainData = {
      analysisRun,
      chainId: this.generateChainId(chain),
      chainType,
      entryComponent: entryCall.callerComponent,
      entryFunction: entryCall.callerFunction,
      exitComponent: exitCall.targetComponent,
      exitFunction: exitCall.targetFunction,
      path,
      length: chain.length,
      maxDepth: Math.max(...chain.map(c => c.depth)),
      frequency: chain.reduce((sum, c) => sum + c.frequency, 0),
      isCircular: chainType === 'circular',
      isRecursive: chain.some(c => c.isRecursive),
      isCritical: riskLevel === 'high' || riskLevel === 'critical',
      isHotPath: chainType === 'hot-path',
      hasExternalCalls,
      hasDatabaseCalls,
      hasAsyncCalls,
      componentIds: Array.from(componentIds),
      componentCount: componentIds.size,
      functionNames: Array.from(functionNames),
      uniqueFunctionCount: functionNames.size,
      complexity: totalComplexity,
      riskLevel,
      riskFactors,
      bottlenecks,
      metadata: {
        frameworks: this.extractFrameworks(chain),
        patterns: this.detectPatterns(chain),
        recommendations: this.generateRecommendations(chain)
      }
    };

    return this.callChainRepository.create(callChainData as any);
  }

  // Helper methods
  private resolveTargetComponent(call: ExtractedCall, componentMap: Map<string, Component>): Component | undefined {
    if (call.resolvedTarget?.file) {
      return componentMap.get(call.resolvedTarget.file);
    }
    return undefined;
  }

  private determineCallType(call: ExtractedCall): FunctionCall['callType'] {
    if (call.targetType === 'constructor') return 'direct';
    if (call.isAsync) return 'async';
    if (call.target.startsWith('use')) return 'hook';
    if (call.targetType === 'method') return 'method';
    if (call.context.isInCallback) return 'callback';
    return 'direct';
  }

  private extractContext(call: ExtractedCall): string {
    const contexts: string[] = [];
    if (call.context.isInTry) contexts.push('error-handling');
    if (call.context.isInCallback) contexts.push('callback');
    if (call.context.isInPromise) contexts.push('async');
    if (call.isConditional) contexts.push('conditional');
    if (call.isInLoop) contexts.push('loop');
    return contexts.join(', ') || 'normal';
  }

  private isLifecycleHook(name: string): boolean {
    const hooks = ['componentDidMount', 'componentWillUnmount', 'useEffect', 'ngOnInit', 'ngOnDestroy', 'mounted', 'destroyed'];
    return hooks.some(hook => name.includes(hook));
  }

  private isUtilityCall(target: string): boolean {
    const utilities = ['lodash', 'underscore', 'moment', 'dayjs', 'axios', 'fetch'];
    return utilities.some(util => target.includes(util));
  }

  private detectFramework(target: string): string | undefined {
    if (target.includes('React') || target.startsWith('use')) return 'react';
    if (target.includes('ng')) return 'angular';
    if (target.includes('Vue')) return 'vue';
    if (target.includes('express')) return 'express';
    return undefined;
  }

  private generateTags(func: ExtractedFunction, call: ExtractedCall): string[] {
    const tags: string[] = [];
    if (func.isAsync) tags.push('async');
    if (func.isGenerator) tags.push('generator');
    if (call.isInLoop) tags.push('loop');
    if (call.isConditional) tags.push('conditional');
    if (call.targetType === 'external') tags.push('external');
    if (call.resolvedTarget?.isBuiltin) tags.push('builtin');
    return tags;
  }

  private generateCallKey(call: FunctionCall): string {
    return `${call.callerComponent.id}::${call.callerFunction}::${call.targetFunction}::${call.callLocation}`;
  }

  private generateChainId(chain: FunctionCall[]): string {
    const path = chain.map(c => `${c.callerFunction}->${c.targetFunction}`).join('::');
    return Buffer.from(path).toString('base64').substring(0, 20);
  }

  private findEntryPoints(callMap: Map<string, FunctionCall>): FunctionCall[] {
    const calledFunctions = new Set<string>();
    for (const call of callMap.values()) {
      calledFunctions.add(`${call.targetComponent?.id || 'external'}::${call.targetFunction}`);
    }

    const entryPoints: FunctionCall[] = [];
    for (const call of callMap.values()) {
      const callerId = `${call.callerComponent.id}::${call.callerFunction}`;
      if (!calledFunctions.has(callerId)) {
        entryPoints.push(call);
      }
    }

    return entryPoints;
  }

  private findCircularDependencies(callMap: Map<string, FunctionCall>): FunctionCall[][] {
    const circles: FunctionCall[][] = [];
    const visited = new Set<string>();

    for (const call of callMap.values()) {
      const path: FunctionCall[] = [];
      if (this.detectCircle(call, callMap, path, visited)) {
        circles.push(path);
      }
    }

    return circles;
  }

  private detectCircle(
    start: FunctionCall,
    callMap: Map<string, FunctionCall>,
    path: FunctionCall[],
    visited: Set<string>
  ): boolean {
    const key = this.generateCallKey(start);

    if (path.some(c => this.generateCallKey(c) === key)) {
      return true; // Circle detected
    }

    if (visited.has(key)) {
      return false;
    }

    path.push(start);
    visited.add(key);

    const nextCalls = Array.from(callMap.values()).filter(c =>
      c.callerFunction === start.targetFunction &&
      c.callerComponent.id === (start.targetComponent?.id || start.callerComponent.id)
    );

    for (const next of nextCalls) {
      if (this.detectCircle(next, callMap, [...path], visited)) {
        return true;
      }
    }

    return false;
  }

  private identifyHotPaths(callMap: Map<string, FunctionCall>): FunctionCall[][] {
    const hotPaths: FunctionCall[][] = [];
    const frequencyMap = new Map<string, number>();

    // Count call frequencies
    for (const call of callMap.values()) {
      const key = `${call.callerFunction}->${call.targetFunction}`;
      frequencyMap.set(key, (frequencyMap.get(key) || 0) + 1);
    }

    // Find paths with high frequency
    const threshold = Math.max(3, Array.from(frequencyMap.values()).sort((a, b) => b - a)[0] * 0.7);

    for (const [key, frequency] of frequencyMap) {
      if (frequency >= threshold) {
        const calls = Array.from(callMap.values()).filter(c =>
          `${c.callerFunction}->${c.targetFunction}` === key
        );
        if (calls.length > 0) {
          hotPaths.push(calls);
        }
      }
    }

    return hotPaths;
  }

  private determineChainType(chain: FunctionCall[]): CallChain['chainType'] {
    if (chain.some(c => c.isRecursive)) return 'recursive';
    if (chain[0].callerFunction === chain[chain.length - 1].targetFunction) return 'circular';
    if (chain.length > 20) return 'critical-path';
    if (!chain[chain.length - 1].targetComponent) return 'dead-end';
    return 'entry-to-exit';
  }

  private calculateRiskLevel(chain: FunctionCall[]): 'low' | 'medium' | 'high' | 'critical' {
    let score = 0;

    score += chain.length > 10 ? 2 : chain.length > 5 ? 1 : 0;
    score += chain.filter(c => c.isInLoop).length;
    score += chain.filter(c => c.isRecursive).length * 2;
    score += chain.filter(c => c.isPotentialBottleneck).length * 2;
    score += chain.some(c => c.isExternal) ? 1 : 0;

    if (score >= 8) return 'critical';
    if (score >= 5) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }

  private identifyRiskFactors(chain: FunctionCall[]): string[] {
    const factors: string[] = [];

    if (chain.length > 10) factors.push('Long call chain');
    if (chain.some(c => c.isRecursive)) factors.push('Contains recursion');
    if (chain.filter(c => c.isInLoop).length > 2) factors.push('Multiple loop calls');
    if (chain.filter(c => c.isExternal).length > 3) factors.push('Many external dependencies');
    if (chain.some(c => c.isPotentialBottleneck)) factors.push('Potential performance bottleneck');

    return factors;
  }

  private identifyBottlenecks(chain: FunctionCall[]): any[] {
    const bottlenecks: any[] = [];

    for (const call of chain) {
      if (call.isPotentialBottleneck) {
        bottlenecks.push({
          componentId: call.callerComponent.id,
          functionName: call.callerFunction,
          reason: call.isInLoop ? 'Called in loop' : 'Complex operation',
          impact: call.isHotPath ? 'high' : 'medium'
        });
      }
    }

    return bottlenecks;
  }

  private extractFrameworks(chain: FunctionCall[]): string[] {
    const frameworks = new Set<string>();
    for (const call of chain) {
      if (call.metadata?.framework) {
        frameworks.add(call.metadata.framework);
      }
    }
    return Array.from(frameworks);
  }

  private detectPatterns(chain: FunctionCall[]): string[] {
    const patterns: string[] = [];

    // Detect common patterns
    if (chain.some(c => c.callerFunction.includes('Controller') && c.targetFunction.includes('Service'))) {
      patterns.push('MVC');
    }
    if (chain.filter(c => c.isAsync).length > chain.length / 2) {
      patterns.push('Async/Await');
    }
    if (chain.some(c => c.targetFunction.startsWith('use'))) {
      patterns.push('React Hooks');
    }
    if (chain.some(c => c.metadata?.isEventHandler)) {
      patterns.push('Event-Driven');
    }

    return patterns;
  }

  private generateRecommendations(chain: FunctionCall[]): string[] {
    const recommendations: string[] = [];

    if (chain.length > 15) {
      recommendations.push('Consider refactoring to reduce call chain depth');
    }
    if (chain.filter(c => c.isInLoop).length > 3) {
      recommendations.push('Optimize loop operations to improve performance');
    }
    if (chain.some(c => c.isRecursive)) {
      recommendations.push('Review recursive calls for potential stack overflow');
    }
    if (chain.filter(c => c.isExternal).length > 5) {
      recommendations.push('Consider caching external API calls');
    }

    return recommendations;
  }

  // Query methods for API
  async getCallChainsForComponent(componentId: string): Promise<CallChain[]> {
    return this.callChainRepository.find({
      componentIds: { $contains: componentId }
    });
  }

  async getFunctionCallsForFunction(componentId: string, functionName: string): Promise<{
    callers: FunctionCall[];
    callees: FunctionCall[];
  }> {
    const callers = await this.functionCallRepository.find({
      targetComponent: componentId,
      targetFunction: functionName
    });

    const callees = await this.functionCallRepository.find({
      callerComponent: componentId,
      callerFunction: functionName
    });

    return { callers, callees };
  }

  async getHotPaths(analysisRunId: string): Promise<CallChain[]> {
    return this.callChainRepository.find({
      analysisRun: analysisRunId,
      isHotPath: true
    });
  }

  async getCriticalPaths(analysisRunId: string): Promise<CallChain[]> {
    return this.callChainRepository.find({
      analysisRun: analysisRunId,
      isCritical: true
    });
  }

  async getCallChainById(chainId: string): Promise<CallChain | null> {
    return this.callChainRepository.findOne({ chainId });
  }

  async getCallStatistics(analysisRunId: string): Promise<any> {
    const functionCalls = await this.functionCallRepository.find({ analysisRun: analysisRunId });
    const callChains = await this.callChainRepository.find({ analysisRun: analysisRunId });

    const functionCallCounts = new Map<string, number>();
    const callingFunctionCounts = new Map<string, number>();

    for (const call of functionCalls) {
      const targetKey = `${call.targetComponent?.name || 'external'}::${call.targetFunction}`;
      functionCallCounts.set(targetKey, (functionCallCounts.get(targetKey) || 0) + 1);

      const callerKey = `${call.callerComponent.name}::${call.callerFunction}`;
      callingFunctionCounts.set(callerKey, (callingFunctionCounts.get(callerKey) || 0) + 1);
    }

    const topCalledFunctions = Array.from(functionCallCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([func, count]) => ({ function: func, callCount: count }));

    const topCallingFunctions = Array.from(callingFunctionCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([func, count]) => ({ function: func, callCount: count }));

    const chainLengths = callChains.map(c => c.length);
    const averageChainLength = chainLengths.length > 0
      ? chainLengths.reduce((a, b) => a + b, 0) / chainLengths.length
      : 0;

    return {
      totalFunctionCalls: functionCalls.length,
      totalCallChains: callChains.length,
      uniqueFunctions: new Set([...functionCallCounts.keys(), ...callingFunctionCounts.keys()]).size,
      averageChainLength: Math.round(averageChainLength * 10) / 10,
      maxChainDepth: Math.max(...callChains.map(c => c.maxDepth), 0),
      circularDependencies: callChains.filter(c => c.isCircular).length,
      hotPaths: callChains.filter(c => c.isHotPath).length,
      criticalPaths: callChains.filter(c => c.isCritical).length,
      externalCalls: functionCalls.filter(c => !c.targetComponent).length,
      asyncCalls: functionCalls.filter(c => c.isAsync).length,
      recursiveCalls: functionCalls.filter(c => c.isRecursive).length,
      topCalledFunctions,
      topCallingFunctions
    };
  }

  async getCallGraph(analysisRunId: string, maxDepth: number, includeExternal: boolean): Promise<any> {
    const functionCalls = await this.functionCallRepository.find(
      { analysisRun: analysisRunId },
      { populate: ['callerComponent', 'targetComponent'] }
    );

    const nodes = new Map<string, any>();
    const edges: any[] = [];

    for (const call of functionCalls) {
      if (!includeExternal && !call.targetComponent) continue;
      if (call.depth > maxDepth) continue;

      const callerId = `${call.callerComponent.id}::${call.callerFunction}`;
      const targetId = call.targetComponent
        ? `${call.targetComponent.id}::${call.targetFunction}`
        : `external::${call.targetFunction}`;

      if (!nodes.has(callerId)) {
        nodes.set(callerId, {
          id: callerId,
          label: call.callerFunction,
          type: 'function',
          component: call.callerComponent.name,
          complexity: call.callerComponent.complexity || 0,
          isEntry: false,
          isExit: false
        });
      }

      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          label: call.targetFunction,
          type: call.targetComponent ? 'function' : 'external',
          component: call.targetComponent?.name || 'External',
          complexity: call.targetComponent?.complexity || 0,
          isEntry: false,
          isExit: !call.targetComponent
        });
      }

      edges.push({
        from: callerId,
        to: targetId,
        type: call.callType,
        count: call.frequency,
        isAsync: call.isAsync,
        isConditional: call.isConditional
      });
    }

    // Mark entry points
    const calledFunctions = new Set(edges.map(e => e.to));
    for (const node of nodes.values()) {
      if (!calledFunctions.has(node.id)) {
        node.isEntry = true;
      }
    }

    return {
      nodes: Array.from(nodes.values()),
      edges
    };
  }

  async getEntryPoints(analysisRunId: string): Promise<any[]> {
    const callChains = await this.callChainRepository.find(
      { analysisRun: analysisRunId },
      { populate: ['entryComponent'] }
    );

    const entryPoints = new Map<string, any>();

    for (const chain of callChains) {
      const key = `${chain.entryComponent.id}::${chain.entryFunction}`;
      if (!entryPoints.has(key)) {
        entryPoints.set(key, {
          component: chain.entryComponent.name,
          function: chain.entryFunction,
          chainCount: 0,
          isHotPath: false,
          isCritical: false
        });
      }

      const entry = entryPoints.get(key)!;
      entry.chainCount++;
      if (chain.isHotPath) entry.isHotPath = true;
      if (chain.isCritical) entry.isCritical = true;
    }

    return Array.from(entryPoints.values()).sort((a, b) => b.chainCount - a.chainCount);
  }

  async getExitPoints(analysisRunId: string): Promise<any[]> {
    const functionCalls = await this.functionCallRepository.find(
      {
        analysisRun: analysisRunId,
        targetComponent: null
      },
      { populate: ['callerComponent'] }
    );

    const exitPoints = new Map<string, any>();

    for (const call of functionCalls) {
      const key = `${call.callerComponent.id}::${call.callerFunction}`;
      if (!exitPoints.has(key)) {
        exitPoints.set(key, {
          component: call.callerComponent.name,
          function: call.callerFunction,
          externalCalls: [],
          totalCalls: 0
        });
      }

      const exit = exitPoints.get(key)!;
      if (!exit.externalCalls.includes(call.targetFunction)) {
        exit.externalCalls.push(call.targetFunction);
      }
      exit.totalCalls++;
    }

    return Array.from(exitPoints.values()).sort((a, b) => b.totalCalls - a.totalCalls);
  }

  async getBottlenecks(analysisRunId: string): Promise<any[]> {
    const callChains = await this.callChainRepository.find({
      analysisRun: analysisRunId,
      bottlenecks: { $ne: null }
    });

    const bottleneckMap = new Map<string, any>();

    for (const chain of callChains) {
      for (const bottleneck of (chain.bottlenecks || [])) {
        const key = `${bottleneck.componentId}::${bottleneck.functionName}`;

        if (!bottleneckMap.has(key)) {
          bottleneckMap.set(key, {
            component: bottleneck.componentId,
            function: bottleneck.functionName,
            reason: bottleneck.reason,
            impact: bottleneck.impact,
            occurrences: 0,
            recommendations: new Set<string>()
          });
        }

        const b = bottleneckMap.get(key)!;
        b.occurrences++;
        if (chain.metadata?.recommendations) {
          for (const rec of chain.metadata.recommendations) {
            b.recommendations.add(rec);
          }
        }
      }
    }

    return Array.from(bottleneckMap.values()).map(b => ({
      ...b,
      recommendations: Array.from(b.recommendations)
    })).sort((a, b) => {
      const impactOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
      return (impactOrder[b.impact] || 0) - (impactOrder[a.impact] || 0);
    });
  }
}