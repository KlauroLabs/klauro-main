import React, { useState, useCallback } from 'react';
import {
  Box,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  IconButton,
  Divider,
  CircularProgress,
  Alert,
  Paper,
  Chip,
  Stack,
  Tooltip,
  Badge,
} from '@mui/material';
import {
  AccountTree,
  Http,
  Output,
  Timeline,
  Cloud,
  Pattern,
  Info,
  ChevronLeft,
  ChevronRight,
  Refresh,
  ZoomIn,
  ZoomOut,
  CenterFocusStrong,
} from '@mui/icons-material';

import { useCASVisualization } from '../hooks/useCASVisualization';
import { useNodeSelection } from '../hooks/useNodeSelection';
import { VisualizationView, CASPattern } from '../types';

import { ArchitectureOverview } from '../views/ArchitectureOverview';
import { EntryPointsView } from '../views/EntryPointsView';
import { ExitPointsView } from '../views/ExitPointsView';
import { CallChainsView } from '../views/CallChainsView';
import { PatternsView } from '../views/PatternsView';
import { PatternDetailView } from '../views/PatternDetailView';
import { NodeDetailPanel } from './NodeDetailPanel';

const SIDEBAR_WIDTH = 240;
const DETAIL_PANEL_WIDTH = 360;

interface ViewConfig {
  id: VisualizationView;
  label: string;
  icon: React.ReactNode;
  getBadge?: (stats: any) => number | undefined;
}

const VIEW_CONFIG: ViewConfig[] = [
  { id: 'overview', label: 'Architecture', icon: <AccountTree /> },
  {
    id: 'entry-points',
    label: 'Entry Points',
    icon: <Http />,
    getBadge: (stats) => stats.totalEntryPoints || undefined,
  },
  {
    id: 'exit-points',
    label: 'Exit Points',
    icon: <Output />,
    getBadge: (stats) => stats.totalExitPoints || undefined,
  },
  {
    id: 'call-chains',
    label: 'Call Chains',
    icon: <Timeline />,
    getBadge: (stats) => stats.totalCallChains || undefined,
  },
  {
    id: 'patterns',
    label: 'Patterns',
    icon: <Pattern />,
    getBadge: (stats) => stats.totalPatterns || undefined,
  },
  { id: 'external-services', label: 'External Services', icon: <Cloud /> },
];

export interface VisualizationContainerProps {
  workspaceId?: string;
  codebaseId?: string;
}

