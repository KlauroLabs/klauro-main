import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Paper, CircularProgress, Alert, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import { ForceGraph } from '@/lib/d3/force-graph';
import { BlueprintVisualization } from './BlueprintVisualization';
import { useWebSocket } from '@/hooks/useWebSocket';
import GraphControls from './GraphControls';
import { ArchitectureBlueprint, VisualizationOptions } from '@/types/visualization';

type VisualizationMode = 'force-graph' | 'blueprint';

interface VisualizationCanvasProps {
  blueprint: ArchitectureBlueprint;
  options?: VisualizationOptions;
  projectId?: string;
  onNodeClick?: (nodeId: string) => void;
  onEdgeClick?: (edgeId: string) => void;
}

export const VisualizationCanvas: React.FC<VisualizationCanvasProps> = ({
  blueprint,
  options = {},
  projectId,
  onNodeClick,
  onEdgeClick
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [layout, setLayout] = useState(options.layout || 'force');
  const [visualizationMode, setVisualizationMode] = useState<VisualizationMode>('blueprint');

  const { telemetry, isConnected } = useWebSocket(projectId || '', {
    enabled: !!projectId
  });

  useEffect(() => {
    if (!containerRef.current || !blueprint) return;

    try {
      setIsLoading(true);
      setError(null);

      if (graphRef.current) {
        graphRef.current.destroy();
      }

      graphRef.current = new ForceGraph(containerRef.current, {
        ...options,
        layout,
        onNodeClick: (node) => {
          setSelectedNode(node.id);
          onNodeClick?.(node.id);
        },
        onEdgeClick: (edge) => {
          onEdgeClick?.(edge.id);
        }
      });

      graphRef.current.render(blueprint);
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render visualization');
      setIsLoading(false);
    }

    return () => {
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [blueprint, layout]);

  useEffect(() => {
    if (telemetry && graphRef.current) {
      graphRef.current.updateTelemetry(telemetry);
    }
  }, [telemetry]);

  const handleZoomIn = useCallback(() => {
    const newZoom = Math.min(zoom * 1.2, 5);
    setZoom(newZoom);
    graphRef.current?.setZoom(newZoom);
  }, [zoom]);

  const handleZoomOut = useCallback(() => {
    const newZoom = Math.max(zoom / 1.2, 0.1);
    setZoom(newZoom);
    graphRef.current?.setZoom(newZoom);
  }, [zoom]);

  const handleResetView = useCallback(() => {
    setZoom(1);
    graphRef.current?.resetView();
  }, []);

  const handleLayoutChange = useCallback((newLayout: string) => {
    setLayout(newLayout as 'force' | 'hierarchical' | 'circular' | 'grid' | 'dagre' | 'radial');
  }, []);

  const handleSearch = useCallback((query: string) => {
    graphRef.current?.searchNodes(query);
  }, []);

  const handleFilter = useCallback((filters: any) => {
    graphRef.current?.applyFilters(filters);
  }, []);

  const handleExport = useCallback(async (format: 'svg' | 'png' | 'pdf') => {
    if (!graphRef.current) return;
    
    try {
      const data = await graphRef.current.export(format);
      const blob = new Blob([data], { 
        type: format === 'svg' ? 'image/svg+xml' : 
              format === 'pdf' ? 'application/pdf' : 'image/png'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `visualization-${Date.now()}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, []);

  const handleVisualizationModeChange = useCallback((
    event: React.MouseEvent<HTMLElement>,
    newMode: VisualizationMode
  ) => {
    if (newMode !== null) {
      setVisualizationMode(newMode);
    }
  }, []);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        p: 1,
        borderBottom: 1,
        borderColor: 'divider'
      }}>
        <ToggleButtonGroup
          value={visualizationMode}
          exclusive
          onChange={handleVisualizationModeChange}
          size="small"
          sx={{ height: 32 }}
        >
          <ToggleButton value="blueprint">
            <Tooltip title="Hierarchical system blueprint with drill-down navigation">
              <span>Blueprint View</span>
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="force-graph">
            <Tooltip title="Force-directed graph showing all connections">
              <span>Graph View</span>
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>

        {visualizationMode === 'force-graph' && (
          <GraphControls
            zoom={zoom}
            layout={layout}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onResetView={handleResetView}
            onLayoutChange={handleLayoutChange}
            onSearch={handleSearch}
            onFilter={handleFilter}
            onExport={handleExport}
            isConnected={isConnected}
            nodeCount={blueprint.components.length}
            edgeCount={blueprint.connections.length}
          />
        )}
      </Box>

      {visualizationMode === 'blueprint' ? (
        <BlueprintVisualization
          blueprint={blueprint}
          options={options}
          projectId={projectId}
          onNodeClick={onNodeClick}
        />
      ) : (
        <Paper 
          elevation={1} 
          sx={{ 
            flex: 1, 
            position: 'relative',
            overflow: 'hidden',
            backgroundColor: options.theme === 'dark' ? '#1a1a1a' : '#ffffff'
          }}
        >
          {isLoading && (
            <Box
              sx={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 10
              }}
            >
              <CircularProgress />
            </Box>
          )}
          
          {error && (
            <Alert 
              severity="error" 
              sx={{ 
                position: 'absolute',
                top: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 10
              }}
            >
              {error}
            </Alert>
          )}
          
          <div 
            ref={containerRef}
            style={{ 
              width: '100%', 
              height: '100%',
              opacity: isLoading ? 0.3 : 1,
              transition: 'opacity 0.3s ease'
            }}
          />
        </Paper>
      )}
    </Box>
  );
};