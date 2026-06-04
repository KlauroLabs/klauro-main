import React, { useState, useCallback, useRef, useEffect } from 'react';
import './InteractiveCardSystem.css';

interface CardNode {
  id: string;
  type: 'system' | 'service' | 'component' | 'class' | 'function' | 'variable';
  name: string;
  description: string;
  level: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  metrics: {
    complexity: number;
    dependencies: number;
    calls: number;
    lines: number;
  };
  children: string[];
  parent?: string;
  entryPoints: EntryPoint[];
  exitPoints: ExitPoint[];
  metadata: Record<string, any>;
  expanded?: boolean;
  visible?: boolean;
}

interface Connection {
  id: string;
  source: string;
  target: string;
  type: 'data-flow' | 'dependency' | 'event' | 'api-call' | 'database';
  label: string;
  strength: number;
  metadata: {
    frequency?: number;
    latency?: number;
    dataType?: string;
    protocol?: string;
  };
}

interface EntryPoint {
  id: string;
  type: 'http' | 'websocket' | 'message-queue' | 'scheduled' | 'cli' | 'ui';
  path?: string;
  method?: string;
  description: string;
  authentication?: string;
  parameters?: any[];
}

interface ExitPoint {
  id: string;
  type: 'database' | 'api' | 'file' | 'message' | 'email' | 'cache';
  target: string;
  operation?: string;
  description: string;
}

interface TelemetryData {
  nodeId: string;
  metric: string;
  value: number;
  timestamp: number;
  status: 'healthy' | 'warning' | 'error';
}

interface InteractiveCardSystemProps {
  nodes: CardNode[];
  connections: Connection[];
  telemetry?: TelemetryData[];
  onNodeClick?: (node: CardNode) => void;
  onConnectionClick?: (connection: Connection) => void;
}

