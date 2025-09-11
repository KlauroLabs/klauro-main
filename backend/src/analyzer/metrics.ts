// Metrics collection and monitoring for analyzer performance
// Production-ready metrics tracking with aggregation and reporting

import { ArchitectureBlueprint } from '../types';

export interface AnalyzerMetrics {
  analysisId: string;
  projectPath: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  status: 'running' | 'completed' | 'failed';
  operations: OperationMetric[];
  summary?: AnalysisSummary;
  errors: ErrorMetric[];
  memoryUsage: MemoryMetric[];
  fileStats: FileStatistics;
}

export interface OperationMetric {
  name: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ErrorMetric {
  timestamp: Date;
  operation: string;
  errorCode: string;
  message: string;
  recoverable: boolean;
}

export interface MemoryMetric {
  timestamp: Date;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

export interface FileStatistics {
  totalFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalSize: number;
  averageSize: number;
  largestFile: { path: string; size: number };
  processingRate: number; // files per second
}

export interface AnalysisSummary {
  totalComponents: number;
  totalConnections: number;
  totalEntryPoints: number;
  totalExitPoints: number;
  averageComplexity: number;
  riskDistribution: {
    low: number;
    medium: number;
    high: number;
  };
  languageDistribution: Record<string, number>;
  frameworksDetected: string[];
  testCoverage?: number;
  analysisTime: number;
  performanceScore: number; // 0-100
}

export class MetricsCollector {
  private metrics: Map<string, AnalyzerMetrics> = new Map();
  private currentAnalysis: string | null = null;
  private memoryInterval: NodeJS.Timeout | null = null;

  startAnalysis(analysisId: string, projectPath: string): void {
    const metrics: AnalyzerMetrics = {
      analysisId,
      projectPath,
      startTime: new Date(),
      status: 'running',
      operations: [],
      errors: [],
      memoryUsage: [],
      fileStats: {
        totalFiles: 0,
        analyzedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        totalSize: 0,
        averageSize: 0,
        largestFile: { path: '', size: 0 },
        processingRate: 0
      }
    };

    this.metrics.set(analysisId, metrics);
    this.currentAnalysis = analysisId;

    // Start memory monitoring
    this.startMemoryMonitoring(analysisId);
  }

  completeAnalysis(analysisId: string, duration: number, blueprint: ArchitectureBlueprint): void {
    const metrics = this.metrics.get(analysisId);
    if (!metrics) return;

    metrics.endTime = new Date();
    metrics.duration = duration;
    metrics.status = 'completed';

    // Calculate summary
    metrics.summary = this.calculateSummary(blueprint, metrics);

    // Stop memory monitoring
    this.stopMemoryMonitoring();

    // Calculate file processing rate
    if (metrics.fileStats.totalFiles > 0 && duration > 0) {
      metrics.fileStats.processingRate = metrics.fileStats.totalFiles / (duration / 1000);
    }
  }

  failAnalysis(analysisId: string, error: Error, duration: number): void {
    const metrics = this.metrics.get(analysisId);
    if (!metrics) return;

    metrics.endTime = new Date();
    metrics.duration = duration;
    metrics.status = 'failed';

    this.recordError(analysisId, 'analysis', error);
    this.stopMemoryMonitoring();
  }

  recordOperation(
    operationName: string,
    duration: number,
    success: boolean,
    error?: Error,
    metadata?: Record<string, any>
  ): void {
    if (!this.currentAnalysis) return;
    
    const metrics = this.metrics.get(this.currentAnalysis);
    if (!metrics) return;

    const operation: OperationMetric = {
      name: operationName,
      startTime: new Date(Date.now() - duration),
      endTime: new Date(),
      duration,
      success,
      error: error?.message,
      metadata
    };

    metrics.operations.push(operation);

    if (!success && error) {
      this.recordError(this.currentAnalysis, operationName, error);
    }
  }

  recordError(analysisId: string, operation: string, error: Error): void {
    const metrics = this.metrics.get(analysisId);
    if (!metrics) return;

    const errorMetric: ErrorMetric = {
      timestamp: new Date(),
      operation,
      errorCode: (error as any).code || 'UNKNOWN',
      message: error.message,
      recoverable: (error as any).recoverable || false
    };

    metrics.errors.push(errorMetric);
  }

