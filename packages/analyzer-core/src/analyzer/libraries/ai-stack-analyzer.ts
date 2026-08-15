import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { isTestFileName } from '../core/scaffold-paths';















type AICapability =
  | 'llm-call'
  | 'ai-chain'
  | 'agent-graph'
  | 'ai-agent'
  | 'ai-tool'
  | 'mcp-server'
  | 'mcp-tool'
  | 'vector-store'
  | 'rag-retriever'
  | 'prompt';

interface AIDetection {
  capability: AICapability;
  name: string;
  nodeType: string;
  filePath: string;
  line: number;
  metadata: Record<string, any>;
}


const AI_PACKAGE_SIGNATURES: string[] = [
  'langchain', '@langchain', 'langchain-core', 'langchain-community',
  'llamaindex', 'llama-index', 'llama_index',
  'ai', '@ai-sdk',
  'openai',
  '@anthropic-ai/sdk', 'anthropic',
  '@modelcontextprotocol/sdk', 'mcp', 'fastmcp',
  'crewai',
  'langgraph', '@langchain/langgraph',
  'autogen', 'pyautogen', 'autogen-agentchat',
  'pinecone', '@pinecone-database', 'pinecone-client',
  'weaviate', 'weaviate-client', 'weaviate-ts-client',
  'chromadb',
  'qdrant', '@qdrant/js-client-rest', 'qdrant-client',
  'pgvector',
];

const TS_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
const PY_EXTENSIONS = ['py'];

