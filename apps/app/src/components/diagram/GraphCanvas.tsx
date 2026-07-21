import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Box } from '@mui/material';
import { tokens } from '../../theme';
import type { GraphLayoutCluster, PositionedGraphNode } from './graphLayout';
import { GraphZoomControls } from './GraphZoomControls';

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Render this edge de-emphasized (dashed, dimmer) — used by perspective
   *  lenses to distinguish e.g. observed-with-evidence vs declared-only
   *  relationships without hiding either. */
  muted?: boolean;
}

/** Shared node/edge SVG renderer — construction-stroke rectangles and
 *  curved connectors, deterministic layout from graphLayout.ts, real zoom/
 *  pan (not the decorative "not yet interactive" row SystemMapCard shipped
 *  with). Used by the workspace system map and the codebase architecture
 *  diagram (full view + card preview) so the interaction model — and the
 *  zoom-control row's look — is the SAME wherever a node/edge graph appears,
 *  per the design language's "one visual language" rule. */
export function GraphCanvas({
  nodes,
  edges,
  clusters,
  contentWidth,
  contentHeight,
  onNodeClick,
  isNodeNavigable,
  ariaLabel,
  interactive = true,
}: {
  nodes: PositionedGraphNode[];
  edges: DiagramEdge[];
  clusters: GraphLayoutCluster[];
  contentWidth: number;
  contentHeight: number;
  onNodeClick?: (nodeId: string) => void;
  isNodeNavigable?: (nodeId: string) => boolean;
  ariaLabel: string;
  /** false = card-preview mode: no zoom controls, no pan, whole canvas is
   *  one click target (the caller wires that to "open full view"). */
  interactive?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const dragState = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  const clampZoom = (z: number) => Math.min(2, Math.max(0.25, z));

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!interactive) return;
      event.preventDefault();
      setZoom(z => clampZoom(z - event.deltaY * 0.001));
    },
    [interactive],
  );

  const handlePointerDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    dragState.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
  };
  const handlePointerMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!interactive || !dragState.current) return;
    const dx = event.clientX - dragState.current.startX;
    const dy = event.clientY - dragState.current.startY;
    setPan({ x: dragState.current.panX + dx, y: dragState.current.panY + dy });
  };
  const endDrag = () => {
    dragState.current = null;
  };

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const viewWidth = Math.max(contentWidth, 200);
  const viewHeight = Math.max(contentHeight, 120);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%' }}>
      <Box
        sx={{
          flexGrow: 1,
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1.5,
          bgcolor: 'background.default',
          cursor: interactive ? 'grab' : 'pointer',
          minHeight: 220,
        }}
        onWheel={handleWheel}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${viewWidth} ${viewHeight}`}
          role="img"
          aria-label={ariaLabel}
        >
          <defs>
            <marker id="graph-canvas-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill={tokens.wireframe} />
            </marker>
          </defs>
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {clusters.length > 1 &&
              clusters.map(cluster => (
                <text key={cluster.name} x={cluster.x} y={16} fontSize={11} fontFamily="monospace" fill={tokens.tertiaryText}>
                  {cluster.name}
                </text>
              ))}

            {edges.map(edge => {
              const source = nodeById.get(edge.source);
              const target = nodeById.get(edge.target);
              if (!source || !target) return null;
              const x1 = source.x + source.width;
              const y1 = source.y + source.height / 2;
              const x2 = target.x;
              const y2 = target.y + target.height / 2;
              const emphasized = hoveredId === source.id || hoveredId === target.id;
              const midX = (x1 + x2) / 2;
              return (
                <g key={edge.id}>
                  <path
                    d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke={emphasized ? tokens.interactiveAccent : edge.muted ? tokens.construction : tokens.overcardStroke}
                    strokeWidth={emphasized ? 1.5 : 1}
                    strokeDasharray={edge.muted ? '3 3' : undefined}
                    markerEnd="url(#graph-canvas-arrow)"
                  />
                  {edge.label ? (
                    <text x={midX} y={(y1 + y2) / 2 - 4} fontSize={10} fontFamily="monospace" textAnchor="middle" fill={tokens.tertiaryText}>
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {nodes.map(node => {
              const navigable = interactive && (isNodeNavigable ? isNodeNavigable(node.id) : Boolean(onNodeClick));
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  style={{ cursor: navigable ? 'pointer' : 'default' }}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => navigable && onNodeClick?.(node.id)}
                >
                  <rect
                    width={node.width}
                    height={node.height}
                    rx={8}
                    fill={tokens.surface}
                    stroke={hoveredId === node.id ? tokens.interactiveAccent : tokens.construction}
                    strokeWidth={hoveredId === node.id ? 1.5 : 1.25}
                  />
                  <text x={12} y={20} fontSize={13} fontWeight={600} fill={tokens.textPrimary}>
                    {node.label}
                  </text>
                  {node.subtitle ? (
                    <text x={12} y={node.height - 12} fontSize={10} fill={tokens.tertiaryText}>
                      {node.subtitle}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      </Box>

      {interactive ? (
        <GraphZoomControls
          zoom={zoom}
          onZoomChange={next => setZoom(clampZoom(next))}
          onReset={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        />
      ) : null}
    </Box>
  );
}