  updateFileStats(analysisId: string, stats: Partial<FileStatistics>): void {
    const metrics = this.metrics.get(analysisId);
    if (!metrics) return;

    metrics.fileStats = { ...metrics.fileStats, ...stats };
  }

  private startMemoryMonitoring(analysisId: string): void {
    this.memoryInterval = setInterval(() => {
      this.recordMemoryUsage(analysisId);
    }, 5000); // Record every 5 seconds
  }

  private stopMemoryMonitoring(): void {
    if (this.memoryInterval) {
      clearInterval(this.memoryInterval);
      this.memoryInterval = null;
    }
  }

  private recordMemoryUsage(analysisId: string): void {
    const metrics = this.metrics.get(analysisId);
    if (!metrics) return;

    const memUsage = process.memoryUsage();
    const memoryMetric: MemoryMetric = {
      timestamp: new Date(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss
    };

    metrics.memoryUsage.push(memoryMetric);
  }

  private calculateSummary(
    blueprint: ArchitectureBlueprint,
    metrics: AnalyzerMetrics
  ): AnalysisSummary {
    const riskDistribution = {
      low: 0,
      medium: 0,
      high: 0
    };

    blueprint.riskAreas.forEach(risk => {
      riskDistribution[risk.riskLevel]++;
    });

    const avgComplexity = blueprint.components.length > 0
      ? blueprint.components.reduce((sum, c) => sum + c.metadata.complexity, 0) / blueprint.components.length
      : 0;

    const performanceScore = this.calculatePerformanceScore(metrics);

    return {
      totalComponents: blueprint.components.length,
      totalConnections: blueprint.connections.length,
      totalEntryPoints: blueprint.entryPoints.length,
      totalExitPoints: blueprint.exitPoints.length,
      averageComplexity: avgComplexity,
      riskDistribution,
      languageDistribution: blueprint.metadata.languageDistribution,
      frameworksDetected: [blueprint.framework],
      testCoverage: blueprint.testingInfo.coverage.overall,
      analysisTime: metrics.duration || 0,
      performanceScore
    };
  }

  private calculatePerformanceScore(metrics: AnalyzerMetrics): number {
    let score = 100;

    // Deduct points for errors
    score -= metrics.errors.length * 5;

    // Deduct points for failed operations
    const failedOps = metrics.operations.filter(op => !op.success).length;
    score -= failedOps * 3;

    // Deduct points for slow operations
    const slowOps = metrics.operations.filter(op => op.duration > 5000).length;
    score -= slowOps * 2;

    // Deduct points for high memory usage
    const avgMemory = metrics.memoryUsage.length > 0
      ? metrics.memoryUsage.reduce((sum, m) => sum + m.heapUsed, 0) / metrics.memoryUsage.length
      : 0;
    
    if (avgMemory > 500 * 1024 * 1024) { // Over 500MB
      score -= 10;
    }

    // Deduct points for low file processing rate
    if (metrics.fileStats.processingRate < 10) {
      score -= 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  getMetrics(analysisId: string): AnalyzerMetrics | undefined {
    return this.metrics.get(analysisId);
  }

  getAllMetrics(): AnalyzerMetrics[] {
    return Array.from(this.metrics.values());
  }

  generateReport(analysisId: string): MetricsReport {
    const metrics = this.metrics.get(analysisId);
    if (!metrics) {
      throw new Error(`No metrics found for analysis: ${analysisId}`);
    }

    return new MetricsReport(metrics);
  }

  clearMetrics(analysisId: string): void {
    this.metrics.delete(analysisId);
  }

  clearAllMetrics(): void {
    this.metrics.clear();
  }
}

export class MetricsReport {
  constructor(private readonly metrics: AnalyzerMetrics) {}

  toConsole(): void {
    console.log('\n' + '='.repeat(60));
    console.log('ANALYSIS METRICS REPORT');
    console.log('='.repeat(60));
    
    console.log(`\nAnalysis ID: ${this.metrics.analysisId}`);
    console.log(`Project: ${this.metrics.projectPath}`);
    console.log(`Status: ${this.metrics.status}`);
    console.log(`Duration: ${this.formatDuration(this.metrics.duration || 0)}`);
    
    if (this.metrics.summary) {
      console.log('\n--- Summary ---');
      console.log(`Components: ${this.metrics.summary.totalComponents}`);
      console.log(`Connections: ${this.metrics.summary.totalConnections}`);
      console.log(`Entry Points: ${this.metrics.summary.totalEntryPoints}`);
      console.log(`Exit Points: ${this.metrics.summary.totalExitPoints}`);
      console.log(`Average Complexity: ${this.metrics.summary.averageComplexity.toFixed(2)}`);
      console.log(`Test Coverage: ${this.metrics.summary.testCoverage || 0}%`);
      console.log(`Performance Score: ${this.metrics.summary.performanceScore}/100`);
    }

    console.log('\n--- File Statistics ---');
    console.log(`Total Files: ${this.metrics.fileStats.totalFiles}`);
    console.log(`Analyzed: ${this.metrics.fileStats.analyzedFiles}`);
    console.log(`Skipped: ${this.metrics.fileStats.skippedFiles}`);
    console.log(`Failed: ${this.metrics.fileStats.failedFiles}`);
    console.log(`Processing Rate: ${this.metrics.fileStats.processingRate.toFixed(2)} files/sec`);

    console.log('\n--- Operation Timings ---');
    this.printOperationTimings();

    if (this.metrics.errors.length > 0) {
      console.log('\n--- Errors ---');
      this.metrics.errors.forEach(error => {
        console.log(`  [${error.operation}] ${error.message}`);
      });
    }

    console.log('\n--- Memory Usage ---');
    this.printMemoryStats();

    console.log('\n' + '='.repeat(60));
  }

  toJSON(): Record<string, any> {
    return {
      ...this.metrics,
      formattedDuration: this.formatDuration(this.metrics.duration || 0),
      operationSummary: this.getOperationSummary(),
      memoryPeak: this.getMemoryPeak(),
      errorRate: this.getErrorRate()
    };
  }

  toHTML(): string {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Analysis Metrics Report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #333; }
          .metric { margin: 10px 0; }
          .label { font-weight: bold; display: inline-block; width: 150px; }
          .value { color: #666; }
          .error { color: #d9534f; }
          .success { color: #5cb85c; }
          .warning { color: #f0ad4e; }
          table { border-collapse: collapse; width: 100%; margin: 20px 0; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
        </style>
      </head>
      <body>
        <h1>Analysis Metrics Report</h1>
        ${this.generateHTMLContent()}
      </body>
      </html>
    `;
    return html;
  }

  private generateHTMLContent(): string {
    // Implementation would generate detailed HTML content
    return '<p>Detailed metrics would be displayed here</p>';
  }

  private formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(2)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds.toFixed(2)}s`;
  }

  private printOperationTimings(): void {
    const operations = [...this.metrics.operations]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    operations.forEach(op => {
      const status = op.success ? '✓' : '✗';
      const time = this.formatDuration(op.duration);
      console.log(`  ${status} ${op.name}: ${time}`);
    });
  }

  private printMemoryStats(): void {
    if (this.metrics.memoryUsage.length === 0) return;

    const peak = this.getMemoryPeak();
    const avg = this.metrics.memoryUsage.reduce((sum, m) => sum + m.heapUsed, 0) / this.metrics.memoryUsage.length;

    console.log(`  Peak: ${this.formatBytes(peak)}`);
    console.log(`  Average: ${this.formatBytes(avg)}`);
  }

  private getMemoryPeak(): number {
    if (this.metrics.memoryUsage.length === 0) return 0;
    return Math.max(...this.metrics.memoryUsage.map(m => m.heapUsed));
  }

  private getOperationSummary(): Record<string, any> {
    const total = this.metrics.operations.length;
    const successful = this.metrics.operations.filter(op => op.success).length;
    const failed = total - successful;
    const avgDuration = total > 0
      ? this.metrics.operations.reduce((sum, op) => sum + op.duration, 0) / total
      : 0;

    return {
      total,
      successful,
      failed,
      successRate: total > 0 ? (successful / total * 100).toFixed(2) + '%' : '0%',
      averageDuration: this.formatDuration(avgDuration)
    };
  }

  private getErrorRate(): string {
    const total = this.metrics.operations.length;
    const errors = this.metrics.errors.length;
    return total > 0 ? (errors / total * 100).toFixed(2) + '%' : '0%';
  }

  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let value = bytes;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }
}