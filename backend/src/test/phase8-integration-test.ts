/**
 * Phase 8.5 Integration Test - Complete Pattern Detection and Hierarchical Navigation
 * Tests the full pipeline: AST Analysis → Pattern Detection → Spatial Layout → Navigation
 */

import { ComponentNode, Connection, ArchitecturalLayer } from '../types';
import { PatternDetector, PatternDetectionResult } from '../analyzer/patterns/pattern-detector';
import { SpatialLayoutEngine } from '../spatial/spatial-layout-engine';
import { HierarchicalNavigationService } from '../spatial/hierarchical-navigation';
import { BreadcrumbNavigationService } from '../spatial/breadcrumb-navigation';

interface TestResults {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  errors: string[];
  results: {
    astData: boolean;
    patternDetection: boolean;
    spatialLayout: boolean;
    hierarchicalNavigation: boolean;
    breadcrumbNavigation: boolean;
    patternVisualization: boolean;
    endToEndIntegration: boolean;
  };
  performance: {
    patternDetectionTime: number;
    spatialLayoutTime: number;
    navigationBuildTime: number;
    totalTime: number;
  };
  statistics: {
    componentsAnalyzed: number;
    patternsDetected: number;
    antiPatternsDetected: number;
    hierarchyNodesCreated: number;
    spatialRoomsGenerated: number;
    navigationPathsAvailable: number;
  };
}

export class Phase8IntegrationTest {
  private testResults: TestResults = {
    totalTests: 7,
    passedTests: 0,
    failedTests: 0,
    errors: [],
    results: {
      astData: false,
      patternDetection: false,
      spatialLayout: false,
      hierarchicalNavigation: false,
      breadcrumbNavigation: false,
      patternVisualization: false,
      endToEndIntegration: false
    },
    performance: {
      patternDetectionTime: 0,
      spatialLayoutTime: 0,
      navigationBuildTime: 0,
      totalTime: 0
    },
    statistics: {
      componentsAnalyzed: 0,
      patternsDetected: 0,
      antiPatternsDetected: 0,
      hierarchyNodesCreated: 0,
      spatialRoomsGenerated: 0,
      navigationPathsAvailable: 0
    }
  };

  async runCompleteIntegrationTest(): Promise<TestResults> {
    const startTime = Date.now();
    console.log('🚀 Starting Phase 8.5 Complete Integration Test...\n');

    try {
      // Test 1: AST Data Pipeline
      await this.testASTDataPipeline();

      // Test 2: Pattern Detection Engine
      await this.testPatternDetectionEngine();

      // Test 3: Spatial Layout Generation
      await this.testSpatialLayoutGeneration();

      // Test 4: Hierarchical Navigation System
      await this.testHierarchicalNavigation();

      // Test 5: Breadcrumb Navigation
      await this.testBreadcrumbNavigation();

      // Test 6: Pattern Visualization Integration
      await this.testPatternVisualizationIntegration();

      // Test 7: End-to-End Integration
      await this.testEndToEndIntegration();

      this.testResults.performance.totalTime = Date.now() - startTime;
      
      console.log('\n✅ Phase 8.5 Integration Test Complete!');
      this.printTestSummary();
      
      return this.testResults;

    } catch (error) {
      this.testResults.errors.push(`Critical test failure: ${error}`);
      this.testResults.failedTests = this.testResults.totalTests;
      console.error('❌ Integration test failed:', error);
      return this.testResults;
    }
  }

