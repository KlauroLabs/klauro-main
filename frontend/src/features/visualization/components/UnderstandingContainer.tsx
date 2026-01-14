import React, { useState, useCallback } from 'react';
import {
  Box,
  CircularProgress,
  Alert,
  IconButton,
  Stack,
  Typography,
  Breadcrumbs,
  Link,
  Paper,
} from '@mui/material';
import { Refresh, Home } from '@mui/icons-material';

import { useCASVisualization } from '../hooks/useCASVisualization';
import { Domain, Capability, FlowStep } from '../utils/domainExtractor';
import { SystemOverview } from '../views/SystemOverview';
import { DomainView } from '../views/DomainView';
import { FlowView } from '../views/FlowView';
import { NodeDetailPanel } from './NodeDetailPanel';
import { useNodeSelection } from '../hooks/useNodeSelection';

type ViewLevel = 'system' | 'domain' | 'flow' | 'component';

interface NavigationState {
  level: ViewLevel;
  domain?: Domain;
  capability?: Capability;
  step?: FlowStep;
}

export interface UnderstandingContainerProps {
  workspaceId?: string;
  codebaseId?: string;
}

export const UnderstandingContainer: React.FC<UnderstandingContainerProps> = ({
  workspaceId,
  codebaseId,
}) => {
  const [navigation, setNavigation] = useState<NavigationState>({ level: 'system' });
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);

  const {
    cas,
    loading,
    error,
    refetch,
    nodes,
    edges,
    entryPoints,
    exitPoints,
    getNodeById,
    getCallChainsForNode,
  } = useCASVisualization({ workspaceId, codebaseId });

  const {
    selectedNode,
    selectNode,
    incomingConnections,
    outgoingConnections,
    outgoingExitPoints,
    canGoBack,
    goBack,
  } = useNodeSelection({ nodes, edges, exitPoints });

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
    const node = getNodeById(step.nodeId);
    if (node) {
      selectNode(step.nodeId);
      setDetailPanelOpen(true);
    }
  }, [getNodeById, selectNode]);

  const handleNodeClick = useCallback((nodeId: string) => {
    const node = getNodeById(nodeId);
    if (node) {
      selectNode(nodeId);
      setDetailPanelOpen(true);
    }
  }, [getNodeById, selectNode]);

  const handleBackToSystem = useCallback(() => {
    setNavigation({ level: 'system' });
  }, []);

  const handleBackToDomain = useCallback(() => {
    setNavigation(prev => ({
      level: 'domain',
      domain: prev.domain,
    }));
  }, []);

  const handleCloseDetailPanel = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
  }, [selectNode]);

  const renderBreadcrumbs = () => {
    const items: React.ReactNode[] = [
      <Link
        key="system"
        component="button"
        variant="body2"
        onClick={handleBackToSystem}
        sx={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5 }}
      >
        <Home fontSize="small" />
        System
      </Link>,
    ];

    if (navigation.domain) {
      items.push(
        <Link
          key="domain"
          component="button"
          variant="body2"
          onClick={handleBackToDomain}
          sx={{ cursor: 'pointer' }}
        >
          {navigation.domain.name}
        </Link>
      );
    }

    if (navigation.capability) {
      items.push(
        <Typography key="capability" variant="body2" color="text.primary">
          {navigation.capability.name}
        </Typography>
      );
    }

    return (
      <Paper sx={{ px: 2, py: 1, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Breadcrumbs separator="›">{items}</Breadcrumbs>
      </Paper>
    );
  };

  const renderCurrentView = () => {
    if (!cas) return null;

    switch (navigation.level) {
      case 'system':
        return (
          <SystemOverview
            cas={cas}
            onDomainSelect={handleDomainSelect}
          />
        );

      case 'domain':
        if (!navigation.domain) return null;
        return (
          <DomainView
            domain={navigation.domain}
            onBack={handleBackToSystem}
            onCapabilitySelect={handleCapabilitySelect}
          />
        );

      case 'flow':
        if (!navigation.capability) return null;
        return (
          <FlowView
            capability={navigation.capability}
            nodes={nodes}
            edges={edges}
            exitPoints={exitPoints}
            onBack={handleBackToDomain}
            onStepClick={handleStepClick}
            onNodeClick={handleNodeClick}
          />
        );

      default:
        return null;
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <Stack spacing={2} alignItems="center">
          <CircularProgress />
          <Typography color="text.secondary">Loading system analysis...</Typography>
        </Stack>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', p: 4 }}>
        <Alert
          severity="error"
          action={
            <IconButton color="inherit" size="small" onClick={refetch}>
              <Refresh />
            </IconButton>
          }
        >
          {error}
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {navigation.level !== 'system' && renderBreadcrumbs()}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {renderCurrentView()}
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
            entryPoints={entryPoints}
            exitPoints={exitPoints}
            incomingConnections={incomingConnections}
            outgoingConnections={outgoingConnections}
            outgoingExitPoints={outgoingExitPoints}
            callChains={getCallChainsForNode(selectedNode.id)}
            onClose={handleCloseDetailPanel}
            onNodeClick={(nodeId) => {
              selectNode(nodeId);
            }}
            canGoBack={canGoBack}
            onGoBack={goBack}
          />
        </Box>
      )}
    </Box>
  );
};
