import React from 'react';
import { CASEdge } from '../types';

export interface ConnectionLineProps {
  edge: CASEdge;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  selected?: boolean;
  highlighted?: boolean;
  dimmed?: boolean;
  showArrow?: boolean;
  curved?: boolean;
  onClick?: (edge: CASEdge) => void;
}

const EDGE_COLORS: Record<string, string> = {
  calls: '#2196f3',
  imports: '#4caf50',
  extends: '#9c27b0',
  implements: '#ff9800',
  uses: '#607d8b',
  injects: '#e91e63',
  decorates: '#673ab7',
  dependency: '#00bcd4',
};

export const ConnectionLine: React.FC<ConnectionLineProps> = ({
  edge,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected = false,
  highlighted = false,
  dimmed = false,
  showArrow = true,
  curved = true,
  onClick,
}) => {
  const color = EDGE_COLORS[edge.type] || '#9e9e9e';
  const strokeWidth = selected ? 3 : highlighted ? 2.5 : 1.5;
  const opacity = dimmed ? 0.2 : selected ? 1 : 0.6;

  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const path = curved && distance > 100
    ? generateCurvedPath(sourceX, sourceY, targetX, targetY)
    : `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;

  const markerId = `arrow-${edge.id.replace(/[^a-zA-Z0-9]/g, '-')}`;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(edge);
  };

  return (
    <g onClick={handleClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      {showArrow && (
        <defs>
          <marker
            id={markerId}
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L0,6 L9,3 z" fill={color} opacity={opacity} />
          </marker>
        </defs>
      )}

      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={10}
        style={{ cursor: onClick ? 'pointer' : 'default' }}
      />

      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeOpacity={opacity}
        strokeDasharray={edge.type === 'async' ? '5,5' : undefined}
        markerEnd={showArrow ? `url(#${markerId})` : undefined}
        style={{
          transition: 'stroke-width 0.2s ease, stroke-opacity 0.2s ease',
        }}
      />
    </g>
  );
};

function generateCurvedPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;

  const curvature = Math.min(Math.abs(dx), Math.abs(dy)) * 0.3;

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  const cpX = midX + (dy > 0 ? curvature : -curvature);
  const cpY = midY + (dx > 0 ? -curvature : curvature);

  return `M ${x1} ${y1} Q ${cpX} ${cpY} ${x2} ${y2}`;
}

export interface ConnectionLinesProps {
  edges: CASEdge[];
  nodePositions: Map<string, { x: number; y: number; width: number; height: number }>;
  selectedEdgeIds?: Set<string>;
  highlightedEdgeIds?: Set<string>;
  dimmedEdgeIds?: Set<string>;
  onEdgeClick?: (edge: CASEdge) => void;
}

export const ConnectionLines: React.FC<ConnectionLinesProps> = ({
  edges,
  nodePositions,
  selectedEdgeIds = new Set(),
  highlightedEdgeIds = new Set(),
  dimmedEdgeIds = new Set(),
  onEdgeClick,
}) => {
  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <g style={{ pointerEvents: 'auto' }}>
        {edges.map(edge => {
          const sourcePos = nodePositions.get(edge.source);
          const targetPos = nodePositions.get(edge.target);

          if (!sourcePos || !targetPos) return null;

          const sourceX = sourcePos.x + sourcePos.width / 2;
          const sourceY = sourcePos.y + sourcePos.height / 2;
          const targetX = targetPos.x + targetPos.width / 2;
          const targetY = targetPos.y + targetPos.height / 2;

          return (
            <ConnectionLine
              key={edge.id}
              edge={edge}
              sourceX={sourceX}
              sourceY={sourceY}
              targetX={targetX}
              targetY={targetY}
              selected={selectedEdgeIds.has(edge.id)}
              highlighted={highlightedEdgeIds.has(edge.id)}
              dimmed={dimmedEdgeIds.has(edge.id)}
              onClick={onEdgeClick}
            />
          );
        })}
      </g>
    </svg>
  );
};

export function getEdgeColor(type: string): string {
  return EDGE_COLORS[type] || '#9e9e9e';
}
