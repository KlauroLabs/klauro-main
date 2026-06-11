export interface EnvironmentCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface HandshakeProbeResult {
  ok: boolean;
  ms: number | null;
  limitMs?: number;
  serverInfo?: unknown;
  detail: string;
}

export interface BundleToolCallResult {
  ok: boolean;
  ms?: number;
  payload?: any;
  detail: string;
}

export declare const MINIMUM_NODE_MAJOR: number;
export declare const DEFAULT_HANDSHAKE_LIMIT_MS: number;
export declare const OPERATING_LOOP_MARKER: string;

export declare function checkResult(id: string, status: 'pass' | 'warn' | 'fail', detail: string, fix?: string): EnvironmentCheck;
export declare function formatCheck(check: EnvironmentCheck): string;
export declare function evaluateNodeVersion(versionString: string, minimumMajor?: number): EnvironmentCheck;
export declare function evaluateBundleState(input: {
  bundleExists: boolean;
  serverExists: boolean;
  handshakeExists: boolean;
  workerExists?: boolean;
  bundleMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  packageRoot: string;
}): EnvironmentCheck;
export declare function newestMtimeMs(rootDir: string): number | null;
export declare function inspectBundle(input: { packageRoot: string; sourceDirs: string[] }): EnvironmentCheck;
export declare function storageAnalysesDir(env?: NodeJS.ProcessEnv): string;
export declare function storageRoot(env?: NodeJS.ProcessEnv): string;
export declare function evaluateStorageState(input: {
  analysesDir: string;
  created: boolean;
  writable: boolean;
  usageBytes?: number;
  writeError?: string;
}): EnvironmentCheck;
export declare function inspectStorage(env?: NodeJS.ProcessEnv): EnvironmentCheck;
export declare function directorySizeBytes(rootDir: string): number;
export declare function formatBytes(bytes: number): string;
export declare function summarizeAiProviders(env?: NodeJS.ProcessEnv): string[];
export declare function probeOllama(baseUrl?: string, timeoutMs?: number): Promise<{ reachable: boolean; models?: number; detail?: string }>;
export declare function evaluateAiProviders(input: {
  configured: string[];
  ollamaConfigured: boolean;
  ollamaProbe?: { reachable: boolean; models?: number; detail?: string };
}): EnvironmentCheck;
export declare function evaluateZstd(input: { zstdAvailable: boolean; compressedFiles: number }): EnvironmentCheck;
export declare function hasZstdBinary(): boolean;
export declare function countZstdAnalysisFiles(analysesDir: string): number;
export declare function findKlauroProcesses(): Array<{ pid: number; command: string }>;
export declare function evaluateWatches(processes: Array<{ pid: number; command: string }>): EnvironmentCheck;
export declare function probeHandshake(input: {
  bundlePath: string;
  profile?: string;
  maxMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}): Promise<HandshakeProbeResult>;
export declare function callBundleTool(input: {
  bundlePath: string;
  tool: string;
  args?: Record<string, unknown>;
  profile?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}): Promise<BundleToolCallResult>;
export declare function decideBuildAction(input: { distComplete: boolean; rebuildRequested: boolean }): { build: boolean; reason: string };
export declare function claudeRegisterCommand(bundlePath: string, scope?: string): string;
export declare function mcpJsonSnippet(bundlePath: string, packageRoot: string): string;
export declare function codexInstructions(bundlePath: string): string;
export declare function operatingLoopSnippet(): string;
export declare function shouldAppendOperatingLoop(existingContent: string | undefined): boolean;
