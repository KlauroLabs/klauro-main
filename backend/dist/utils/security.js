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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileSecurity = exports.PathSecurity = exports.SecurityError = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class SecurityError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'SecurityError';
    }
}
exports.SecurityError = SecurityError;
class PathSecurity {
    static sanitizePath(inputPath, basePath) {
        if (!inputPath || typeof inputPath !== 'string') {
            throw new SecurityError('Invalid path input', 'INVALID_PATH');
        }
        if (inputPath.length > this.MAX_PATH_LENGTH) {
            throw new SecurityError('Path too long', 'PATH_TOO_LONG');
        }
        const normalizedPath = path.normalize(inputPath).replace(/\\/g, '/');
        for (const pattern of this.DANGEROUS_PATTERNS) {
            if (pattern.test(normalizedPath)) {
                throw new SecurityError(`Dangerous path pattern detected: ${inputPath}`, 'DANGEROUS_PATH');
            }
        }
        const resolvedPath = path.resolve(basePath, normalizedPath);
        const resolvedBasePath = path.resolve(basePath);
        if (!resolvedPath.startsWith(resolvedBasePath + path.sep) && resolvedPath !== resolvedBasePath) {
            throw new SecurityError('Path traversal detected', 'PATH_TRAVERSAL');
        }
        const filename = path.basename(resolvedPath);
        if (filename.length > this.MAX_FILENAME_LENGTH) {
            throw new SecurityError('Filename too long', 'FILENAME_TOO_LONG');
        }
        return resolvedPath;
    }
    static validatePath(targetPath, basePath) {
        this.sanitizePath(targetPath, basePath);
    }
    static isPathSafe(targetPath, basePath) {
        try {
            this.sanitizePath(targetPath, basePath);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.PathSecurity = PathSecurity;
PathSecurity.DANGEROUS_PATTERNS = [
    /\.\./,
    /\/\.\./,
    /\.\.\\/,
    /~\//,
    /\/$/,
    /^\/(?:etc|proc|sys|dev|var|tmp|bin|sbin|usr\/bin|usr\/sbin)\//i,
    /[<>:"|?*]/,
    /\x00/,
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
];
PathSecurity.MAX_PATH_LENGTH = 4096;
PathSecurity.MAX_FILENAME_LENGTH = 255;
class FileSecurity {
    static async validateFileAccess(filePath, basePath) {
        const safePath = PathSecurity.sanitizePath(filePath, basePath);
        const stats = await fs.stat(safePath).catch(() => {
            throw new SecurityError(`File does not exist: ${filePath}`, 'FILE_NOT_FOUND');
        });
        if (stats.size > this.MAX_FILE_SIZE) {
            throw new SecurityError(`File too large: ${stats.size} bytes`, 'FILE_TOO_LARGE');
        }
        const ext = path.extname(filePath).toLowerCase();
        if (ext && !this.ALLOWED_EXTENSIONS.has(ext)) {
            throw new SecurityError(`File extension not allowed: ${ext}`, 'INVALID_EXTENSION');
        }
        if (!stats.isFile()) {
            throw new SecurityError('Path is not a file', 'NOT_A_FILE');
        }
    }
    static async safeReadFile(filePath, basePath) {
        await this.validateFileAccess(filePath, basePath);
        const safePath = PathSecurity.sanitizePath(filePath, basePath);
        try {
            return await fs.readFile(safePath, 'utf-8');
        }
        catch (error) {
            throw new SecurityError(`Failed to read file: ${error.message}`, 'READ_ERROR');
        }
    }
    static async safePathExists(filePath, basePath) {
        try {
            const safePath = PathSecurity.sanitizePath(filePath, basePath);
            return await fs.pathExists(safePath);
        }
        catch {
            return false;
        }
    }
    static async safeStat(filePath, basePath) {
        const safePath = PathSecurity.sanitizePath(filePath, basePath);
        try {
            return await fs.stat(safePath);
        }
        catch (error) {
            throw new SecurityError(`Failed to stat file: ${error.message}`, 'STAT_ERROR');
        }
    }
}
exports.FileSecurity = FileSecurity;
FileSecurity.MAX_FILE_SIZE = 10 * 1024 * 1024;
FileSecurity.ALLOWED_EXTENSIONS = new Set([
    '.ts', '.js', '.py', '.java', '.cs', '.go', '.rs', '.php', '.cpp', '.c', '.h', '.hpp',
    '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.txt', '.cfg', '.ini', '.env',
    '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig'
]);
