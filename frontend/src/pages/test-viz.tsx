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
import { SystemOverview, ArchitectureItemType } from '../features/visualization/views/SystemOverview';
import { DomainView } from '../features/visualization/views/DomainView';
import { FlowView } from '../features/visualization/views/FlowView';
import { ImplementationHealthView } from '../features/visualization/views/ImplementationHealthView';
import { ArchitectureItemsView } from '../features/visualization/views/ArchitectureItemsView';
import { PatternsView } from '../features/visualization/views/PatternsView';
import { PatternDetailView } from '../features/visualization/views/PatternDetailView';
import { NodeDetailPanel } from '../features/visualization/components/NodeDetailPanel';
import { useNodeSelection } from '../features/visualization/hooks/useNodeSelection';
import { Domain, Capability, FlowStep, extractDomains } from '../features/visualization/utils/domainExtractor';

type ViewLevel = 'system' | 'domain' | 'flow' | 'health' | 'architecture' | 'patterns' | 'pattern-detail';

interface NavigationState {
  level: ViewLevel;
  domain?: Domain;
  capability?: Capability;
  architectureItemType?: ArchitectureItemType;
  selectedPattern?: CASPattern;
}

const TestVisualizationPage: React.FC = () => {
  const [cas, setCas] = useState<CASOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<NavigationState>({ level: 'system' });
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);

  const nodes = cas?.nodes || [];
  const edges = cas?.edges || [];
  const exitPoints = cas?.exit_points || [];
  const patterns = cas?.patterns || [];
  const domains = useMemo(() => cas ? extractDomains(cas) : [], [cas]);

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

  const handleBackToSystem = useCallback(() => {
    setNavigation({ level: 'system' });
  }, []);

  const handleBackToDomain = useCallback(() => {
    setNavigation(prev => ({
      level: 'domain',
      domain: prev.domain,
    }));
  }, []);

  const handleBackToPatterns = useCallback(() => {
    setNavigation({ level: 'patterns' });
  }, []);

  const handleViewImplementationHealth = useCallback(() => {
    setNavigation({ level: 'health' });
  }, []);

  const handleViewArchitectureItems = useCallback((itemType: ArchitectureItemType) => {
    setNavigation({ level: 'architecture', architectureItemType: itemType });
  }, []);

  const handleViewPatterns = useCallback(() => {
    setNavigation({ level: 'patterns' });
  }, []);

  const handlePatternSelect = useCallback((pattern: CASPattern) => {
    setNavigation({ level: 'pattern-detail', selectedPattern: pattern });
  }, []);

  const handleCloseDetailPanel = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
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
                {navigation.capability && (
                  <>
                    <Typography color="text.secondary">/</Typography>
                    <Typography variant="body2">{navigation.capability.name}</Typography>
                  </>
                )}
              </Stack>
            </Paper>
          )}

          <Box sx={{ flex: 1, overflow: 'hidden' }}>
            {navigation.level === 'system' && (
              <SystemOverview
                cas={cas}
                patterns={patterns}
                onDomainSelect={handleDomainSelect}
                onViewImplementationHealth={handleViewImplementationHealth}
                onViewArchitectureItems={handleViewArchitectureItems}
                onViewPatterns={handleViewPatterns}
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
                onBack={handleBackToSystem}
                onNodeSelect={(nodeId) => {
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
            {navigation.level === 'flow' && navigation.capability && (
              <FlowView
                capability={navigation.capability}
                nodes={nodes}
                onBack={handleBackToDomain}
                onStepClick={handleStepClick}
              />
            )}
          </Box>
        </Box>

        {detailPanelOpen && selectedNode && (
          <Box
            sx={{
              width: 400,
              borderLeft: 1,
              borderColor: 'divider',
              overflow: 'auto',
            }}
          >
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
          </Box>
        )}
      </Box>
    );
  };

  return (
    <>
      <Head>
        <title>Test Visualization | Unravl</title>
      </Head>
      {cas ? renderVisualization() : renderUploadScreen()}
    </>
  );
};

export default TestVisualizationPage;
