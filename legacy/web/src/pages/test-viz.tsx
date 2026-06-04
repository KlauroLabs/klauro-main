import React, { useState, useCallback, useMemo } from 'react';
import Head from 'next/head';
import {
  Box,
  Button,
  Typography,
  Paper,
  Stack,
  Alert,
  CircularProgress,
} from '@mui/material';
import { Upload, Folder } from '@mui/icons-material';
import { CASOutput, CASPattern } from '../features/visualization/types';
import { SystemOverview } from '../features/visualization/views/SystemOverview';
import { DomainView } from '../features/visualization/views/DomainView';
import { FlowView } from '../features/visualization/views/FlowView';
import { ImplementationHealthView } from '../features/visualization/views/ImplementationHealthView';
import { ArchitectureItemsView } from '../features/visualization/views/ArchitectureItemsView';
import { PatternsView } from '../features/visualization/views/PatternsView';
import { PatternDetailView } from '../features/visualization/views/PatternDetailView';
import { GraphView } from '../features/visualization/views/GraphView';
import { TestOverviewView } from '../features/visualization/views/TestOverviewView';
import { TestAreaView } from '../features/visualization/views/TestAreaView';
import { CriticalFlowsView } from '../features/visualization/views/CriticalFlowsView';
import { ChangeRiskView } from '../features/visualization/views/ChangeRiskView';
import { SecurityBoundariesView } from '../features/visualization/views/SecurityBoundariesView';
import { CodeStabilityView } from '../features/visualization/views/CodeStabilityView';
import { DataEntitiesView } from '../features/visualization/views/DataEntitiesView';
import { SystemCapabilitiesView } from '../features/visualization/views/SystemCapabilitiesView';
import { EntryPointsView } from '../features/visualization/views/EntryPointsView';
import { TestArea } from '../features/visualization/utils/testExtractor';
import { NodeDetailPanel } from '../features/visualization/components/NodeDetailPanel';
import { ExitPointDetailPanel } from '../features/visualization/components/ExitPointDetailPanel';
import { useNodeSelection } from '../features/visualization/hooks/useNodeSelection';
import { Domain, Capability, FlowStep, extractDomains, extractSections } from '../features/visualization/utils/domainExtractor';
import { ExitPoint } from '../features/visualization/types';
import { Section, SectionCapability } from '../features/visualization/types/sections';
import { UICapabilities, detectCapabilities } from '../features/visualization/utils/uiCapabilities';
import { getStylesForTypes, NodeStyle } from '../features/visualization/utils/dynamicStyling';

type ViewLevel = 'system' | 'domain' | 'section' | 'flow' | 'section-flow' | 'health' | 'architecture' | 'patterns' | 'pattern-detail' | 'graph' | 'tests' | 'test-area' | 'critical-flows' | 'change-risk' | 'security-boundaries' | 'code-stability' | 'data-entities' | 'system-capabilities' | 'entry-points';

interface NavigationState {
  level: ViewLevel;
  domain?: Domain;
  capability?: Capability;
  section?: Section;
  sectionCapability?: SectionCapability;
  architectureItemType?: string;
  selectedPattern?: CASPattern;
  testArea?: TestArea;
}

