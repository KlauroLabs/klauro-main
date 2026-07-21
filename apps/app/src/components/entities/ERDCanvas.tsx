import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography } from '@mui/material';
import { tokens } from '../../theme';
import { computeErdLayout } from './erdLayout';
import type { DataEntity, DatabaseEntity } from '../../hooks/useEntities';
import { encodeSlug } from '../../lib/slugs';

/**
 * Entity-relationship diagram — construction lines, not a graph library.
 * Per LANE-COMMON's design language: stroke system (0.75/1/1.25/1.5px),
 * geometry over illustration, deterministic layout (erdLayout.ts), clustered
 * by module once the entity count passes the "large" threshold. Relationship
 * cardinality (OneToOne/OneToMany/ManyToOne/ManyToMany) is evidence-gated —
 * it only exists when database_schema recorded a real ORM relation; entities
 * with no edges are drawn with none (relationship sparsity is a real,
 * common case — see docs/briefs/entities.md).
 */
export function ERDCanvas({
  projectId,
  entities,
  databaseEntityByNameLower,
  focusEntityId,
}: {
  projectId: string;
  entities: DataEntity[];
  databaseEntityByNameLower: Map<string, DatabaseEntity>;
  focusEntityId?: string;
}) {
  const navigate = useNavigate();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const layout = useMemo(
    () => computeErdLayout(entities, databaseEntityByNameLower),
    [entities, databaseEntityByNameLower],
  );

  if (layout.nodes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No entities to diagram.
      </Typography>
    );
  }

  const nodeById = new Map(layout.nodes.map(n => [n.id, n]));

  return (
    <Box sx={{ overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}>
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Entity relationship diagram">
        <defs>
          <marker id="erd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={tokens.wireframe} />
          </marker>
        </defs>

        {layout.clusters.length > 1 && layout.clusters.map(cluster => (
          <text
            key={cluster.name}
            x={cluster.x}
            y={16}
            fontSize={11}
            fontFamily="monospace"
            fill={tokens.tertiaryText}
          >
            {cluster.name}
          </text>
        ))}

        {layout.edges.map(edge => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const x1 = source.x + source.width;
          const y1 = source.y + source.height / 2;
          const x2 = target.x;
          const y2 = target.y + target.height / 2;
          const emphasized = hoveredId === source.id || hoveredId === target.id;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          return (
            <g key={edge.id}>
              <path
                d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                fill="none"
                stroke={emphasized ? tokens.interactiveAccent : tokens.overcardStroke}
                strokeWidth={emphasized ? 1.5 : 1}
                markerEnd="url(#erd-arrow)"
              />
              <text x={midX} y={midY - 4} fontSize={10} fontFamily="monospace" textAnchor="middle" fill={tokens.tertiaryText}>
                {edge.type}
              </text>
            </g>
          );
        })}

        {layout.nodes.map(node => {
          const isFocus = node.id === focusEntityId;
          const isHovered = hoveredId === node.id;
          return (
            <g
              key={node.id}
              transform={`translate(${node.x},${node.y})`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredId(node.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => navigate(`/codebases/${projectId}/entities/${encodeSlug({ id: node.id, name: node.name })}`)}
            >
              <rect
                width={node.width}
                height={node.height}
                rx={8}
                fill={tokens.surface}
                stroke={isFocus || isHovered ? tokens.interactiveAccent : tokens.construction}
                strokeWidth={isFocus ? 1.5 : 1.25}
              />
              <line x1={0} y1={30} x2={node.width} y2={30} stroke={tokens.construction} strokeWidth={0.75} />
              <text x={12} y={20} fontSize={13} fontWeight={600} fill={tokens.textPrimary}>
                {node.name}
              </text>
              <text x={12} y={44} fontSize={11} fill={tokens.tertiaryText}>
                {node.fieldCount} field{node.fieldCount === 1 ? '' : 's'}
              </text>
            </g>
          );
        })}
      </svg>
    </Box>
  );
}
