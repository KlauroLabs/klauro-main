import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { 
  Issue, 
  IssueType, 
  IssueSeverity, 
  IssueStatus, 
  IssueSource 
} from '../database/entities/issue.entity';
import { Project } from '../database/entities/project.entity';
import { AnalysisResult } from '../database/entities/analysis-result.entity';
import { TelemetrySnapshot, TelemetryType } from '../database/entities/telemetry-snapshot.entity';
import { PatternDetection, PatternType } from '../database/entities/pattern-detection.entity';
import { Component } from '../database/entities/component.entity';

export interface IssueDetectionConfig {
  errorRateThreshold: number;
  responseTimeThreshold: number;
  memoryUsageThreshold: number;
  cpuUsageThreshold: number;
  complexityThreshold: number;
  testCoverageThreshold: number;
  duplicateCodeThreshold: number;
  securityScanEnabled: boolean;
  performanceScanEnabled: boolean;
}

export interface DetectedIssue {
  type: IssueType;
  severity: IssueSeverity;
  title: string;
  description: string;
  location?: any;
  suggestedFix?: string;
  metadata?: any;
}

@Injectable()
export class IssueDetectionService {
  private readonly logger = new Logger(IssueDetectionService.name);
  private readonly defaultConfig: IssueDetectionConfig = {
    errorRateThreshold: 5, // 5% error rate
    responseTimeThreshold: 1000, // 1 second
    memoryUsageThreshold: 80, // 80% memory usage
    cpuUsageThreshold: 80, // 80% CPU usage
    complexityThreshold: 10, // Cyclomatic complexity
    testCoverageThreshold: 60, // 60% test coverage
    duplicateCodeThreshold: 10, // 10% duplicate code
    securityScanEnabled: true,
    performanceScanEnabled: true,
  };

  constructor(
    @InjectRepository(Issue)
    private readonly issueRepository: EntityRepository<Issue>,
    @InjectRepository(Project)
    private readonly projectRepository: EntityRepository<Project>,
    @InjectRepository(AnalysisResult)
    private readonly analysisRepository: EntityRepository<AnalysisResult>,
    @InjectRepository(TelemetrySnapshot)
    private readonly telemetryRepository: EntityRepository<TelemetrySnapshot>,
    @InjectRepository(PatternDetection)
    private readonly patternRepository: EntityRepository<PatternDetection>,
    @InjectRepository(Component)
    private readonly componentRepository: EntityRepository<Component>,
  ) {}

  /**
   * Scan project for issues based on analysis results
   */
  async scanAnalysisResults(
    projectId: string,
    analysisResultId: string,
    config?: Partial<IssueDetectionConfig>,
  ): Promise<Issue[]> {
    const mergedConfig = { ...this.defaultConfig, ...config };
    const issues: Issue[] = [];

    try {
      const analysisResult = await this.analysisRepository.findOne(
        { id: analysisResultId, project: projectId },
        { populate: ['project', 'patterns'] },
      );

      if (!analysisResult) {
        throw new Error('Analysis result not found');
      }

      // Scan for architecture issues
      const architectureIssues = await this.detectArchitectureIssues(
        analysisResult,
        mergedConfig,
      );
      issues.push(...architectureIssues);

      // Scan for quality issues
      const qualityIssues = await this.detectQualityIssues(
        analysisResult,
        mergedConfig,
      );
      issues.push(...qualityIssues);

      // Scan for dependency issues
      const dependencyIssues = await this.detectDependencyIssues(
        analysisResult,
        mergedConfig,
      );
      issues.push(...dependencyIssues);

      // Scan patterns for issues
      const patternIssues = await this.detectPatternIssues(
        analysisResult.patterns.getItems(),
        mergedConfig,
      );
      issues.push(...patternIssues);

      // Persist detected issues
      const persistedIssues = await this.persistIssues(
        issues,
        projectId,
        IssueSource.STATIC_ANALYSIS,
      );

      this.logger.log(
        `Detected ${persistedIssues.length} issues for project ${projectId}`,
      );

      return persistedIssues;
    } catch (error) {
      this.logger.error('Error scanning analysis results', error);
      throw error;
    }
  }