const TestVisualizationPage: React.FC = () => {
  const [cas, setCas] = useState<CASOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<NavigationState>({ level: 'system' });
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [selectedExitPoint, setSelectedExitPoint] = useState<{ exitPoint: ExitPoint; sourceNodeId: string } | null>(null);

  const nodes = cas?.nodes || [];
  const edges = cas?.edges || [];
  const exitPoints = cas?.exit_points || [];
  const patterns = cas?.patterns || [];

  const capabilities = useMemo(() => cas ? detectCapabilities(cas) : null, [cas]);
  const sections = useMemo(() => {
    if (!cas || !capabilities) return [];
    return extractSections(cas, capabilities);
  }, [cas, capabilities]);
  const domains = useMemo(() => cas ? extractDomains(cas) : [], [cas]);
  const nodeStyles = useMemo(() => {
    if (!capabilities) return new Map<string, NodeStyle>();
    return getStylesForTypes(capabilities.detectedNodeTypes);
  }, [capabilities]);

  const {
    selectedNode,
    selectNode,
    incomingConnections,
    outgoingConnections,
    outgoingExitPoints,
    canGoBack,
    goBack,
  } = useNodeSelection({ nodes, edges, exitPoints });

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        setCas(json);
        setNavigation({ level: 'system' });
      } catch (err) {
        setError('Failed to parse JSON file');
      } finally {
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setLoading(false);
    };
    reader.readAsText(file);
  }, []);

  const handleDomainSelect = useCallback((domain: Domain) => {
    setNavigation({ level: 'domain', domain });
  }, []);

  const handleCapabilitySelect = useCallback((capability: Capability) => {
    setNavigation(prev => ({
      level: 'flow',
      domain: prev.domain,
      capability,
    }));
  }, []);

  const handleStepClick = useCallback((step: FlowStep) => {
    const node = nodes.find(n => n.id === step.nodeId);
    if (node) {
      selectNode(step.nodeId);
      setDetailPanelOpen(true);
    }
  }, [nodes, selectNode]);

  const handleNodeClick = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      selectNode(nodeId);
      setSelectedExitPoint(null);
      setDetailPanelOpen(true);
    }
  }, [nodes, selectNode]);

  const handleExitPointClick = useCallback((exitPoint: ExitPoint, sourceNodeId: string) => {
    setSelectedExitPoint({ exitPoint, sourceNodeId });
    selectNode(null);
    setDetailPanelOpen(true);
  }, [selectNode]);

  const handleBackToSystem = useCallback(() => {
    setNavigation({ level: 'system' });
  }, []);

  const handleBackToDomain = useCallback(() => {
    setNavigation(prev => ({
      level: 'domain',
      domain: prev.domain,
    }));
  }, []);

  const handleSectionSelect = useCallback((section: Section) => {
    setNavigation({ level: 'section', section });
  }, []);

  const handleSectionCapabilitySelect = useCallback((cap: SectionCapability) => {
    setNavigation(prev => ({
      level: 'section-flow',
      section: prev.section,
      sectionCapability: cap,
    }));
  }, []);

  const handleBackToSection = useCallback(() => {
    setNavigation(prev => ({
      level: 'section',
      section: prev.section,
    }));
  }, []);

  const handleBackToPatterns = useCallback(() => {
    setNavigation({ level: 'patterns' });
  }, []);

  const handleViewImplementationHealth = useCallback(() => {
    setNavigation({ level: 'health' });
  }, []);

  const handleViewArchitectureItems = useCallback((itemType: string) => {
    setNavigation({ level: 'architecture', architectureItemType: itemType });
  }, []);

  const handleViewPatterns = useCallback(() => {
    setNavigation({ level: 'patterns' });
  }, []);

  const handleViewGraph = useCallback(() => {
    setNavigation({ level: 'graph' });
  }, []);

  const handlePatternSelect = useCallback((pattern: CASPattern) => {
    setNavigation({ level: 'pattern-detail', selectedPattern: pattern });
  }, []);

  const handleViewTests = useCallback(() => {
    setNavigation({ level: 'tests' });
  }, []);

  const handleTestAreaSelect = useCallback((area: TestArea) => {
    setNavigation({ level: 'test-area', testArea: area });
  }, []);

  const handleViewCriticalFlows = useCallback(() => {
    setNavigation({ level: 'critical-flows' });
  }, []);

  const handleViewChangeRisk = useCallback(() => {
    setNavigation({ level: 'change-risk' });
  }, []);

  const handleViewSecurityBoundaries = useCallback(() => {
    setNavigation({ level: 'security-boundaries' });
  }, []);

  const handleViewCodeStability = useCallback(() => {
    setNavigation({ level: 'code-stability' });
  }, []);

  const handleViewDataEntities = useCallback(() => {
    setNavigation({ level: 'data-entities' });
  }, []);

  const handleViewSystemCapabilities = useCallback(() => {
    setNavigation({ level: 'system-capabilities' });
  }, []);

  const handleViewEntryPoints = useCallback(() => {
    setNavigation({ level: 'entry-points' });
  }, []);

  const handleBackToTests = useCallback(() => {
    setNavigation({ level: 'tests' });
  }, []);

  const handleCloseDetailPanel = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
    setSelectedExitPoint(null);
  }, [selectNode]);

  const getCallChainsForNode = useCallback((nodeId: string) => {
    const callChains = cas?.call_chains || [];
    return callChains.filter(
      chain =>
        chain.entry_point.node_id === nodeId ||
        chain.exit_point?.node_id === nodeId ||
        chain.call_path.some(p => p.node_id === nodeId)
    );
  }, [cas?.call_chains]);

  const renderUploadScreen = () => (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        bgcolor: 'background.default',
      }}
    >
      <Paper sx={{ p: 6, maxWidth: 500, textAlign: 'center' }}>
        <Folder sx={{ fontSize: 64, color: 'primary.main', mb: 2 }} />
        <Typography variant="h4" fontWeight={600} gutterBottom>
          Test Visualization
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          Upload a CAS JSON file to test the visualization without needing the backend.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <input
          type="file"
          accept=".json"
          onChange={handleFileUpload}
          style={{ display: 'none' }}
          id="cas-file-input"
        />
        <label htmlFor="cas-file-input">
          <Button
            variant="contained"
            component="span"
            size="large"
            startIcon={loading ? <CircularProgress size={20} color="inherit" /> : <Upload />}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Upload CAS JSON'}
          </Button>
        </label>

        <Typography variant="caption" display="block" sx={{ mt: 3 }} color="text.secondary">
          Tip: Use the cas-output.json file from your backend folder
        </Typography>
      </Paper>
    </Box>
  );

  const renderVisualization = () => {
    if (!cas) return null;

    return (
      <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {navigation.level !== 'system' && (
            <Paper sx={{ px: 2, py: 1, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Button size="small" onClick={handleBackToSystem}>
                  System
                </Button>
                {navigation.level === 'health' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Implementation Health</Typography>
                  </>
                )}
                {(navigation.level === 'patterns' || navigation.level === 'pattern-detail') && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    {navigation.level === 'patterns' ? (
                      <Typography variant="body2">Patterns</Typography>
                    ) : (
                      <Button size="small" onClick={handleBackToPatterns}>
                        Patterns
                      </Button>
                    )}
                  </>
                )}
                {navigation.level === 'graph' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Graph</Typography>
                  </>
                )}
                {(navigation.level === 'tests' || navigation.level === 'test-area') && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    {navigation.level === 'tests' ? (
                      <Typography variant="body2">Tests</Typography>
                    ) : (
                      <Button size="small" onClick={handleBackToTests}>
                        Tests
                      </Button>
                    )}
                  </>
                )}
                {navigation.level === 'test-area' && navigation.testArea && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">{navigation.testArea.name}</Typography>
                  </>
                )}
                {navigation.level === 'critical-flows' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Critical Flows</Typography>
                  </>
                )}
                {navigation.level === 'change-risk' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Change Risk</Typography>
                  </>
                )}
                {navigation.level === 'security-boundaries' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Security Boundaries</Typography>
                  </>
                )}
                {navigation.level === 'code-stability' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Code Stability</Typography>
                  </>
                )}
                {navigation.level === 'data-entities' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Data Entities</Typography>
                  </>
                )}
                {navigation.level === 'system-capabilities' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">System Capabilities</Typography>
                  </>
                )}
                {navigation.level === 'entry-points' && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">Entry Points</Typography>
                  </>
                )}
                {navigation.level === 'pattern-detail' && navigation.selectedPattern && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">{navigation.selectedPattern.name}</Typography>
                  </>
                )}
                {navigation.level === 'architecture' && navigation.architectureItemType && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">
                      {navigation.architectureItemType.charAt(0).toUpperCase() + navigation.architectureItemType.slice(1)}s
                    </Typography>
                  </>
                )}
                {navigation.domain && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Button size="small" onClick={handleBackToDomain}>
                      {navigation.domain.name}
                    </Button>
                  </>
                )}
                {navigation.section && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Button size="small" onClick={handleBackToSection}>
                      {navigation.section.name}
                    </Button>
                  </>
                )}
                {navigation.capability && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">{navigation.capability.name}</Typography>
                  </>
                )}
                {navigation.sectionCapability && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">{navigation.sectionCapability.name}</Typography>
                  </>
                )}
              </Stack>
            </Paper>
          )}

          <Box sx={{ flex: 1, overflow: 'hidden' }}>
            {navigation.level === 'system' && capabilities && (
              <SystemOverview
                cas={cas}
                patterns={patterns}
                capabilities={capabilities}
                sections={sections}
                nodeStyles={nodeStyles}
                onDomainSelect={handleDomainSelect}
                onSectionSelect={handleSectionSelect}
                onViewImplementationHealth={handleViewImplementationHealth}
                onViewArchitectureItems={handleViewArchitectureItems}
                onViewPatterns={handleViewPatterns}
                onViewArchitecture={handleViewGraph}
                onViewTests={handleViewTests}
                onTestAreaSelect={handleTestAreaSelect}
                onViewCriticalFlows={handleViewCriticalFlows}
                onViewChangeRisk={handleViewChangeRisk}
                onViewSecurityBoundaries={handleViewSecurityBoundaries}
                onViewCodeStability={handleViewCodeStability}
                onViewDataEntities={handleViewDataEntities}
                onViewSystemCapabilities={handleViewSystemCapabilities}
                onViewEntryPoints={handleViewEntryPoints}
              />
            )}
            {navigation.level === 'graph' && (
              <GraphView
                cas={cas}
                nodes={nodes}
                edges={edges}
                exitPoints={exitPoints}
                selectedNodeId={selectedNode?.id}
                onNodeSelect={handleNodeClick}
                onExitPointClick={handleExitPointClick}
              />
            )}
            {navigation.level === 'patterns' && (
              <PatternsView
                patterns={patterns}
                nodes={nodes}
                onBack={handleBackToSystem}
                onPatternSelect={handlePatternSelect}
              />
            )}
            {navigation.level === 'pattern-detail' && navigation.selectedPattern && (
              <PatternDetailView
                pattern={navigation.selectedPattern}
                nodes={nodes}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'health' && (
              <ImplementationHealthView
                nodes={nodes}
                domains={domains}
                onBack={handleBackToSystem}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'architecture' && navigation.architectureItemType && (
              <ArchitectureItemsView
                itemType={navigation.architectureItemType}
                nodes={nodes}
                nodeStyles={nodeStyles}
                onBack={handleBackToSystem}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'tests' && (
              <TestOverviewView
                cas={cas}
                onBack={handleBackToSystem}
                onAreaSelect={handleTestAreaSelect}
              />
            )}
            {navigation.level === 'test-area' && navigation.testArea && (
              <TestAreaView
                area={navigation.testArea}
                onBack={handleBackToTests}
                onTargetClick={(targetId) => {
                  selectNode(targetId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'critical-flows' && cas && (
              <CriticalFlowsView
                cas={cas}
                onBack={handleBackToSystem}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'change-risk' && cas && (
              <ChangeRiskView
                cas={cas}
                onBack={handleBackToSystem}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'security-boundaries' && cas && (
              <SecurityBoundariesView
                data={cas}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'code-stability' && cas && (
              <CodeStabilityView
                data={cas}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'data-entities' && cas && (
              <DataEntitiesView
                data={cas}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'system-capabilities' && cas && (
              <SystemCapabilitiesView
                data={cas}
                onNodeSelect={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
                onViewCriticalFlows={handleViewCriticalFlows}
              />
            )}
            {navigation.level === 'entry-points' && cas && (
              <EntryPointsView
                entryPoints={cas.entry_points || []}
                nodes={cas.nodes || []}
                onNodeClick={(nodeId) => {
                  selectNode(nodeId);
                  setDetailPanelOpen(true);
                }}
              />
            )}
            {navigation.level === 'domain' && navigation.domain && (
              <DomainView
                domain={navigation.domain}
                nodes={nodes}
                onBack={handleBackToSystem}
                onCapabilitySelect={handleCapabilitySelect}
              />
            )}
            {navigation.level === 'section' && navigation.section && (
              <DomainView
                domain={{
                  id: navigation.section.id,
                  name: navigation.section.name,
                  description: navigation.section.description || '',
                  icon: navigation.section.icon,
                  color: navigation.section.color,
                  capabilities: navigation.section.capabilities.map(cap => ({
                    id: cap.id,
                    name: cap.name,
                    description: cap.description || '',
                    action: '',
                    entryPoint: cap.entryPoint as any,
                    flow: cap.flow,
                    flowSteps: cap.flowSteps,
                    method: cap.method,
                    path: cap.path,
                    requiresAuth: cap.requiresAuth,
                  })),
                  stats: {
                    entryPoints: navigation.section.stats.entryPoints,
                    exitPoints: 0,
                    components: 0,
                    hasDatabase: navigation.section.stats.hasDatabase,
                    hasExternalApi: navigation.section.stats.hasExternalCalls,
                    hasAuth: navigation.section.stats.hasAuth,
                  },
                }}
                nodes={nodes}
                onBack={handleBackToSystem}
                onCapabilitySelect={(cap) => {
                  const sectionCap = navigation.section?.capabilities.find(c => c.id === cap.id);
                  if (sectionCap) {
                    handleSectionCapabilitySelect(sectionCap);
                  }
                }}
              />
            )}
            {navigation.level === 'flow' && navigation.capability && (
              <FlowView
                capability={navigation.capability}
                nodes={nodes}
                edges={edges}
                exitPoints={exitPoints}
                nodeStyles={nodeStyles}
                onBack={handleBackToDomain}
                onStepClick={handleStepClick}
                onNodeClick={handleNodeClick}
                onExitPointClick={handleExitPointClick}
              />
            )}
            {navigation.level === 'section-flow' && navigation.sectionCapability && (
              <FlowView
                capability={{
                  id: navigation.sectionCapability.id,
                  name: navigation.sectionCapability.name,
                  description: navigation.sectionCapability.description || '',
                  action: '',
                  entryPoint: navigation.sectionCapability.entryPoint as any,
                  flow: navigation.sectionCapability.flow,
                  flowSteps: navigation.sectionCapability.flowSteps,
                  method: navigation.sectionCapability.method,
                  path: navigation.sectionCapability.path,
                  requiresAuth: navigation.sectionCapability.requiresAuth,
                }}
                nodes={nodes}
                edges={edges}
                exitPoints={exitPoints}
                nodeStyles={nodeStyles}
                onBack={handleBackToSection}
                onStepClick={handleStepClick}
                onNodeClick={handleNodeClick}
                onExitPointClick={handleExitPointClick}
              />
            )}
          </Box>
        </Box>

        {detailPanelOpen && (selectedNode || selectedExitPoint) && (
          <Box
            sx={{
              width: 400,
              borderLeft: 1,
              borderColor: 'divider',
              overflow: 'auto',
            }}
          >
            {selectedNode ? (
              <NodeDetailPanel
                node={selectedNode}
                allNodes={nodes}
                allEdges={edges}
                decorators={cas?.decorators}
                entryPoints={cas?.entry_points}
                exitPoints={cas?.exit_points}
                incomingConnections={incomingConnections}
                outgoingConnections={outgoingConnections}
                outgoingExitPoints={outgoingExitPoints}
                callChains={getCallChainsForNode(selectedNode.id)}
                onClose={handleCloseDetailPanel}
                onNodeClick={(nodeId) => selectNode(nodeId)}
                canGoBack={canGoBack}
                onGoBack={goBack}
              />
            ) : selectedExitPoint ? (
              <ExitPointDetailPanel
                exitPoint={selectedExitPoint.exitPoint}
                sourceNodeName={nodes.find(n => n.id === selectedExitPoint.sourceNodeId)?.name}
                onClose={handleCloseDetailPanel}
              />
            ) : null}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <>
      <Head>
        <title>Test Visualization | Klauro</title>
      </Head>
      {cas ? renderVisualization() : renderUploadScreen()}
    </>
  );
};

export default TestVisualizationPage;
