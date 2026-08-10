// Custom error types for the analyzer system
// Production-ready error handling with proper error codes and context

export class AnalyzerError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, any>;
  public readonly timestamp: Date;
  public readonly recoverable: boolean;

  constructor(
    message: string,
    code: string = 'ANALYZER_ERROR',
    context?: Record<string, any>,
    recoverable: boolean = false
  ) {
    super(message);
    this.name = 'AnalyzerError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date();
    this.recoverable = recoverable;
    
    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AnalyzerError);
    }
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp,
      recoverable: this.recoverable,
      stack: this.stack
    };
  }
}

export class ValidationError extends AnalyzerError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', context, true);
    this.name = 'ValidationError';
  }
}

export class FileSystemError extends AnalyzerError {
  constructor(message: string, code: string = 'FS_ERROR', context?: Record<string, any>) {
    super(message, code, context, true);
    this.name = 'FileSystemError';
  }
}

export class LanguageDetectionError extends AnalyzerError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'LANGUAGE_DETECTION_ERROR', context, false);
    this.name = 'LanguageDetectionError';
  }
}

export class ParsingError extends AnalyzerError {
  public readonly filePath?: string;
  public readonly line?: number;
  public readonly column?: number;

  constructor(
    message: string,
    filePath?: string,
    line?: number,
    column?: number,
    context?: Record<string, any>
  ) {
    super(
      message,
      'PARSING_ERROR',
      { ...context, filePath, line, column },
      true
    );
    this.name = 'ParsingError';
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

export class TimeoutError extends AnalyzerError {
  constructor(operation: string, timeout: number, context?: Record<string, any>) {
    super(
      `Operation '${operation}' timed out after ${timeout}ms`,
      'TIMEOUT_ERROR',
      { ...context, operation, timeout },
      false
    );
    this.name = 'TimeoutError';
  }
}

export class PluginError extends AnalyzerError {
  public readonly pluginId?: string;
  public readonly pluginName?: string;

  constructor(
    message: string,
    pluginId?: string,
    pluginName?: string,
    context?: Record<string, any>
  ) {
    super(
      message,
      'PLUGIN_ERROR',
      { ...context, pluginId, pluginName },
      false
    );
    this.name = 'PluginError';
    this.pluginId = pluginId;
    this.pluginName = pluginName;
  }
}

/**
 * Thrown when a native N-API addon required for parsing (the `tree-sitter`
 * binding and its per-language grammars) cannot be loaded — most commonly a
 * missing prebuilt binary for the running Node ABI (e.g. no `tree-sitter`
 * prebuild exists yet for a newly-released Node major version).
 *
 * This is deliberately NOT recoverable and deliberately distinct from
 * ParsingError: a single file failing to parse is a per-file, often-recoverable
 * event (log a warning, skip the file, keep going). A native addon failing to
 * load is a PROCESS-WIDE, deterministic failure — every file of every language
 * routed through this binding will fail identically and silently produce zero
 * nodes, which is indistinguishable from a legitimately tiny/empty project
 * unless this is surfaced loudly. Callers along the parse path must check for
 * this error type and RETHROW it rather than swallowing it into a per-file
 * warning (see tree-sitter-parser.ts, tree-sitter-ts-extractor.ts,
 * typescript-javascript-analyzer.ts).
 */
export class NativeAddonUnavailableError extends AnalyzerError {
  public readonly addon: string;

  constructor(addon: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Native addon '${addon}' failed to load — tree-sitter-backed parsing is unavailable for this process ` +
      `(${NATIVE_ADDON_UNAVAILABLE_MARKER}). This usually means there is no prebuilt binary for the running ` +
      `Node ABI (node ${process.version}, ${process.platform}/${process.arch}). Rebuild native dependencies ` +
      `under a supported Node version, or run under a Node version with a prebuilt binary. Underlying error: ${causeMessage}`,
      'NATIVE_ADDON_UNAVAILABLE',
      { addon, nodeVersion: process.version, platform: process.platform, arch: process.arch, cause: causeMessage },
      false
    );
    this.name = 'NativeAddonUnavailableError';
    this.addon = addon;
  }
}

/**
 * A short, greppable marker embedded in NativeAddonUnavailableError's message.
 * Necessary because errors crossing a worker_thread boundary are rehydrated
 * from a plain message STRING (postMessage cannot clone class identity), so
 * `instanceof NativeAddonUnavailableError` does not survive that trip. Any
 * code that receives an Error from a worker and needs to tell "this file had
 * a one-off issue" from "the native addon is completely unavailable" should
 * check `isNativeAddonUnavailableError` instead of `instanceof`.
 */
export const NATIVE_ADDON_UNAVAILABLE_MARKER = 'NATIVE_ADDON_UNAVAILABLE';

/** True for a real NativeAddonUnavailableError OR a rehydrated Error whose
 *  message still carries the marker (post worker_thread round-trip). */
export function isNativeAddonUnavailableError(error: unknown): boolean {
  if (error instanceof NativeAddonUnavailableError) return true;
  return error instanceof Error && error.message.includes(NATIVE_ADDON_UNAVAILABLE_MARKER);
}

export class ManifestError extends AnalyzerError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'MANIFEST_ERROR', context, false);
    this.name = 'ManifestError';
  }
}

export class ConfigurationError extends AnalyzerError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONFIGURATION_ERROR', context, true);
    this.name = 'ConfigurationError';
  }
}

// Error aggregator for collecting multiple errors
export class AggregatedError extends AnalyzerError {
  public readonly errors: AnalyzerError[];

  constructor(errors: AnalyzerError[], message?: string) {
    const errorMessage = message || `${errors.length} errors occurred during analysis`;
    super(
      errorMessage,
      'AGGREGATED_ERROR',
      { errorCount: errors.length },
      false
    );
    this.name = 'AggregatedError';
    this.errors = errors;
  }

  toJSON(): Record<string, any> {
    return {
      ...super.toJSON(),
      errors: this.errors.map(e => e.toJSON())
    };
  }
}

// Error handler utility
export class ErrorHandler {
  private errors: AnalyzerError[] = [];
  private readonly maxErrors: number;
  private readonly throwOnFirstError: boolean;

  constructor(maxErrors: number = 100, throwOnFirstError: boolean = false) {
    this.maxErrors = maxErrors;
    this.throwOnFirstError = throwOnFirstError;
  }

  handleError(error: Error): void {
    const analyzerError = this.normalizeError(error);
    
    if (this.throwOnFirstError && !analyzerError.recoverable) {
      throw analyzerError;
    }

    this.errors.push(analyzerError);

    if (this.errors.length >= this.maxErrors) {
      throw new AggregatedError(
        this.errors,
        `Maximum error count (${this.maxErrors}) exceeded`
      );
    }
  }

  private normalizeError(error: Error): AnalyzerError {
    if (error instanceof AnalyzerError) {
      return error;
    }

    return new AnalyzerError(
      error.message,
      'UNKNOWN_ERROR',
      { originalError: error.name, stack: error.stack }
    );
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  getErrors(): AnalyzerError[] {
    return [...this.errors];
  }

  clearErrors(): void {
    this.errors = [];
  }

  throwIfErrors(): void {
    if (this.errors.length > 0) {
      throw new AggregatedError(this.errors);
    }
  }
}

// Error recovery strategies
export interface ErrorRecoveryStrategy {
  canRecover(error: AnalyzerError): boolean;
  recover(error: AnalyzerError): Promise<any>;
}

export class RetryStrategy implements ErrorRecoveryStrategy {
  constructor(
    private readonly maxRetries: number = 3,
    private readonly retryDelay: number = 1000,
    private readonly exponentialBackoff: boolean = true
  ) {}

  canRecover(error: AnalyzerError): boolean {
    return error.recoverable && 
           ['FS_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR'].includes(error.code);
  }

  async recover(error: AnalyzerError): Promise<any> {
    let delay = this.retryDelay;
    
    for (let i = 0; i < this.maxRetries; i++) {
      await this.sleep(delay);
      
      if (this.exponentialBackoff) {
        delay *= 2;
      }
      
      // Actual retry logic would be implemented by the caller
      // This just provides the retry timing mechanism
    }
    
    throw error;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class FallbackStrategy implements ErrorRecoveryStrategy {
  constructor(private readonly fallbackValue: any) {}

  canRecover(error: AnalyzerError): boolean {
    return error.recoverable;
  }

  async recover(error: AnalyzerError): Promise<any> {
    console.warn(`Using fallback value due to error: ${error.message}`);
    return this.fallbackValue;
  }
}

// Error formatters for different output formats
export class ErrorFormatter {
  static toHumanReadable(error: AnalyzerError): string {
    let message = `[${error.code}] ${error.message}`;
    
    if (error.context) {
      message += '\nContext:';
      for (const [key, value] of Object.entries(error.context)) {
        message += `\n  ${key}: ${JSON.stringify(value)}`;
      }
    }
    
    if (error instanceof ParsingError && error.filePath) {
      message += `\nLocation: ${error.filePath}`;
      if (error.line !== undefined) {
        message += `:${error.line}`;
        if (error.column !== undefined) {
          message += `:${error.column}`;
        }
      }
    }
    
    return message;
  }

  static toJSON(error: AnalyzerError): string {
    return JSON.stringify(error.toJSON(), null, 2);
  }

  static toLogEntry(error: AnalyzerError): Record<string, any> {
    return {
      timestamp: error.timestamp.toISOString(),
      level: error.recoverable ? 'warning' : 'error',
      code: error.code,
      message: error.message,
      context: error.context,
      stack: error.stack?.split('\n').slice(0, 5) // First 5 lines of stack
    };
  }
}