  /**
   * Scan telemetry data for runtime issues
   */
  async scanTelemetry(
    projectId: string,
    startTime: Date,
    endTime: Date,
    config?: Partial<IssueDetectionConfig>,
  ): Promise<Issue[]> {
    const mergedConfig = { ...this.defaultConfig, ...config };
    const issues: Issue[] = [];

    try {
      // Get telemetry snapshots
      const telemetrySnapshots = await this.telemetryRepository.find({
        project: projectId,
        timestamp: { $gte: startTime, $lte: endTime },
      });

      // Detect performance issues
      if (mergedConfig.performanceScanEnabled) {
        const performanceIssues = await this.detectPerformanceIssues(
          telemetrySnapshots,
          mergedConfig,
        );
        issues.push(...performanceIssues);
      }

      // Detect error spikes
      const errorIssues = await this.detectErrorSpikes(
        telemetrySnapshots,
        mergedConfig,
      );
      issues.push(...errorIssues);

      // Detect resource issues
      const resourceIssues = await this.detectResourceIssues(
        telemetrySnapshots,
        mergedConfig,
      );
      issues.push(...resourceIssues);

      // Persist detected issues
      const persistedIssues = await this.persistIssues(
        issues,
        projectId,
        IssueSource.RUNTIME_TELEMETRY,
      );

      this.logger.log(
        `Detected ${persistedIssues.length} runtime issues for project ${projectId}`,
      );

      return persistedIssues;
    } catch (error) {
      this.logger.error('Error scanning telemetry', error);
      throw error;
    }
  }

  /**
   * Scheduled task to scan all active projects
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledScan(): Promise<void> {
    this.logger.log('Starting scheduled issue scan');

    try {
      const activeProjects = await this.projectRepository.find({
        status: 'active',
      });

      for (const project of activeProjects) {
        const endTime = new Date();
        const startTime = new Date();
        startTime.setHours(startTime.getHours() - 1);

        await this.scanTelemetry(project.id, startTime, endTime);
      }

      this.logger.log('Completed scheduled issue scan');
    } catch (error) {
      this.logger.error('Error in scheduled scan', error);
    }
  }

  /**
   * Get bug hotspots for a project
   */
  async getBugHotspots(
    projectId: string,
    limit: number = 10,
  ): Promise<Array<{
    component: Component;
    issueCount: number;
    criticalCount: number;
    recentIssues: Issue[];
  }>> {
    const issues = await this.issueRepository.find(
      {
        project: projectId,
        status: { $in: [IssueStatus.OPEN, IssueStatus.ACKNOWLEDGED] },
      },
      { populate: ['component'] },
    );

    const componentMap = new Map<string, {
      component: Component;
      issues: Issue[];
    }>();

    issues.forEach(issue => {
      if (issue.component) {
        const key = issue.component.id;
        if (!componentMap.has(key)) {
          componentMap.set(key, {
            component: issue.component,
            issues: [],
          });
        }
        componentMap.get(key)!.issues.push(issue);
      }
    });

    const hotspots = Array.from(componentMap.values())
      .map(({ component, issues }) => ({
        component,
        issueCount: issues.length,
        criticalCount: issues.filter(i => i.severity === IssueSeverity.CRITICAL).length,
        recentIssues: issues
          .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
          .slice(0, 5),
      }))
      .sort((a, b) => b.issueCount - a.issueCount)
      .slice(0, limit);

    return hotspots;
  }

