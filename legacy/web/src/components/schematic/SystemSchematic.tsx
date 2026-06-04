import React, { useState, useCallback } from 'react';
import { Box, Paper, Typography, Chip, Alert } from '@mui/material';
import { 
  Warning, 
  Error as ErrorIcon, 
  CheckCircle, 
  People, 
  Memory,
  Storage,
  Router
} from '@mui/icons-material';

interface SystemNode {
  id: string;
  name: string;
  type: 'section' | 'subsystem' | 'component' | 'endpoint';
  status: 'healthy' | 'warning' | 'critical' | 'offline';
  children?: SystemNode[];
  position: { x: number; y: number };
  size: { width: number; height: number };
  connections: string[];
  metrics: {
    cpu?: number;
    memory?: number;
    requests?: number;
    errors?: number;
    activeUsers?: number;
  };
  issues: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    component: string;
  }>;
}

interface SystemSchematicProps {
  systemData: SystemNode;
  onNodeClick: (nodeId: string) => void;
  onDrillDown: (nodeId: string) => void;
  currentPath: string[];
}

export const SystemSchematic: React.FC<SystemSchematicProps> = ({
  systemData,
  onNodeClick,
  onDrillDown,
  currentPath
}) => {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return '#4caf50';
      case 'warning': return '#ff9800';
      case 'critical': return '#f44336';
      case 'offline': return '#9e9e9e';
      default: return '#2196f3';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy': return <CheckCircle fontSize="small" />;
      case 'warning': return <Warning fontSize="small" />;
      case 'critical': return <ErrorIcon fontSize="small" />;
      default: return <Memory fontSize="small" />;
    }
  };

  const handleNodeClick = useCallback((node: SystemNode) => {
    setSelectedNode(node.id);
    onNodeClick(node.id);
    
    // If node has children, drill down
    if (node.children && node.children.length > 0) {
      onDrillDown(node.id);
    }
  }, [onNodeClick, onDrillDown]);

  const renderConnections = () => {
    if (!systemData.children) return null;

    return (
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 1
        }}
      >
        {systemData.children.map(node => 
          node.connections.map(connectionId => {
            const targetNode = systemData.children?.find(n => n.id === connectionId);
            if (!targetNode) return null;

            const startX = node.position.x + node.size.width / 2;
            const startY = node.position.y + node.size.height / 2;
            const endX = targetNode.position.x + targetNode.size.width / 2;
            const endY = targetNode.position.y + targetNode.size.height / 2;

            return (
              <line
                key={`${node.id}-${connectionId}`}
                x1={startX}
                y1={startY}
                x2={endX}
                y2={endY}
                stroke="#00bcd4"
                strokeWidth="2"
                strokeOpacity="0.6"
                strokeDasharray={node.metrics.requests ? "none" : "5,5"}
              />
            );
          })
        )}
      </svg>
    );
  };

  const renderDataFlow = () => {
    if (!systemData.children) return null;

    return systemData.children
      .filter(node => node.metrics.requests && node.metrics.requests > 0)
      .map(node => (
        <Box
          key={`flow-${node.id}`}
          sx={{
            position: 'absolute',
            left: node.position.x + node.size.width - 8,
            top: node.position.y - 4,
            width: 16,
            height: 16,
            borderRadius: '50%',
            bgcolor: '#4caf50',
            animation: 'pulse 2s infinite',
            zIndex: 10
          }}
        />
      ));
  };

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '600px', overflow: 'hidden' }}>
      {/* Main Schematic Canvas */}
      <Paper
        elevation={0}
        sx={{
          position: 'relative',
          width: '100%',
          height: '100%',
          bgcolor: '#000814',
          backgroundImage: 'radial-gradient(circle at 25% 25%, #001d3d 0%, #000814 50%)',
          border: '2px solid #00bcd4',
          overflow: 'hidden'
        }}
      >
        {/* Grid Background */}
        <Box
          sx={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            backgroundImage: `
              linear-gradient(rgba(0, 188, 212, 0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0, 188, 212, 0.1) 1px, transparent 1px)
            `,
            backgroundSize: '20px 20px',
            opacity: 0.3
          }}
        />

        {/* Render Connections */}
        {renderConnections()}

        {/* System Nodes */}
        {systemData.children?.map(node => (
          <Paper
            key={node.id}
            onClick={() => handleNodeClick(node)}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            sx={{
              position: 'absolute',
              left: node.position.x,
              top: node.position.y,
              width: node.size.width,
              height: node.size.height,
              bgcolor: selectedNode === node.id ? 'rgba(255, 235, 59, 0.1)' : 'rgba(0, 188, 212, 0.05)',
              border: `2px solid ${getStatusColor(node.status)}`,
              borderRadius: 1,
              cursor: node.children ? 'pointer' : 'default',
              transition: 'all 0.3s ease',
              zIndex: selectedNode === node.id ? 5 : 2,
              transform: hoveredNode === node.id ? 'scale(1.05)' : 'scale(1)',
              boxShadow: selectedNode === node.id 
                ? `0 0 20px ${getStatusColor(node.status)}` 
                : hoveredNode === node.id 
                  ? `0 0 10px ${getStatusColor(node.status)}` 
                  : 'none',
              '&:hover': {
                bgcolor: 'rgba(0, 188, 212, 0.1)'
              }
            }}
          >
            <Box sx={{ p: 1.5, height: '100%', display: 'flex', flexDirection: 'column' }}>
              {/* Node Header */}
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <Box sx={{ color: getStatusColor(node.status), mr: 1 }}>
                  {getStatusIcon(node.status)}
                </Box>
                <Typography 
                  variant="subtitle2" 
                  sx={{ 
                    color: '#00bcd4',
                    fontWeight: 'bold',
                    fontSize: '12px',
                    textTransform: 'uppercase'
                  }}
                >
                  {node.name}
                </Typography>
              </Box>

              {/* Status Indicators */}
              <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
                {node.metrics.cpu && (
                  <Chip 
                    label={`CPU: ${node.metrics.cpu}%`}
                    size="small"
                    sx={{ 
                      bgcolor: node.metrics.cpu > 80 ? '#f44336' : '#4caf50',
                      color: 'white',
                      fontSize: '10px',
                      height: 20
                    }}
                  />
                )}
                {node.metrics.memory && (
                  <Chip 
                    label={`MEM: ${node.metrics.memory}%`}
                    size="small"
                    sx={{ 
                      bgcolor: node.metrics.memory > 80 ? '#f44336' : '#4caf50',
                      color: 'white',
                      fontSize: '10px',
                      height: 20
                    }}
                  />
                )}
                {node.metrics.activeUsers && (
                  <Chip 
                    icon={<People sx={{ fontSize: '12px !important' }} />}
                    label={node.metrics.activeUsers}
                    size="small"
                    sx={{ 
                      bgcolor: '#2196f3',
                      color: 'white',
                      fontSize: '10px',
                      height: 20
                    }}
                  />
                )}
              </Box>

              {/* Issues Counter */}
              {node.issues.length > 0 && (
                <Alert 
                  severity="error" 
                  sx={{ 
                    fontSize: '10px',
                    py: 0,
                    '& .MuiAlert-message': { py: 0 }
                  }}
                >
                  {node.issues.length} issue{node.issues.length > 1 ? 's' : ''}
                </Alert>
              )}

              {/* Drill-down indicator */}
              {node.children && node.children.length > 0 && (
                <Typography 
                  variant="caption" 
                  sx={{ 
                    color: '#ffeb3b',
                    fontSize: '10px',
                    mt: 'auto',
                    textAlign: 'center'
                  }}
                >
                  Click to drill down ↓
                </Typography>
              )}
            </Box>
          </Paper>
        ))}

        {/* Data Flow Animation */}
        {renderDataFlow()}
      </Paper>

      {/* System Status Bar */}
      <Paper sx={{ 
        position: 'absolute',
        top: 10,
        right: 10,
        p: 1,
        bgcolor: 'rgba(0, 0, 0, 0.8)',
        border: '1px solid #00bcd4'
      }}>
        <Typography variant="caption" sx={{ color: '#00bcd4' }}>
          System Status: {systemData.status.toUpperCase()}
        </Typography>
      </Paper>

      <style jsx global>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.2); }
        }
      `}</style>
    </Box>
  );
};