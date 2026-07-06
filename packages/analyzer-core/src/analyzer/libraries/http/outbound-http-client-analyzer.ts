import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASContribution, CASExitPoint, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

interface HttpClientCall {
  library: string;
  method: string;
  endpoint: string;
  line: number;
  serviceAlias?: string;
  declaration?: string;
}

interface FileHttpContext {
  baseUrls: Map<string, string>;
  feignInterfaces: Map<string, FeignClientInfo>;
}

interface FeignClientInfo {
  name: string;
  baseUrl?: string;
  pathPrefix?: string;
}

const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,go}';
const HTTP_CLIENT_DEPENDENCIES = [
  'axios',
  'got',
  'ky',
  'node-fetch',
  '@apollo/client',
  'apollo-client',
  'urql',
  '@urql/core',
  'requests',
  'httpx',
  'aiohttp',
  'spring-web',
  'spring-webflux',
  'okhttp',
  'feign-core',
  'spring-cloud-starter-openfeign',
  'net/http',
  'github.com/go-resty/resty',
  'github.com/go-resty/resty/v2',
];

const JS_HTTP_IMPORT = /\bfrom\s+['"](?:axios|got|ky|node-fetch|@apollo\/client|apollo-client|urql|@urql\/core)['"]|\brequire\(\s*['"](?:axios|got|ky|node-fetch|@apollo\/client|apollo-client|urql|@urql\/core)['"]\s*\)|\bimport\s+['"](?:axios|got|ky|node-fetch|@apollo\/client|apollo-client|urql|@urql\/core)['"]/;
const PY_HTTP_IMPORT = /^\s*(?:import|from)\s+(requests|httpx|aiohttp)\b/m;
const JAVA_HTTP_IMPORT = /\bimport\s+(?:org\.springframework\.(?:web\.client\.RestTemplate|web\.reactive\.function\.client\.WebClient)|okhttp3\.|org\.springframework\.cloud\.openfeign\.FeignClient|feign\.)/;
const GO_HTTP_IMPORT = /"net\/http"|"github\.com\/go-resty\/resty(?:\/v2)?"/;
const GLOBAL_FETCH_CALL = /\bfetch\s*\(\s*['"`]https?:\/\//;

export class OutboundHttpClientAnalyzer extends BaseAnalyzer {
  constructor() {
    super('outbound-http-client', 'Outbound HTTP Client Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencyHits = await this.readDependencyNames(projectPath);
    if (HTTP_CLIENT_DEPENDENCIES.some(dep => dependencyHits.some(hit => hit.includes(dep)))) return true;

    const files = this.capAndPrioritizeSourceFiles(await glob(SOURCE_GLOB, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    }), 'outbound HTTP client candidate files');

    for (const relativePath of files) {
      const content = await this.readFileIfPresent(projectPath, relativePath);
      if (content && this.fileHasHttpClientEvidence(content, relativePath)) return true;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const allSourceFiles = await glob(SOURCE_GLOB, {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true,
      absolute: false,
    });

    const nodes: CASNode[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenNodeIds = new Set<string>();
    const seenExitIds = new Set<string>();
    const candidateFiles: string[] = [];
    // JS/TS files with client-looking method calls but no direct http-lib import:
    // they may call an instance EXPORTED by another module (`http.get('/users/')`).
    // Confirmed against the project-level instance map below before scanning.
    const potentialInstanceCallers: string[] = [];
    const jsCallShape = /\.\s*(?:get|post|put|patch|delete|head)\s*(?:<[^<>()]{0,200}>)?\s*\(\s*['"`]/;
    for (const relativePath of allSourceFiles) {
      const content = await this.readFileIfPresent(context.projectPath, relativePath);
      if (!content) continue;
      if (this.fileHasHttpClientEvidence(content, relativePath)) {
        candidateFiles.push(relativePath);
      } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relativePath) && jsCallShape.test(content)) {
        potentialInstanceCallers.push(relativePath);
      }
    }
    const sourceFiles = this.capAndPrioritizeSourceFiles(candidateFiles, 'outbound HTTP client candidate files');

    // PROJECT-level client-instance map (corpus-depth sweep fix): the canonical
    // real-world shape is ONE module doing `export default axios.create({...})`
    // and every other module importing it — a per-file context never sees the
    // factory from the call site's file. Collect instance names (+ base URLs
    // when literal) across ALL candidate files first, then let each file's own
    // context win on name collision.
    const projectBaseUrls = new Map<string, string>();
    for (const relativePath of sourceFiles) {
      const content = await this.readFileIfPresent(context.projectPath, relativePath);
      if (!content) continue;
      for (const [name, base] of this.extractFileContext(content).baseUrls) {
        if (!projectBaseUrls.has(name)) projectBaseUrls.set(name, base);
      }
    }

    // Second-order candidates: files that CALL a known project client instance
    // without importing an http library themselves (the api-service module
    // importing the shared axios wrapper). Only files that name a known
    // instance are admitted.
    const instanceCallerFiles: string[] = [];
    if (projectBaseUrls.size > 0 && potentialInstanceCallers.length > 0) {
      const instanceUse = new RegExp(`\\b(?:${[...projectBaseUrls.keys()].join('|')})\\s*\\.`);
      for (const relativePath of this.capAndPrioritizeSourceFiles(potentialInstanceCallers, 'outbound HTTP instance-caller candidate files')) {
        const content = await this.readFileIfPresent(context.projectPath, relativePath);
        if (content && instanceUse.test(content)) instanceCallerFiles.push(relativePath);
      }
    }

    for (const relativePath of [...sourceFiles, ...instanceCallerFiles]) {
      const content = await this.readFileIfPresent(context.projectPath, relativePath);
      if (!content) continue;

      const nodeId = this.findFileNodeId(relativePath, context.existingAnalysis) ||
        this.ensureHttpClientSourceNode(relativePath, nodes, seenNodeIds);

      for (const call of this.extractCalls(content, relativePath, projectBaseUrls)) {
        const exitId = `exit_http_client_${this.safeId(relativePath)}_${this.safeId(call.library)}_${this.safeId(call.method)}_${this.safeId(call.endpoint)}_${call.line}`;
        if (seenExitIds.has(exitId)) continue;
        seenExitIds.add(exitId);
        exitPoints.push(this.createExitPoint(
          exitId,
          nodeId,
          'api',
          `${call.method.toUpperCase()} ${call.endpoint}`,
          `${call.library} outbound HTTP call to ${call.endpoint}.`,
          {
            service_id: call.serviceAlias || serviceAliasFromEndpoint(call.endpoint) || 'external_api',
            endpoint: call.endpoint,
            resource: call.endpoint,
          },
          {
            method: call.method.toUpperCase(),
            action: call.method.toLowerCase(),
            async: true,
          },
          {
            library: call.library,
            protocol: 'http',
            sourceFile: relativePath,
            line: call.line,
            declaration: call.declaration,
            service_aliases: call.serviceAlias ? [call.serviceAlias] : [],
          }
        ));
      }
    }

    return this.createContribution(nodes, [], [], exitPoints, {
      library: 'outbound-http-client',
      http_client: 'multi-language',
      callsFound: exitPoints.length,
    });
  }

  protected getCapabilities(): string[] {
    return [
      'outbound-http-client-call-detection',
      'external-api-dependency-detection',
      'multi-language-http-client-boundary-detection',
      'feign-declarative-client-endpoint-detection',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'outbound HTTP clients' : 'outbound HTTP call detail';
  }

  private extractCalls(content: string, relativePath: string, projectBaseUrls?: Map<string, string>): HttpClientCall[] {
    const extension = path.extname(relativePath).toLowerCase();
    const fileContext = this.extractFileContext(content);
    // Fold the project-level instance map in as a FALLBACK — the file's own
    // factory declarations win on name collision.
    if (projectBaseUrls) {
      for (const [name, base] of projectBaseUrls) {
        if (!fileContext.baseUrls.has(name)) fileContext.baseUrls.set(name, base);
      }
    }
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
      return this.extractJavaScriptCalls(content, fileContext);
    }
    if (extension === '.py') return this.extractPythonCalls(content, fileContext);
    if (extension === '.java') return this.extractJavaCalls(content, fileContext);
    if (extension === '.go') return this.extractGoCalls(content, fileContext);
    return [];
  }

  private extractJavaScriptCalls(content: string, fileContext: FileHttpContext): HttpClientCall[] {
    const calls: HttpClientCall[] = [];
    // `(?:<...>)?` after the method: TypeScript generic call-site arguments
    // (`http.get<User[]>('/users')`) are the NORM in typed API layers — without
    // this the whole typed call surface is invisible (corpus-depth sweep fix).
    const directClient = /\b(axios|got|ky)\s*(?:\.\s*(get|post|put|patch|delete|head))?\s*(?:<[^<>()]{0,160}(?:<[^<>()]{0,160}>)?[^<>()]{0,40}>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = directClient.exec(content)) !== null) {
      const method = match[2] || (match[1] === 'got' || match[1] === 'ky' ? 'get' : 'get');
      this.addCall(calls, match[1], method, match[3], content, match.index);
    }

    const instanceCall = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head)\s*(?:<[^<>()]{0,160}(?:<[^<>()]{0,160}>)?[^<>()]{0,40}>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = instanceCall.exec(content)) !== null) {
      const variable = match[1];
      if (variable === 'axios' || variable === 'got' || variable === 'ky') continue;
      const baseUrl = fileContext.baseUrls.get(variable);
      // `undefined` = not a known client instance; `''` = a known instance whose
      // base URL wasn't a literal (still a REAL outbound call — keep it).
      if (baseUrl === undefined) continue;
      this.addCall(calls, this.libraryForBaseVariable(variable), match[2], joinEndpoint(baseUrl, match[3]), content, match.index);
    }

    const fetchCall = /\b(fetch)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*\{([\s\S]{0,300}?)\})?/g;
    while ((match = fetchCall.exec(content)) !== null) {
      const method = match[3]?.match(/\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/)?.[1] || 'GET';
      this.addCall(calls, 'fetch', method, match[2], content, match.index);
    }

    const apolloClient = /\bnew\s+ApolloClient\s*\(\s*\{[\s\S]{0,600}?\buri\s*:\s*['"`]([^'"`]+)['"`][\s\S]{0,600}?\}\s*\)/g;
    while ((match = apolloClient.exec(content)) !== null) {
      this.addCall(calls, 'apollo-client', 'POST', match[1], content, match.index, 'ApolloClient');
    }

    const urqlClient = /\bcreateClient\s*\(\s*\{[\s\S]{0,600}?\burl\s*:\s*['"`]([^'"`]+)['"`][\s\S]{0,600}?\}\s*\)/g;
    while ((match = urqlClient.exec(content)) !== null) {
      this.addCall(calls, 'urql', 'POST', match[1], content, match.index, 'createClient');
    }

    return calls;
  }

  private extractPythonCalls(content: string, fileContext: FileHttpContext): HttpClientCall[] {
    const calls: HttpClientCall[] = [];
    const direct = /\b(requests|httpx)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = direct.exec(content)) !== null) {
      this.addCall(calls, match[1], match[2], match[3], content, match.index);
    }

    const sessionCall = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = sessionCall.exec(content)) !== null) {
      const baseUrl = fileContext.baseUrls.get(match[1]);
      if (!baseUrl) continue;
      this.addCall(calls, this.libraryForBaseVariable(match[1]), match[2], joinEndpoint(baseUrl, match[3]), content, match.index);
    }

    return calls;
  }

  private extractJavaCalls(content: string, fileContext: FileHttpContext): HttpClientCall[] {
    const calls: HttpClientCall[] = [];
    let match: RegExpExecArray | null;

    const restTemplate = /\.\s*(getForObject|getForEntity|postForObject|postForEntity|put|delete|patchForObject)\s*\(\s*["']([^"']+)["']/g;
    while ((match = restTemplate.exec(content)) !== null) {
      this.addCall(calls, 'RestTemplate', javaRestTemplateMethod(match[1]), match[2], content, match.index);
    }

    const exchange = /\.exchange\s*\(\s*["']([^"']+)["']\s*,\s*HttpMethod\.([A-Z]+)/g;
    while ((match = exchange.exec(content)) !== null) {
      this.addCall(calls, 'RestTemplate', match[2], match[1], content, match.index);
    }

    const webClientCreate = /\bWebClient\s*\.\s*create\s*\(\s*["']([^"']+)["']\s*\)[\s\S]{0,500}?\.\s*(get|post|put|patch|delete|head)\s*\(\s*\)[\s\S]{0,300}?\.\s*uri\s*\(\s*["']([^"']+)["']/g;
    while ((match = webClientCreate.exec(content)) !== null) {
      this.addCall(calls, 'WebClient', match[2], joinEndpoint(match[1], match[3]), content, match.index);
    }

    const webClientVariable = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*\)[\s\S]{0,300}?\.\s*uri\s*\(\s*["']([^"']+)["']/g;
    while ((match = webClientVariable.exec(content)) !== null) {
      const baseUrl = fileContext.baseUrls.get(match[1]);
      if (!baseUrl) continue;
      this.addCall(calls, 'WebClient', match[2], joinEndpoint(baseUrl, match[3]), content, match.index);
    }

    const okHttp = /\bRequest\.Builder\s*\(\s*\)[\s\S]{0,500}?\.\s*url\s*\(\s*["']([^"']+)["'][\s\S]{0,500}?(?:\.\s*(get|post|put|patch|delete|head)\s*\(|\.\s*method\s*\(\s*["']([A-Z]+)["'])/g;
    while ((match = okHttp.exec(content)) !== null) {
      this.addCall(calls, 'OkHttp', match[2] || match[3] || 'GET', match[1], content, match.index);
    }

    calls.push(...this.extractFeignCalls(content, fileContext));
    return calls;
  }

  private extractGoCalls(content: string, fileContext: FileHttpContext): HttpClientCall[] {
    const calls: HttpClientCall[] = [];
    let match: RegExpExecArray | null;

    const direct = /\bhttp\.(Get|Post|Head)\s*\(\s*"([^"]+)"/g;
    while ((match = direct.exec(content)) !== null) {
      this.addCall(calls, 'net/http', match[1], match[2], content, match.index);
    }

    const newRequest = /\bhttp\.NewRequest\s*\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"|\bhttp\.NewRequestWithContext\s*\([^,]+,\s*"([A-Z]+)"\s*,\s*"([^"]+)"/g;
    while ((match = newRequest.exec(content)) !== null) {
      this.addCall(calls, 'net/http', match[1] || match[3], match[2] || match[4], content, match.index);
    }

    const clientCall = /\b([A-Za-z_][A-Za-z0-9_]*)\.(Get|Post|Head)\s*\(\s*"([^"]+)"/g;
    while ((match = clientCall.exec(content)) !== null) {
      if (match[1] === 'http') continue;
      const baseUrl = fileContext.baseUrls.get(match[1]);
      if (!baseUrl && !/^https?:\/\//.test(match[3])) continue;
      this.addCall(calls, 'net/http', match[2], baseUrl ? joinEndpoint(baseUrl, match[3]) : match[3], content, match.index);
    }

    const restyChain = /\bresty\.New\s*\(\s*\)(?:\s*\.\s*SetBaseURL\s*\(\s*"([^"]+)"\s*\))?[\s\S]{0,500}?\.\s*R\s*\(\s*\)[\s\S]{0,300}?\.\s*(Get|Post|Put|Patch|Delete|Head)\s*\(\s*"([^"]+)"/g;
    while ((match = restyChain.exec(content)) !== null) {
      this.addCall(calls, 'resty', match[2], match[1] ? joinEndpoint(match[1], match[3]) : match[3], content, match.index);
    }

    const restyVariable = /\b([A-Za-z_][A-Za-z0-9_]*)\.R\s*\(\s*\)[\s\S]{0,300}?\.\s*(Get|Post|Put|Patch|Delete|Head)\s*\(\s*"([^"]+)"/g;
    while ((match = restyVariable.exec(content)) !== null) {
      const baseUrl = fileContext.baseUrls.get(match[1]);
      if (!baseUrl && !/^https?:\/\//.test(match[3])) continue;
      this.addCall(calls, 'resty', match[2], baseUrl ? joinEndpoint(baseUrl, match[3]) : match[3], content, match.index);
    }

    return calls;
  }

  private extractFeignCalls(content: string, fileContext: FileHttpContext): HttpClientCall[] {
    const calls: HttpClientCall[] = [];
    for (const client of fileContext.feignInterfaces.values()) {
      const methodPattern = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'](?:\s*,\s*method\s*=\s*RequestMethod\.([A-Z]+))?[\s\S]{0,120}?\))?[\s\r\n\t ]+(?:[\w<>, ?]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = methodPattern.exec(content)) !== null) {
        const method = match[3] || springMappingMethod(match[1]);
        const endpoint = joinEndpoint(joinEndpoint(client.baseUrl || client.name, client.pathPrefix || ''), match[2] || '');
        this.addCall(calls, 'Feign', method, endpoint, content, match.index, match[4]);
      }
    }
    return calls;
  }

  private extractFileContext(content: string): FileHttpContext {
    const baseUrls = new Map<string, string>();
    let match: RegExpExecArray | null;

    const jsFactories = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:axios|ky|got)\s*\.\s*(?:create|extend)\s*\(\s*\{[\s\S]{0,400}?\b(?:baseURL|prefixUrl)\s*:\s*['"`]([^'"`]+)['"`]/g;
    while ((match = jsFactories.exec(content)) !== null) baseUrls.set(match[1], match[2]);

    // Client instances whose base URL is NOT a string literal
    // (`axios.create({ baseURL: import.meta.env.API_URL })` or no config at all)
    // are still real client instances — record them with an empty base so their
    // call sites are recognized (corpus-depth sweep fix). Literal-base factories
    // above win (already in the map).
    const jsInstanceOnly = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:axios|ky|got)\s*\.\s*(?:create|extend)\s*\(/g;
    while ((match = jsInstanceOnly.exec(content)) !== null) {
      if (!baseUrls.has(match[1])) baseUrls.set(match[1], '');
    }

    const pythonClients = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:requests\.Session\(\)|(?:httpx|aiohttp)\.(?:Client|AsyncClient|ClientSession)\s*\([\s\S]{0,200}?\bbase_url\s*=\s*['"]([^'"]+)['"])/g;
    while ((match = pythonClients.exec(content)) !== null) {
      if (match[2]) baseUrls.set(match[1], match[2]);
    }

    const aiohttpWith = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
    const aiohttpBase = /aiohttp\.ClientSession\s*\([\s\S]{0,200}?\bbase_url\s*=\s*['"]([^'"]+)['"][\s\S]{0,200}?\)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((match = aiohttpBase.exec(content)) !== null) baseUrls.set(match[2], match[1]);
    aiohttpWith.lastIndex = 0;

    const javaWebClient = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*WebClient\s*\.\s*(?:create|builder)\s*\(\s*(?:\)\s*\.\s*baseUrl\s*\(\s*)?["']([^"']+)["']/g;
    while ((match = javaWebClient.exec(content)) !== null) baseUrls.set(match[1], match[2]);

    const goResty = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*resty\.New\s*\(\s*\)\s*\.\s*SetBaseURL\s*\(\s*"([^"]+)"/g;
    while ((match = goResty.exec(content)) !== null) baseUrls.set(match[1], match[2]);

    const feignInterfaces = new Map<string, FeignClientInfo>();
    const feign = /@FeignClient\s*\(\s*([\s\S]{0,500}?)\)\s*(?:public\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((match = feign.exec(content)) !== null) {
      const args = match[1];
      const name = readJavaAnnotationString(args, 'name') || readJavaAnnotationString(args, 'value') || match[2];
      feignInterfaces.set(match[2], {
        name,
        baseUrl: readJavaAnnotationString(args, 'url'),
        pathPrefix: readJavaAnnotationString(args, 'path'),
      });
    }

    return { baseUrls, feignInterfaces };
  }

  private addCall(
    calls: HttpClientCall[],
    library: string,
    method: string,
    endpoint: string,
    content: string,
    index: number,
    declaration?: string
  ): void {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) return;
    calls.push({
      library,
      method: method.toUpperCase(),
      endpoint: normalized,
      line: lineForIndex(content, index),
      serviceAlias: serviceAliasFromEndpoint(normalized),
      declaration,
    });
  }

  private fileHasHttpClientEvidence(content: string, relativePath: string): boolean {
    if (JS_HTTP_IMPORT.test(content) || PY_HTTP_IMPORT.test(content) || JAVA_HTTP_IMPORT.test(content) || GO_HTTP_IMPORT.test(content)) return true;
    if (GLOBAL_FETCH_CALL.test(content)) return true;
    if (relativePath.endsWith('.java') && /@FeignClient\b/.test(content)) return true;
    if (relativePath.endsWith('.go') && /\bhttp\.NewRequest|\bhttp\.(Get|Post|Head)\s*\(/.test(content)) return true;
    return false;
  }

  private async readDependencyNames(projectPath: string): Promise<string[]> {
    const names = new Set<string>();
    await this.collectPackageJsonDependencies(projectPath, names);
    await this.collectRequirements(projectPath, names);
    await this.collectJavaDependencies(projectPath, names);
    await this.collectGoDependencies(projectPath, names);
    return [...names].map(name => name.toLowerCase());
  }

  private async collectPackageJsonDependencies(projectPath: string, names: Set<string>): Promise<void> {
    const files = await glob(['package.json', '**/package.json'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativePath of files) {
      const pkg = await fs.readJson(path.join(projectPath, relativePath)).catch(() => null);
      for (const deps of [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies]) {
        for (const name of Object.keys(deps || {})) names.add(name);
      }
    }
  }

  private async collectRequirements(projectPath: string, names: Set<string>): Promise<void> {
    const files = await glob(['requirements*.txt', '**/requirements*.txt', 'pyproject.toml', '**/pyproject.toml'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativePath of files) {
      const content = await this.readFileIfPresent(projectPath, relativePath);
      if (!content) continue;
      for (const line of content.split(/\r?\n/)) {
        const match = line.trim().match(/^["']?([a-zA-Z0-9_.-]+)["']?\s*(?:[><=!~,\]]|$)/);
        if (match) names.add(match[1]);
      }
    }
  }

  private async collectJavaDependencies(projectPath: string, names: Set<string>): Promise<void> {
    const files = await glob(['pom.xml', '**/pom.xml', 'build.gradle', 'build.gradle.kts', '**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativePath of files) {
      const content = await this.readFileIfPresent(projectPath, relativePath);
      if (!content) continue;
      for (const dep of HTTP_CLIENT_DEPENDENCIES) {
        if (content.toLowerCase().includes(dep.toLowerCase())) names.add(dep);
      }
    }
  }

  private async collectGoDependencies(projectPath: string, names: Set<string>): Promise<void> {
    const files = await glob(['go.mod', '**/go.mod'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativePath of files) {
      const content = await this.readFileIfPresent(projectPath, relativePath);
      if (!content) continue;
      for (const dep of HTTP_CLIENT_DEPENDENCIES) {
        if (content.includes(dep)) names.add(dep);
      }
    }
  }

  private async readFileIfPresent(projectPath: string, relativePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(projectPath, relativePath), 'utf8');
    } catch {
      return undefined;
    }
  }

  private ensureHttpClientSourceNode(relativePath: string, nodes: CASNode[], seen: Set<string>): string {
    const nodeId = `outbound_http_client_source_${this.safeId(relativePath)}`;
    if (seen.has(nodeId)) return nodeId;
    seen.add(nodeId);
    nodes.push(this.createNode(nodeId, `Outbound HTTP clients: ${relativePath}`, 'http_client_source', 3, relativePath, 1, 1, {
      library: 'outbound-http-client',
      subcategories: ['http-client', 'external-api'],
    }));
    return nodeId;
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    for (const contribution of existingAnalysis || []) {
      const found = contribution.nodes?.find(node => node.id === fileId || (node.type === 'file' && node.source?.file === relativePath));
      if (found) return found.id;
    }
    return undefined;
  }

  private libraryForBaseVariable(variable: string): string {
    const lower = variable.toLowerCase();
    if (lower.includes('ky')) return 'ky';
    if (lower.includes('got')) return 'got';
    if (lower.includes('httpx')) return 'httpx';
    if (lower.includes('aio')) return 'aiohttp';
    if (lower.includes('resty')) return 'resty';
    return 'http-client';
  }

  private safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9]/g, '_');
  }
}

function javaRestTemplateMethod(methodName: string): string {
  if (methodName.startsWith('post')) return 'POST';
  if (methodName.startsWith('put')) return 'PUT';
  if (methodName.startsWith('delete')) return 'DELETE';
  if (methodName.startsWith('patch')) return 'PATCH';
  return 'GET';
}

function springMappingMethod(annotation: string): string {
  return annotation.replace(/Mapping$/, '').replace(/^Get$/, 'GET').replace(/^Post$/, 'POST').replace(/^Put$/, 'PUT').replace(/^Patch$/, 'PATCH').replace(/^Delete$/, 'DELETE') || 'GET';
}

function readJavaAnnotationString(args: string, key: string): string | undefined {
  const keyMatch = args.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)["']`));
  if (keyMatch) return keyMatch[1];
  if (key === 'value') return args.match(/^\s*["']([^"']+)["']/)?.[1];
  return undefined;
}

function normalizeEndpoint(endpoint: string): string | undefined {
  let value = endpoint.trim();
  if (!value) return undefined;
  // Template-literal path segments (`/users/${id}`) are the NORM for REST call
  // sites — dropping every templated endpoint made the analyzer blind to most
  // real call surfaces (corpus-depth sweep fix). Normalize each interpolation
  // to a `{param}` placeholder instead.
  value = value.replace(/\$\{[^}]*\}/g, '{param}');
  // Reject endpoints with NO static content left (pure `${x}` / `/${x}/`):
  // a placeholder-only path names nothing and would fabricate an exit target.
  const staticPart = value.replace(/\{param\}/g, '').replace(/[\/]/g, '');
  if (!staticPart) return undefined;
  // Keep the original guard for non-template `{...}` fragments in non-URLs.
  if (value.includes('{') && !value.includes('{param}') && !value.startsWith('http')) return undefined;
  return value;
}

function joinEndpoint(base: string, endpoint: string): string {
  if (!base) return endpoint;
  if (!endpoint) return base;
  if (/^https?:\/\//.test(endpoint)) return endpoint;
  return `${base.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

function serviceAliasFromEndpoint(endpoint: string): string | undefined {
  const host = endpoint.match(/^https?:\/\/([A-Za-z0-9_.-]+)/)?.[1];
  if (host) return host;
  if (/^[A-Za-z0-9_.-]+$/.test(endpoint) && endpoint.includes('.')) return endpoint;
  return undefined;
}

function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}