  // Private detection methods
  private async detectArchitectureIssues(
    analysisResult: AnalysisResult,
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const data = analysisResult.data;

    // Check for circular dependencies
    if (data.circularDependencies?.length > 0) {
      data.circularDependencies.forEach((cycle: string[]) => {
        issues.push({
          type: IssueType.ARCHITECTURE,
          severity: IssueSeverity.HIGH,
          title: 'Circular Dependency Detected',
          description: `Circular dependency found: ${cycle.join(' -> ')}`,
          suggestedFix: 'Refactor the components to remove circular dependencies',
          metadata: { cycle },
        });
      });
    }

    // Check for orphaned components
    if (data.orphanedComponents?.length > 0) {
      issues.push({
        type: IssueType.ARCHITECTURE,
        severity: IssueSeverity.MEDIUM,
        title: 'Orphaned Components Found',
        description: `${data.orphanedComponents.length} components are not connected to the main application`,
        suggestedFix: 'Remove or integrate orphaned components',
        metadata: { components: data.orphanedComponents },
      });
    }

    // Check for god objects
    const components = await this.componentRepository.find({
      analysisRun: analysisResult.analysisRun.id,
    });

    components.forEach(component => {
      if (component.connectionCount > 20) {
        issues.push({
          type: IssueType.ARCHITECTURE,
          severity: IssueSeverity.HIGH,
          title: 'God Object Detected',
          description: `Component ${component.name} has too many dependencies (${component.connectionCount})`,
          location: { file: component.path },
          suggestedFix: 'Consider breaking down this component into smaller, more focused components',
          metadata: { connectionCount: component.connectionCount },
        });
      }
    });

    return issues;
  }

  private async detectQualityIssues(
    analysisResult: AnalysisResult,
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const components = await this.componentRepository.find({
      analysisRun: analysisResult.analysisRun.id,
    });

    components.forEach(component => {
      // High complexity
      if (component.complexity > config.complexityThreshold) {
        issues.push({
          type: IssueType.QUALITY,
          severity: component.complexity > config.complexityThreshold * 2 
            ? IssueSeverity.HIGH 
            : IssueSeverity.MEDIUM,
          title: 'High Complexity',
          description: `Component ${component.name} has high cyclomatic complexity (${component.complexity})`,
          location: { file: component.path },
          suggestedFix: 'Refactor complex methods into smaller, more manageable functions',
          metadata: { complexity: component.complexity },
        });
      }

      // Low test coverage
      if (component.testCoverage !== undefined && 
          component.testCoverage < config.testCoverageThreshold) {
        issues.push({
          type: IssueType.QUALITY,
          severity: component.testCoverage < 30 
            ? IssueSeverity.HIGH 
            : IssueSeverity.MEDIUM,
          title: 'Low Test Coverage',
          description: `Component ${component.name} has low test coverage (${component.testCoverage}%)`,
          location: { file: component.path },
          suggestedFix: 'Add unit tests to improve code coverage',
          metadata: { coverage: component.testCoverage },
        });
      }

      // Large files
      if (component.lineCount > 1000) {
        issues.push({
          type: IssueType.QUALITY,
          severity: IssueSeverity.MEDIUM,
          title: 'Large File',
          description: `Component ${component.name} is too large (${component.lineCount} lines)`,
          location: { file: component.path },
          suggestedFix: 'Consider splitting this file into smaller modules',
          metadata: { lineCount: component.lineCount },
        });
      }
    });

    return issues;
  }

  private async detectDependencyIssues(
    analysisResult: AnalysisResult,
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const data = analysisResult.data;

    // Check for outdated dependencies
    if (data.dependencies?.outdated?.length > 0) {
      data.dependencies.outdated.forEach((dep: any) => {
        const severity = dep.securityIssue 
          ? IssueSeverity.CRITICAL 
          : dep.majorVersionBehind > 2 
            ? IssueSeverity.HIGH 
            : IssueSeverity.MEDIUM;

        issues.push({
          type: IssueType.DEPENDENCY,
          severity,
          title: `Outdated Dependency: ${dep.name}`,
          description: `${dep.name} is outdated (current: ${dep.current}, latest: ${dep.latest})`,
          suggestedFix: `Update ${dep.name} to version ${dep.latest}`,
          metadata: dep,
        });
      });
    }

    // Check for vulnerable dependencies
    if (data.dependencies?.vulnerable?.length > 0) {
      data.dependencies.vulnerable.forEach((dep: any) => {
        issues.push({
          type: IssueType.SECURITY,
          severity: IssueSeverity.CRITICAL,
          title: `Vulnerable Dependency: ${dep.name}`,
          description: `${dep.name} has known security vulnerabilities: ${dep.vulnerabilities.join(', ')}`,
          suggestedFix: `Update ${dep.name} to a secure version or find an alternative`,
          metadata: dep,
        });
      });
    }

    return issues;
  }

