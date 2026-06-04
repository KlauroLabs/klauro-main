import React, { useState, useCallback } from 'react';
import { Box, Typography, Tooltip, Fade, Chip } from '@mui/material';
import {
  CheckCircle,
  Warning,
  Error as ErrorIcon,
  ArrowForward,
  Storage as Database,
  Api,
  Web,
  Memory
} from '@mui/icons-material';

interface SystemNode {
  id: string;
  name: string;
  type: 'section' | 'subsystem' | 'component';
  status: 'healthy' | 'warning' | 'critical' | 'offline';
  children?: SystemNode[];
  position: { x: number; y: number };
  size: { width: number; height: number };
  connections: string[];
  
  // Quick info (shown on hover)
  quickInfo: {
    description: string;
    technology: string;
    requests?: number;
    users?: number;
    issues?: number;
  };
  
  // Detailed info (available but not overwhelming)
  detailedInfo?: any;
}

interface SimpleSystemSchematicProps {
  systemData: SystemNode;
  onNodeClick: (nodeId: string) => void;
  onDrillDown: (nodeId: string) => void;
  currentPath: string[];
}

export const SimpleSystemSchematic: React.FC<SimpleSystemSchematicProps> = ({
  systemData,
  onNodeClick,
  onDrillDown,
  currentPath
}) => {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

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

  const getTypeIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'database': return <Database fontSize="small" />;
      case 'api': return <Api fontSize="small" />;
      case 'frontend': return <Web fontSize="small" />;
      default: return <Memory fontSize="small" />;
    }
  };

  const handleNodeClick = useCallback((node: SystemNode) => {
    if (node.children && node.children.length > 0) {
      onDrillDown(node.id);
    } else {
      onNodeClick(node.id);
    }
  }, [onNodeClick, onDrillDown]);

  return (
    <Box sx={{ 
      position: 'relative', 
      width: '100%', 
      height: '100%',
      bgcolor: '#0a0f1c',
      backgroundImage: 'radial-gradient(circle at 25% 25%, #1a237e 0%, #0a0f1c 50%)',
      overflow: 'hidden'
    }}>
      {/* Subtle Grid */}
      <Box
        sx={{
          position: 'absolute',
          width: '100%',
          height: '100%',
          backgroundImage: `
            linear-gradient(rgba(64, 181, 246, 0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(64, 181, 246, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Connection Lines */}
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
        {systemData.children?.map(node => 
          node.connections.map(connectionId => {
            const targetNode = systemData.children?.find(n => n.id === connectionId);
            if (!targetNode) return null;

            const startX = node.position.x + node.size.width / 2;
            const startY = node.position.y + node.size.height / 2;
            const endX = targetNode.position.x + targetNode.size.width / 2;
            const endY = targetNode.position.y + targetNode.size.height / 2;

            const isActive = hoveredNode === node.id || hoveredNode === connectionId;

            return (
              <g key={`${node.id}-${connectionId}`}>
                <line
                  x1={startX}
                  y1={startY}
                  x2={endX}
                  y2={endY}
                  stroke={isActive ? "#64b5f6" : "#40a9ff"}
                  strokeWidth={isActive ? "3" : "2"}
                  strokeOpacity={isActive ? "0.9" : "0.4"}
                  strokeDasharray="none"
                />
                {/* Data flow indicator */}
                {node.quickInfo.requests && node.quickInfo.requests > 0 && (
                  <circle
                    cx={(startX + endX) / 2}
                    cy={(startY + endY) / 2}
                    r="3"
                    fill="#4caf50"
                    opacity={isActive ? 1 : 0.6}
                  >
                    <animate
                      attributeName="r"
                      values="2;4;2"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}
              </g>
            );
          })
        )}
      </svg>

      {/* System Nodes */}
      {systemData.children?.map(node => (
        <Tooltip
          key={node.id}
          title={
            <Box sx={{ p: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
                {node.name}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
                {node.quickInfo.description}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.5 }}>
                {getTypeIcon(node.quickInfo.technology)}
                <Typography variant="caption">
                  {node.quickInfo.technology}
                </Typography>
              </Box>
              {node.quickInfo.requests && (
                <Typography variant="caption" sx={{ display: 'block' }}>
                  {node.quickInfo.requests} req/min
                </Typography>
              )}
              {node.quickInfo.users && (
                <Typography variant="caption" sx={{ display: 'block' }}>
                  {node.quickInfo.users} active users
                </Typography>
              )}
              {node.children && node.children.length > 0 && (
                <Typography variant="caption" sx={{ color: '#ffeb3b', display: 'block', mt: 0.5 }}>
                  Click to explore →
                </Typography>
              )}
            </Box>
          }
          placement="top"
          arrow
          TransitionComponent={Fade}
          TransitionProps={{ timeout: 200 }}
        >
          <Box
            onClick={() => handleNodeClick(node)}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            sx={{
              position: 'absolute',
              left: node.position.x,
              top: node.position.y,
              width: node.size.width,
              height: node.size.height,
              border: `2px solid ${getStatusColor(node.status)}`,
              borderRadius: 2,
              bgcolor: hoveredNode === node.id 
                ? 'rgba(64, 181, 246, 0.1)' 
                : 'rgba(255, 255, 255, 0.03)',
              backdropFilter: 'blur(10px)',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              zIndex: hoveredNode === node.id ? 10 : 2,
              transform: hoveredNode === node.id ? 'scale(1.02)' : 'scale(1)',
              boxShadow: hoveredNode === node.id 
                ? `0 0 20px ${getStatusColor(node.status)}40` 
                : 'none',
              '&:hover': {
                bgcolor: 'rgba(64, 181, 246, 0.1)',
              }
            }}
          >
            <Box sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
              {/* Header with Status */}
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box sx={{ color: getStatusColor(node.status) }}>
                    {getStatusIcon(node.status)}
                  </Box>
                  <Typography 
                    variant="subtitle2" 
                    sx={{ 
                      color: '#fff',
                      fontWeight: 'bold',
                      fontSize: '14px'
                    }}
                  >
                    {node.name}
                  </Typography>
                </Box>
                {node.children && node.children.length > 0 && (
                  <ArrowForward sx={{ color: '#64b5f6', fontSize: '16px' }} />
                )}
              </Box>

              {/* Technology Badge */}
              <Chip 
                label={node.quickInfo.technology}
                size="small"
                sx={{ 
                  bgcolor: 'rgba(64, 181, 246, 0.2)',
                  color: '#64b5f6',
                  fontSize: '10px',
                  height: 20,
                  mb: 1,
                  alignSelf: 'flex-start'
                }}
              />

              {/* Quick Metrics */}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 'auto' }}>
                {node.quickInfo.requests && (
                  <Typography variant="caption" sx={{ color: '#4caf50' }}>
                    {node.quickInfo.requests} req/min
                  </Typography>
                )}
                {node.quickInfo.users && (
                  <Typography variant="caption" sx={{ color: '#64b5f6' }}>
                    {node.quickInfo.users} users
                  </Typography>
                )}
                {node.quickInfo.issues && node.quickInfo.issues > 0 && (
                  <Typography variant="caption" sx={{ color: '#f44336' }}>
                    {node.quickInfo.issues} issue{node.quickInfo.issues > 1 ? 's' : ''}
                  </Typography>
                )}
              </Box>
            </Box>
          </Box>
        </Tooltip>
      ))}

      {/* Simple Breadcrumb - Always Visible */}
      <Box sx={{ 
        position: 'absolute',
        top: 16,
        left: 16,
        bgcolor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(10px)',
        borderRadius: 2,
        p: 1.5,
        border: '1px solid rgba(64, 181, 246, 0.3)'
      }}>
        <Typography variant="body2" sx={{ color: '#64b5f6' }}>
          {currentPath.join(' › ')}
        </Typography>
      </Box>

      {/* Quick System Health - Top Right */}
      <Box sx={{ 
        position: 'absolute',
        top: 16,
        right: 16,
        bgcolor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(10px)',
        borderRadius: 2,
        p: 1.5,
        border: '1px solid rgba(64, 181, 246, 0.3)'
      }}>
        <Typography variant="caption" sx={{ color: '#64b5f6', display: 'block' }}>
          System Health
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
          <Box sx={{ color: getStatusColor(systemData.status) }}>
            {getStatusIcon(systemData.status)}
          </Box>
          <Typography variant="body2" sx={{ color: '#fff', textTransform: 'capitalize' }}>
            {systemData.status}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};