const InteractiveCardSystem: React.FC<InteractiveCardSystemProps> = ({
  nodes: initialNodes,
  connections,
  telemetry = [],
  onNodeClick,
  onConnectionClick,
}) => {
  const [nodes, setNodes] = useState<Map<string, CardNode>>(new Map());
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const nodeMap = new Map<string, CardNode>();
    initialNodes.forEach(node => {
      nodeMap.set(node.id, { ...node, visible: node.level <= viewLevel });
    });
    setNodes(nodeMap);
  }, [initialNodes, viewLevel]);

  const handleCardClick = useCallback((nodeId: string) => {
    const node = nodes.get(nodeId);
    if (!node) return;

    if (expandedNodes.has(nodeId)) {
      // Collapse
      setExpandedNodes(prev => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      
      // Hide children
      const hideChildren = (id: string) => {
        const n = nodes.get(id);
        if (n?.children) {
          n.children.forEach(childId => {
            const child = nodes.get(childId);
            if (child) {
              child.visible = false;
              hideChildren(childId);
            }
          });
        }
      };
      hideChildren(nodeId);
    } else {
      // Expand
      setExpandedNodes(prev => new Set([...prev, nodeId]));
      
      // Show immediate children
      node.children.forEach(childId => {
        const child = nodes.get(childId);
        if (child) {
          child.visible = true;
        }
      });
    }

    setSelectedNode(nodeId);
    onNodeClick?.(node);
    
    setNodes(new Map(nodes));
  }, [nodes, expandedNodes, onNodeClick]);

  const getNodeStatus = (nodeId: string): 'healthy' | 'warning' | 'error' => {
    const nodeTelemetry = telemetry.filter(t => t.nodeId === nodeId);
    if (nodeTelemetry.some(t => t.status === 'error')) return 'error';
    if (nodeTelemetry.some(t => t.status === 'warning')) return 'warning';
    return 'healthy';
  };

  const getConnectionPath = (connection: Connection): string => {
    const source = nodes.get(connection.source);
    const target = nodes.get(connection.target);
    
    if (!source || !target || !source.visible || !target.visible) return '';

    const sx = source.position.x + source.size.width / 2;
    const sy = source.position.y + source.size.height / 2;
    const tx = target.position.x + target.size.width / 2;
    const ty = target.position.y + target.size.height / 2;

    // Create curved path
    const dx = tx - sx;
    const dy = ty - sy;
    const dr = Math.sqrt(dx * dx + dy * dy);
    
    return `M ${sx},${sy} Q ${sx + dx/2},${sy + dy/2 - dr/4} ${tx},${ty}`;
  };

  const renderCard = (node: CardNode) => {
    if (!node.visible) return null;

    const isExpanded = expandedNodes.has(node.id);
    const isSelected = selectedNode === node.id;
    const isHovered = hoveredNode === node.id;
    const status = getNodeStatus(node.id);

    return (
      <g key={node.id} className="card-node">
        {/* Card shadow */}
        <rect
          x={node.position.x + 2}
          y={node.position.y + 2}
          width={node.size.width}
          height={isExpanded ? node.size.height * 1.5 : node.size.height}
          rx="8"
          fill="rgba(0,0,0,0.1)"
        />
        
        {/* Main card */}
        <rect
          x={node.position.x}
          y={node.position.y}
          width={node.size.width}
          height={isExpanded ? node.size.height * 1.5 : node.size.height}
          rx="8"
          fill="white"
          stroke={isSelected ? '#2563eb' : isHovered ? '#64748b' : '#e2e8f0'}
          strokeWidth={isSelected ? 2 : 1}
          className={`card-rect card-${node.type} status-${status}`}
          onClick={() => handleCardClick(node.id)}
          onMouseEnter={() => setHoveredNode(node.id)}
          onMouseLeave={() => setHoveredNode(null)}
          style={{ cursor: 'pointer' }}
        />

        {/* Status indicator */}
        <circle
          cx={node.position.x + node.size.width - 15}
          cy={node.position.y + 15}
          r="5"
          fill={status === 'error' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#10b981'}
        />

        {/* Card header */}
        <rect
          x={node.position.x}
          y={node.position.y}
          width={node.size.width}
          height="40"
          rx="8"
          fill={`url(#gradient-${node.type})`}
        />

        {/* Title */}
        <text
          x={node.position.x + 15}
          y={node.position.y + 25}
          fontSize="14"
          fontWeight="600"
          fill="white"
        >
          {node.name}
        </text>

        {/* Type badge */}
        <rect
          x={node.position.x + 10}
          y={node.position.y + 45}
          width="60"
          height="20"
          rx="10"
          fill="#f1f5f9"
        />
        <text
          x={node.position.x + 40}
          y={node.position.y + 58}
          fontSize="10"
          textAnchor="middle"
          fill="#64748b"
        >
          {node.type}
        </text>

        {/* Description */}
        <text
          x={node.position.x + 15}
          y={node.position.y + 85}
          fontSize="12"
          fill="#475569"
        >
          {node.description.substring(0, 30)}...
        </text>

        {/* Metrics */}
        <g transform={`translate(${node.position.x + 15}, ${node.position.y + 105})`}>
          <text fontSize="10" fill="#94a3b8">
            Lines: {node.metrics.lines} | Complexity: {node.metrics.complexity}
          </text>
        </g>

        {/* Entry/Exit indicators */}
        {node.entryPoints.length > 0 && (
          <g transform={`translate(${node.position.x + 10}, ${node.position.y + 125})`}>
            <rect width="20" height="15" rx="3" fill="#10b981" opacity="0.2" />
            <text x="10" y="11" fontSize="10" textAnchor="middle" fill="#10b981">
              →
            </text>
            <text x="25" y="11" fontSize="10" fill="#10b981">
              {node.entryPoints.length} entry
            </text>
          </g>
        )}

        {node.exitPoints.length > 0 && (
          <g transform={`translate(${node.position.x + node.size.width - 70}, ${node.position.y + 125})`}>
            <rect width="20" height="15" rx="3" fill="#f59e0b" opacity="0.2" />
            <text x="10" y="11" fontSize="10" textAnchor="middle" fill="#f59e0b">
              ←
            </text>
            <text x="25" y="11" fontSize="10" fill="#f59e0b">
              {node.exitPoints.length} exit
            </text>
          </g>
        )}

        {/* Expandable leaflet section */}
        {isExpanded && (
          <g className="leaflet-content">
            {/* Methods/Properties section */}
            {node.metadata?.methods && (
              <g transform={`translate(${node.position.x + 15}, ${node.position.y + 150})`}>
                <text fontSize="11" fontWeight="600" fill="#334155">Methods:</text>
                {node.metadata.methods.slice(0, 3).map((method: any, i: number) => (
                  <text
                    key={i}
                    y={15 + i * 15}
                    fontSize="10"
                    fill="#64748b"
                  >
                    • {method.name}({method.parameters?.join(', ') || ''})
                  </text>
                ))}
              </g>
            )}

            {/* Properties section */}
            {node.metadata?.properties && (
              <g transform={`translate(${node.position.x + 15}, ${node.position.y + 220})`}>
                <text fontSize="11" fontWeight="600" fill="#334155">Properties:</text>
                {node.metadata.properties.slice(0, 3).map((prop: any, i: number) => (
                  <text
                    key={i}
                    y={15 + i * 15}
                    fontSize="10"
                    fill="#64748b"
                  >
                    • {prop.name}: {prop.type}
                  </text>
                ))}
              </g>
            )}
          </g>
        )}

        {/* Expand/Collapse indicator */}
        {node.children.length > 0 && (
          <g
            transform={`translate(${node.position.x + node.size.width - 30}, ${node.position.y + node.size.height - 20})`}
            style={{ cursor: 'pointer' }}
          >
            <circle r="10" fill="#e2e8f0" />
            <text
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="12"
              fill="#64748b"
            >
              {isExpanded ? '−' : '+'}
            </text>
            <text
              x="15"
              dominantBaseline="middle"
              fontSize="10"
              fill="#94a3b8"
            >
              {node.children.length}
            </text>
          </g>
        )}
      </g>
    );
  };

  const renderConnection = (connection: Connection) => {
    const path = getConnectionPath(connection);
    if (!path) return null;

    const isActive = telemetry.some(t => 
      t.nodeId === connection.source || t.nodeId === connection.target
    );

    return (
      <g key={connection.id} className="connection">
        <path
          d={path}
          fill="none"
          stroke={
            connection.type === 'data-flow' ? '#3b82f6' :
            connection.type === 'dependency' ? '#8b5cf6' :
            connection.type === 'api-call' ? '#10b981' :
            connection.type === 'database' ? '#f59e0b' :
            '#94a3b8'
          }
          strokeWidth={Math.max(1, connection.strength * 2)}
          strokeOpacity={0.5}
          strokeDasharray={connection.type === 'event' ? '5,5' : undefined}
          className={isActive ? 'connection-active' : ''}
          onClick={() => onConnectionClick?.(connection)}
          style={{ cursor: 'pointer' }}
        />
        
        {/* Connection label */}
        <text
          x={nodes.get(connection.source)!.position.x + nodes.get(connection.target)!.position.x / 2}
          y={nodes.get(connection.source)!.position.y + nodes.get(connection.target)!.position.y / 2}
          fontSize="10"
          fill="#64748b"
          textAnchor="middle"
        >
          {connection.label}
        </text>

        {/* Animated flow indicator */}
        {isActive && (
          <circle r="3" fill="#3b82f6">
            <animateMotion dur="2s" repeatCount="indefinite">
              <mpath href={`#${connection.id}-path`} />
            </animateMotion>
          </circle>
        )}
      </g>
    );
  };

  return (
    <div className="interactive-card-system">
      {/* Controls */}
      <div className="controls-panel">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search components..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        
        <div className="view-controls">
          <label>View Depth:</label>
          <input
            type="range"
            min="0"
            max="5"
            value={viewLevel}
            onChange={(e) => setViewLevel(Number(e.target.value))}
          />
          <span>{viewLevel}</span>
        </div>

        <div className="zoom-controls">
          <button onClick={() => setZoom(z => Math.min(z * 1.2, 3))}>+</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.max(z / 1.2, 0.3))}>−</button>
        </div>
      </div>

      {/* Main visualization */}
      <svg
        ref={svgRef}
        width="100%"
        height="800"
        viewBox={`${pan.x} ${pan.y} ${1200 / zoom} ${800 / zoom}`}
        className="card-canvas"
      >
        {/* Define gradients */}
        <defs>
          <linearGradient id="gradient-system" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#1e40af" />
            <stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
          <linearGradient id="gradient-service" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id="gradient-component" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#059669" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
          <linearGradient id="gradient-class" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#dc2626" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
          <linearGradient id="gradient-function" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ea580c" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>

        {/* Render connections first (behind cards) */}
        <g className="connections-layer">
          {connections.map(renderConnection)}
        </g>

        {/* Render cards */}
        <g className="cards-layer">
          {Array.from(nodes.values()).map(renderCard)}
        </g>
      </svg>

      {/* Details panel */}
      {selectedNode && (
        <div className="details-panel">
          {(() => {
            const selectedNodeData = nodes.get(selectedNode);
            if (!selectedNodeData) return null;

            return (
              <>
                <h3>{selectedNodeData.name}</h3>
                <p>{selectedNodeData.description}</p>

                {selectedNodeData.entryPoints && selectedNodeData.entryPoints.length > 0 && (
                  <div className="entry-points">
                    <h4>Entry Points:</h4>
                    {selectedNodeData.entryPoints.map(ep => (
                <div key={ep.id} className="entry-point">
                  <span className="ep-type">{ep.type}</span>
                  <span className="ep-path">{ep.path || ep.description}</span>
                </div>
                    ))}
                  </div>
                )}

                {selectedNodeData.exitPoints && selectedNodeData.exitPoints.length > 0 && (
                  <div className="exit-points">
                    <h4>Exit Points:</h4>
                    {selectedNodeData.exitPoints.map(ep => (
                      <div key={ep.id} className="exit-point">
                        <span className="ep-type">{ep.type}</span>
                        <span className="ep-target">{ep.target}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default InteractiveCardSystem;