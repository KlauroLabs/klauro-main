import React, { useMemo, useState, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  Chip,
  IconButton,
  Tooltip,
  Card,
  CardContent,
} from '@mui/material';
import {
  ZoomIn,
  ZoomOut,
  FitScreen,
  Input,
  Output,
  Hub,
  Lock,
  ExpandMore,
  ChevronRight,
  AccountTree,
} from '@mui/icons-material';
import { CASNode, CASEdge, CASOutput, ExitPoint } from '../types';
import { usePanZoom } from '../hooks/usePanZoom';
import { Domain, Capability, FlowStep, extractDomains } from '../utils/domainExtractor';

export type GroupByMode = 'architecture' | 'domain' | 'layer';

export interface GraphViewProps {
  cas: CASOutput;
  nodes: CASNode[];
  edges: CASEdge[];
  exitPoints?: ExitPoint[];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onExitPointClick?: (exitPoint: ExitPoint, sourceNodeId: string) => void;
}

interface ArchitectureBlock {
  id: string;
  name: string;
  description: string;
  type: 'entry' | 'domain' | 'external' | 'layer';
  count: number;
  color: string;
  items: string[];
  metadata?: Record<string, unknown>;
}

const CARD_WIDTH = 200;
const CARD_HEIGHT = 80;
const CARD_GAP = 16;
const SECTION_GAP = 120;

const CAP_CARD_WIDTH = 160;
const CAP_CARD_HEIGHT = 50;
const CAP_CARD_GAP = 8;

const STEP_CARD_WIDTH = 140;
const STEP_CARD_HEIGHT = 40;
const STEP_CARD_GAP = 6;

function hashStringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 45%)`;
}

function getCapabilityLabel(capability: Capability): string {
  if (capability.method) {
    return capability.method.toUpperCase();
  }
  return capability.action || 'Action';
}

function getCapabilityColor(capability: Capability): string {
  const label = getCapabilityLabel(capability).toLowerCase();

  if (['get', 'read', 'list', 'view', 'fetch'].some(k => label.includes(k))) {
    return '#2196f3';
  }
  if (['post', 'create', 'add', 'new', 'insert'].some(k => label.includes(k))) {
    return '#4caf50';
  }
  if (['put', 'patch', 'update', 'modify', 'edit'].some(k => label.includes(k))) {
    return '#ff9800';
  }
  if (['delete', 'remove', 'destroy'].some(k => label.includes(k))) {
    return '#f44336';
  }

  return '#9e9e9e';
}

function getStepColor(step: FlowStep): string {
  const type = step.nodeType.toLowerCase();
  if (type.includes('controller')) return '#4caf50';
  if (type.includes('service')) return '#2196f3';
  if (type.includes('repository')) return '#9c27b0';
  if (type.includes('guard')) return '#ff9800';
  return '#607d8b';
}

interface PositionedElement {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ConnectionType = 'flow' | 'read' | 'write';

interface Connection {
  from: string;
  to: string;
  count: number;
  type?: ConnectionType;
  label?: string;
}

interface ConnectionLinesProps {
  connections: Connection[];
  positions: Map<string, PositionedElement>;
  bounds: { width: number; height: number };
  dimmedConnections?: Set<string>;
}

function getConnectionColor(type?: ConnectionType): string {
  if (type === 'read') return '#2196f3';
  if (type === 'write') return '#ff9800';
  return '#e53935';
}

const ConnectionLines: React.FC<ConnectionLinesProps> = ({ connections, positions, bounds, dimmedConnections }) => {
  if (connections.length === 0) return null;

  return (
    <svg
      width={bounds.width + 200}
      height={bounds.height + 200}
      style={{
        position: 'absolute',
        top: -50,
        left: -50,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <defs>
        <marker
          id="graph-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L6,3 z" fill="#e53935" />
        </marker>
        <marker
          id="graph-arrow-read"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L6,3 z" fill="#2196f3" />
        </marker>
        <marker
          id="graph-arrow-write"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L6,3 z" fill="#ff9800" />
        </marker>
      </defs>
      <g transform="translate(50, 50)">
        {connections.map((conn, i) => {
          const fromPos = positions.get(conn.from);
          const toPos = positions.get(conn.to);
          if (!fromPos || !toPos) return null;

          const x1 = fromPos.x + fromPos.width;
          const y1 = fromPos.y + fromPos.height / 2;
          const x2 = toPos.x;
          const y2 = toPos.y + toPos.height / 2;

          const dx = x2 - x1;
          const controlOffset = Math.min(Math.abs(dx) * 0.4, 60);
          const color = getConnectionColor(conn.type);
          const markerId = conn.type === 'read' ? 'graph-arrow-read' : conn.type === 'write' ? 'graph-arrow-write' : 'graph-arrow';
          const isDimmed = dimmedConnections?.has(`${conn.from}-${conn.to}`);
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;

          return (
            <g key={`conn-${i}`}>
              <path
                d={`M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeOpacity={isDimmed ? 0.15 : 0.7}
                markerEnd={`url(#${markerId})`}
              />
              {conn.label && !isDimmed && (
                <text
                  x={midX}
                  y={midY - 6}
                  fill={color}
                  fontSize={9}
                  fontWeight={600}
                  textAnchor="middle"
                >
                  {conn.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};

export const GraphView: React.FC<GraphViewProps> = ({
  cas,
  nodes,
  edges,
  exitPoints = [],
  selectedNodeId,
  onNodeSelect,
}) => {
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [expandedCapabilities, setExpandedCapabilities] = useState<Set<string>>(new Set());

  const {
    viewTransform,
    isDragging,
    containerRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    zoomIn,
    zoomOut,
    fitToContent,
    panTo,
  } = usePanZoom({ initialTransform: { x: 100, y: 100, scale: 0.9 } });

  const domains = useMemo(() => extractDomains(cas), [cas]);

  const externalServices = useMemo(() => {
    return cas.external_services || [];
  }, [cas]);

  const entryPointSummary = useMemo(() => {
    const eps = cas.entry_points || [];
    const byType: Record<string, number> = {};
    eps.forEach(ep => {
      byType[ep.type] = (byType[ep.type] || 0) + 1;
    });
    return {
      total: eps.length,
      byType,
    };
  }, [cas]);

  const architectureBlocks = useMemo((): ArchitectureBlock[] => {
    const blocks: ArchitectureBlock[] = [];

    if (entryPointSummary.total > 0) {
      blocks.push({
        id: 'entry-points',
        name: 'Entry Points',
        description: `${entryPointSummary.total} endpoints`,
        type: 'entry',
        count: entryPointSummary.total,
        color: '#4caf50',
        items: Object.entries(entryPointSummary.byType).map(([type, count]) => `${count} ${type}`),
        metadata: entryPointSummary.byType,
      });
    }

    domains.forEach(domain => {
      const color = domain.color !== '#757575' ? domain.color : hashStringToColor(domain.id);
      blocks.push({
        id: `domain-${domain.id}`,
        name: domain.name,
        description: `${domain.stats.entryPoints} capabilities`,
        type: 'domain',
        count: domain.stats.entryPoints,
        color,
        items: domain.capabilities.slice(0, 5).map(c => c.name),
        metadata: { domain },
      });
    });

    const servicesByType = new Map<string, typeof externalServices>();
    externalServices.forEach(svc => {
      const type = svc.type || 'dependency';
      if (!servicesByType.has(type)) {
        servicesByType.set(type, []);
      }
      servicesByType.get(type)!.push(svc);
    });

    servicesByType.forEach((services, type) => {
      const typeName = type.charAt(0).toUpperCase() + type.slice(1);
      blocks.push({
        id: `external-${type}`,
        name: typeName,
        description: `${services.length} ${type}${services.length > 1 ? 's' : ''}`,
        type: 'external',
        count: services.length,
        color: hashStringToColor(type),
        items: services.slice(0, 4).map(s => s.name.replace(/via.*$/, '').trim()),
      });
    });

    return blocks;
  }, [domains, externalServices, entryPointSummary]);

  const domainBlocks = useMemo(() =>
    architectureBlocks.filter(b => b.type === 'domain'),
  [architectureBlocks]);

  const externalBlocks = useMemo(() =>
    architectureBlocks.filter(b => b.type === 'external'),
  [architectureBlocks]);

  const entryBlock = useMemo(() =>
    architectureBlocks.find(b => b.type === 'entry'),
  [architectureBlocks]);

  const getCapabilities = useCallback((domainId: string): Capability[] => {
    const domain = domains.find(d => `domain-${d.id}` === domainId);
    return domain?.capabilities || [];
  }, [domains]);

  const getFlowSteps = useCallback((capId: string): FlowStep[] => {
    for (const domain of domains) {
      const cap = domain.capabilities.find(c => c.id === capId);
      if (cap?.flowSteps && cap.flowSteps.length > 0) {
        return cap.flowSteps;
      }
    }
    return [];
  }, [domains]);

  const { positions, bounds } = useMemo(() => {
    const pos = new Map<string, PositionedElement>();
    let maxX = 0;
    let maxY = 0;

    let col1X = 0;
    let col2X = CARD_WIDTH + SECTION_GAP;
    let col3X = col2X;
    let col4X = col2X;

    let currentY = 0;

    domainBlocks.forEach((block) => {
      pos.set(block.id, {
        x: col2X,
        y: currentY,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      });

      let blockBottom = currentY + CARD_HEIGHT;

      if (expandedModules.has(block.id)) {
        const caps = getCapabilities(block.id);
        let capY = currentY;

        caps.forEach((cap) => {
          const capId = `cap-${cap.id}`;
          const capX = col2X + CARD_WIDTH + 30;

          pos.set(capId, {
            x: capX,
            y: capY,
            width: CAP_CARD_WIDTH,
            height: CAP_CARD_HEIGHT,
          });

          let capBottom = capY + CAP_CARD_HEIGHT;

          if (expandedCapabilities.has(cap.id)) {
            const steps = getFlowSteps(cap.id);
            let stepY = capY;

            steps.forEach((step, stepIdx) => {
              const stepId = `step-${cap.id}-${stepIdx}`;
              const stepX = capX + CAP_CARD_WIDTH + 20;

              pos.set(stepId, {
                x: stepX,
                y: stepY,
                width: STEP_CARD_WIDTH,
                height: STEP_CARD_HEIGHT,
              });

              col4X = Math.max(col4X, stepX + STEP_CARD_WIDTH + SECTION_GAP);
              stepY += STEP_CARD_HEIGHT + STEP_CARD_GAP;
              capBottom = Math.max(capBottom, stepY);
            });
          }

          col3X = Math.max(col3X, capX + CAP_CARD_WIDTH + SECTION_GAP);
          capY = capBottom + CAP_CARD_GAP;
          blockBottom = Math.max(blockBottom, capY);
        });
      }

      currentY = blockBottom + CARD_GAP;
      maxY = Math.max(maxY, currentY);
    });

    const totalModulesHeight = currentY - CARD_GAP;
    if (entryBlock) {
      pos.set(entryBlock.id, {
        x: col1X,
        y: Math.max(0, totalModulesHeight / 2 - CARD_HEIGHT / 2),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      });
    }

    const hasExpanded = expandedModules.size > 0 || expandedCapabilities.size > 0;
    const externalX = hasExpanded ? Math.max(col3X, col4X) : col2X + CARD_WIDTH + SECTION_GAP;
    const externalStartY = Math.max(0, totalModulesHeight / 2 - (externalBlocks.length * (CARD_HEIGHT + CARD_GAP) - CARD_GAP) / 2);

    externalBlocks.forEach((block, i) => {
      pos.set(block.id, {
        x: externalX,
        y: externalStartY + i * (CARD_HEIGHT + CARD_GAP),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      });
      maxX = Math.max(maxX, externalX + CARD_WIDTH);
      maxY = Math.max(maxY, externalStartY + (i + 1) * (CARD_HEIGHT + CARD_GAP));
    });

    maxX = Math.max(maxX, externalX + CARD_WIDTH);

    return { positions: pos, bounds: { width: maxX, height: maxY } };
  }, [entryBlock, domainBlocks, externalBlocks, expandedModules, expandedCapabilities, getCapabilities, getFlowSteps]);

  const getDbOperationType = useCallback((cap: Capability): ConnectionType => {
    const method = (cap.method || cap.action || '').toLowerCase();
    if (['get', 'read', 'list', 'view', 'fetch', 'find', 'select'].some(k => method.includes(k))) {
      return 'read';
    }
    return 'write';
  }, []);

  const getDbOperationLabel = useCallback((cap: Capability): string => {
    const method = (cap.method || cap.action || '').toLowerCase();
    if (['get', 'list', 'find'].some(k => method.includes(k))) return 'QUERY';
    if (['post', 'create', 'insert'].some(k => method.includes(k))) return 'INSERT';
    if (['put', 'patch', 'update'].some(k => method.includes(k))) return 'UPDATE';
    if (['delete', 'remove'].some(k => method.includes(k))) return 'DELETE';
    return 'QUERY';
  }, []);

  const connections = useMemo(() => {
    const conns: Connection[] = [];

    if (entryBlock) {
      domainBlocks.forEach(domain => {
        conns.push({
          from: entryBlock.id,
          to: domain.id,
          count: domain.count,
        });
      });
    }

    domainBlocks.forEach(domainBlock => {
      if (expandedModules.has(domainBlock.id)) {
        const caps = getCapabilities(domainBlock.id);

        caps.forEach(cap => {
          conns.push({
            from: domainBlock.id,
            to: `cap-${cap.id}`,
            count: 1,
          });

          const dbOpType = getDbOperationType(cap);
          const dbOpLabel = getDbOperationLabel(cap);

          if (expandedCapabilities.has(cap.id)) {
            const steps = getFlowSteps(cap.id);
            steps.forEach((step, stepIdx) => {
              if (stepIdx === 0) {
                conns.push({
                  from: `cap-${cap.id}`,
                  to: `step-${cap.id}-${stepIdx}`,
                  count: 1,
                });
              } else {
                conns.push({
                  from: `step-${cap.id}-${stepIdx - 1}`,
                  to: `step-${cap.id}-${stepIdx}`,
                  count: 1,
                });
              }

              const combinedName = (step.nodeType + step.nodeName + step.name).toLowerCase();
              const isRepository = combinedName.includes('repository') || step.nodeType.toLowerCase() === 'repository';
              const startsWithDbVerb = /^(find|get|save|create|update|delete|remove|insert|query|count|persist|flush)/.test(step.name.toLowerCase());
              const isDbMethod = startsWithDbVerb || ['findone', 'findall', 'findand', 'findby', 'getone', 'getall', 'getby', 'save', 'persist', 'flush', 'remove', 'delete', 'insert', 'query', 'count', 'nativequery'].some(p => combinedName.includes(p));
              const isDbCall = isRepository || isDbMethod;
              if (isDbCall) {
                const stepId = `step-${cap.id}-${stepIdx}`;
                externalBlocks.forEach(external => {
                  if (external.name === 'Database') {
                    conns.push({
                      from: stepId,
                      to: external.id,
                      count: 1,
                      type: dbOpType,
                      label: dbOpLabel,
                    });
                  }
                });
              }
            });
          } else {
            const domainData = domainBlock.metadata?.domain as Domain | undefined;
            externalBlocks.forEach(external => {
              if (domainData?.stats.hasDatabase && external.name === 'Database') {
                conns.push({
                  from: `cap-${cap.id}`,
                  to: external.id,
                  count: 1,
                  type: dbOpType,
                  label: dbOpLabel,
                });
              }
            });
          }
        });
      } else {
        const domainData = domainBlock.metadata?.domain as Domain | undefined;
        externalBlocks.forEach(external => {
          if (domainData?.stats.hasDatabase && external.name === 'Database') {
            conns.push({ from: domainBlock.id, to: external.id, count: 3 });
          } else if (domainData?.stats.hasExternalApi && external.type === 'external' && external.name !== 'Database') {
            conns.push({ from: domainBlock.id, to: external.id, count: 2 });
          }
        });
      }
    });

    return conns;
  }, [entryBlock, domainBlocks, externalBlocks, expandedModules, expandedCapabilities, getCapabilities, getFlowSteps, getDbOperationType, getDbOperationLabel]);

  const { dimmedBlocks, dimmedConnections } = useMemo(() => {
    const dimmed = new Set<string>();
    const dimmedConns = new Set<string>();

    if (expandedModules.size > 0) {
      domainBlocks.forEach(block => {
        if (!expandedModules.has(block.id)) {
          dimmed.add(block.id);
          connections.forEach(conn => {
            if (conn.from === block.id || conn.to === block.id) {
              dimmedConns.add(`${conn.from}-${conn.to}`);
            }
          });
        }
      });

      if (entryBlock) {
        connections.forEach(conn => {
          if (conn.from === entryBlock.id && dimmed.has(conn.to)) {
            dimmedConns.add(`${conn.from}-${conn.to}`);
          }
        });
      }
    }

    return { dimmedBlocks: dimmed, dimmedConnections: dimmedConns };
  }, [expandedModules, domainBlocks, entryBlock, connections]);

  const toggleModule = useCallback((blockId: string) => {
    setExpandedModules(prev => {
      if (prev.has(blockId)) {
        setExpandedCapabilities(prevCaps => {
          const caps = getCapabilities(blockId);
          const nextCaps = new Set(prevCaps);
          caps.forEach(c => nextCaps.delete(c.id));
          return nextCaps;
        });
        return new Set();
      } else {
        setExpandedCapabilities(new Set());
        return new Set([blockId]);
      }
    });
  }, [getCapabilities]);

  const toggleCapability = useCallback((capId: string) => {
    setExpandedCapabilities(prev => {
      const next = new Set(prev);
      if (next.has(capId)) {
        next.delete(capId);
      } else {
        next.add(capId);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedModules(new Set());
    setExpandedCapabilities(new Set());
  }, []);

  const getBlockIcon = (block: ArchitectureBlock) => {
    if (block.type === 'entry') return <Input fontSize="small" />;
    if (block.type === 'external') return <Output fontSize="small" />;
    return <Hub fontSize="small" />;
  };

  const renderBlock = (block: ArchitectureBlock) => {
    const pos = positions.get(block.id);
    if (!pos) return null;

    const isExpanded = expandedModules.has(block.id);
    const canExpand = block.type === 'domain';
    const isDimmed = dimmedBlocks.has(block.id);

    return (
      <Card
        key={block.id}
        data-component="arch-block"
        sx={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          width: pos.width,
          height: pos.height,
          cursor: canExpand ? 'pointer' : 'default',
          transition: 'all 0.3s ease',
          borderLeft: 4,
          borderColor: block.color,
          bgcolor: isExpanded ? `${block.color}18` : '#2d2d2d',
          opacity: isDimmed ? 0.3 : 1,
          '&:hover': canExpand ? { boxShadow: 4, opacity: isDimmed ? 0.6 : 1 } : {},
        }}
        onClick={(e) => {
          if (canExpand) {
            e.stopPropagation();
            toggleModule(block.id);
          }
        }}
      >
        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
          <Stack spacing={0.25}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              {canExpand && (
                <Box sx={{ color: block.color, display: 'flex' }}>
                  {isExpanded ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
                </Box>
              )}
              <Box sx={{ color: block.color, display: 'flex' }}>
                {getBlockIcon(block)}
              </Box>
              <Typography variant="body2" fontWeight={600} noWrap sx={{ flex: 1, color: '#fff' }}>
                {block.name}
              </Typography>
              <Chip
                label={block.count}
                size="small"
                sx={{
                  bgcolor: `${block.color}30`,
                  color: block.color,
                  fontWeight: 600,
                  height: 18,
                  fontSize: '0.65rem',
                }}
              />
            </Stack>
            <Typography variant="caption" noWrap sx={{ color: 'rgba(255,255,255,0.6)' }}>
              {block.description}
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    );
  };

  const renderCapability = (cap: Capability) => {
    const pos = positions.get(`cap-${cap.id}`);
    if (!pos) return null;

    const capLabel = getCapabilityLabel(cap);
    const capColor = getCapabilityColor(cap);
    const isExpanded = expandedCapabilities.has(cap.id);
    const hasSteps = getFlowSteps(cap.id).length > 0;

    return (
      <Card
        key={`cap-${cap.id}`}
        data-component="cap-block"
        sx={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          width: pos.width,
          height: pos.height,
          cursor: hasSteps ? 'pointer' : 'default',
          transition: 'all 0.2s ease',
          borderLeft: 3,
          borderColor: capColor,
          bgcolor: isExpanded ? `${capColor}18` : '#252525',
          '&:hover': hasSteps ? { boxShadow: 3 } : {},
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (hasSteps) {
            toggleCapability(cap.id);
          } else {
            const handlerNodeId = cap.entryPoint?.handler?.node_id;
            if (handlerNodeId) {
              onNodeSelect?.(handlerNodeId);
            }
          }
        }}
      >
        <CardContent sx={{ p: 0.75, '&:last-child': { pb: 0.75 } }}>
          <Stack spacing={0.25}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              {hasSteps && (
                <Box sx={{ color: capColor, display: 'flex' }}>
                  {isExpanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
                </Box>
              )}
              <Chip
                label={capLabel}
                size="small"
                sx={{
                  bgcolor: `${capColor}20`,
                  color: capColor,
                  fontWeight: 600,
                  fontSize: '0.6rem',
                  height: 16,
                }}
              />
              {cap.requiresAuth && (
                <Lock sx={{ fontSize: 10, color: '#4caf50' }} />
              )}
            </Stack>
            <Typography variant="caption" fontWeight={500} noWrap sx={{ fontSize: '0.7rem', color: '#fff' }}>
              {cap.name}
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    );
  };

  const renderFlowStep = (step: FlowStep, capId: string, stepIdx: number) => {
    const pos = positions.get(`step-${capId}-${stepIdx}`);
    if (!pos) return null;

    const stepColor = getStepColor(step);

    return (
      <Card
        key={`step-${capId}-${stepIdx}`}
        data-component="step-block"
        sx={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          width: pos.width,
          height: pos.height,
          cursor: 'pointer',
          borderLeft: 2,
          borderColor: stepColor,
          bgcolor: '#1e1e1e',
          '&:hover': { boxShadow: 2, bgcolor: `${stepColor}20` },
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (step.nodeId) {
            onNodeSelect?.(step.nodeId);
          }
        }}
      >
        <CardContent sx={{ p: 0.5, '&:last-child': { pb: 0.5 } }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <AccountTree sx={{ fontSize: 12, color: stepColor }} />
            <Typography variant="caption" fontWeight={500} noWrap sx={{ fontSize: '0.65rem', color: '#fff' }}>
              {step.name}
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    );
  };

  const systemName = cas.system?.name || 'System Architecture';
  const totalExpanded = expandedModules.size + expandedCapabilities.size;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Paper sx={{ p: 1, borderRadius: 0, borderBottom: 1, borderColor: 'rgba(255,255,255,0.1)', bgcolor: '#1e1e1e' }}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" fontWeight={600} sx={{ color: '#fff' }}>
              {systemName}
            </Typography>
            <Chip
              label={`${domains.length} modules`}
              size="small"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', color: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.3)' }}
            />
            {totalExpanded > 0 && (
              <Chip
                label={`${totalExpanded} expanded`}
                size="small"
                onDelete={collapseAll}
                sx={{ height: 20, fontSize: '0.7rem', bgcolor: 'primary.main', color: 'white' }}
              />
            )}
          </Stack>

          <Stack direction="row" spacing={0.5} alignItems="center">
            <Tooltip title="Zoom in">
              <IconButton size="small" onClick={zoomIn} sx={{ color: 'rgba(255,255,255,0.7)' }}>
                <ZoomIn fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Zoom out">
              <IconButton size="small" onClick={zoomOut} sx={{ color: 'rgba(255,255,255,0.7)' }}>
                <ZoomOut fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Fit to view">
              <IconButton size="small" onClick={() => fitToContent(bounds)} sx={{ color: 'rgba(255,255,255,0.7)' }}>
                <FitScreen fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Paper>

      <Box
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        sx={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          bgcolor: '#1a1a1a',
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
            transformOrigin: '0 0',
          }}
        >
          <ConnectionLines
            connections={connections}
            positions={positions}
            bounds={bounds}
            dimmedConnections={dimmedConnections}
          />

          {entryBlock && renderBlock(entryBlock)}

          {domainBlocks.map(block => (
            <React.Fragment key={block.id}>
              {renderBlock(block)}
              {expandedModules.has(block.id) && (
                getCapabilities(block.id).map(cap => (
                  <React.Fragment key={cap.id}>
                    {renderCapability(cap)}
                    {expandedCapabilities.has(cap.id) && (
                      getFlowSteps(cap.id).map((step, stepIdx) =>
                        renderFlowStep(step, cap.id, stepIdx)
                      )
                    )}
                  </React.Fragment>
                ))
              )}
            </React.Fragment>
          ))}

          {externalBlocks.map(block => renderBlock(block))}
        </Box>

        <Paper
          sx={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            p: 1,
            maxWidth: 220,
            bgcolor: 'rgba(30,30,30,0.9)',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.6)' }} fontWeight={500}>
            Click to expand. Scroll to zoom.
          </Typography>
        </Paper>

        <Box
          sx={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            bgcolor: 'rgba(30,30,30,0.9)',
            border: '1px solid rgba(255,255,255,0.1)',
            px: 1.5,
            py: 0.5,
            borderRadius: 1,
          }}
        >
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.6)' }}>
            {Math.round(viewTransform.scale * 100)}%
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};
