import * as path from 'path';
import * as fs from 'fs-extra';

export class SecurityError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class PathSecurity {
  private static readonly DANGEROUS_PATTERNS = [
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

  private static readonly MAX_PATH_LENGTH = 4096;
  private static readonly MAX_FILENAME_LENGTH = 255;

  static sanitizePath(inputPath: string, basePath: string): string {
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

  static validatePath(targetPath: string, basePath: string): void {
    this.sanitizePath(targetPath, basePath);
  }

  static isPathSafe(targetPath: string, basePath: string): boolean {
    try {
      this.sanitizePath(targetPath, basePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class FileSecurity {
  private static readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly ALLOWED_EXTENSIONS = new Set([
    '.ts', '.js', '.py', '.java', '.cs', '.go', '.rs', '.php', '.cpp', '.c', '.h', '.hpp',
    '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.txt', '.cfg', '.ini', '.env',
    '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig'
  ]);

  static async validateFileAccess(filePath: string, basePath: string): Promise<void> {
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

  static async safeReadFile(filePath: string, basePath: string): Promise<string> {
    await this.validateFileAccess(filePath, basePath);
    const safePath = PathSecurity.sanitizePath(filePath, basePath);
    
    try {
      return await fs.readFile(safePath, 'utf-8');
    } catch (error) {
      throw new SecurityError(
        `Failed to read file: ${(error as Error).message}`, 
        'READ_ERROR'
      );
    }
  }

  static async safePathExists(filePath: string, basePath: string): Promise<boolean> {
    try {
      const safePath = PathSecurity.sanitizePath(filePath, basePath);
      return await fs.pathExists(safePath);
    } catch {
      return false;
    }
  }

  static async safeStat(filePath: string, basePath: string): Promise<fs.Stats> {
    const safePath = PathSecurity.sanitizePath(filePath, basePath);
    try {
      return await fs.stat(safePath);
    } catch (error) {
      throw new SecurityError(
        `Failed to stat file: ${(error as Error).message}`, 
        'STAT_ERROR'
      );
    }
  }
}