  private async testASTDataPipeline(): Promise<void> {
    console.log('📊 Testing AST Data Pipeline...');
    
    try {
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);

      // Validate mock data structure
      if (mockComponents.length === 0) {
        throw new Error('No mock components generated');
      }

      if (mockConnections.length === 0) {
        throw new Error('No mock connections generated');
      }

      // Check component data integrity
      for (const component of mockComponents) {
        if (!component.id || !component.name || !component.type) {
          throw new Error(`Invalid component data: ${component.id}`);
        }

        if (!component.metadata || typeof component.metadata.complexity !== 'number') {
          throw new Error(`Invalid component metadata: ${component.id}`);
        }
      }

      // Check connection data integrity
      for (const connection of mockConnections) {
        const fromExists = mockComponents.some(c => c.id === connection.from);
        const toExists = mockComponents.some(c => c.id === connection.to);

        if (!fromExists || !toExists) {
          throw new Error(`Invalid connection: ${connection.from} -> ${connection.to}`);
        }
      }

      this.testResults.statistics.componentsAnalyzed = mockComponents.length;
      this.testResults.results.astData = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ AST Data: ${mockComponents.length} components, ${mockConnections.length} connections`);

    } catch (error) {
      this.testResults.errors.push(`AST Data Pipeline: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ AST Data Pipeline failed: ${error}`);
    }
  }

  private async testPatternDetectionEngine(): Promise<void> {
    console.log('🎯 Testing Pattern Detection Engine...');
    
    try {
      const startTime = Date.now();
      
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);
      
      const patternDetector = new PatternDetector();
      const patternResults = await patternDetector.detectPatterns(
        mockComponents,
        mockConnections,
        'test-project'
      );

      this.testResults.performance.patternDetectionTime = Date.now() - startTime;

      // Validate pattern detection results
      if (!patternResults) {
        throw new Error('Pattern detection returned null results');
      }

      if (!Array.isArray(patternResults.patterns)) {
        throw new Error('Pattern results missing patterns array');
      }

      if (!Array.isArray(patternResults.antiPatterns)) {
        throw new Error('Pattern results missing anti-patterns array');
      }

      if (!patternResults.architectureType) {
        throw new Error('Pattern results missing architecture type');
      }

      if (typeof patternResults.confidenceScore !== 'number') {
        throw new Error('Pattern results missing confidence score');
      }

      // Check for framework-specific patterns
      const frameworkPatterns = patternResults.patterns.filter(p => 
        p.metadata && (p.metadata.pattern as string)?.includes('react') ||
        (p.metadata.pattern as string)?.includes('nestjs') ||
        (p.metadata.pattern as string)?.includes('express')
      );

      // Check for anti-patterns
      const criticalAntiPatterns = patternResults.antiPatterns.filter(ap => 
        ap.severity === 'critical' || ap.severity === 'high'
      );

      this.testResults.statistics.patternsDetected = patternResults.patterns.length;
      this.testResults.statistics.antiPatternsDetected = patternResults.antiPatterns.length;
      this.testResults.results.patternDetection = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ Pattern Detection: ${patternResults.patterns.length} patterns, ${patternResults.antiPatterns.length} anti-patterns`);
      console.log(`   📐 Architecture: ${patternResults.architectureType} (confidence: ${patternResults.confidenceScore.toFixed(2)})`);
      if (frameworkPatterns.length > 0) {
        console.log(`   🔧 Framework patterns: ${frameworkPatterns.length}`);
      }
      if (criticalAntiPatterns.length > 0) {
        console.log(`   ⚠️ Critical issues: ${criticalAntiPatterns.length}`);
      }

    } catch (error) {
      this.testResults.errors.push(`Pattern Detection: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ Pattern Detection failed: ${error}`);
    }
  }

  private async testSpatialLayoutGeneration(): Promise<void> {
    console.log('🏗️ Testing Spatial Layout Generation...');
    
    try {
      const startTime = Date.now();
      
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);
      
      const spatialEngine = new SpatialLayoutEngine({
        enableRealTimeUpdates: true,
        enableSpatialIndex: true,
        enableAnimations: true,
        collisionDetection: true,
        optimizationLevel: 'medium'
      });

      const architectureBlueprint = {
        components: mockComponents,
        connections: mockConnections,
        entryPoints: ['main', 'app', 'index'],
        layers: this.generateMockLayers(mockComponents),
        metadata: {
          framework: 'mixed',
          language: 'typescript',
          version: '1.0.0',
          totalComponents: mockComponents.length,
          spatialComplexity: mockComponents.reduce((sum, c) => sum + c.metadata.complexity, 0)
        }
      };

      const spatialBlueprint = await spatialEngine.generateSpatialLayout(architectureBlueprint);
      
      this.testResults.performance.spatialLayoutTime = Date.now() - startTime;

      // Validate spatial layout
      if (!spatialBlueprint) {
        throw new Error('Spatial layout generation returned null');
      }

      if (!spatialBlueprint.rooms || spatialBlueprint.rooms.length === 0) {
        throw new Error('Spatial layout contains no rooms');
      }

      if (!spatialBlueprint.buildings || spatialBlueprint.buildings.length === 0) {
        throw new Error('Spatial layout contains no buildings');
      }

      // Check room positioning
      for (const room of spatialBlueprint.rooms) {
        if (!room.position || typeof room.position.x !== 'number') {
          throw new Error(`Invalid room position: ${room.id}`);
        }

        if (!room.dimensions || typeof room.dimensions.width !== 'number') {
          throw new Error(`Invalid room dimensions: ${room.id}`);
        }
      }

      // Check spatial index
      const spatialContext = spatialEngine.getNavigationContext();
      if (!spatialContext) {
        throw new Error('Spatial engine missing navigation context');
      }

      this.testResults.statistics.spatialRoomsGenerated = spatialBlueprint.rooms.length;
      this.testResults.results.spatialLayout = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ Spatial Layout: ${spatialBlueprint.rooms.length} rooms, ${spatialBlueprint.buildings.length} buildings`);
      console.log(`   🏢 Hallways: ${spatialBlueprint.hallways?.length || 0}, Pathways: ${spatialBlueprint.pathways?.length || 0}`);

    } catch (error) {
      this.testResults.errors.push(`Spatial Layout: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ Spatial Layout failed: ${error}`);
    }
  }

  private async testHierarchicalNavigation(): Promise<void> {
    console.log('🗂️ Testing Hierarchical Navigation System...');
    
    try {
      const startTime = Date.now();
      
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);
      
      const hierarchicalNav = new HierarchicalNavigationService();
      const rootHierarchy = await hierarchicalNav.buildHierarchy(
        mockComponents,
        mockConnections
      );

      this.testResults.performance.navigationBuildTime = Date.now() - startTime;

      // Validate hierarchy structure
      if (!rootHierarchy) {
        throw new Error('Hierarchical navigation returned null root');
      }

      if (rootHierarchy.level !== 0) { // HierarchyLevel.SYSTEM
        throw new Error('Root hierarchy has invalid level');
      }

      if (rootHierarchy.children.length === 0) {
        throw new Error('Root hierarchy has no children');
      }

      // Test navigation context
      const context = hierarchicalNav.getNavigationContext(rootHierarchy.id);
      if (!context) {
        throw new Error('Failed to get navigation context');
      }

      if (!context.breadcrumbs || context.breadcrumbs.length === 0) {
        throw new Error('Navigation context missing breadcrumbs');
      }

      if (!context.children || !context.availableActions) {
        throw new Error('Navigation context incomplete');
      }

      // Test search functionality
      const searchResults = hierarchicalNav.searchNodes('test', undefined);
      if (!Array.isArray(searchResults)) {
        throw new Error('Search functionality failed');
      }

      // Test drill-down functionality
      if (context.children.length > 0) {
        const childContext = hierarchicalNav.drillDown(
          rootHierarchy.id,
          context.children[0].id
        );
        
        if (!childContext || !childContext.breadcrumbs) {
          throw new Error('Drill-down functionality failed');
        }

        if (childContext.breadcrumbs.length <= context.breadcrumbs.length) {
          throw new Error('Drill-down did not increase breadcrumb depth');
        }
      }

      // Test navigation paths
      if (context.children.length > 1) {
        const paths = hierarchicalNav.getNavigationPaths(
          context.children[0].id,
          context.children[1].id
        );
        
        if (!Array.isArray(paths)) {
          throw new Error('Navigation paths functionality failed');
        }
        
        this.testResults.statistics.navigationPathsAvailable = paths.length;
      }

      const stats = hierarchicalNav.getHierarchyStats();
      this.testResults.statistics.hierarchyNodesCreated = stats.totalNodes;
      this.testResults.results.hierarchicalNavigation = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ Hierarchical Navigation: ${stats.totalNodes} nodes across ${Object.keys(stats).length - 1} levels`);
      console.log(`   🔍 Search: ${searchResults.length} results for 'test' query`);
      console.log(`   📊 Stats: ${stats.serviceNodes} services, ${stats.componentNodes} components`);

    } catch (error) {
      this.testResults.errors.push(`Hierarchical Navigation: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ Hierarchical Navigation failed: ${error}`);
    }
  }

  private async testBreadcrumbNavigation(): Promise<void> {
    console.log('🍞 Testing Breadcrumb Navigation System...');
    
    try {
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);
      
      const hierarchicalNav = new HierarchicalNavigationService();
      await hierarchicalNav.buildHierarchy(mockComponents, mockConnections);
      
      const breadcrumbNav = new BreadcrumbNavigationService(hierarchicalNav);
      
      // Test breadcrumb generation
      const rootContext = hierarchicalNav.getNavigationContext('system_root');
      if (!rootContext || !rootContext.children.length) {
        throw new Error('No navigation context available for breadcrumb test');
      }

      const breadcrumbs = breadcrumbNav.generateBreadcrumbs(rootContext.children[0].id);
      
      if (!breadcrumbs || breadcrumbs.length === 0) {
        throw new Error('Breadcrumb generation returned empty results');
      }

      // Validate breadcrumb structure
      for (const crumb of breadcrumbs) {
        if (!crumb.id || !crumb.name || typeof crumb.level !== 'number') {
          throw new Error(`Invalid breadcrumb structure: ${crumb.id}`);
        }
      }

      // Test breadcrumb rendering
      const renderedBreadcrumbs = breadcrumbNav.renderBreadcrumbs(breadcrumbs, {
        separator: ' > ',
        maxWidth: 100,
        truncateStrategy: 'smart'
      });

      if (!renderedBreadcrumbs || typeof renderedBreadcrumbs !== 'string') {
        throw new Error('Breadcrumb rendering failed');
      }

      // Test contextual shortcuts
      const shortcuts = breadcrumbNav.getContextualShortcuts(rootContext.children[0].id);
      if (!Array.isArray(shortcuts)) {
        throw new Error('Contextual shortcuts generation failed');
      }

      // Test quick navigation
      const quickNav = breadcrumbNav.generateQuickNavigation(rootContext.children[0].id);
      if (!quickNav || !quickNav.currentLocation || !quickNav.quickActions) {
        throw new Error('Quick navigation generation failed');
      }

      // Test enhanced breadcrumbs
      const enhancedBreadcrumbs = breadcrumbNav.generateEnhancedBreadcrumbs(rootContext.children[0].id);
      if (!enhancedBreadcrumbs || !enhancedBreadcrumbs.breadcrumbs || !enhancedBreadcrumbs.navigation) {
        throw new Error('Enhanced breadcrumbs generation failed');
      }

      this.testResults.results.breadcrumbNavigation = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ Breadcrumb Navigation: ${breadcrumbs.length} levels, ${shortcuts.length} shortcuts`);
      console.log(`   🚀 Quick Navigation: ${quickNav.quickActions.length} actions, ${quickNav.levelNavigation.length} level groups`);

    } catch (error) {
      this.testResults.errors.push(`Breadcrumb Navigation: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ Breadcrumb Navigation failed: ${error}`);
    }
  }

  private async testPatternVisualizationIntegration(): Promise<void> {
    console.log('🎨 Testing Pattern Visualization Integration...');
    
    try {
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);
      
      // Run pattern detection
      const patternDetector = new PatternDetector();
      const patternResults = await patternDetector.detectPatterns(
        mockComponents,
        mockConnections,
        'test-project'
      );

      // Generate spatial layout
      const spatialEngine = new SpatialLayoutEngine({
        enableAnimations: true,
        collisionDetection: true
      });

      const architectureBlueprint = {
        components: mockComponents,
        connections: mockConnections,
        entryPoints: ['main'],
        layers: this.generateMockLayers(mockComponents),
        metadata: {
          framework: 'mixed',
          language: 'typescript',
          version: '1.0.0',
          totalComponents: mockComponents.length,
          spatialComplexity: mockComponents.reduce((sum, c) => sum + c.metadata.complexity, 0)
        }
      };

      const spatialBlueprint = await spatialEngine.generateSpatialLayout(architectureBlueprint);

      // Integrate pattern results with spatial visualization
      spatialEngine.integratePatternResults(patternResults);

      // Validate pattern integration
      const enhancedBlueprint = spatialEngine.getEnhancedBlueprint();
      if (!enhancedBlueprint) {
        throw new Error('Enhanced blueprint generation failed');
      }

      if (!enhancedBlueprint.metadata.patternDetection) {
        throw new Error('Pattern detection data not integrated');
      }

      // Check for pattern styling in rooms
      let roomsWithPatterns = 0;
      let roomsWithAntiPatterns = 0;

      for (const room of enhancedBlueprint.rooms) {
        if (room.metadata.patterns && room.metadata.patterns.length > 0) {
          roomsWithPatterns++;
        }
        
        if (room.metadata.alerts && room.metadata.alerts.some(a => a.antiPattern)) {
          roomsWithAntiPatterns++;
        }
      }

      // Check for pattern connections
      let patternConnections = 0;
      for (const hallway of enhancedBlueprint.hallways || []) {
        if (hallway.metadata.patternConnection) {
          patternConnections++;
        }
      }

      // Validate animations for critical anti-patterns
      const animations = spatialEngine.getAnimations();
      const antiPatternAnimations = animations.filter(a => 
        a.metadata?.reason === 'critical-antipattern'
      );

      this.testResults.results.patternVisualization = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ Pattern Visualization: ${roomsWithPatterns} pattern rooms, ${roomsWithAntiPatterns} issue rooms`);
      console.log(`   🔗 Pattern Connections: ${patternConnections}, Animations: ${antiPatternAnimations.length}`);
      console.log(`   📐 Architecture: ${enhancedBlueprint.metadata.patternDetection.architectureType}`);

    } catch (error) {
      this.testResults.errors.push(`Pattern Visualization: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ Pattern Visualization failed: ${error}`);
    }
  }

  private async testEndToEndIntegration(): Promise<void> {
    console.log('🔄 Testing End-to-End Integration...');
    
    try {
      // Create complete pipeline test
      const mockComponents = this.generateMockComponents();
      const mockConnections = this.generateMockConnections(mockComponents);
      
      // Step 1: Pattern Detection
      const patternDetector = new PatternDetector();
      const patternResults = await patternDetector.detectPatterns(
        mockComponents,
        mockConnections,
        'e2e-test-project'
      );

      // Step 2: Spatial Layout with Pattern Integration
      const spatialEngine = new SpatialLayoutEngine({
        enableRealTimeUpdates: true,
        enableSpatialIndex: true,
        enableAnimations: true
      });

      const architectureBlueprint = {
        components: mockComponents,
        connections: mockConnections,
        entryPoints: ['main', 'app'],
        layers: this.generateMockLayers(mockComponents),
        metadata: {
          framework: 'mixed',
          language: 'typescript',
          version: '1.0.0',
          totalComponents: mockComponents.length,
          spatialComplexity: mockComponents.reduce((sum, c) => sum + c.metadata.complexity, 0)
        }
      };

      const spatialBlueprint = await spatialEngine.generateSpatialLayout(architectureBlueprint);
      spatialEngine.integratePatternResults(patternResults);

      // Step 3: Hierarchical Navigation with Breadcrumbs
      const hierarchicalNav = new HierarchicalNavigationService();
      const rootHierarchy = await hierarchicalNav.buildHierarchy(
        mockComponents,
        mockConnections,
        spatialBlueprint
      );

      const breadcrumbNav = new BreadcrumbNavigationService(hierarchicalNav);

      // Step 4: Test Complete Workflow
      
      // 4a: Search and Navigate
      const searchResults = hierarchicalNav.searchNodes('service');
      if (searchResults.length === 0) {
        throw new Error('Search functionality not working in integration');
      }

      // 4b: Drill down and generate breadcrumbs
      const rootContext = hierarchicalNav.getNavigationContext(rootHierarchy.id);
      if (rootContext.children.length > 0) {
        const childContext = hierarchicalNav.drillDown(rootHierarchy.id, rootContext.children[0].id);
        const breadcrumbs = breadcrumbNav.generateBreadcrumbs(childContext.currentNode.id);
        
        if (breadcrumbs.length < 2) {
          throw new Error('Breadcrumb generation not working in integration');
        }
      }

      // 4c: Spatial navigation with patterns
      const enhancedBlueprint = spatialEngine.getEnhancedBlueprint();
      if (!enhancedBlueprint || !enhancedBlueprint.metadata.patternDetection) {
        throw new Error('Enhanced blueprint not available in integration');
      }

      // 4d: Pattern-aware navigation
      const navigationPaths = spatialEngine.getNavigationPaths(
        mockComponents[0].id,
        mockComponents[mockComponents.length - 1].id
      );

      // 4e: Real-time updates simulation
      spatialEngine.applyRealTimeUpdate({
        type: 'alert',
        targetId: mockComponents[0].id,
        data: {
          severity: 'warning',
          message: 'Integration test alert'
        },
        timestamp: new Date()
      });

      // Final Validation: Everything should still work
      const finalContext = spatialEngine.getNavigationContext(rootHierarchy.id);
      const finalBreadcrumbs = breadcrumbNav.generateBreadcrumbs(rootHierarchy.id);
      const finalPatterns = spatialEngine.getPatternResults();

      if (!finalContext || !finalBreadcrumbs || !finalPatterns) {
        throw new Error('End-to-end integration state corruption detected');
      }

      this.testResults.results.endToEndIntegration = true;
      this.testResults.passedTests++;
      
      console.log(`   ✅ End-to-End Integration: Complete pipeline working`);
      console.log(`   🔍 Search Results: ${searchResults.length}`);
      console.log(`   🗺️ Navigation Paths: ${navigationPaths.length}`);
      console.log(`   📊 Final State: ${finalContext.children.length} children, ${finalBreadcrumbs.length} breadcrumbs`);

    } catch (error) {
      this.testResults.errors.push(`End-to-End Integration: ${error}`);
      this.testResults.failedTests++;
      console.log(`   ❌ End-to-End Integration failed: ${error}`);
    }
  }

  private printTestSummary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📋 PHASE 8.5 INTEGRATION TEST SUMMARY');
    console.log('='.repeat(60));
    
    console.log(`\n📊 Results: ${this.testResults.passedTests}/${this.testResults.totalTests} tests passed`);
    console.log(`⏱️ Total Time: ${this.testResults.performance.totalTime}ms`);
    
    console.log('\n🧪 Test Results:');
    Object.entries(this.testResults.results).forEach(([test, passed]) => {
      console.log(`   ${passed ? '✅' : '❌'} ${test.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
    });
    
    if (this.testResults.errors.length > 0) {
      console.log('\n❌ Errors:');
      this.testResults.errors.forEach(error => {
        console.log(`   - ${error}`);
      });
    }
    
    console.log('\n📈 Performance:');
    console.log(`   Pattern Detection: ${this.testResults.performance.patternDetectionTime}ms`);
    console.log(`   Spatial Layout: ${this.testResults.performance.spatialLayoutTime}ms`);
    console.log(`   Navigation Build: ${this.testResults.performance.navigationBuildTime}ms`);
    
    console.log('\n📊 Statistics:');
    console.log(`   Components Analyzed: ${this.testResults.statistics.componentsAnalyzed}`);
    console.log(`   Patterns Detected: ${this.testResults.statistics.patternsDetected}`);
    console.log(`   Anti-patterns Detected: ${this.testResults.statistics.antiPatternsDetected}`);
    console.log(`   Hierarchy Nodes: ${this.testResults.statistics.hierarchyNodesCreated}`);
    console.log(`   Spatial Rooms: ${this.testResults.statistics.spatialRoomsGenerated}`);
    console.log(`   Navigation Paths: ${this.testResults.statistics.navigationPathsAvailable}`);
    
    const successRate = (this.testResults.passedTests / this.testResults.totalTests) * 100;
    console.log(`\n🎯 Success Rate: ${successRate.toFixed(1)}%`);
    
    if (successRate >= 90) {
      console.log('🎉 EXCELLENT: Phase 8.5 implementation is highly successful!');
    } else if (successRate >= 75) {
      console.log('👍 GOOD: Phase 8.5 implementation is working well with minor issues.');
    } else if (successRate >= 50) {
      console.log('⚠️ NEEDS WORK: Phase 8.5 implementation has significant issues.');
    } else {
      console.log('❌ FAILED: Phase 8.5 implementation requires major fixes.');
    }
  }

  // Mock data generators

  private generateMockComponents(): ComponentNode[] {
    const frameworks = ['react', 'nestjs', 'express'];
    const types = ['controller', 'service', 'utility', 'model', 'middleware'];
    const layers: ArchitecturalLayer[] = ['presentation', 'business', 'data', 'infrastructure'];
    
    const components: ComponentNode[] = [];
    
    // Generate diverse components across frameworks
    for (let i = 0; i < 25; i++) {
      const framework = frameworks[i % frameworks.length];
      const type = types[i % types.length];
      const layer = layers[i % layers.length];
      
      components.push({
        id: `component_${framework}_${type}_${i}`,
        name: `${framework.charAt(0).toUpperCase() + framework.slice(1)}${type.charAt(0).toUpperCase() + type.slice(1)}${i}`,
        type: type as any,
        path: `src/${framework}/${type}s/${type}${i}.ts`,
        framework,
        dependencies: [],
        dependents: [],
        metadata: {
          lineCount: Math.floor(Math.random() * 500) + 50,
          complexity: Math.floor(Math.random() * 20) + 1,
          lastModified: new Date(),
          exports: [`${type}${i}`],
          imports: [`dependency${i}`],
          layer,
          responsibilities: [`${type} responsibilities for ${framework}`],
          // Framework-specific metadata
          ...(framework === 'react' && {
            hooks: ['useState', 'useEffect'],
            props: ['prop1', 'prop2'],
            tags: ['functional', 'component']
          }),
          ...(framework === 'nestjs' && {
            methods: ['method1', 'method2'],
            frameworkType: type,
            isGlobal: false
          }),
          ...(framework === 'express' && {
            httpMethods: ['GET', 'POST'],
            frameworkType: type
          })
        },
        metrics: {
          linesOfCode: Math.floor(Math.random() * 500) + 50,
          complexity: Math.floor(Math.random() * 20) + 1,
          maintainability: Math.floor(Math.random() * 100),
          testCoverage: Math.floor(Math.random() * 100),
          duplicateCode: Math.floor(Math.random() * 10),
          technicalDebt: Math.floor(Math.random() * 50)
        }
      });
    }

    // Set up dependencies
    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      const numDeps = Math.floor(Math.random() * 3) + 1;
      
      for (let j = 0; j < numDeps; j++) {
        const depIndex = Math.floor(Math.random() * components.length);
        if (depIndex !== i) {
          const depId = components[depIndex].id;
          if (!component.dependencies.includes(depId)) {
            component.dependencies.push(depId);
            components[depIndex].dependents.push(component.id);
          }
        }
      }
    }

    return components;
  }

  private generateMockConnections(components: ComponentNode[]): Connection[] {
    const connections: Connection[] = [];
    
    for (const component of components) {
      for (const depId of component.dependencies) {
        connections.push({
          from: component.id,
          to: depId,
          type: 'dependency',
          protocol: 'import',
          metadata: {
            callSites: Math.floor(Math.random() * 10) + 1,
            framework: component.framework
          }
        });
      }
    }
    
    return connections;
  }

  private generateMockLayers(components: ComponentNode[]): Record<string, string[]> {
    const layers: Record<string, string[]> = {
      presentation: [],
      business: [],
      data: [],
      infrastructure: []
    };
    
    for (const component of components) {
      layers[component.metadata.layer].push(component.id);
    }
    
    return layers;
  }
}

// Export for external testing
export default Phase8IntegrationTest;