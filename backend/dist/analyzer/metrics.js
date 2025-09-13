"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricsReport = exports.MetricsCollector = void 0;
class MetricsCollector {
    constructor() {
        this.metrics = new Map();
        this.currentAnalysis = null;
        this.memoryInterval = null;
    }
    startAnalysis(analysisId, projectPath) {
        const metrics = {
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
        this.startMemoryMonitoring(analysisId);
    }
    completeAnalysis(analysisId, duration, blueprint) {
        const metrics = this.metrics.get(analysisId);
        if (!metrics)
            return;
        metrics.endTime = new Date();
        metrics.duration = duration;
        metrics.status = 'completed';
        metrics.summary = this.calculateSummary(blueprint, metrics);
        this.stopMemoryMonitoring();
        if (metrics.fileStats.totalFiles > 0 && duration > 0) {
            metrics.fileStats.processingRate = metrics.fileStats.totalFiles / (duration / 1000);
        }
    }
    failAnalysis(analysisId, error, duration) {
        const metrics = this.metrics.get(analysisId);
        if (!metrics)
            return;
        metrics.endTime = new Date();
        metrics.duration = duration;
        metrics.status = 'failed';
        this.recordError(analysisId, 'analysis', error);
        this.stopMemoryMonitoring();
    }
    recordOperation(operationName, duration, success, error, metadata) {
        if (!this.currentAnalysis)
            return;
        const metrics = this.metrics.get(this.currentAnalysis);
        if (!metrics)
            return;
        const operation = {
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
    recordError(analysisId, operation, error) {
        const metrics = this.metrics.get(analysisId);
        if (!metrics)
            return;
        const errorMetric = {
            timestamp: new Date(),
            operation,
            errorCode: error.code || 'UNKNOWN',
            message: error.message,
            recoverable: error.recoverable || false
        };
        metrics.errors.push(errorMetric);
    }
    updateFileStats(analysisId, stats) {
        const metrics = this.metrics.get(analysisId);
        if (!metrics)
            return;
        metrics.fileStats = { ...metrics.fileStats, ...stats };
    }
    startMemoryMonitoring(analysisId) {
        this.memoryInterval = setInterval(() => {
            this.recordMemoryUsage(analysisId);
        }, 5000);
    }
    stopMemoryMonitoring() {
        if (this.memoryInterval) {
            clearInterval(this.memoryInterval);
            this.memoryInterval = null;
        }
    }
    recordMemoryUsage(analysisId) {
        const metrics = this.metrics.get(analysisId);
        if (!metrics)
            return;
        const memUsage = process.memoryUsage();
        const memoryMetric = {
            timestamp: new Date(),
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            rss: memUsage.rss
        };
        metrics.memoryUsage.push(memoryMetric);
    }
    calculateSummary(blueprint, metrics) {
        const riskDistribution = {
            low: 0,
            medium: 0,
            high: 0,
            critical: 0
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
    calculatePerformanceScore(metrics) {
        let score = 100;
        score -= metrics.errors.length * 5;
        const failedOps = metrics.operations.filter(op => !op.success).length;
        score -= failedOps * 3;
        const slowOps = metrics.operations.filter(op => op.duration > 5000).length;
        score -= slowOps * 2;
        const avgMemory = metrics.memoryUsage.length > 0
            ? metrics.memoryUsage.reduce((sum, m) => sum + m.heapUsed, 0) / metrics.memoryUsage.length
            : 0;
        if (avgMemory > 500 * 1024 * 1024) {
            score -= 10;
        }
        if (metrics.fileStats.processingRate < 10) {
            score -= 5;
        }
        return Math.max(0, Math.min(100, score));
    }
    getMetrics(analysisId) {
        return this.metrics.get(analysisId);
    }
    getAllMetrics() {
        return Array.from(this.metrics.values());
    }
    generateReport(analysisId) {
        const metrics = this.metrics.get(analysisId);
        if (!metrics) {
            throw new Error(`No metrics found for analysis: ${analysisId}`);
        }
        return new MetricsReport(metrics);
    }
    clearMetrics(analysisId) {
        this.metrics.delete(analysisId);
    }
    clearAllMetrics() {
        this.metrics.clear();
    }
}
exports.MetricsCollector = MetricsCollector;
class MetricsReport {
    constructor(metrics) {
        this.metrics = metrics;
    }
    toConsole() {
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
    toJSON() {
        return {
            ...this.metrics,
            formattedDuration: this.formatDuration(this.metrics.duration || 0),
            operationSummary: this.getOperationSummary(),
            memoryPeak: this.getMemoryPeak(),
            errorRate: this.getErrorRate()
        };
    }
    toHTML() {
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
    generateHTMLContent() {
        return '<p>Detailed metrics would be displayed here</p>';
    }
    formatDuration(ms) {
        const seconds = ms / 1000;
        if (seconds < 60) {
            return `${seconds.toFixed(2)}s`;
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds.toFixed(2)}s`;
    }
    printOperationTimings() {
        const operations = [...this.metrics.operations]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 10);
        operations.forEach(op => {
            const status = op.success ? '✓' : '✗';
            const time = this.formatDuration(op.duration);
            console.log(`  ${status} ${op.name}: ${time}`);
        });
    }
    printMemoryStats() {
        if (this.metrics.memoryUsage.length === 0)
            return;
        const peak = this.getMemoryPeak();
        const avg = this.metrics.memoryUsage.reduce((sum, m) => sum + m.heapUsed, 0) / this.metrics.memoryUsage.length;
        console.log(`  Peak: ${this.formatBytes(peak)}`);
        console.log(`  Average: ${this.formatBytes(avg)}`);
    }
    getMemoryPeak() {
        if (this.metrics.memoryUsage.length === 0)
            return 0;
        return Math.max(...this.metrics.memoryUsage.map(m => m.heapUsed));
    }
    getOperationSummary() {
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
    getErrorRate() {
        const total = this.metrics.operations.length;
        const errors = this.metrics.errors.length;
        return total > 0 ? (errors / total * 100).toFixed(2) + '%' : '0%';
    }
    formatBytes(bytes) {
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
exports.MetricsReport = MetricsReport;