  private async detectPatternIssues(
    patterns: PatternDetection[],
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];

    patterns.forEach(pattern => {
      if (pattern.isActive && 
          [PatternType.ANTI_PATTERN, PatternType.CODE_SMELL, 
           PatternType.SECURITY_ISSUE, PatternType.PERFORMANCE_ISSUE].includes(pattern.type)) {
        
        const issueType = this.mapPatternTypeToIssueType(pattern.type);
        const severity = this.mapPatternSeverityToIssueSeverity(pattern.severity);

        issues.push({
          type: issueType,
          severity,
          title: pattern.title,
          description: pattern.description,
          location: pattern.location,
          suggestedFix: pattern.suggestedFix,
          metadata: {
            patternId: pattern.patternId,
            occurrences: pattern.occurrences,
            autoFix: pattern.autoFix,
          },
        });
      }
    });

    return issues;
  }

  private async detectPerformanceIssues(
    snapshots: TelemetrySnapshot[],
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const traceSnapshots = snapshots.filter(s => s.type === TelemetryType.TRACE);

    // Group by endpoint/operation
    const endpointMetrics = new Map<string, {
      avgDuration: number;
      maxDuration: number;
      count: number;
    }>();

    traceSnapshots.forEach(snapshot => {
      const current = endpointMetrics.get(snapshot.name) || {
        avgDuration: 0,
        maxDuration: 0,
        count: 0,
      };

      const duration = snapshot.data.duration || snapshot.data.avg || 0;
      current.avgDuration = (current.avgDuration * current.count + duration) / (current.count + 1);
      current.maxDuration = Math.max(current.maxDuration, duration);
      current.count++;

      endpointMetrics.set(snapshot.name, current);
    });

    // Check for slow endpoints
    endpointMetrics.forEach((metrics, endpoint) => {
      if (metrics.avgDuration > config.responseTimeThreshold) {
        issues.push({
          type: IssueType.PERFORMANCE,
          severity: metrics.avgDuration > config.responseTimeThreshold * 2 
            ? IssueSeverity.HIGH 
            : IssueSeverity.MEDIUM,
          title: `Slow Endpoint: ${endpoint}`,
          description: `Endpoint ${endpoint} has high average response time (${metrics.avgDuration.toFixed(0)}ms)`,
          suggestedFix: 'Optimize database queries, add caching, or improve algorithm efficiency',
          metadata: metrics,
        });
      }
    });

    return issues;
  }

  private async detectErrorSpikes(
    snapshots: TelemetrySnapshot[],
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const errorSnapshots = snapshots.filter(s => s.type === TelemetryType.ERROR);

    // Group errors by type
    const errorGroups = new Map<string, {
      count: number;
      lastSeen: Date;
      stackTrace?: string;
    }>();

    errorSnapshots.forEach(snapshot => {
      const current = errorGroups.get(snapshot.name) || {
        count: 0,
        lastSeen: snapshot.timestamp,
      };

      current.count += snapshot.data.occurrences || 1;
      current.lastSeen = snapshot.timestamp;
      if (snapshot.data.stackTrace) {
        current.stackTrace = snapshot.data.stackTrace;
      }

      errorGroups.set(snapshot.name, current);
    });

    // Check for error rate threshold
    const totalRequests = snapshots.filter(s => s.type === TelemetryType.TRACE).length;
    errorGroups.forEach((error, errorName) => {
      const errorRate = totalRequests > 0 ? (error.count / totalRequests) * 100 : 0;

      if (errorRate > config.errorRateThreshold || error.count > 100) {
        issues.push({
          type: IssueType.BUG,
          severity: error.count > 1000 || errorRate > 10 
            ? IssueSeverity.CRITICAL 
            : IssueSeverity.HIGH,
          title: `Error Spike: ${errorName}`,
          description: `Error "${errorName}" occurred ${error.count} times (${errorRate.toFixed(1)}% error rate)`,
          metadata: {
            ...error,
            errorRate,
          },
        });
      }
    });

    return issues;
  }

  private async detectResourceIssues(
    snapshots: TelemetrySnapshot[],
    config: IssueDetectionConfig,
  ): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const metricSnapshots = snapshots.filter(s => s.type === TelemetryType.METRIC);

    // Check memory usage
    const memorySnapshots = metricSnapshots.filter(s => s.name.includes('memory'));
    memorySnapshots.forEach(snapshot => {
      const usage = snapshot.data.avg || snapshot.data.value || 0;
      if (usage > config.memoryUsageThreshold) {
        issues.push({
          type: IssueType.PERFORMANCE,
          severity: usage > 90 ? IssueSeverity.CRITICAL : IssueSeverity.HIGH,
          title: 'High Memory Usage',
          description: `Memory usage is at ${usage.toFixed(1)}%`,
          suggestedFix: 'Check for memory leaks, optimize data structures, or increase memory allocation',
          metadata: { usage },
        });
      }
    });

    // Check CPU usage
    const cpuSnapshots = metricSnapshots.filter(s => s.name.includes('cpu'));
    cpuSnapshots.forEach(snapshot => {
      const usage = snapshot.data.avg || snapshot.data.value || 0;
      if (usage > config.cpuUsageThreshold) {
        issues.push({
          type: IssueType.PERFORMANCE,
          severity: usage > 90 ? IssueSeverity.CRITICAL : IssueSeverity.HIGH,
          title: 'High CPU Usage',
          description: `CPU usage is at ${usage.toFixed(1)}%`,
          suggestedFix: 'Optimize algorithms, reduce computational complexity, or scale horizontally',
          metadata: { usage },
        });
      }
    });

    return issues;
  }

  private async persistIssues(
    detectedIssues: DetectedIssue[],
    projectId: string,
    source: IssueSource,
  ): Promise<Issue[]> {
    const persistedIssues: Issue[] = [];

    for (const detected of detectedIssues) {
      const fingerprint = Issue.generateFingerprint(
        detected.type,
        detected.title,
        detected.location,
      );

      // Check if issue already exists
      let issue = await this.issueRepository.findOne({
        fingerprint,
        project: projectId,
      });

      if (issue) {
        // Update existing issue
        issue.incrementOccurrences();
        issue.lastSeen = new Date();
        
        // Reopen if resolved
        if (issue.isResolved) {
          issue.reopen();
        }
      } else {
        // Create new issue
        issue = this.issueRepository.create({
          project: projectId,
          type: detected.type,
          severity: detected.severity,
          status: IssueStatus.OPEN,
          source,
          title: detected.title,
          description: detected.description,
          fingerprint,
          firstDetected: new Date(),
          lastSeen: new Date(),
          location: detected.location,
          suggestedFix: detected.suggestedFix,
          metadata: detected.metadata,
        });
      }

      // Calculate priority
      issue.updatePriority();

      await this.issueRepository.persistAndFlush(issue);
      persistedIssues.push(issue);
    }

    return persistedIssues;
  }

  private mapPatternTypeToIssueType(patternType: PatternType): IssueType {
    switch (patternType) {
      case PatternType.SECURITY_ISSUE:
        return IssueType.SECURITY;
      case PatternType.PERFORMANCE_ISSUE:
        return IssueType.PERFORMANCE;
      case PatternType.ARCHITECTURE_VIOLATION:
        return IssueType.ARCHITECTURE;
      case PatternType.DEPENDENCY_ISSUE:
        return IssueType.DEPENDENCY;
      default:
        return IssueType.QUALITY;
    }
  }

  private mapPatternSeverityToIssueSeverity(severity: any): IssueSeverity {
    switch (severity) {
      case 'critical':
        return IssueSeverity.CRITICAL;
      case 'high':
        return IssueSeverity.HIGH;
      case 'medium':
        return IssueSeverity.MEDIUM;
      default:
        return IssueSeverity.LOW;
    }
  }
}