export const VisualizationContainer: React.FC<VisualizationContainerProps> = ({
  workspaceId,
  codebaseId,
}) => {
  const [currentView, setCurrentView] = useState<VisualizationView>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [selectedPattern, setSelectedPattern] = useState<CASPattern | null>(null);

  const {
    cas,
    loading,
    error,
    refetch,
    nodes,
    edges,
    entryPoints,
    exitPoints,
    externalServices,
    callChains,
    methodCalls,
    patterns,
    stats,
    getNodeById,
    getNodeConnections,
    getCallChainsForNode,
  } = useCASVisualization({ workspaceId, codebaseId });

  const {
    selectedNode,
    selectedNodeId,
    selectNode,
    incomingConnections,
    outgoingConnections,
    outgoingExitPoints,
    history,
    canGoBack,
    goBack,
  } = useNodeSelection({ nodes, edges, exitPoints });

  const handleNodeSelect = useCallback((nodeId: string) => {
    selectNode(nodeId);
    setDetailPanelOpen(true);
  }, [selectNode]);

  const handleNodeDoubleClick = useCallback((nodeId: string) => {
    const node = getNodeById(nodeId);
    if (node?.source?.file) {
      console.log('Open file:', node.source.file, 'at line', node.source.line);
    }
  }, [getNodeById]);

  const handleCloseDetailPanel = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
  }, [selectNode]);

  const renderCurrentView = () => {
    switch (currentView) {
      case 'overview':
        return (
          <ArchitectureOverview
            cas={cas}
            nodes={nodes}
            edges={edges}
            patterns={patterns}
            selectedNodeId={selectedNodeId}
            onNodeSelect={handleNodeSelect}
            onNodeDoubleClick={handleNodeDoubleClick}
            onViewPatterns={() => setCurrentView('patterns')}
          />
        );
      case 'entry-points':
        return (
          <EntryPointsView
            entryPoints={entryPoints}
            nodes={nodes}
            onNodeClick={handleNodeSelect}
          />
        );
      case 'exit-points':
        return (
          <ExitPointsView
            exitPoints={exitPoints}
            nodes={nodes}
            onNodeClick={handleNodeSelect}
          />
        );
      case 'call-chains':
        return (
          <CallChainsView
            callChains={callChains}
            methodCalls={methodCalls}
            nodes={nodes}
            onNodeClick={handleNodeSelect}
          />
        );
      case 'patterns':
        if (selectedPattern) {
          return (
            <PatternDetailView
              pattern={selectedPattern}
              nodes={nodes}
              onNodeSelect={handleNodeSelect}
            />
          );
        }
        return (
          <PatternsView
            patterns={patterns}
            nodes={nodes}
            onBack={() => setCurrentView('overview')}
            onPatternSelect={(pattern) => setSelectedPattern(pattern)}
          />
        );
      case 'external-services':
        return (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">
              External Services View - {externalServices.length} services detected
            </Typography>
          </Box>
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
          <Typography color="text.secondary">Loading visualization...</Typography>
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
      <Drawer
        variant="permanent"
        sx={{
          width: sidebarOpen ? SIDEBAR_WIDTH : 56,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: sidebarOpen ? SIDEBAR_WIDTH : 56,
            boxSizing: 'border-box',
            position: 'relative',
            transition: 'width 0.2s ease',
            overflowX: 'hidden',
          },
        }}
      >
        <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {sidebarOpen && (
            <Typography variant="subtitle2" fontWeight={600} color="text.secondary">
              VIEWS
            </Typography>
          )}
          <IconButton size="small" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? <ChevronLeft /> : <ChevronRight />}
          </IconButton>
        </Box>

        <Divider />

        <List>
          {VIEW_CONFIG.map((view) => {
            const badge = view.getBadge?.(stats);
            const isSelected = currentView === view.id;

            return (
              <ListItem key={view.id} disablePadding>
                <ListItemButton
                  selected={isSelected}
                  onClick={() => {
                    setCurrentView(view.id);
                    setSelectedPattern(null);
                  }}
                  sx={{
                    minHeight: 48,
                    justifyContent: sidebarOpen ? 'initial' : 'center',
                    px: 2.5,
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: 0,
                      mr: sidebarOpen ? 2 : 'auto',
                      justifyContent: 'center',
                      color: isSelected ? 'primary.main' : 'text.secondary',
                    }}
                  >
                    {badge ? (
                      <Badge badgeContent={badge} color="primary" max={999}>
                        {view.icon}
                      </Badge>
                    ) : (
                      view.icon
                    )}
                  </ListItemIcon>
                  {sidebarOpen && (
                    <ListItemText
                      primary={view.label}
                      primaryTypographyProps={{
                        fontWeight: isSelected ? 600 : 400,
                        color: isSelected ? 'primary.main' : 'text.primary',
                      }}
                    />
                  )}
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>

        <Box sx={{ flexGrow: 1 }} />

        <Divider />

        {sidebarOpen && cas && (
          <Box sx={{ p: 2 }}>
            <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
              Analysis Info
            </Typography>
            <Stack spacing={0.5}>
              <Typography variant="caption">
                CAS v{cas.cas_version}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {new Date(cas.analysis_timestamp).toLocaleDateString()}
              </Typography>
              {cas.analyzer_contributions && (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                  {cas.analyzer_contributions.slice(0, 3).map((contrib, i) => (
                    <Chip
                      key={i}
                      label={contrib.analyzer_name.replace('-analyzer', '')}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: '0.65rem', height: 20 }}
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          </Box>
        )}
      </Drawer>

      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {renderCurrentView()}
      </Box>

      <Drawer
        variant="persistent"
        anchor="right"
        open={detailPanelOpen && selectedNode !== null}
        sx={{
          width: detailPanelOpen && selectedNode ? DETAIL_PANEL_WIDTH : 0,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DETAIL_PANEL_WIDTH,
            boxSizing: 'border-box',
            position: 'relative',
          },
        }}
      >
        {selectedNode && (
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
            onNodeClick={handleNodeSelect}
            canGoBack={canGoBack}
            onGoBack={goBack}
          />
        )}
      </Drawer>
    </Box>
  );
};
