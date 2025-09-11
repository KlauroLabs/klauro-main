"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorFormatter = exports.FallbackStrategy = exports.RetryStrategy = exports.ErrorHandler = exports.AggregatedError = exports.ConfigurationError = exports.ManifestError = exports.PluginError = exports.TimeoutError = exports.ParsingError = exports.LanguageDetectionError = exports.FileSystemError = exports.ValidationError = exports.AnalyzerError = void 0;
class AnalyzerError extends Error {
    constructor(message, code = 'ANALYZER_ERROR', context, recoverable = false) {
        super(message);
        this.name = 'AnalyzerError';
        this.code = code;
        this.context = context;
        this.timestamp = new Date();
        this.recoverable = recoverable;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AnalyzerError);
        }
    }
    toJSON() {
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
exports.AnalyzerError = AnalyzerError;
class ValidationError extends AnalyzerError {
    constructor(message, context) {
        super(message, 'VALIDATION_ERROR', context, true);
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
class FileSystemError extends AnalyzerError {
    constructor(message, code = 'FS_ERROR', context) {
        super(message, code, context, true);
        this.name = 'FileSystemError';
    }
}
exports.FileSystemError = FileSystemError;
class LanguageDetectionError extends AnalyzerError {
    constructor(message, context) {
        super(message, 'LANGUAGE_DETECTION_ERROR', context, false);
        this.name = 'LanguageDetectionError';
    }
}
exports.LanguageDetectionError = LanguageDetectionError;
class ParsingError extends AnalyzerError {
    constructor(message, filePath, line, column, context) {
        super(message, 'PARSING_ERROR', { ...context, filePath, line, column }, true);
        this.name = 'ParsingError';
        this.filePath = filePath;
        this.line = line;
        this.column = column;
    }
}
exports.ParsingError = ParsingError;
class TimeoutError extends AnalyzerError {
    constructor(operation, timeout, context) {
        super(`Operation '${operation}' timed out after ${timeout}ms`, 'TIMEOUT_ERROR', { ...context, operation, timeout }, false);
        this.name = 'TimeoutError';
    }
}
exports.TimeoutError = TimeoutError;
class PluginError extends AnalyzerError {
    constructor(message, pluginId, pluginName, context) {
        super(message, 'PLUGIN_ERROR', { ...context, pluginId, pluginName }, false);
        this.name = 'PluginError';
        this.pluginId = pluginId;
        this.pluginName = pluginName;
    }
}
exports.PluginError = PluginError;
class ManifestError extends AnalyzerError {
    constructor(message, context) {
        super(message, 'MANIFEST_ERROR', context, false);
        this.name = 'ManifestError';
    }
}
exports.ManifestError = ManifestError;
class ConfigurationError extends AnalyzerError {
    constructor(message, context) {
        super(message, 'CONFIGURATION_ERROR', context, true);
        this.name = 'ConfigurationError';
    }
}
exports.ConfigurationError = ConfigurationError;
class AggregatedError extends AnalyzerError {
    constructor(errors, message) {
        const errorMessage = message || `${errors.length} errors occurred during analysis`;
        super(errorMessage, 'AGGREGATED_ERROR', { errorCount: errors.length }, false);
        this.name = 'AggregatedError';
        this.errors = errors;
    }
    toJSON() {
        return {
            ...super.toJSON(),
            errors: this.errors.map(e => e.toJSON())
        };
    }
}
exports.AggregatedError = AggregatedError;
class ErrorHandler {
    constructor(maxErrors = 100, throwOnFirstError = false) {
        this.errors = [];
        this.maxErrors = maxErrors;
        this.throwOnFirstError = throwOnFirstError;
    }
    handleError(error) {
        const analyzerError = this.normalizeError(error);
        if (this.throwOnFirstError && !analyzerError.recoverable) {
            throw analyzerError;
        }
        this.errors.push(analyzerError);
        if (this.errors.length >= this.maxErrors) {
            throw new AggregatedError(this.errors, `Maximum error count (${this.maxErrors}) exceeded`);
        }
    }
    normalizeError(error) {
        if (error instanceof AnalyzerError) {
            return error;
        }
        return new AnalyzerError(error.message, 'UNKNOWN_ERROR', { originalError: error.name, stack: error.stack });
    }
    hasErrors() {
        return this.errors.length > 0;
    }
    getErrors() {
        return [...this.errors];
    }
    clearErrors() {
        this.errors = [];
    }
    throwIfErrors() {
        if (this.errors.length > 0) {
            throw new AggregatedError(this.errors);
        }
    }
}
exports.ErrorHandler = ErrorHandler;
class RetryStrategy {
    constructor(maxRetries = 3, retryDelay = 1000, exponentialBackoff = true) {
        this.maxRetries = maxRetries;
        this.retryDelay = retryDelay;
        this.exponentialBackoff = exponentialBackoff;
    }
    canRecover(error) {
        return error.recoverable &&
            ['FS_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR'].includes(error.code);
    }
    async recover(error) {
        let delay = this.retryDelay;
        for (let i = 0; i < this.maxRetries; i++) {
            await this.sleep(delay);
            if (this.exponentialBackoff) {
                delay *= 2;
            }
        }
        throw error;
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.RetryStrategy = RetryStrategy;
class FallbackStrategy {
    constructor(fallbackValue) {
        this.fallbackValue = fallbackValue;
    }
    canRecover(error) {
        return error.recoverable;
    }
    async recover(error) {
        console.warn(`Using fallback value due to error: ${error.message}`);
        return this.fallbackValue;
    }
}
exports.FallbackStrategy = FallbackStrategy;
class ErrorFormatter {
    static toHumanReadable(error) {
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
    static toJSON(error) {
        return JSON.stringify(error.toJSON(), null, 2);
    }
    static toLogEntry(error) {
        return {
            timestamp: error.timestamp.toISOString(),
            level: error.recoverable ? 'warning' : 'error',
            code: error.code,
            message: error.message,
            context: error.context,
            stack: error.stack?.split('\n').slice(0, 5)
        };
    }
}
exports.ErrorFormatter = ErrorFormatter;
