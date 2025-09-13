import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Paper, CircularProgress, Alert, Button, Breadcrumbs, Link } from '@mui/material';
import { BlueprintRenderer } from '@/lib/blueprint/blueprint-renderer';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ArchitectureBlueprint, VisualizationOptions } from '@/types/visualization';

interface BlueprintVisualizationProps {
  blueprint: ArchitectureBlueprint;
  options?: VisualizationOptions;
  projectId?: string;
  onNodeClick?: (nodeId: string) => void;
  onSectionClick?: (sectionId: string) => void;
  onComponentClick?: (componentId: string) => void;
}

export const BlueprintVisualization: React.FC<BlueprintVisualizationProps> = ({
  blueprint,
  options = {},
  projectId,
  onNodeClick,
  onSectionClick,
  onComponentClick
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BlueprintRenderer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [navigationStack, setNavigationStack] = useState<string[]>([]);

  const { telemetry, isConnected } = useWebSocket(projectId || '', {
    enabled: !!projectId
  });

  useEffect(() => {
    if (!containerRef.current || !blueprint) return;

    try {
      setIsLoading(true);
      setError(null);

      if (rendererRef.current) {
        rendererRef.current.destroy();
      }

      rendererRef.current = new BlueprintRenderer(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        theme: options.theme === 'dark' ? 'blueprint' : 'light',
        onSectionClick: (sectionId) => {
          setNavigationStack(prev => [...prev, sectionId]);
          onSectionClick?.(sectionId);
        },
        onComponentClick: (componentId) => {
          onComponentClick?.(componentId);
          onNodeClick?.(componentId);
        }
      });

      rendererRef.current.render(blueprint);
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render blueprint visualization');
      setIsLoading(false);
    }

    return () => {
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
  }, [blueprint, options.theme]);

  useEffect(() => {
    if (telemetry && rendererRef.current) {
      rendererRef.current.updateTelemetry(telemetry);
    }
  }, [telemetry]);

  const handleNavigateBack = useCallback(() => {
    if (rendererRef.current) {
      rendererRef.current.navigateBack();
      setNavigationStack(prev => prev.slice(0, -1));
    }
  }, []);

  const handleNavigateToRoot = useCallback(() => {
    if (rendererRef.current) {
      // Navigate back to level 0
      while (navigationStack.length > 0) {
        rendererRef.current.navigateBack();
      }
      setNavigationStack([]);
    }
  }, [navigationStack.length]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Navigation Controls */}
      <Box sx={{ 
        p: 2, 
        borderBottom: 1, 
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button 
            variant="outlined" 
            size="small"
            onClick={handleNavigateToRoot}
            disabled={navigationStack.length === 0}
          >
            System Overview
          </Button>
          {navigationStack.length > 0 && (
            <Button 
              variant="outlined" 
              size="small"
              onClick={handleNavigateBack}
            >
              Back
            </Button>
          )}
        </Box>

        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: 2,
          fontSize: '0.875rem',
          color: 'text.secondary'
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box 
              sx={{ 
                width: 8, 
                height: 8, 
                borderRadius: '50%', 
                bgcolor: isConnected ? 'success.main' : 'error.main' 
              }} 
            />
            {isConnected ? 'Live Telemetry' : 'Offline'}
          </Box>
          <Box>
            {blueprint.components.length} Components
          </Box>
          <Box>
            {blueprint.connections.length} Connections
          </Box>
        </Box>
      </Box>
      
      {/* Main Visualization Area */}
      <Paper 
        elevation={1} 
        sx={{ 
          flex: 1, 
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: options.theme === 'dark' ? '#001122' : '#ffffff'
        }}
      >
        {isLoading && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2
            }}
          >
            <CircularProgress />
            <Box sx={{ color: 'text.secondary', fontSize: '0.875rem' }}>
              Generating system blueprint...
            </Box>
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
              zIndex: 10,
              maxWidth: '80%'
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

      {/* Status Bar */}
      <Box sx={{ 
        p: 1, 
        borderTop: 1, 
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '0.75rem',
        color: 'text.secondary'
      }}>
        <Box>
          Blueprint Visualization • Click sections to drill down • Live telemetry overlay
        </Box>
        <Box>
          Level {navigationStack.length} • {navigationStack.length > 0 ? navigationStack[navigationStack.length - 1] : 'System Overview'}
        </Box>
      </Box>
    </Box>
  );
};