export class AIStackAnalyzer extends BaseAnalyzer {
  constructor() {
    super('ai-stack', 'AI Stack Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      try {
        const packageJson = await fs.readJson(packageJsonPath);
        const allDeps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
          ...packageJson.peerDependencies,
        };
        if (Object.keys(allDeps).some(dep => this.isAIPackage(dep))) {
          return true;
        }
      } catch {

      }
    }


    for (const manifest of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const manifestPath = path.join(projectPath, manifest);
      if (await fs.pathExists(manifestPath)) {
        try {
          const content = (await fs.readFile(manifestPath, 'utf-8')).toLowerCase();
          if (AI_PACKAGE_SIGNATURES.some(sig => content.includes(sig.toLowerCase()))) {
            return true;
          }
        } catch {

        }
      }
    }


    const ignorePatterns = this.getIgnorePatterns({ projectPath });
    const sourceFiles = (await glob(`**/*.{${[...TS_EXTENSIONS, ...PY_EXTENSIONS].join(',')}}`, {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    })).filter(file => !isTestFileName(path.basename(file)));

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (this.hasAIImport(content)) {
          return true;
        }
      } catch {

      }
    }

    return false;
  }

  private isAIPackage(dep: string): boolean {
    const normalized = dep.toLowerCase();
    return AI_PACKAGE_SIGNATURES.some(sig => {
      const s = sig.toLowerCase();
      return normalized === s || normalized.startsWith(`${s}/`) || normalized.startsWith(`${s}-`);
    });
  }

  private hasAIImport(content: string): boolean {

    const importRegex = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*(?:import|from)\s+([a-zA-Z0-9_.]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const pkg = (m[1] || m[2] || m[3] || '').toLowerCase();
      if (!pkg) continue;
      const root = pkg.split(/[/.]/).slice(0, pkg.startsWith('@') ? 2 : 1).join(pkg.startsWith('@') ? '/' : '');
      if (this.isAIPackage(root) || this.isAIPackage(pkg.split(/[/.]/)[0])) {
        return true;
      }
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    const ignorePatterns = this.getIgnorePatterns(context);
    const groundedFiles = this.filesFromExistingAnalysis(
      context,
      source => this.isAIPackage(source) || this.isAIPackage(source.split(/[/.]/)[0]),
      true
    );
    const conventionFiles = context.existingAnalysis?.length
      ? await glob([
        '**/*{agent,prompt,mcp,retriever,embedding,vector,llm,chat,completion}*.{ts,tsx,js,jsx,mjs,cjs,py}',
        '**/{agents,prompts,mcp,ai}/**/*.{ts,tsx,js,jsx,mjs,cjs,py}',
      ], {
        cwd: context.projectPath,
        ignore: ignorePatterns,
        absolute: false,
        nodir: true,
      })
      : [];
    let sourceFiles = context.existingAnalysis?.length
      ? [...new Set([...groundedFiles, ...conventionFiles])].map(file => path.join(context.projectPath, file))
      : await glob(`**/*.{${[...TS_EXTENSIONS, ...PY_EXTENSIONS].join(',')}}`, {
        cwd: context.projectPath,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
      });
    sourceFiles = sourceFiles.filter(file => !isTestFileName(path.basename(file)));
    sourceFiles = this.capAndPrioritizeSourceFiles(sourceFiles, 'AI stack source files');

    const detections: AIDetection[] = [];
    let mcpServerCount = 0;

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }

      if (!this.hasAIImport(content) && !this.looksAIShaped(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);












      const scannable = this.blankComments(content);
      const fileDetections = this.scanFile(scannable, relativePath);
      detections.push(...fileDetections);
    }


    mcpServerCount = this.emitDetections(detections, nodes, entryPoints);

    const counts = this.tallyCapabilities(nodes);

    return this.createContribution(nodes, edges, entryPoints, [], {

      aiAppProfile: {
        isAIApp: nodes.length > 0,
        isMCPServer: mcpServerCount > 0,
        isAgentApp: (counts['ai-agent'] || 0) + (counts['agent-graph'] || 0) > 0,
        isRAGApp: (counts['rag-retriever'] || 0) + (counts['vector-store'] || 0) > 0,
        components: counts,
        mcpServers: mcpServerCount,
        mcpTools: counts['mcp-tool'] || 0,
        llmCalls: counts['llm-call'] || 0,
        chains: (counts['ai-chain'] || 0) + (counts['agent-graph'] || 0),
        tools: counts['ai-tool'] || 0,
        agents: counts['ai-agent'] || 0,
        vectorStores: counts['vector-store'] || 0,
        retrievers: counts['rag-retriever'] || 0,
        prompts: counts['prompt'] || 0,
      },
      tags: this.buildProfileTags(counts, mcpServerCount, nodes.length),
      nodesFound: nodes.length,
      entryPointsFound: entryPoints.length,
      warnings: this.collectAnalysisWarnings(),
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = (await glob(`**/*.{${[...TS_EXTENSIONS, ...PY_EXTENSIONS].join(',')}}`, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      })).filter(file => !isTestFileName(path.basename(file)));
    } catch {
      return [];
    }

    const relevant: string[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (this.hasAIImport(content) || this.looksAIShaped(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);


    if (this.hasAIImport(content) || this.looksAIShaped(content)) {



      const detections = this.scanFile(this.blankComments(content), context.relativePath);
      this.emitDetections(detections, nodes, entryPoints);
    }

    const exports = nodes.map(n => n.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }


  private emitDetections(
    detections: AIDetection[],
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): number {
    let mcpServerCount = 0;
    const seen = new Set<string>();
    for (const det of detections) {
      const nodeId = this.detectionNodeId(det);
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);

      const node = this.createNode(
        nodeId,
        det.name,
        det.nodeType,
        3,
        det.filePath,
        det.line,
        undefined,
        {
          source: 'ai_stack',
          capability: det.capability,
          subcategories: ['ai', det.capability],
          ...det.metadata,
        }
      );

      node.tags = [...(node.tags || []), `ai:${det.capability}`, 'ai-stack'];
      nodes.push(node);


      if (det.capability === 'mcp-tool') {
        const handlerCallCandidates = Array.isArray(det.metadata?.handlerCallCandidates) && det.metadata.handlerCallCandidates.length > 0
          ? det.metadata.handlerCallCandidates
          : undefined;
        entryPoints.push(
          this.createEntryPoint(







            `entry_mcp_tool_${this.sanitizeId(det.name)}_${this.sanitizeId(det.filePath)}_${det.line}`,
            nodeId,
            'message',
            det.name,
            `MCP tool '${det.name}' exposed by an MCP server`,
            { event: 'mcp.tool.call', pattern: det.name },
            undefined,
            {
              ai: true, mcp: true, capability: 'mcp-tool',




              ...(handlerCallCandidates ? { handlerCallCandidates } : {})
            },
            { node_id: nodeId, method_name: det.name, file: det.filePath }
          )
        );
      }
      if (det.capability === 'mcp-server') {
        mcpServerCount += 1;
      }
    }
    return mcpServerCount;
  }


  private looksAIShaped(content: string): boolean {
    return /generateText|streamText|chat\.completions\.create|messages\.create|registerTool|setRequestHandler|McpServer|StateGraph|ChatOpenAI|ChatAnthropic|similaritySearch|PromptTemplate|new\s+Pinecone|new\s+Weaviate|ChromaClient|QdrantClient/.test(
      content
    );
  }

  private scanFile(content: string, filePath: string): AIDetection[] {
    const detections: AIDetection[] = [];
    const lineAt = (index: number) => content.slice(0, index).split('\n').length;

    const push = (
      capability: AICapability,
      name: string,
      nodeType: string,
      index: number,
      metadata: Record<string, any> = {}
    ) => {
      detections.push({ capability, name, nodeType, filePath, line: lineAt(index), metadata });
    };



    for (const m of content.matchAll(/(?:\w+\.)?chat\.completions\.create\s*\(/g)) {
      const model = this.nearbyModel(content, m.index ?? 0);
      push('llm-call', 'openai.chat.completions.create', 'llm-call', m.index ?? 0, {
        provider: 'openai',
        ...(model ? { model } : {}),
      });
    }

    for (const m of content.matchAll(/(?:\w+\.)?messages\.create\s*\(/g)) {
      const model = this.nearbyModel(content, m.index ?? 0);
      push('llm-call', 'anthropic.messages.create', 'llm-call', m.index ?? 0, {
        provider: 'anthropic',
        ...(model ? { model } : {}),
      });
    }

    for (const m of content.matchAll(/\b(generateText|streamText|generateObject|streamObject)\s*\(/g)) {
      const model = this.nearbyModel(content, m.index ?? 0);
      push('llm-call', `ai-sdk.${m[1]}`, 'llm-call', m.index ?? 0, {
        provider: 'vercel-ai-sdk',
        sdkFn: m[1],
        ...(model ? { model } : {}),
      });
    }

    for (const m of content.matchAll(/new\s+(ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|ChatOllama|ChatMistralAI)\s*\(/g)) {
      const model = this.nearbyModel(content, m.index ?? 0);
      push('llm-call', m[1], 'llm-call', m.index ?? 0, {
        provider: 'langchain',
        ...(model ? { model } : {}),
      });
    }

    for (const m of content.matchAll(/\b(ChatOpenAI|ChatAnthropic)\s*\(/g)) {

      const prefix = content.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0);
      if (/new\s$/.test(prefix)) continue;
      const model = this.nearbyModel(content, m.index ?? 0);
      push('llm-call', m[1], 'llm-call', m.index ?? 0, {
        provider: 'langchain',
        ...(model ? { model } : {}),
      });
    }


    for (const m of content.matchAll(/\b(RunnableSequence|LLMChain|SequentialChain|RetrievalQA|ConversationChain)\b/g)) {
      push('ai-chain', m[1], 'ai-chain', m.index ?? 0, { framework: 'langchain' });
    }
    for (const m of content.matchAll(/\bnew\s+StateGraph\s*\(/g)) {
      push('agent-graph', 'StateGraph', 'agent-graph', m.index ?? 0, { framework: 'langgraph' });
    }

    for (const m of content.matchAll(/(?<!new\s)\bStateGraph\s*\(/g)) {
      push('agent-graph', 'StateGraph', 'agent-graph', m.index ?? 0, { framework: 'langgraph' });
    }


    for (const m of content.matchAll(/\b(?:new\s+)?(Crew|Agent|AssistantAgent|UserProxyAgent|ConversableAgent)\s*\(/g)) {
      const fw = /Crew|Agent\b/.test(m[1]) ? 'crewai' : 'autogen';
      push('ai-agent', m[1], 'ai-agent', m.index ?? 0, { framework: fw });
    }



    for (const m of content.matchAll(/(\w+)\s*:\s*tool\s*\(\s*[\{(]/g)) {
      push('ai-tool', m[1], 'ai-tool', m.index ?? 0, { framework: 'ai-sdk' });
    }
    for (const m of content.matchAll(/\bnew\s+DynamicTool\s*\(/g)) {
      push('ai-tool', 'DynamicTool', 'ai-tool', m.index ?? 0, { framework: 'langchain' });
    }

    for (const m of content.matchAll(/\btool\s*\([^)]*name\s*[:=]\s*['"]([^'"]+)['"]/g)) {
      push('ai-tool', m[1], 'ai-tool', m.index ?? 0, { framework: 'langchain' });
    }

    for (const m of content.matchAll(/@(?:tool|function_tool)\b/g)) {
      const name = this.nextPyDefName(content, m.index ?? 0) || 'tool';
      push('ai-tool', name, 'ai-tool', m.index ?? 0, { framework: 'python-decorator' });
    }


    for (const m of content.matchAll(/new\s+(McpServer|Server)\s*\(/g)) {
      push('mcp-server', m[1], 'mcp-server', m.index ?? 0, { framework: 'mcp' });
    }

    for (const m of content.matchAll(/\b(FastMCP)\s*\(/g)) {
      push('mcp-server', m[1], 'mcp-server', m.index ?? 0, { framework: 'mcp' });
    }


    for (const m of content.matchAll(/\.(?:registerTool|tool)\s*\(\s*['"]([^'"]+)['"]/g)) {









      const openParenIndex = content.indexOf('(', m.index ?? 0);
      const candidates = openParenIndex >= 0
        ? this.extractHandlerCallCandidates(this.extractBalancedArgsText(content, openParenIndex))
        : [];
      push('mcp-tool', m[1], 'mcp-tool', m.index ?? 0, {
        framework: 'mcp',
        ...(candidates.length > 0 ? { handlerCallCandidates: candidates } : {}),
      });
    }

    for (const m of content.matchAll(/@(?:mcp|server)\.tool\s*\(/g)) {
      const name = this.nextPyDefName(content, m.index ?? 0) || 'tool';
      push('mcp-tool', name, 'mcp-tool', m.index ?? 0, { framework: 'mcp' });
    }


    for (const m of content.matchAll(/new\s+(Pinecone|Weaviate|WeaviateClient|ChromaClient|QdrantClient)\s*\(/g)) {
      push('vector-store', m[1], 'vector-store', m.index ?? 0, { store: m[1].toLowerCase() });
    }

    for (const m of content.matchAll(/\b(?:chromadb\.Client|weaviate\.connect_to\w*|Pinecone|QdrantClient|PGVector)\s*\(/g)) {
      const prefix = content.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0);
      if (/new\s$/.test(prefix)) continue;
      const name = m[0].replace(/\s*\($/, '');
      push('vector-store', name, 'vector-store', m.index ?? 0, { store: name.toLowerCase() });
    }


    for (const m of content.matchAll(/\.(?:similaritySearch|similarity_search|asRetriever|as_retriever|query|embed|embeddings|upsert)\s*\(/g)) {
      const method = m[0].replace(/^\./, '').replace(/\s*\($/, '');
      push('rag-retriever', method, 'rag-retriever', m.index ?? 0, { retrieval: method });
    }


    for (const m of content.matchAll(/\b(?:new\s+)?(PromptTemplate|ChatPromptTemplate|FewShotPromptTemplate)\b/g)) {
      push('prompt', m[1], 'prompt', m.index ?? 0, { framework: 'langchain' });
    }

    return detections;
  }


  private nearbyModel(content: string, index: number): string | undefined {
    const window = content.slice(index, index + 400);
    const direct = window.match(/model\s*[:=]\s*['"]([^'"]+)['"]/);
    if (direct) return direct[1];

    const wrapped = window.match(/model\s*[:=]\s*\w+\(\s*['"]([^'"]+)['"]/);
    if (wrapped) return wrapped[1];

    const bare = window.match(/\b(?:openai|anthropic|google|mistral)\(\s*['"]([^'"]+)['"]/);
    if (bare) return bare[1];
    return undefined;
  }


  private nextPyDefName(content: string, index: number): string | undefined {
    const window = content.slice(index, index + 200);
    const m = window.match(/def\s+(\w+)\s*\(/);
    return m ? m[1] : undefined;
  }








  private extractBalancedArgsText(content: string, openParenIndex: number): string {
    let depth = 0;
    let start = -1;
    let inStr: string | null = null;
    for (let i = openParenIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '(') { depth++; if (depth === 1) start = i + 1; continue; }
      if (ch === ')') { depth--; if (depth === 0) return start >= 0 ? content.slice(start, i) : ''; }
    }
    return start >= 0 ? content.slice(start) : '';
  }









  private extractHandlerCallCandidates(argsText: string): string[] {
    if (!argsText) return [];
    const candidates: string[] = [];
    const seen = new Set<string>();
    const skip = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'async',
      'await', 'json', 'JSON', 'Boolean', 'String', 'Number', 'Array', 'Object',
      'Promise', 'Error', 'new'
    ]);






    const identifierPattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
    let m;
    while ((m = identifierPattern.exec(argsText)) !== null) {
      const qualified = m[1];
      const parts = qualified.split('.');
      const bare = parts[parts.length - 1];
      if (skip.has(bare) || skip.has(qualified)) continue;

      let i = identifierPattern.lastIndex;
      while (i < argsText.length && /\s/.test(argsText[i])) i++;
      if (argsText[i] === '<') {
        let depth = 0;
        let j = i;
        for (; j < argsText.length; j++) {
          if (argsText[j] === '<') depth++;
          else if (argsText[j] === '>') { depth--; if (depth === 0) { j++; break; } }
        }
        if (depth !== 0) continue;
        i = j;
        while (i < argsText.length && /\s/.test(argsText[i])) i++;
      }
      if (argsText[i] !== '(') continue;

      if (!seen.has(qualified)) { seen.add(qualified); candidates.push(qualified); }
      if (bare !== qualified && !seen.has(bare)) { seen.add(bare); candidates.push(bare); }
    }
    return candidates;
  }

  private detectionNodeId(det: AIDetection): string {
    return `ai_${det.capability}_${this.sanitizeId(det.name)}_${this.sanitizeId(det.filePath)}_${det.line}`;
  }

  private tallyCapabilities(nodes: CASNode[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const node of nodes) {
      const cap = (node.metadata as any)?.capability as string | undefined;
      if (cap) counts[cap] = (counts[cap] || 0) + 1;
    }
    return counts;
  }

  private buildProfileTags(
    counts: Record<string, number>,
    mcpServers: number,
    nodeCount: number
  ): string[] {
    const tags: string[] = [];
    if (nodeCount > 0) tags.push('ai-app');
    if (mcpServers > 0) tags.push('mcp-server');
    if ((counts['ai-agent'] || 0) + (counts['agent-graph'] || 0) > 0) tags.push('agent-app');
    if ((counts['rag-retriever'] || 0) + (counts['vector-store'] || 0) > 0) tags.push('rag-app');
    if ((counts['llm-call'] || 0) > 0) tags.push('llm-app');
    return tags;
  }

  protected getCapabilities(): string[] {
    return [
      'llm-calls',
      'ai-chains',
      'ai-agents',
      'ai-tools',
      'mcp-servers',
      'vector-stores',
      'rag-retrievers',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
