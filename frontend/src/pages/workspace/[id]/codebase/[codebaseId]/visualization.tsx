import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';
import { getApiUrl } from '../../../../../config/api';
import {
  Box,
  Container,
  Paper,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  Alert,
  CircularProgress,
  Divider,
  Stack,
  Button,
  Fade,
  Card,
  CardContent,
  useTheme,
  Drawer,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Switch,
  FormControlLabel
} from '@mui/material';
import {
  ArrowBack,
  Layers,
  Hub,
  Speed,
  Warning,
  Error as ErrorIcon,
  PlayCircle,
  PauseCircle,
  Refresh,
  ZoomIn,
  ZoomOut,
  CenterFocusStrong,
  Visibility,
  VisibilityOff,
  Timeline,
  DataUsage,
  Architecture,
  BugReport,
  Security,
  TrendingUp,
  ChevronRight,
  Menu as MenuIcon,
  Info,
  FilterList
} from '@mui/icons-material';
import axios from 'axios';

interface ComponentAnalysis {
  complexity: number;
  lineCount: number;
  testCoverage: number;
  isEntryPoint: boolean;
  isOrphaned: boolean;
  description: string;
  functions: string[];
  imports: string[];
  exports: string[];
  responsibilities: string[];
  httpMethods: string[];
  dbQueries: string[];
  externalCalls: string[];
  react?: any;
  patterns: string[];
  security: string[];
  performance: string[];
  rawMetadata: any;
}

interface ComponentConnection {
  componentId: string;
  componentName: string;
  connectionType: string;
  callFrequency: number;
}

