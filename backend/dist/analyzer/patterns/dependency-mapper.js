"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependencyMapper = void 0;
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
const parser = __importStar(require("@babel/parser"));
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
class DependencyMapper {
    constructor() {
        this.componentMap = new Map();
        this.fileContentCache = new Map();
        this.astCache = new Map();
        this.projectPath = '';
        this.graph = {
            nodes: new Map(),
            edges: new Map(),
            layers: [],
            cycles: [],
            transitiveDepth: new Map(),
            criticalPaths: [],
            clusters: []
        };
    }
    async mapDependencies(components, projectPath) {
        const span = telemetry_schema_1.telemetry.createSpan('mapDependencies');
        this.projectPath = projectPath;
        for (const component of components) {
            this.componentMap.set(component.path, component);
        }
        await this.buildDependencyNodes(components);
        await this.analyzeDependencies();
        this.calculateLayers();
        this.detectCycles();
        this.calculateTransitiveDependencies();
        this.identifyCriticalPaths();
        this.performClusterAnalysis();
        this.calculateMetrics();
        telemetry_schema_1.telemetry.emit({
            type: 'dependency_detected',
            source: { analyzer: 'dependency-mapper' },
            data: {
                nodeCount: this.graph.nodes.size,
                edgeCount: Array.from(this.graph.edges.values()).flat().length,
                cycleCount: this.graph.cycles.length,
                layerCount: this.graph.layers.length,
                criticalPathCount: this.graph.criticalPaths.length
            }
        });
        span.end();
        return this.graph;
    }
    async buildDependencyNodes(components) {
        for (const component of components) {
            try {
                const fullPath = path.join(this.projectPath, component.path);
                const content = await this.readFileContent(fullPath);
                const ast = await this.parseFile(content, component.path);
                const imports = this.extractImports(ast, component.path);
                const exports = this.extractExports(ast, component.path);
                const node = {
                    id: component.id,
                    path: component.path,
                    type: this.determineNodeType(ast),
                    imports,
                    exports,
                    dependencies: [],
                    dependents: [],
                    depth: 0,
                    layer: 0,
                    critical: false,
                    metrics: this.initializeMetrics()
                };
                this.graph.nodes.set(component.id, node);
            }
            catch (error) {
                telemetry_schema_1.telemetry.emit({
                    type: 'error_occurred',
                    source: {
                        analyzer: 'dependency-mapper',
                        component: component.path
                    },
                    data: {
                        error: error instanceof Error ? error.message : String(error),
                        component: component.path
                    }
                });
            }
        }
    }
    async analyzeDependencies() {
        for (const [nodeId, node] of this.graph.nodes) {
            const edges = [];
            for (const importInfo of node.imports) {
                const targetPath = this.resolveImportPath(importInfo.source, node.path);
                const targetNode = this.findNodeByPath(targetPath);
                if (targetNode) {
                    const edge = {
                        from: nodeId,
                        to: targetNode.id,
                        type: this.determineConnectionType(importInfo),
                        weight: this.calculateEdgeWeight(importInfo),
                        importPath: importInfo.source,
                        isCircular: false,
                        isTransitive: false,
                        isDynamic: importInfo.isDynamic,
                        isConditional: await this.isConditionalImport(node.path, importInfo),
                        isAsync: importInfo.isLazy,
                        metadata: await this.extractEdgeMetadata(node.path, importInfo)
                    };
                    edges.push(edge);
                    node.dependencies.push(targetNode.id);
                    targetNode.dependents.push(nodeId);
                }
            }
            this.graph.edges.set(nodeId, edges);
        }
    }
    calculateLayers() {
        const visited = new Set();
        const layers = new Map();
        let maxLayer = 0;
        const queue = [];
        for (const [nodeId, node] of this.graph.nodes) {
            if (node.dependencies.length === 0) {
                queue.push(nodeId);
                node.layer = 0;
                if (!layers.has(0))
                    layers.set(0, []);
                layers.get(0).push(nodeId);
            }
        }
        while (queue.length > 0) {
            const currentId = queue.shift();
            if (visited.has(currentId))
                continue;
            visited.add(currentId);
            const currentNode = this.graph.nodes.get(currentId);
            for (const dependentId of currentNode.dependents) {
                const dependentNode = this.graph.nodes.get(dependentId);
                const newLayer = currentNode.layer + 1;
                if (newLayer > dependentNode.layer) {
                    dependentNode.layer = newLayer;
                    maxLayer = Math.max(maxLayer, newLayer);
                    if (!layers.has(newLayer))
                        layers.set(newLayer, []);
                    layers.get(newLayer).push(dependentId);
                    queue.push(dependentId);
                }
            }
        }
        for (let i = 0; i <= maxLayer; i++) {
            const nodeIds = layers.get(i) || [];
            this.graph.layers.push({
                level: i,
                name: this.getLayerName(i, maxLayer),
                nodes: nodeIds,
                description: this.getLayerDescription(i, maxLayer),
                metrics: this.calculateLayerMetrics(nodeIds)
            });
        }
    }
    detectCycles() {
        const visited = new Set();
        const recursionStack = new Set();
        const cycles = [];
        const dfs = (nodeId, path = []) => {
            visited.add(nodeId);
            recursionStack.add(nodeId);
            path.push(nodeId);
            const edges = this.graph.edges.get(nodeId) || [];
            for (const edge of edges) {
                if (!visited.has(edge.to)) {
                    dfs(edge.to, [...path]);
                }
                else if (recursionStack.has(edge.to)) {
                    const cycleStart = path.indexOf(edge.to);
                    if (cycleStart !== -1) {
                        const cycle = path.slice(cycleStart);
                        cycle.push(edge.to);
                        cycles.push(cycle);
                        edge.isCircular = true;
                    }
                }
            }
            recursionStack.delete(nodeId);
        };
        for (const nodeId of this.graph.nodes.keys()) {
            if (!visited.has(nodeId)) {
                dfs(nodeId);
            }
        }
        this.graph.cycles = cycles;
        for (const cycle of cycles) {
            for (const nodeId of cycle) {
                const node = this.graph.nodes.get(nodeId);
                if (node) {
                    node.critical = true;
                }
            }
        }
    }
    calculateTransitiveDependencies() {
        const nodes = Array.from(this.graph.nodes.keys());
        const n = nodes.length;
        const dist = Array(n).fill(null).map(() => Array(n).fill(Infinity));
        const nodeIndex = new Map(nodes.map((id, i) => [id, i]));
        for (let i = 0; i < n; i++) {
            dist[i][i] = 0;
        }
        for (const [fromId, edges] of this.graph.edges) {
            const fromIdx = nodeIndex.get(fromId);
            for (const edge of edges) {
                const toIdx = nodeIndex.get(edge.to);
                dist[fromIdx][toIdx] = 1;
            }
        }
        for (let k = 0; k < n; k++) {
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (dist[i][k] + dist[k][j] < dist[i][j]) {
                        dist[i][j] = dist[i][k] + dist[k][j];
                    }
                }
            }
        }
        for (let i = 0; i < n; i++) {
            let maxDepth = 0;
            for (let j = 0; j < n; j++) {
                if (i !== j && dist[i][j] !== Infinity) {
                    maxDepth = Math.max(maxDepth, dist[i][j]);
                }
            }
            this.graph.transitiveDepth.set(nodes[i], maxDepth);
            const nodeId = nodes[i];
            const edges = this.graph.edges.get(nodeId) || [];
            for (const edge of edges) {
                const toIdx = nodeIndex.get(edge.to);
                if (dist[i][toIdx] > 1) {
                    edge.isTransitive = true;
                }
            }
        }
    }
    identifyCriticalPaths() {
        const entryNodes = Array.from(this.graph.nodes.values())
            .filter(node => node.dependents.length === 0 || node.critical);
        for (const entryNode of entryNodes) {
            const paths = this.findAllPaths(entryNode.id, null, 5);
            for (const path of paths) {
                const weight = this.calculatePathWeight(path);
                const bottlenecks = this.identifyBottlenecks(path);
                if (weight > 0.7 || bottlenecks.length > 0) {
                    this.graph.criticalPaths.push({
                        path,
                        weight,
                        type: 'import',
                        bottlenecks,
                        optimizations: this.suggestOptimizations(path, bottlenecks)
                    });
                }
            }
        }
        this.graph.criticalPaths.sort((a, b) => b.weight - a.weight);
    }
    performClusterAnalysis() {
        const clusters = this.findStronglyConnectedComponents();
        for (const cluster of clusters) {
            if (cluster.length > 1) {
                const cohesion = this.calculateClusterCohesion(cluster);
                const coupling = this.calculateClusterCoupling(cluster);
                this.graph.clusters.push({
                    id: `cluster_${this.graph.clusters.length}`,
                    nodes: cluster,
                    type: this.determineClusterType(cluster),
                    cohesion,
                    coupling,
                    description: this.describeCluster(cluster)
                });
            }
        }
    }
    calculateMetrics() {
        for (const [nodeId, node] of this.graph.nodes) {
            const fanIn = node.dependents.length;
            const fanOut = node.dependencies.length;
            const instability = fanOut > 0 || fanIn > 0 ? fanOut / (fanIn + fanOut) : 0;
            node.metrics = {
                fanIn,
                fanOut,
                coupling: this.calculateCoupling(nodeId),
                cohesion: this.calculateCohesion(nodeId),
                instability,
                abstractness: this.calculateAbstractness(node),
                distance: Math.abs(instability + this.calculateAbstractness(node) - 1)
            };
        }
    }
    async readFileContent(filePath) {
        if (this.fileContentCache.has(filePath)) {
            return this.fileContentCache.get(filePath);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        this.fileContentCache.set(filePath, content);
        return content;
    }
    async parseFile(content, filePath) {
        if (this.astCache.has(filePath)) {
            return this.astCache.get(filePath);
        }
        try {
            const ast = parser.parse(content, {
                sourceType: 'module',
                plugins: [
                    'typescript',
                    'jsx',
                    'decorators-legacy',
                    'classProperties',
                    'asyncGenerators',
                    'dynamicImport',
                    'optionalChaining',
                    'nullishCoalescingOperator'
                ],
                errorRecovery: true
            });
            this.astCache.set(filePath, ast);
            return ast;
        }
        catch (error) {
            return null;
        }
    }
    extractImports(ast, filePath) {
        const imports = [];
        if (!ast)
            return imports;
        (0, traverse_1.default)(ast, {
            ImportDeclaration(path) {
                const source = path.node.source.value;
                const specifiers = [];
                path.node.specifiers.forEach((spec) => {
                    if (t.isImportDefaultSpecifier(spec)) {
                        specifiers.push({
                            imported: 'default',
                            local: spec.local.name,
                            type: 'default'
                        });
                    }
                    else if (t.isImportNamespaceSpecifier(spec)) {
                        specifiers.push({
                            imported: '*',
                            local: spec.local.name,
                            type: 'namespace'
                        });
                    }
                    else if (t.isImportSpecifier(spec)) {
                        specifiers.push({
                            imported: 'name' in spec.imported ? spec.imported.name : spec.imported.value,
                            local: spec.local.name,
                            type: 'named'
                        });
                    }
                });
                imports.push({
                    source,
                    specifiers,
                    type: specifiers.length === 0 ? 'side-effect' :
                        specifiers[0].type === 'default' ? 'default' :
                            specifiers[0].type === 'namespace' ? 'namespace' : 'named',
                    isLazy: false,
                    isDynamic: false,
                    location: {
                        line: path.node.loc?.start.line || 0,
                        column: path.node.loc?.start.column || 0,
                        file: filePath
                    }
                });
            },
            CallExpression(path) {
                if (t.isImport(path.node.callee) && path.node.arguments.length > 0) {
                    const arg = path.node.arguments[0];
                    if (t.isStringLiteral(arg)) {
                        imports.push({
                            source: arg.value,
                            specifiers: [],
                            type: 'namespace',
                            isLazy: true,
                            isDynamic: true,
                            location: {
                                line: path.node.loc?.start.line || 0,
                                column: path.node.loc?.start.column || 0,
                                file: filePath
                            }
                        });
                    }
                }
                if (t.isIdentifier(path.node.callee, { name: 'require' }) &&
                    path.node.arguments.length > 0) {
                    const arg = path.node.arguments[0];
                    if (t.isStringLiteral(arg)) {
                        imports.push({
                            source: arg.value,
                            specifiers: [],
                            type: 'namespace',
                            isLazy: false,
                            isDynamic: false,
                            location: {
                                line: path.node.loc?.start.line || 0,
                                column: path.node.loc?.start.column || 0,
                                file: filePath
                            }
                        });
                    }
                }
            }
        });
        return imports;
    }
    extractExports(ast, filePath) {
        const exports = [];
        if (!ast)
            return exports;
        (0, traverse_1.default)(ast, {
            ExportNamedDeclaration(path) {
                if (path.node.declaration) {
                    if (t.isFunctionDeclaration(path.node.declaration) ||
                        t.isClassDeclaration(path.node.declaration)) {
                        exports.push({
                            name: path.node.declaration.id?.name || 'anonymous',
                            type: 'named',
                            isAsync: t.isFunctionDeclaration(path.node.declaration) &&
                                path.node.declaration.async || false,
                            location: {
                                line: path.node.loc?.start.line || 0,
                                column: path.node.loc?.start.column || 0,
                                file: filePath
                            }
                        });
                    }
                    else if (t.isVariableDeclaration(path.node.declaration)) {
                        path.node.declaration.declarations.forEach((decl) => {
                            if (t.isIdentifier(decl.id)) {
                                exports.push({
                                    name: decl.id.name,
                                    type: 'named',
                                    isAsync: false,
                                    location: {
                                        line: path.node.loc?.start.line || 0,
                                        column: path.node.loc?.start.column || 0,
                                        file: filePath
                                    }
                                });
                            }
                        });
                    }
                }
                else if (path.node.specifiers) {
                    path.node.specifiers.forEach((spec) => {
                        exports.push({
                            name: spec.exported.name,
                            type: 'named',
                            source: path.node.source?.value,
                            isAsync: false,
                            location: {
                                line: path.node.loc?.start.line || 0,
                                column: path.node.loc?.start.column || 0,
                                file: filePath
                            }
                        });
                    });
                }
            },
            ExportDefaultDeclaration(path) {
                exports.push({
                    name: 'default',
                    type: 'default',
                    isAsync: t.isFunctionDeclaration(path.node.declaration) &&
                        path.node.declaration.async || false,
                    location: {
                        line: path.node.loc?.start.line || 0,
                        column: path.node.loc?.start.column || 0,
                        file: filePath
                    }
                });
            },
            ExportAllDeclaration(path) {
                exports.push({
                    name: '*',
                    type: 're-export',
                    source: path.node.source.value,
                    isAsync: false,
                    location: {
                        line: path.node.loc?.start.line || 0,
                        column: path.node.loc?.start.column || 0,
                        file: filePath
                    }
                });
            }
        });
        return exports;
    }
    determineNodeType(ast) {
        if (!ast)
            return 'module';
        let hasClass = false;
        let hasFunction = false;
        let hasInterface = false;
        (0, traverse_1.default)(ast, {
            ClassDeclaration() { hasClass = true; },
            FunctionDeclaration() { hasFunction = true; },
            TSInterfaceDeclaration() { hasInterface = true; }
        });
        if (hasInterface)
            return 'interface';
        if (hasClass)
            return 'class';
        if (hasFunction)
            return 'function';
        return 'module';
    }
    resolveImportPath(importPath, currentFile) {
        if (importPath.startsWith('.')) {
            const currentDir = path.dirname(currentFile);
            const resolved = path.join(currentDir, importPath);
            const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
            for (const ext of extensions) {
                const testPath = resolved.includes('.') ? resolved : resolved + ext;
                const normalizedPath = path.normalize(testPath).replace(/\\/g, '/');
                for (const [componentPath] of this.componentMap) {
                    if (componentPath === normalizedPath ||
                        componentPath.startsWith(normalizedPath.replace(/\.[^.]+$/, ''))) {
                        return componentPath;
                    }
                }
            }
        }
        if (!importPath.startsWith('.') && !importPath.includes('node_modules')) {
            const sourceDirs = ['src/', 'lib/', 'app/', ''];
            for (const dir of sourceDirs) {
                const testPath = path.join(dir, importPath);
                for (const [componentPath] of this.componentMap) {
                    if (componentPath.startsWith(testPath)) {
                        return componentPath;
                    }
                }
            }
        }
        return null;
    }
    findNodeByPath(filePath) {
        if (!filePath)
            return null;
        for (const node of this.graph.nodes.values()) {
            if (node.path === filePath) {
                return node;
            }
        }
        return null;
    }
    determineConnectionType(importInfo) {
        if (importInfo.isDynamic)
            return 'function_call';
        if (importInfo.type === 'side-effect')
            return 'data_flow';
        return 'import';
    }
    calculateEdgeWeight(importInfo) {
        let weight = 1;
        if (importInfo.type === 'namespace')
            weight += 2;
        if (importInfo.isDynamic)
            weight += 1;
        if (importInfo.specifiers.length > 3)
            weight += 1;
        return Math.min(weight, 5);
    }
    async isConditionalImport(filePath, importInfo) {
        try {
            const fullPath = path.join(this.projectPath, filePath);
            const content = await this.readFileContent(fullPath);
            const lines = content.split('\n');
            const importLine = lines[importInfo.location.line - 1];
            const beforeLines = lines.slice(Math.max(0, importInfo.location.line - 5), importInfo.location.line);
            const beforeText = beforeLines.join('\n');
            return beforeText.includes('if') ||
                beforeText.includes('switch') ||
                beforeText.includes('? ') ||
                importInfo.isDynamic;
        }
        catch {
            return false;
        }
    }
    async extractEdgeMetadata(filePath, importInfo) {
        const callSites = [];
        const dataFlow = [];
        const sideEffects = [];
        try {
            const fullPath = path.join(this.projectPath, filePath);
            const content = await this.readFileContent(fullPath);
            const ast = await this.parseFile(content, filePath);
            if (ast) {
                for (const spec of importInfo.specifiers) {
                    const usage = this.findSymbolUsage(ast, spec.local);
                    callSites.push(...usage.callSites);
                    dataFlow.push(...usage.dataFlow);
                    sideEffects.push(...usage.sideEffects);
                }
            }
        }
        catch (error) {
        }
        return {
            usageCount: callSites.length,
            callSites,
            dataFlow,
            sideEffects
        };
    }
    findSymbolUsage(ast, symbol) {
        const callSites = [];
        const dataFlow = [];
        const sideEffects = [];
        (0, traverse_1.default)(ast, {
            CallExpression(path) {
                if (t.isIdentifier(path.node.callee, { name: symbol }) ||
                    (t.isMemberExpression(path.node.callee) &&
                        t.isIdentifier(path.node.callee.object, { name: symbol }))) {
                    callSites.push({
                        function: symbol,
                        line: path.node.loc?.start.line || 0,
                        column: path.node.loc?.start.column || 0,
                        type: 'direct'
                    });
                }
            },
            VariableDeclarator(path) {
                if (t.isIdentifier(path.node.init, { name: symbol })) {
                    dataFlow.push({
                        variable: t.isIdentifier(path.node.id) ? path.node.id.name : 'unknown',
                        type: 'assignment',
                        direction: 'out',
                        transforms: []
                    });
                }
            },
            AssignmentExpression(path) {
                if (t.isIdentifier(path.node.right, { name: symbol })) {
                    dataFlow.push({
                        variable: path.node.left.toString(),
                        type: 'assignment',
                        direction: 'out',
                        transforms: []
                    });
                }
            }
        });
        return { callSites, dataFlow, sideEffects };
    }
    initializeMetrics() {
        return {
            fanIn: 0,
            fanOut: 0,
            coupling: 0,
            cohesion: 0,
            instability: 0,
            abstractness: 0,
            distance: 0
        };
    }
    getLayerName(level, maxLevel) {
        if (level === 0)
            return 'Foundation';
        if (level === maxLevel)
            return 'Application';
        if (level <= maxLevel / 3)
            return 'Infrastructure';
        if (level <= 2 * maxLevel / 3)
            return 'Domain';
        return 'Presentation';
    }
    getLayerDescription(level, maxLevel) {
        if (level === 0)
            return 'Core utilities and libraries with no dependencies';
        if (level === maxLevel)
            return 'Top-level application components';
        if (level <= maxLevel / 3)
            return 'Infrastructure and framework components';
        if (level <= 2 * maxLevel / 3)
            return 'Business logic and domain models';
        return 'User interface and API components';
    }
    calculateLayerMetrics(nodeIds) {
        let totalFanIn = 0;
        let totalFanOut = 0;
        let edgeCount = 0;
        for (const nodeId of nodeIds) {
            const node = this.graph.nodes.get(nodeId);
            if (node) {
                totalFanIn += node.metrics.fanIn;
                totalFanOut += node.metrics.fanOut;
            }
            const edges = this.graph.edges.get(nodeId) || [];
            edgeCount += edges.length;
        }
        return {
            nodeCount: nodeIds.length,
            edgeCount,
            averageFanIn: nodeIds.length > 0 ? totalFanIn / nodeIds.length : 0,
            averageFanOut: nodeIds.length > 0 ? totalFanOut / nodeIds.length : 0,
            cohesion: this.calculateLayerCohesion(nodeIds),
            coupling: this.calculateLayerCoupling(nodeIds)
        };
    }
    calculateLayerCohesion(nodeIds) {
        let internalEdges = 0;
        let totalEdges = 0;
        for (const nodeId of nodeIds) {
            const edges = this.graph.edges.get(nodeId) || [];
            for (const edge of edges) {
                totalEdges++;
                if (nodeIds.includes(edge.to)) {
                    internalEdges++;
                }
            }
        }
        return totalEdges > 0 ? internalEdges / totalEdges : 0;
    }
    calculateLayerCoupling(nodeIds) {
        let externalEdges = 0;
        let totalEdges = 0;
        for (const nodeId of nodeIds) {
            const edges = this.graph.edges.get(nodeId) || [];
            for (const edge of edges) {
                totalEdges++;
                if (!nodeIds.includes(edge.to)) {
                    externalEdges++;
                }
            }
        }
        return totalEdges > 0 ? externalEdges / totalEdges : 0;
    }
    findAllPaths(startId, endId, maxDepth) {
        const paths = [];
        const visited = new Set();
        const dfs = (currentId, path, depth) => {
            if (depth > maxDepth)
                return;
            if (visited.has(currentId))
                return;
            path.push(currentId);
            visited.add(currentId);
            if (endId === null || currentId === endId) {
                paths.push([...path]);
            }
            else {
                const edges = this.graph.edges.get(currentId) || [];
                for (const edge of edges) {
                    dfs(edge.to, path, depth + 1);
                }
            }
            path.pop();
            visited.delete(currentId);
        };
        dfs(startId, [], 0);
        return paths;
    }
    calculatePathWeight(path) {
        let weight = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const edges = this.graph.edges.get(path[i]) || [];
            const edge = edges.find(e => e.to === path[i + 1]);
            if (edge) {
                weight += edge.weight;
            }
        }
        return weight / (path.length - 1);
    }
    identifyBottlenecks(path) {
        const bottlenecks = [];
        for (const nodeId of path) {
            const node = this.graph.nodes.get(nodeId);
            if (node) {
                if (node.metrics.fanIn > 5) {
                    bottlenecks.push(nodeId);
                }
                if (node.metrics.coupling > 0.7) {
                    bottlenecks.push(nodeId);
                }
            }
        }
        return [...new Set(bottlenecks)];
    }
    suggestOptimizations(path, bottlenecks) {
        const optimizations = [];
        for (const bottleneck of bottlenecks) {
            const node = this.graph.nodes.get(bottleneck);
            if (node) {
                if (node.metrics.fanIn > 5) {
                    optimizations.push(`Consider splitting ${node.path} into smaller modules`);
                }
                if (node.metrics.coupling > 0.7) {
                    optimizations.push(`Reduce coupling in ${node.path} by using dependency injection`);
                }
                if (node.imports.some(i => i.isDynamic)) {
                    optimizations.push(`Consider static imports in ${node.path} for better tree-shaking`);
                }
            }
        }
        return optimizations;
    }
    findStronglyConnectedComponents() {
        const components = [];
        const visited = new Set();
        const stack = [];
        const lowlinks = new Map();
        const indices = new Map();
        const onStack = new Set();
        let index = 0;
        const strongconnect = (v) => {
            indices.set(v, index);
            lowlinks.set(v, index);
            index++;
            stack.push(v);
            onStack.add(v);
            const edges = this.graph.edges.get(v) || [];
            for (const edge of edges) {
                const w = edge.to;
                if (!indices.has(w)) {
                    strongconnect(w);
                    lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
                }
                else if (onStack.has(w)) {
                    lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
                }
            }
            if (lowlinks.get(v) === indices.get(v)) {
                const component = [];
                let w;
                do {
                    w = stack.pop();
                    onStack.delete(w);
                    component.push(w);
                } while (w !== v);
                components.push(component);
            }
        };
        for (const nodeId of this.graph.nodes.keys()) {
            if (!indices.has(nodeId)) {
                strongconnect(nodeId);
            }
        }
        return components;
    }
    calculateClusterCohesion(nodeIds) {
        return this.calculateLayerCohesion(nodeIds);
    }
    calculateClusterCoupling(nodeIds) {
        return this.calculateLayerCoupling(nodeIds);
    }
    determineClusterType(nodeIds) {
        const nodes = nodeIds.map(id => this.graph.nodes.get(id)).filter(n => n);
        const directories = new Set(nodes.map(n => path.dirname(n.path)));
        if (directories.size === 1) {
            const dir = Array.from(directories)[0];
            if (dir.includes('component'))
                return 'component';
            if (dir.includes('feature'))
                return 'feature';
            if (dir.includes('util') || dir.includes('helper'))
                return 'utility';
        }
        const types = new Set(nodes.map(n => n.type));
        if (types.size === 1 && types.has('interface'))
            return 'component';
        return 'feature';
    }
    describeCluster(nodeIds) {
        const nodes = nodeIds.map(id => this.graph.nodes.get(id)).filter(n => n);
        const directories = new Set(nodes.map(n => path.dirname(n.path)));
        const types = new Set(nodes.map(n => n.type));
        return `Cluster of ${nodes.length} ${Array.from(types).join('/')} modules in ${directories.size} directories`;
    }
    calculateCoupling(nodeId) {
        const node = this.graph.nodes.get(nodeId);
        if (!node)
            return 0;
        const edges = this.graph.edges.get(nodeId) || [];
        const uniqueTargets = new Set(edges.map(e => e.to));
        return uniqueTargets.size / Math.max(1, this.graph.nodes.size - 1);
    }
    calculateCohesion(nodeId) {
        const node = this.graph.nodes.get(nodeId);
        if (!node)
            return 0;
        const exportNames = new Set(node.exports.map(e => e.name));
        let usedExports = 0;
        for (const dependentId of node.dependents) {
            const dependent = this.graph.nodes.get(dependentId);
            if (dependent) {
                for (const imp of dependent.imports) {
                    if (imp.specifiers.some(s => exportNames.has(s.imported))) {
                        usedExports++;
                    }
                }
            }
        }
        return exportNames.size > 0 ? usedExports / exportNames.size : 0;
    }
    calculateAbstractness(node) {
        if (node.type === 'interface')
            return 1;
        const abstractExports = node.exports.filter(e => e.name.startsWith('I') ||
            e.name.includes('Abstract') ||
            e.name.includes('Base'));
        return node.exports.length > 0 ? abstractExports.length / node.exports.length : 0;
    }
    generateCallGraph(components) {
        const nodes = [];
        const edges = [];
        for (const [nodeId, depNode] of this.graph.nodes) {
            const component = components.find(c => c.id === nodeId);
            if (component) {
                nodes.push({
                    id: nodeId,
                    name: component.name,
                    type: 'module',
                    file: component.path,
                    complexity: component.metadata.complexity,
                    fanIn: depNode.metrics.fanIn,
                    fanOut: depNode.metrics.fanOut,
                    depth: depNode.depth,
                    critical: depNode.critical
                });
            }
        }
        for (const [fromId, depEdges] of this.graph.edges) {
            for (const depEdge of depEdges) {
                edges.push({
                    from: fromId,
                    to: depEdge.to,
                    count: depEdge.weight,
                    type: depEdge.isTransitive ? 'indirect' : 'direct',
                    async: depEdge.isAsync,
                    conditional: depEdge.isConditional
                });
            }
        }
        const layers = this.graph.layers.map(layer => ({
            level: layer.level,
            nodes: layer.nodes,
            description: layer.description
        }));
        const hotPaths = this.graph.criticalPaths.map(cp => ({
            path: cp.path,
            frequency: cp.weight,
            critical: true,
            description: `Critical path with ${cp.bottlenecks.length} bottlenecks`
        }));
        const deadCode = Array.from(this.graph.nodes.entries())
            .filter(([_, node]) => node.dependents.length === 0 && node.dependencies.length === 0)
            .map(([id]) => id);
        return {
            nodes,
            edges,
            entryPoints: nodes.filter(n => n.fanIn === 0).map(n => n.id),
            cycles: this.graph.cycles,
            layers,
            hotPaths,
            deadCode
        };
    }
}
exports.DependencyMapper = DependencyMapper;