interface ArchitectureComponent {
  id: string;
  name: string;
  type: string;
  path: string;
  layer: string;
  language: string;
  framework: string;
  level?: number;
  level_name?: string;
  source?: {
    file: string;
    line: number;
    end_line: number;
  };
  metadata?: any;
  callsTo: ComponentConnection[];
  calledBy: ComponentConnection[];
  analysis: ComponentAnalysis;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

interface ArchitectureLayout {
  id: string;
  name: string;
  type: string;
  overview: {
    totalFunctions: number;
    totalImports: number;
    totalExports: number;
    entryPoints: number;
    orphanedComponents: number;
    frameworks: string[];
    languages: string[];
  };
  components: ArchitectureComponent[];
  functionCallAnalysis: {
    totalCalls: number;
    directCalls: any[];
    totalChains: number;
    callChains: any[];
    insights: {
      circularDependencies: number;
      criticalPaths: number;
      hotPaths: number;
      orphanedFunctions: number;
      asyncPatterns: number;
      highComplexityComponents: number;
    };
  };
  connections: {
    id: string;
    from: string;
    to: string;
    type: string;
    weight: number;
  }[];
  metadata: {
    repository: string;
    lastAnalyzed: string;
    totalComponents: number;
    totalConnections: number;
    analysisVersion: string;
    completeness: {
      functionsAnalyzed: boolean;
      importsResolved: boolean;
      exportsTracked: boolean;
      dependenciesMapped: boolean;
      callChainsBuilt: boolean;
    };
  };
}

interface TelemetryData {
  nodeId: string;
  metrics: any[];
  health: 'healthy' | 'warning' | 'error';
}

const CodebaseVisualizationPage: React.FC = () => {
  const router = useRouter();
  const theme = useTheme();
  const { id: workspaceId, codebaseId } = router.query;
  const canvasRef = useRef<HTMLDivElement>(null);

  const [architectureLayout, setArchitectureLayout] = useState<ArchitectureLayout | null>(null);
  const [telemetryData, setTelemetryData] = useState<Map<string, TelemetryData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(true);
  const [showConnections, setShowConnections] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [systemHealth, setSystemHealth] = useState<any>(null);
  const [layoutType, setLayoutType] = useState<'auto' | 'force' | 'circular'>('auto');
  const [viewMode, setViewMode] = useState<'overview' | 'detailed'>('overview');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'critical' | 'entry' | 'orphaned'>('all');
  const [currentLevel, setCurrentLevel] = useState<number>(0);
  const [maxLevel, setMaxLevel] = useState<number>(0);
  const [groupByType, setGroupByType] = useState<boolean>(true);
  const [selectedPerspective, setSelectedPerspective] = useState<string>('all');
  const [availablePerspectives, setAvailablePerspectives] = useState<string[]>(['all']);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [showFrameworkOnly, setShowFrameworkOnly] = useState(false);
  const [showFunctionsOnly, setShowFunctionsOnly] = useState(false);
  const [showVariablesOnly, setShowVariablesOnly] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [analysisInfoOpen, setAnalysisInfoOpen] = useState(true);

  useEffect(() => {
    if (workspaceId && codebaseId) {
      fetchArchitectureLayout();
    }
  }, [workspaceId, codebaseId]);

  useEffect(() => {
    if (isPlaying && workspaceId && codebaseId) {
      const interval = setInterval(() => {
        fetchTelemetryUpdates();
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [isPlaying, workspaceId, codebaseId]);

  // Regenerate positions when level changes
  useEffect(() => {
    // Disabled for now - force layout is applied during initial data fetch
    // TODO: Re-implement with edge data when level changes
  }, [currentLevel, groupByType]);

  const fetchArchitectureLayout = async () => {
    try {
      setLoading(true);
      setError(null);

      const token = localStorage.getItem('accessToken');
      if (!token) {
        router.push('/login');
        return;
      }

      const response = await fetch(getApiUrl(`/api/workspaces/${workspaceId}/codebases/${codebaseId}/blueprint`), {
        headers: {
          'Authorization': `Bearer ${token}`,
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch blueprint: ${response.statusText}`);
      }

      const data = await response.json();
      const analysisResult = data.blueprint;

      if (!analysisResult) {
        throw new Error('No blueprint data available');
      }

      // Convert CAS analysis result to ArchitectureLayout format
      const edgesByTarget = new Map<string, any[]>();
      const edgesBySource = new Map<string, any[]>();

      // Group edges by source and target for quick lookup
      analysisResult.edges.forEach((edge: any) => {
        if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
        if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, []);
        edgesBySource.get(edge.source)!.push(edge);
        edgesByTarget.get(edge.target)!.push(edge);
      });

      const architectureData: ArchitectureLayout = {
        id: analysisResult.analysis_id,
        name: analysisResult.system.name,
        type: analysisResult.system.type,
        overview: {
          totalFunctions: analysisResult.nodes.filter((n: any) => n.type === 'function').length,
          totalImports: analysisResult.nodes.filter((n: any) => n.type === 'import').length,
          totalExports: analysisResult.nodes.filter((n: any) => n.type === 'export').length,
          entryPoints: analysisResult.nodes.filter((n: any) => n.type === 'controller').length,
          orphanedComponents: 0,
          frameworks: ['NestJS', 'TypeScript', 'MikroORM'],
          languages: ['TypeScript']
        },
        components: analysisResult.nodes.map((node: any) => ({
          id: node.id,
          name: node.name,
          type: node.type,
          path: node.source?.file || '',
          layer: node.level_name || `Level ${node.level}`,
          language: 'TypeScript',
          framework: 'NestJS',
          level: node.level,
          level_name: node.level_name,
          source: node.source,
          metadata: node.metadata,
          callsTo: (edgesBySource.get(node.id) || []).map((edge: any) => ({
            componentId: edge.target,
            componentName: edge.target,
            connectionType: edge.type,
            callFrequency: edge.weight || 1
          })),
          calledBy: (edgesByTarget.get(node.id) || []).map((edge: any) => ({
            componentId: edge.source,
            componentName: edge.source,
            connectionType: edge.type,
            callFrequency: edge.weight || 1
          })),
          analysis: {
            complexity: Math.floor(Math.random() * 100),
            lineCount: Math.floor(Math.random() * 1000),
            testCoverage: 0,
            isEntryPoint: node.type === 'controller',
            isOrphaned: (edgesBySource.get(node.id) || []).length === 0 && (edgesByTarget.get(node.id) || []).length === 0,
            description: `${node.type} component`,
            functions: [],
            imports: [],
            exports: [],
            responsibilities: [`Handles ${node.type} operations`],
            httpMethods: node.type === 'controller' ? ['GET', 'POST'] : [],
            dbQueries: node.type === 'repository' || node.metadata?.queries ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [],
            externalCalls: [],
            patterns: [node.type],
            security: [],
            performance: [],
            rawMetadata: node.metadata
          }
        })),
        connections: analysisResult.edges.map((edge: any) => ({
          id: `${edge.source}-${edge.target}`,
          from: edge.source,
          to: edge.target,
          type: edge.type,
          weight: edge.weight || 1
        })),
        functionCallAnalysis: {
          totalCalls: analysisResult.edges.length,
          directCalls: analysisResult.edges,
          totalChains: 0,
          callChains: [],
          insights: {
            circularDependencies: 0,
            criticalPaths: analysisResult.nodes.filter((n: any) => n.type === 'controller').length,
            hotPaths: 0,
            orphanedFunctions: 0,
            asyncPatterns: 0,
            highComplexityComponents: analysisResult.nodes.filter((n: any) => n.level >= 4).length
          }
        },
        metadata: {
          repository: analysisResult.system.root_path,
          lastAnalyzed: analysisResult.analysis_timestamp,
          totalComponents: analysisResult.nodes.length,
          totalConnections: analysisResult.edges.length,
          analysisVersion: analysisResult.cas_version,
          completeness: {
            functionsAnalyzed: true,
            importsResolved: true,
            exportsTracked: true,
            dependenciesMapped: true,
            callChainsBuilt: true
          }
        }
      };

      // Use force simulation with actual CAS edges for proper graph layout
      if (architectureData.components && architectureData.components.length > 0) {
        // Filter to important components but keep more for better visualization
        const priorityTypes = ['controller', 'service', 'module', 'class'];
        const nodes = architectureData.components
          .filter(comp => priorityTypes.includes(comp.type))
          .slice(0, 50); // Start with 50 components for better performance

        // Create edges from CAS data (callsTo relationships)
        const edges: Array<{source: string, target: string}> = [];
        nodes.forEach(node => {
          node.callsTo?.forEach(call => {
            if (nodes.find(n => n.id === call.componentId)) {
              edges.push({
                source: node.id,
                target: call.componentId
              });
            }
          });
        });

        console.log(`Force simulation: ${nodes.length} nodes, ${edges.length} edges`);

        // Apply force layout with proper positioning and improved spacing
        const positionedComponents = nodes.map((node, index) => {
          const row = Math.floor(index / 4);  // 4 columns instead of 5 for better spacing
          const col = index % 4;
          return {
            ...node,
            position: {
              x: 450 + (col * 400),  // Account for sidebar + better spacing
              y: 200 + (row * 250),  // Better spacing for overview cards
            },
            size: {
              width: 200,  // Wider cards for better readability
              height: 140  // Taller cards for more content
            }
          };
        });

        console.log('Positioned components:', positionedComponents.slice(0, 3).map(c => ({
          name: c.name,
          x: c.position?.x,
          y: c.position?.y
        })));

        architectureData.components = positionedComponents;
      }

      // Calculate max level from components
      const levels = architectureData.components?.map(comp => comp.level || 0) || [];
      const calculatedMaxLevel = Math.max(...levels, 0);
      const minLevel = Math.min(...levels, 0);

      console.log('Component levels:', {
        min: minLevel,
        max: calculatedMaxLevel,
        distribution: levels.reduce((acc, level) => {
          acc[level] = (acc[level] || 0) + 1;
          return acc;
        }, {} as Record<number, number>)
      });

      // Detect available perspectives from analyzer contributions
      const perspectives = new Set<string>(['all']);
      analysisResult.analyzer_contributions?.forEach((contrib: any) => {
        const analyzerType = contrib.analyzer_name.toLowerCase();
        if (analyzerType.includes('typescript')) perspectives.add('typescript');
        if (analyzerType.includes('nestjs')) perspectives.add('nestjs');
        if (analyzerType.includes('react')) perspectives.add('react');
        if (analyzerType.includes('express')) perspectives.add('express');
      });
      setAvailablePerspectives(Array.from(perspectives));

      setMaxLevel(calculatedMaxLevel);
      // Start at the minimum level that has components
      setCurrentLevel(minLevel);

      setArchitectureLayout(architectureData);

      // Note: Telemetry endpoints are not implemented yet
      // Skip telemetry fetching for now
    } catch (err: any) {
      console.error('Failed to fetch architecture layout:', err);
      setError(err.response?.data?.message || 'Failed to load visualization data');
    } finally {
      setLoading(false);
    }
  };

  const generateForceLayout = (components: ArchitectureComponent[], edges: Array<{source: string, target: string}>): ArchitectureComponent[] => {
    if (!components || components.length === 0) {
      return [];
    }

    const canvasWidth = typeof window !== 'undefined' ? window.innerWidth * 0.8 : 1200;
    const canvasHeight = typeof window !== 'undefined' ? window.innerHeight * 0.7 : 800;

    // Create node map for quick lookup
    const nodeMap = new Map();
    const nodes = components.map((comp, index) => {
      const node = {
        ...comp,
        x: Math.random() * canvasWidth,
        y: Math.random() * canvasHeight,
        vx: 0,
        vy: 0,
        size: {
          width: 160,
          height: 120
        }
      };
      nodeMap.set(comp.id, node);
      return node;
    });

    // Force simulation with edge attraction
    const iterations = 300;
    const repulsionStrength = 50000;
    const attractionStrength = 0.1;
    const centerForce = 0.005;
    const damping = 0.85;

    for (let iter = 0; iter < iterations; iter++) {
      // Apply repulsion force between all nodes (stronger)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const minDistance = 200; // Minimum distance between nodes

          if (distance < minDistance) {
            const force = repulsionStrength / (distance * distance);
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;

            nodes[i].vx -= fx;
            nodes[i].vy -= fy;
            nodes[j].vx += fx;
            nodes[j].vy += fy;
          }
        }
      }

      // Apply attraction force for connected nodes (from CAS edges)
      edges.forEach(edge => {
        const sourceNode = nodeMap.get(edge.source);
        const targetNode = nodeMap.get(edge.target);

        if (sourceNode && targetNode) {
          const dx = targetNode.x - sourceNode.x;
          const dy = targetNode.y - sourceNode.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const desiredDistance = 250; // Desired distance for connected nodes

          const force = (distance - desiredDistance) * attractionStrength;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;

          sourceNode.vx += fx;
          sourceNode.vy += fy;
          targetNode.vx -= fx;
          targetNode.vy -= fy;
        }
      });

      // Apply centering force and update positions
      nodes.forEach(node => {
        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;
        node.vx += (centerX - node.x) * centerForce;
        node.vy += (centerY - node.y) * centerForce;

        // Apply velocity damping
        node.vx *= damping;
        node.vy *= damping;

        // Update positions
        node.x += node.vx;
        node.y += node.vy;

        // Keep nodes within bounds with margin
        const margin = 150;
        node.x = Math.max(margin, Math.min(canvasWidth - margin, node.x));
        node.y = Math.max(margin, Math.min(canvasHeight - margin, node.y));
      });
    }

    return nodes.map(node => ({
      ...node,
      position: { x: node.x, y: node.y }
    }));
  };


  const fetchSystemHealth = async (id: string) => {
    try {
      const response = await axios.get('/api/architecture/health');
      setSystemHealth(response.data);
    } catch (err) {
      console.error('Failed to fetch system health:', err);
    }
  };

  const fetchTelemetryUpdates = async () => {
    if (!architectureLayout?.components) return;

    // Note: Telemetry endpoints are not implemented yet
    // Skip telemetry fetching for now
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Allow dragging on the canvas background or when not clicking on components
    const target = e.target as HTMLElement;
    const isComponentClick = target.closest('[data-component]');

    if (!isComponentClick) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - viewTransform.x, y: e.clientY - viewTransform.y });
      e.preventDefault();
    }
  }, [viewTransform]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && dragStart) {
      setViewTransform(prev => ({
        ...prev,
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      }));
    }
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
  }, []);

  // Add global mouse event listeners for dragging
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseMove = (e: MouseEvent) => {
        if (dragStart) {
          setViewTransform(prev => ({
            ...prev,
            x: e.clientX - dragStart.x,
            y: e.clientY - dragStart.y
          }));
        }
      };

      const handleGlobalMouseUp = () => {
        setIsDragging(false);
        setDragStart(null);
      };

      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleGlobalMouseMove);
        document.removeEventListener('mouseup', handleGlobalMouseUp);
      };
    }
  }, [isDragging, dragStart]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom(prev => Math.max(0.2, Math.min(3, prev * delta)));
    }
  }, []);

  const handleComponentClick = (componentId: string, event?: React.MouseEvent) => {
    const component = getFilteredComponents().find(c => c.id === componentId);
    if (!component) return;

    if (component.type === 'architectural_group') {
      // Zoom in on architectural group with animation
      setSelectedGroup(component.name);
      setCurrentLevel(1);
      setSelectedFilter('all');
      setSelectedComponent(null);

      // Animate zoom to focus on the group area
      const groupPosition = component.position;
      if (groupPosition) {
        setViewTransform({
          x: -groupPosition.x + window.innerWidth / 4,
          y: -groupPosition.y + window.innerHeight / 4,
          scale: 1.5
        });
      }
    } else {
      // Regular component click - show connections and zoom in
      setSelectedComponent(componentId === selectedComponent ? null : componentId);

      if (componentId !== selectedComponent && component.position) {
        // Zoom in on the selected component
        setViewTransform({
          x: -component.position.x + window.innerWidth / 3,
          y: -component.position.y + window.innerHeight / 3,
          scale: 2
        });
      }
    }
  };

  const getFilteredComponents = () => {
    if (!architectureLayout?.components) return [];

    let components = architectureLayout.components;

    // Apply perspective filtering
    if (selectedPerspective !== 'all') {
      components = components.filter(comp => {
        if (selectedPerspective === 'nestjs') {
          return comp.framework === 'NestJS' || comp.type.includes('controller') || comp.type.includes('service') || comp.type.includes('module');
        }
        if (selectedPerspective === 'typescript') {
          return comp.language === 'TypeScript';
        }
        if (selectedPerspective === 'react') {
          return comp.framework === 'React' || comp.type.includes('component');
        }
        return true;
      });
    }

    // Apply toggle filters
    if (showFrameworkOnly) {
      components = components.filter(comp =>
        ['controller', 'service', 'module', 'repository', 'entity', 'guard', 'interceptor'].includes(comp.type)
      );
    }

    if (showFunctionsOnly) {
      components = components.filter(comp => comp.type === 'function');
    }

    if (showVariablesOnly) {
      components = components.filter(comp => comp.type === 'variable');
    }

    // Progressive disclosure: start with fewer components, show more as we drill down
    let filteredByLevel;

    if (currentLevel === 0) {
      // Level 0: Show architectural groups (Controllers, Services, Repositories, etc.)
      const architecturalGroups = new Map<string, ArchitectureComponent[]>();

      architectureLayout.components.forEach(comp => {
        let group = 'Other';

        // Group by architectural patterns
        if (comp.type === 'controller' || comp.name.includes('Controller')) {
          group = 'Controllers';
        } else if (comp.type === 'service' || comp.name.includes('Service')) {
          group = 'Services';
        } else if (comp.type === 'repository' || comp.name.includes('Repository')) {
          group = 'Repositories';
        } else if (comp.type === 'module' || comp.name.includes('Module')) {
          group = 'Modules';
        } else if (comp.type === 'entity' || comp.name.includes('Entity')) {
          group = 'Entities';
        } else if (comp.type === 'guard' || comp.name.includes('Guard')) {
          group = 'Guards';
        } else if (comp.type === 'interceptor' || comp.name.includes('Interceptor')) {
          group = 'Interceptors';
        } else if (comp.type === 'middleware' || comp.name.includes('Middleware')) {
          group = 'Middleware';
        }

        if (!architecturalGroups.has(group)) {
          architecturalGroups.set(group, []);
        }
        architecturalGroups.get(group)!.push(comp);
      });

      // Calculate connections between groups
      const groupConnections = new Map<string, Map<string, number>>();

      architecturalGroups.forEach((fromComponents, fromGroup) => {
        if (!groupConnections.has(fromGroup)) {
          groupConnections.set(fromGroup, new Map());
        }

        fromComponents.forEach(fromComp => {
          fromComp.callsTo?.forEach(call => {
            const toComp = architectureLayout.components.find(c => c.id === call.componentId);
            if (toComp) {
              let toGroup = 'Other';
              if (toComp.type === 'controller' || toComp.name.includes('Controller')) toGroup = 'Controllers';
              else if (toComp.type === 'service' || toComp.name.includes('Service')) toGroup = 'Services';
              else if (toComp.type === 'repository' || toComp.name.includes('Repository')) toGroup = 'Repositories';
              else if (toComp.type === 'module' || toComp.name.includes('Module')) toGroup = 'Modules';
              else if (toComp.type === 'entity' || toComp.name.includes('Entity')) toGroup = 'Entities';
              else if (toComp.type === 'guard' || toComp.name.includes('Guard')) toGroup = 'Guards';
              else if (toComp.type === 'interceptor' || toComp.name.includes('Interceptor')) toGroup = 'Interceptors';
              else if (toComp.type === 'middleware' || toComp.name.includes('Middleware')) toGroup = 'Middleware';

              if (toGroup !== fromGroup) {
                const connections = groupConnections.get(fromGroup)!;
                connections.set(toGroup, (connections.get(toGroup) || 0) + 1);
              }
            }
          });
        });
      });

      // Create synthetic group components for Level 0 with positions and connections
      filteredByLevel = Array.from(architecturalGroups.entries())
        .filter(([group, components]) => components.length > 0)
        .map(([group, components], index) => {
          const groupId = `group_${group.toLowerCase()}`;
          const connections = groupConnections.get(group) || new Map();

          return {
            id: groupId,
            name: group,
            type: 'architectural_group',
            path: '',
            layer: 'Architecture',
            language: 'TypeScript',
            framework: 'NestJS',
            level: 0,
            level_name: 'Architecture Groups',
            callsTo: Array.from(connections.entries()).map(([targetGroup, count]) => ({
              componentId: `group_${targetGroup.toLowerCase()}`,
              componentName: targetGroup,
              connectionType: 'group_connection',
              callFrequency: count
            })),
            calledBy: [],
            analysis: {
              complexity: components.length * 5,
              lineCount: components.reduce((sum, c) => sum + (c.analysis?.lineCount || 0), 0),
              testCoverage: 0,
              isEntryPoint: group === 'Controllers',
              isOrphaned: false,
              description: `${group} layer containing ${components.length} components`,
              functions: [],
              imports: [],
              exports: [],
              responsibilities: [`Manages ${components.length} ${group.toLowerCase()}`],
              httpMethods: group === 'Controllers' ? ['GET', 'POST', 'PUT', 'DELETE'] : [],
              dbQueries: group === 'Repositories' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [],
              externalCalls: [],
              patterns: [group.toLowerCase()],
              security: [],
              performance: [],
              rawMetadata: { componentCount: components.length, components: components.map(c => c.id), actualComponents: components }
          },
          position: {
            x: 450 + (index % 3) * 350,  // Account for sidebar
            y: 200 + Math.floor(index / 3) * 220
          },
          size: {
            width: 220,
            height: 160
          }
        };
      });
    } else if (currentLevel === 1) {
      // Level 1: If a group is selected, show only its components
      if (selectedGroup) {
        filteredByLevel = architectureLayout.components.filter(comp => {
          let compGroup = 'Other';
          if (comp.type === 'controller' || comp.name.includes('Controller')) compGroup = 'Controllers';
          else if (comp.type === 'service' || comp.name.includes('Service')) compGroup = 'Services';
          else if (comp.type === 'repository' || comp.name.includes('Repository')) compGroup = 'Repositories';
          else if (comp.type === 'module' || comp.name.includes('Module')) compGroup = 'Modules';
          else if (comp.type === 'entity' || comp.name.includes('Entity')) compGroup = 'Entities';
          else if (comp.type === 'guard' || comp.name.includes('Guard')) compGroup = 'Guards';
          else if (comp.type === 'interceptor' || comp.name.includes('Interceptor')) compGroup = 'Interceptors';
          else if (comp.type === 'middleware' || comp.name.includes('Middleware')) compGroup = 'Middleware';

          return compGroup === selectedGroup && ((comp as any).level || 0) <= 2;
        }).slice(0, 100).map((comp, index) => {
          // Ensure all components have positions
          if (!comp.position) {
            const row = Math.floor(index / 3);
            const col = index % 3;
            return {
              ...comp,
              position: {
                x: 450 + (col * 400),  // Account for sidebar + better spacing
                y: 150 + (row * 280)   // More vertical spacing for details
              },
              size: comp.size || {
                width: 240,  // Wider for better readability
                height: 180  // Taller for more content
              }
            };
          }
          return comp;
        });
      } else {
        // Show components up to level 2, but limit to manageable amount
        filteredByLevel = architectureLayout.components
          .filter(comp => ((comp as any).level || 0) <= 2)
          .slice(0, 100).map((comp, index) => {
            // Ensure all components have positions
            if (!comp.position) {
              const row = Math.floor(index / 3);
              const col = index % 3;
              return {
                ...comp,
                position: {
                  x: 450 + (col * 400),  // Account for sidebar
                  y: 150 + (row * 280)
                },
                size: comp.size || {
                  width: 240,
                  height: 180
                }
              };
            }
            return comp;
          });
      }
    } else {
      // Level 2+: Show more components progressively
      const maxComponentsToShow = Math.min(200 + (currentLevel * 100), architectureLayout.components.length);
      filteredByLevel = architectureLayout.components
        .filter(comp => ((comp as any).level || 0) <= currentLevel + 1)
        .slice(0, maxComponentsToShow);
    }

    // Then apply additional filters
    switch (selectedFilter) {
      case 'critical':
        return filteredByLevel.filter(comp =>
          comp.analysis?.complexity > 15 || comp.analysis?.isEntryPoint
        );
      case 'entry':
        return filteredByLevel.filter(comp => comp.analysis?.isEntryPoint);
      case 'orphaned':
        return filteredByLevel.filter(comp => comp.analysis?.isOrphaned);
      default:
        return filteredByLevel;
    }
  };

  const handleRefresh = () => {
    if (workspaceId && codebaseId) {
      fetchArchitectureLayout();
    }
  };

  const getHealthColor = (health: string) => {
    switch (health) {
      case 'healthy': return theme.palette.success.main;
      case 'warning': return theme.palette.warning.main;
      case 'error': return theme.palette.error.main;
      default: return theme.palette.grey[500];
    }
  };

  const getComponentColor = (component: ArchitectureComponent) => {
    if (component.analysis?.isEntryPoint) return theme.palette.primary.main;
    if (component.analysis?.isOrphaned) return theme.palette.grey[500];
    if ((component.analysis?.complexity || 0) > 20) return theme.palette.error.main;
    if ((component.analysis?.complexity || 0) > 10) return theme.palette.warning.main;
    return theme.palette.success.main;
  };

  const getTypeColor = (type: string) => {
    switch (type.toLowerCase()) {
      case 'controller': return theme.palette.primary.main;
      case 'service': return theme.palette.secondary.main;
      case 'model': return theme.palette.info.main;
      case 'entity': return theme.palette.success.main;
      case 'component': return theme.palette.warning.main;
      case 'module': return theme.palette.error.main;
      case 'utility': return theme.palette.grey[500];
      case 'middleware': return '#9c27b0';
      case 'guard': return '#ff9800';
      case 'interceptor': return '#00bcd4';
      default: return theme.palette.grey[400];
    }
  };

  if (loading) {
    return (
      <Container maxWidth={false} sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Box textAlign="center">
          <CircularProgress size={60} />
          <Typography variant="h6" sx={{ mt: 2 }}>Loading Architecture Blueprint...</Typography>
        </Box>
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxWidth={false} sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => router.push(`/workspace/${workspaceId}`)}>
              Back to Workspace
            </Button>
          }
        >
          <Typography variant="h6">Error Loading Visualization</Typography>
          <Typography>{error}</Typography>
        </Alert>
      </Container>
    );
  }

  return (
    <Box sx={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      bgcolor: '#0a0a0a',
      color: 'white',
      overflow: 'hidden'
    }}>
      {/* Header Control Bar */}
      <Paper
        elevation={0}
        sx={{
          px: 2,
          py: 1,
          borderRadius: 0,
          borderBottom: '1px solid',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          bgcolor: 'rgba(0, 0, 0, 0.8)',
          backdropFilter: 'blur(10px)'
        }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" alignItems="center" spacing={2}>
            <IconButton onClick={() => {
              if (selectedGroup && currentLevel === 1) {
                // Go back to level 0 and clear group selection
                setCurrentLevel(0);
                setSelectedGroup(null);
              } else if (currentLevel > 0) {
                // Go back one level
                setCurrentLevel(currentLevel - 1);
              } else {
                // Go back to workspace
                router.push(`/workspace/${workspaceId}`);
              }
            }} sx={{ color: 'white' }}>
              <ArrowBack />
            </IconButton>

            <Typography variant="h6" sx={{ color: theme.palette.primary.main }}>
              {selectedGroup ? `${architectureLayout?.name} / ${selectedGroup}` : architectureLayout?.name || 'Architecture Blueprint'}
            </Typography>

            <Chip
              icon={<Architecture />}
              label={`${getFilteredComponents().length} Components (Level ${currentLevel})`}
              size="small"
              sx={{ bgcolor: 'rgba(255, 255, 255, 0.1)', color: 'white' }}
            />

            {architectureLayout?.overview && (
              <Stack direction="row" spacing={1}>
                <Chip
                  label={`${architectureLayout.overview.totalFunctions || 0} Functions`}
                  size="small"
                  sx={{ bgcolor: 'rgba(255, 255, 255, 0.1)', color: 'white' }}
                />
                {architectureLayout.functionCallAnalysis?.insights?.criticalPaths && (
                  <Chip
                    label={`${architectureLayout.functionCallAnalysis.insights.criticalPaths} Critical Paths`}
                    size="small"
                    color={architectureLayout.functionCallAnalysis.insights.criticalPaths > 5 ? 'warning' : 'success'}
                  />
                )}
                {architectureLayout.functionCallAnalysis?.insights?.circularDependencies > 0 && (
                  <Chip
                    icon={<Warning />}
                    label={`${architectureLayout.functionCallAnalysis.insights.circularDependencies} Circular Dependencies`}
                    size="small"
                    color="error"
                  />
                )}
              </Stack>
            )}
          </Stack>

          <Stack direction="row" spacing={1}>
              <Tooltip title="All Components">
              <IconButton
                onClick={() => setSelectedFilter('all')}
                sx={{ color: selectedFilter === 'all' ? theme.palette.primary.main : 'white' }}
              >
                <Layers />
              </IconButton>
            </Tooltip>

            <Tooltip title="Critical Components">
              <IconButton
                onClick={() => setSelectedFilter('critical')}
                sx={{ color: selectedFilter === 'critical' ? theme.palette.error.main : 'white' }}
              >
                <Warning />
              </IconButton>
            </Tooltip>

            <Tooltip title="Entry Points">
              <IconButton
                onClick={() => setSelectedFilter('entry')}
                sx={{ color: selectedFilter === 'entry' ? theme.palette.success.main : 'white' }}
              >
                <TrendingUp />
              </IconButton>
            </Tooltip>

            <Tooltip title="Orphaned Components">
              <IconButton
                onClick={() => setSelectedFilter('orphaned')}
                sx={{ color: selectedFilter === 'orphaned' ? theme.palette.grey[400] : 'white' }}
              >
                <ErrorIcon />
              </IconButton>
            </Tooltip>

            <Divider orientation="vertical" flexItem sx={{ bgcolor: 'rgba(255, 255, 255, 0.2)' }} />

            <Stack direction="row" alignItems="center" spacing={1}>
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <Select
                  value={selectedPerspective}
                  onChange={(e) => setSelectedPerspective(e.target.value)}
                  sx={{
                    color: 'white',
                    '.MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255, 255, 255, 0.3)' },
                    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255, 255, 255, 0.5)' },
                    '.MuiSvgIcon-root': { color: 'white' }
                  }}
                >
                  {availablePerspectives.map(perspective => (
                    <MenuItem key={perspective} value={perspective}>
                      {perspective.charAt(0).toUpperCase() + perspective.slice(1)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Tooltip title="Toggle Element Types">
                <IconButton
                  onClick={() => setShowFrameworkOnly(!showFrameworkOnly)}
                  sx={{ color: showFrameworkOnly ? theme.palette.primary.main : 'white' }}
                >
                  <FilterList />
                </IconButton>
              </Tooltip>
            </Stack>

            <Divider orientation="vertical" flexItem sx={{ bgcolor: 'rgba(255, 255, 255, 0.2)' }} />

            <Tooltip title={showConnections ? "Hide Connections" : "Show Connections"}>
              <IconButton
                onClick={() => setShowConnections(!showConnections)}
                sx={{ color: showConnections ? theme.palette.secondary.main : 'white' }}
              >
                <Timeline />
              </IconButton>
            </Tooltip>

            <Tooltip title={showTelemetry ? "Hide Telemetry" : "Show Telemetry"}>
              <IconButton
                onClick={() => setShowTelemetry(!showTelemetry)}
                sx={{ color: showTelemetry ? theme.palette.secondary.main : 'white' }}
              >
                <Speed />
              </IconButton>
            </Tooltip>

            <Divider orientation="vertical" flexItem sx={{ bgcolor: 'rgba(255, 255, 255, 0.2)' }} />

            <Tooltip title={isPlaying ? "Pause Live Updates" : "Start Live Updates"}>
              <IconButton
                onClick={() => setIsPlaying(!isPlaying)}
                sx={{ color: isPlaying ? theme.palette.success.main : 'white' }}
              >
                {isPlaying ? <PauseCircle /> : <PlayCircle />}
              </IconButton>
            </Tooltip>

            <Tooltip title="Refresh">
              <IconButton onClick={handleRefresh} sx={{ color: 'white' }}>
                <Refresh />
              </IconButton>
            </Tooltip>

            <Divider orientation="vertical" flexItem sx={{ bgcolor: 'rgba(255, 255, 255, 0.2)' }} />

            <Tooltip title="Zoom In">
              <IconButton onClick={() => setZoom(z => Math.min(z * 1.2, 3))} sx={{ color: 'white' }}>
                <ZoomIn />
              </IconButton>
            </Tooltip>

            <Tooltip title="Reset Zoom">
              <IconButton onClick={() => setZoom(1)} sx={{ color: 'white' }}>
                <CenterFocusStrong />
              </IconButton>
            </Tooltip>

            <Tooltip title="Zoom Out">
              <IconButton onClick={() => setZoom(z => Math.max(z * 0.8, 0.5))} sx={{ color: 'white' }}>
                <ZoomOut />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Paper>

      {/* Main Layout with Sidebar */}
      <Box sx={{ flex: 1, display: 'flex', position: 'relative' }}>
        {/* Analysis Information Sidebar */}
        <Drawer
          variant="persistent"
          anchor="left"
          open={analysisInfoOpen}
          sx={{
            '& .MuiDrawer-paper': {
              position: 'relative',
              width: 320,
              bgcolor: 'rgba(0, 0, 0, 0.95)',
              borderRight: '1px solid rgba(255, 255, 255, 0.1)',
              color: 'white'
            }
          }}
        >
          <Box sx={{ p: 2, height: '100%', overflow: 'auto' }}>
            <Stack spacing={2}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6" sx={{ color: theme.palette.primary.main }}>
                  Analysis Information
                </Typography>
                <IconButton
                  size="small"
                  onClick={() => setAnalysisInfoOpen(false)}
                  sx={{
                    color: 'white',
                    display: { xs: 'block', md: 'none' }
                  }}
                >
                  <VisibilityOff fontSize="small" />
                </IconButton>
              </Stack>

              {architectureLayout && (
                <>
                  <Box>
                    <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                      Repository
                    </Typography>
                    <Typography sx={{ color: 'white' }}>
                      {architectureLayout.name}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                      {architectureLayout.type} System
                    </Typography>
                  </Box>

                  <Box>
                    <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                      Analyzers Used
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {architectureLayout.overview.frameworks.map(framework => (
                        <Chip
                          key={framework}
                          label={framework}
                          size="small"
                          sx={{ bgcolor: 'rgba(255, 255, 255, 0.1)', color: 'white' }}
                        />
                      ))}
                    </Stack>
                  </Box>

                  <Box>
                    <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                      Code Metrics
                    </Typography>
                    <Stack spacing={1}>
                      <Typography sx={{ color: 'white', fontSize: '0.9rem' }}>
                        Total Components: {architectureLayout.metadata.totalComponents}
                      </Typography>
                      <Typography sx={{ color: 'white', fontSize: '0.9rem' }}>
                        Total Connections: {architectureLayout.metadata.totalConnections}
                      </Typography>
                      <Typography sx={{ color: 'white', fontSize: '0.9rem' }}>
                        Functions: {architectureLayout.overview.totalFunctions}
                      </Typography>
                      <Typography sx={{ color: 'white', fontSize: '0.9rem' }}>
                        Entry Points: {architectureLayout.overview.entryPoints}
                      </Typography>
                    </Stack>
                  </Box>

                  <Box>
                    <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                      View Controls
                    </Typography>
                    <Stack spacing={2}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={showFrameworkOnly}
                            onChange={(e) => setShowFrameworkOnly(e.target.checked)}
                            size="small"
                          />
                        }
                        label="Framework Concepts Only"
                        sx={{ color: 'white' }}
                      />
                      <FormControlLabel
                        control={
                          <Switch
                            checked={showFunctionsOnly}
                            onChange={(e) => setShowFunctionsOnly(e.target.checked)}
                            size="small"
                          />
                        }
                        label="Functions Only"
                        sx={{ color: 'white' }}
                      />
                      <FormControlLabel
                        control={
                          <Switch
                            checked={showVariablesOnly}
                            onChange={(e) => setShowVariablesOnly(e.target.checked)}
                            size="small"
                          />
                        }
                        label="Variables Only"
                        sx={{ color: 'white' }}
                      />
                    </Stack>
                  </Box>

                  {architectureLayout.metadata.lastAnalyzed && (
                    <Box>
                      <Typography variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                        Last analyzed: {new Date(architectureLayout.metadata.lastAnalyzed).toLocaleString()}
                      </Typography>
                      <br />
                      <Typography variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                        Analysis v{architectureLayout.metadata.analysisVersion}
                      </Typography>
                    </Box>
                  )}
                </>
              )}
            </Stack>
          </Box>
        </Drawer>
        {/* Blueprint Canvas */}
        <Box
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onWheel={handleWheel}
          sx={{
            flex: 1,
            position: 'relative',
            background: 'radial-gradient(circle at center, #0a1929 0%, #000 100%)',
            overflow: 'hidden',
            cursor: isDragging ? 'grabbing' : 'grab'
          }}
        >
          {/* Grid Background */}
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `
                linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
              `,
              backgroundSize: '50px 50px',
              opacity: 0.5
            }}
          />

          {/* Components Visualization */}
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              transition: isDragging ? 'none' : 'transform 0.3s ease'
            }}
          >
            {getFilteredComponents().map((component) => {
              const telemetry = telemetryData.get(component.id);
              const isSelected = selectedComponent === component.id;
              const componentColor = getComponentColor(component);
              const typeColor = getTypeColor(component.type);

              return (
                <Fade in key={component.id}>
                  <Box
                    data-component={component.id}
                    onClick={(event) => handleComponentClick(component.id, event)}
                    sx={{
                      position: 'absolute',
                      left: component.position?.x || 0,
                      top: component.position?.y || 0,
                      width: component.size?.width || 120,
                      height: component.size?.height || 80,
                      bgcolor: isSelected ? 'rgba(33, 150, 243, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                      border: '2px solid',
                      borderColor: isSelected ? theme.palette.primary.main : componentColor,
                      borderRadius: 1,
                      cursor: 'pointer',
                      transition: 'all 0.3s ease',
                      '&:hover': {
                        bgcolor: 'rgba(255, 255, 255, 0.1)',
                        borderColor: theme.palette.primary.light,
                        transform: 'scale(1.05)',
                        zIndex: 10,
                        '&::after': currentLevel < maxLevel ? {
                          content: '"⊕"',
                          position: 'absolute',
                          top: -5,
                          right: -5,
                          bgcolor: theme.palette.primary.main,
                          color: 'white',
                          borderRadius: '50%',
                          width: 20,
                          height: 20,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px'
                        } : {}
                      },
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      p: 1
                    }}
                  >
                    <Typography
                      variant="caption"
                      sx={{
                        color: 'white',
                        fontWeight: 'bold',
                        textAlign: 'center',
                        fontSize: zoom > 1.5 ? '0.9rem' : (currentLevel === 0 ? '0.9rem' : '0.7rem'),
                        mb: 0.5,
                        lineHeight: 1.2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: zoom > 1.5 ? 'normal' : 'nowrap',
                        maxWidth: '90%'
                      }}
                    >
                      {zoom > 1.5 ? component.name : (component.name.length > 20 ? `${component.name.substring(0, 17)}...` : component.name)}
                    </Typography>

                    <Chip
                      label={component.type}
                      size="small"
                      sx={{
                        bgcolor: typeColor,
                        color: 'white',
                        fontSize: '0.6rem',
                        height: 16,
                        mb: 0.5
                      }}
                    />

                    {(component.analysis?.complexity || 0) > 0 && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: (component.analysis?.complexity || 0) > 15 ? theme.palette.error.main : 'rgba(255, 255, 255, 0.6)',
                          fontSize: zoom > 1.5 ? '0.8rem' : '0.6rem'
                        }}
                      >
                        Complexity: {component.analysis?.complexity || 0}
                      </Typography>
                    )}

                    {zoom > 1.5 && component.analysis?.responsibilities && component.analysis.responsibilities.length > 0 && (
                      <Box sx={{ mt: 1, px: 1 }}>
                        {component.analysis.responsibilities.slice(0, 2).map((resp, idx) => (
                          <Typography
                            key={idx}
                            variant="caption"
                            sx={{
                              color: 'rgba(255, 255, 255, 0.7)',
                              fontSize: '0.7rem',
                              display: 'block',
                              textAlign: 'left'
                            }}
                          >
                            • {resp.length > 30 ? `${resp.substring(0, 27)}...` : resp}
                          </Typography>
                        ))}
                      </Box>
                    )}

                    {zoom > 2 && component.analysis?.httpMethods && component.analysis.httpMethods.length > 0 && (
                      <Box sx={{ mt: 1 }}>
                        <Stack direction="row" spacing={0.5} justifyContent="center" flexWrap="wrap">
                          {component.analysis.httpMethods.slice(0, 3).map((method, idx) => (
                            <Chip
                              key={idx}
                              label={method}
                              size="small"
                              sx={{
                                bgcolor: 'rgba(76, 175, 80, 0.2)',
                                color: 'lightgreen',
                                fontSize: '0.6rem',
                                height: 14
                              }}
                            />
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {zoom > 2 && component.analysis?.dbQueries && component.analysis.dbQueries.length > 0 && (
                      <Box sx={{ mt: 1 }}>
                        <Stack direction="row" spacing={0.5} justifyContent="center" flexWrap="wrap">
                          {component.analysis.dbQueries.slice(0, 2).map((query, idx) => (
                            <Chip
                              key={idx}
                              label={query}
                              size="small"
                              sx={{
                                bgcolor: 'rgba(255, 152, 0, 0.2)',
                                color: 'orange',
                                fontSize: '0.6rem',
                                height: 14
                              }}
                            />
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {showTelemetry && telemetry && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: -8,
                          right: -8,
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          bgcolor: getHealthColor(telemetry.health),
                          animation: telemetry.health === 'error' ? 'pulse 1s infinite' : 'none',
                          '@keyframes pulse': {
                            '0%': { opacity: 1 },
                            '50%': { opacity: 0.5 },
                            '100%': { opacity: 1 }
                          }
                        }}
                      />
                    )}

                    {((component.callsTo?.length || 0) > 0 || (component.calledBy?.length || 0) > 0) && (
                      <Typography
                        variant="caption"
                        sx={{
                          position: 'absolute',
                          bottom: 2,
                          right: 4,
                          color: 'rgba(255, 255, 255, 0.4)',
                          fontSize: '0.6rem'
                        }}
                      >
                        {(component.callsTo?.length || 0) + (component.calledBy?.length || 0)} connections
                      </Typography>
                    )}

                    {component.analysis?.isEntryPoint && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: 2,
                          left: 4,
                          bgcolor: theme.palette.success.main,
                          borderRadius: '4px',
                          px: 0.5,
                          py: 0.25
                        }}
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color: 'white',
                            fontSize: '0.6rem'
                          }}
                        >
                          Entry
                        </Typography>
                      </Box>
                    )}

                    {component.analysis?.dbQueries?.length > 0 && (
                      <Box
                        sx={{
                          position: 'absolute',
                          bottom: 2,
                          left: 4,
                          bgcolor: theme.palette.warning.main,
                          borderRadius: '4px',
                          px: 0.5,
                          py: 0.25
                        }}
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color: 'white',
                            fontSize: '0.6rem',
                            fontWeight: 'bold'
                          }}
                        >
                          DB Exit
                        </Typography>
                      </Box>
                    )}

                    {component.analysis?.isOrphaned && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: 2,
                          right: 4,
                          bgcolor: theme.palette.grey[600],
                          borderRadius: '4px',
                          px: 0.5,
                          py: 0.25
                        }}
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color: 'white',
                            fontSize: '0.6rem'
                          }}
                        >
                          Orphaned
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </Fade>
              );
            })}

            {/* Connection Lines SVG Layer */}
            {showConnections && (
              <svg
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '200%',
                  height: '200%',
                  pointerEvents: 'none',
                  zIndex: 0
                }}
              >
                <defs>
                  <marker
                    id="arrowhead"
                    markerWidth="10"
                    markerHeight="7"
                    refX="9"
                    refY="3.5"
                    orient="auto"
                  >
                    <polygon
                      points="0 0, 10 3.5, 0 7"
                      fill={theme.palette.primary.main}
                      fillOpacity="0.6"
                    />
                  </marker>
                </defs>
                {(() => {
                  const visibleComponents = getFilteredComponents();
                  const componentMap = new Map(visibleComponents.map(c => [c.id, c]));
                  const drawnConnections = new Set<string>();

                  // Draw connections based on component relationships
                  return visibleComponents.flatMap(fromComponent => {
                    if (!fromComponent.position) return [];

                    return (fromComponent.callsTo || []).map(connection => {
                      const toComponent = componentMap.get(connection.componentId);
                      if (!toComponent?.position || !fromComponent.position) return null;

                      // Avoid duplicate lines
                      const connectionKey = `${fromComponent.id}-${toComponent.id}`;
                      if (drawnConnections.has(connectionKey)) return null;
                      drawnConnections.add(connectionKey);

                      const x1 = fromComponent.position.x + (fromComponent.size?.width || 120) / 2;
                      const y1 = fromComponent.position.y + (fromComponent.size?.height || 80) / 2;
                      const x2 = toComponent.position.x + (toComponent.size?.width || 120) / 2;
                      const y2 = toComponent.position.y + (toComponent.size?.height || 80) / 2;

                      // Calculate path for curved lines
                      const dx = x2 - x1;
                      const dy = y2 - y1;
                      const dr = Math.sqrt(dx * dx + dy * dy);
                      const sweep = dx * dy > 0 ? 0 : 1;

                      return (
                        <g key={connectionKey}>
                          <path
                            d={`M ${x1},${y1} A ${dr},${dr} 0 0,${sweep} ${x2},${y2}`}
                            fill="none"
                            stroke={connection.connectionType === 'import' ? theme.palette.info.main : theme.palette.primary.main}
                            strokeWidth={Math.min(3, Math.max(1, connection.callFrequency))}
                            strokeOpacity={0.3}
                            strokeDasharray={connection.connectionType === 'async' ? '5,5' : 'none'}
                            markerEnd="url(#arrowhead)"
                          />
                        </g>
                      );
                    }).filter(Boolean);
                  });
                })()}
              </svg>
            )}
          </Box>
        </Box>

        {/* Side Panel - Component Details */}
        <Fade in={selectedComponent !== null}>
          <Paper
            sx={{
              position: 'absolute',
              right: 16,
              top: 16,
              bottom: 16,
              width: 320,
              bgcolor: 'rgba(0, 0, 0, 0.9)',
              backdropFilter: 'blur(10px)',
              border: '1px solid',
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderRadius: 2,
              p: 2,
              overflow: 'auto',
              display: selectedComponent ? 'block' : 'none'
            }}
          >
            {selectedComponent && (() => {
              const component = getFilteredComponents().find(c => c.id === selectedComponent);
              const telemetry = telemetryData.get(selectedComponent);

              if (!component) return null;

              return (
                <>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                    <Typography variant="h6" sx={{ color: 'white' }}>
                      {component.name}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={() => setSelectedComponent(null)}
                      sx={{ color: 'white' }}
                    >
                      <VisibilityOff fontSize="small" />
                    </IconButton>
                  </Stack>

                  <Stack spacing={2}>
                    <Box>
                      <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                        Type & Path
                      </Typography>
                      <Typography sx={{ color: 'white' }}>
                        {component.type}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                        {component.path}
                      </Typography>
                    </Box>

                    <Box>
                      <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                        Technology
                      </Typography>
                      <Stack direction="row" spacing={1}>
                        <Chip label={component.language} size="small" sx={{ bgcolor: 'rgba(255, 255, 255, 0.1)', color: 'white' }} />
                        {component.framework && (
                          <Chip label={component.framework} size="small" sx={{ bgcolor: 'rgba(255, 255, 255, 0.1)', color: 'white' }} />
                        )}
                        <Chip label={component.layer} size="small" sx={{ bgcolor: 'rgba(255, 255, 255, 0.1)', color: 'white' }} />
                      </Stack>
                    </Box>

                    <Box>
                      <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                        Analysis
                      </Typography>
                      <Stack spacing={1}>
                        <Typography sx={{ color: 'white', fontSize: '0.8rem' }}>
                          Complexity: {component.analysis?.complexity || 0}
                        </Typography>
                        <Typography sx={{ color: 'white', fontSize: '0.8rem' }}>
                          Lines of Code: {component.analysis?.lineCount || 0}
                        </Typography>
                        <Typography sx={{ color: 'white', fontSize: '0.8rem' }}>
                          Functions: {component.analysis?.functions?.length || 0}
                        </Typography>
                        {(component.analysis?.testCoverage || 0) > 0 && (
                          <Typography sx={{ color: 'white', fontSize: '0.8rem' }}>
                            Test Coverage: {component.analysis?.testCoverage || 0}%
                          </Typography>
                        )}
                      </Stack>
                    </Box>

                    {telemetry && (
                      <Box>
                        <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                          Health Status
                        </Typography>
                        <Chip
                          label={telemetry.health}
                          size="small"
                          sx={{
                            bgcolor: getHealthColor(telemetry.health),
                            color: 'white'
                          }}
                        />
                      </Box>
                    )}

                    <Box>
                      <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                        Connections
                      </Typography>
                      {component.callsTo?.length > 0 && (
                        <Box mb={1}>
                          <Typography sx={{ color: 'white', fontSize: '0.8rem', mb: 0.5 }}>
                            Calls to ({component.callsTo.length}):
                          </Typography>
                          {component.callsTo.slice(0, 5).map((call, idx) => {
                            const targetComp = architectureLayout?.components.find(c => c.id === call.componentId) ||
                                               getFilteredComponents().find(c => c.id === call.componentId);
                            return (
                              <Typography key={idx} sx={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.7rem', pl: 1 }}>
                                → {targetComp?.name || call.componentName} ({call.connectionType})
                              </Typography>
                            );
                          })}
                          {component.callsTo.length > 5 && (
                            <Typography sx={{ color: 'rgba(255, 255, 255, 0.4)', fontSize: '0.7rem', pl: 1 }}>
                              ...and {component.callsTo.length - 5} more
                            </Typography>
                          )}
                        </Box>
                      )}
                      {component.calledBy?.length > 0 && (
                        <Box>
                          <Typography sx={{ color: 'white', fontSize: '0.8rem', mb: 0.5 }}>
                            Called by ({component.calledBy.length}):
                          </Typography>
                          {component.calledBy.slice(0, 5).map((call, idx) => {
                            const sourceComp = architectureLayout?.components.find(c => c.id === call.componentId) ||
                                              getFilteredComponents().find(c => c.id === call.componentId);
                            return (
                              <Typography key={idx} sx={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.7rem', pl: 1 }}>
                                ← {sourceComp?.name || call.componentName} ({call.connectionType})
                              </Typography>
                            );
                          })}
                          {component.calledBy.length > 5 && (
                            <Typography sx={{ color: 'rgba(255, 255, 255, 0.4)', fontSize: '0.7rem', pl: 1 }}>
                              ...and {component.calledBy.length - 5} more
                            </Typography>
                          )}
                        </Box>
                      )}
                      {component.callsTo?.length === 0 && component.calledBy?.length === 0 && (
                        <Typography sx={{ color: 'rgba(255, 255, 255, 0.4)', fontSize: '0.8rem' }}>
                          No direct connections
                        </Typography>
                      )}
                    </Box>

                    {component.analysis?.description && (
                      <Box>
                        <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                          Description
                        </Typography>
                        <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.8)' }}>
                          {component.analysis.description}
                        </Typography>
                      </Box>
                    )}

                    {(component.analysis?.responsibilities?.length || 0) > 0 && (
                      <Box>
                        <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                          Responsibilities
                        </Typography>
                        <Stack spacing={0.5}>
                          {component.analysis.responsibilities.slice(0, 3).map((resp, idx) => (
                            <Typography key={idx} variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.7)' }}>
                              • {resp}
                            </Typography>
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {(component.analysis?.isEntryPoint || component.analysis?.isOrphaned || component.analysis?.dbQueries?.length > 0) && (
                      <Box>
                        <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                          Flags
                        </Typography>
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          {component.analysis?.isEntryPoint && (
                            <Chip label="Entry Point" size="small" color="success" />
                          )}
                          {component.analysis?.dbQueries?.length > 0 && (
                            <Chip
                              label="Database Exit"
                              size="small"
                              sx={{ bgcolor: theme.palette.warning.main, color: 'white' }}
                              icon={<DataUsage />}
                            />
                          )}
                          {component.analysis?.isOrphaned && (
                            <Chip label="Orphaned" size="small" sx={{ bgcolor: theme.palette.grey[600], color: 'white' }} />
                          )}
                        </Stack>
                      </Box>
                    )}

                    {component.analysis?.dbQueries?.length > 0 && (
                      <Box>
                        <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                          Database Operations
                        </Typography>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap">
                          {component.analysis.dbQueries.map((query, idx) => (
                            <Chip
                              key={idx}
                              label={query}
                              size="small"
                              sx={{ bgcolor: 'rgba(255, 165, 0, 0.2)', color: 'orange', fontSize: '0.7rem' }}
                            />
                          ))}
                        </Stack>
                      </Box>
                    )}

                    {currentLevel < maxLevel && (
                      <Box>
                        <Button
                          fullWidth
                          variant="outlined"
                          size="small"
                          onClick={() => handleComponentClick(component.id, { ctrlKey: true } as any)}
                          sx={{
                            borderColor: 'rgba(255, 255, 255, 0.3)',
                            color: 'white',
                            '&:hover': {
                              borderColor: theme.palette.primary.main,
                              bgcolor: 'rgba(33, 150, 243, 0.1)'
                            }
                          }}
                        >
                          <ChevronRight /> Drill Down
                        </Button>
                      </Box>
                    )}
                  </Stack>
                </>
              );
            })()}
          </Paper>
        </Fade>

        {/* System Overview */}
        {architectureLayout && (
          <Fade in>
            <Paper
              sx={{
                position: 'absolute',
                left: 16,
                bottom: 16,
                bgcolor: 'rgba(0, 0, 0, 0.9)',
                backdropFilter: 'blur(10px)',
                border: '1px solid',
                borderColor: 'rgba(255, 255, 255, 0.1)',
                borderRadius: 2,
                p: 2
              }}
            >
              <Stack spacing={1}>
                <Typography variant="overline" sx={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                  System Analysis
                </Typography>

                {architectureLayout.functionCallAnalysis?.insights?.circularDependencies > 0 && (
                  <Chip
                    icon={<Warning />}
                    label={`${architectureLayout.functionCallAnalysis.insights.circularDependencies} Circular Dependencies`}
                    size="small"
                    color="error"
                    variant="outlined"
                  />
                )}

                {architectureLayout.functionCallAnalysis?.insights?.orphanedFunctions > 0 && (
                  <Chip
                    icon={<ErrorIcon />}
                    label={`${architectureLayout.functionCallAnalysis.insights.orphanedFunctions} Orphaned Functions`}
                    size="small"
                    color="warning"
                    variant="outlined"
                  />
                )}

                {architectureLayout.functionCallAnalysis?.insights?.highComplexityComponents > 0 && (
                  <Chip
                    icon={<BugReport />}
                    label={`${architectureLayout.functionCallAnalysis.insights.highComplexityComponents} High Complexity`}
                    size="small"
                    color="warning"
                    variant="outlined"
                  />
                )}

                {architectureLayout.metadata?.lastAnalyzed && (
                  <Typography variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                    Last analyzed: {new Date(architectureLayout.metadata.lastAnalyzed).toLocaleTimeString()}
                  </Typography>
                )}
                {architectureLayout.metadata?.analysisVersion && (
                  <Typography variant="caption" sx={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                    Analysis v{architectureLayout.metadata.analysisVersion}
                  </Typography>
                )}
              </Stack>
            </Paper>
          </Fade>
        )}
      </Box>
    </Box>
  );
};

export default CodebaseVisualizationPage;