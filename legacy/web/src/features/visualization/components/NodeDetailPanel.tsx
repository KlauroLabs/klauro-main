import React, { useMemo } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Divider,
  Stack,
  Chip,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Paper,
  Tooltip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import {
  Close,
  ArrowBack,
  CallMade,
  CallReceived,
  Code,
  FolderOpen,
  Timeline,
  ExpandMore,
  Warning,
  CheckCircle,
  Storage,
  AccountTree,
  Functions,
  Label,
  KeyboardArrowUp,
  Http,
  Input,
  Output,
  Link as LinkIcon,
  Segment,
} from '@mui/icons-material';
import { CASNode, CASCallChain, CASDecorator, EntryPoint, ExitPoint } from '../types';
import { getNodeColor, getNodeIcon } from '../canvas/NodeCard';
import { ExitPointConnection } from '../hooks/useNodeSelection';

const CLASS_LIKE_TYPES = ['class', 'interface', 'controller', 'service', 'repository', 'module', 'entity'];

export interface NodeDetailPanelProps {
  node: CASNode;
  allNodes?: CASNode[];
  allEdges?: import('../types').CASEdge[];
  decorators?: CASDecorator[];
  entryPoints?: EntryPoint[];
  exitPoints?: ExitPoint[];
  incomingConnections: CASNode[];
  outgoingConnections: CASNode[];
  outgoingExitPoints?: ExitPointConnection[];
  callChains: CASCallChain[];
  onClose: () => void;
  onNodeClick: (nodeId: string) => void;
  canGoBack?: boolean;
  onGoBack?: () => void;
}

export const NodeDetailPanel: React.FC<NodeDetailPanelProps> = ({
  node,
  allNodes = [],
  allEdges = [],
  decorators = [],
  entryPoints = [],
  exitPoints = [],
  incomingConnections,
  outgoingConnections,
  outgoingExitPoints = [],
  callChains,
  onClose,
  onNodeClick,
  canGoBack,
  onGoBack,
}) => {
  const typeColor = getNodeColor(node.type);

  const isEntryPoint = node.tags?.includes('entry-point') || node.type === 'controller';
  const isExitPoint = node.tags?.includes('exit-point') || node.type === 'repository';

  const parentNode = useMemo(() => {
    if (!node.parent) return null;
    return allNodes.find(n => n.id === node.parent) || null;
  }, [node, allNodes]);

  const childMethods = useMemo(() => {
    if (!['class', 'interface', 'controller', 'service', 'repository', 'module'].includes(node.type)) {
      return [];
    }
    return allNodes.filter(n =>
      n.parent === node.id &&
      ['method', 'function', 'constructor'].includes(n.type)
    );
  }, [node, allNodes]);

  const nodeDecorators = useMemo(() => {
    return decorators.filter(d => d.target_node === node.id);
  }, [node.id, decorators]);

  const signature = node.signature;
  const attributes = node.metadata?.attributes;

  const nodeEntryPoint = useMemo(() => {
    return entryPoints.find(ep =>
      ep.handler?.node_id === node.id ||
      (node.parent && ep.handler?.node_id === node.parent && ep.handler?.method_name === node.name)
    );
  }, [node, entryPoints]);

  const nodeExitPointsTriggered = useMemo(() => {
    return exitPoints.filter(ep =>
      ep.source?.node_id === node.id ||
      (node.parent && ep.source?.node_id === node.parent && ep.source?.method_name === node.name)
    );
  }, [node, exitPoints]);

  const siblingMethods = useMemo(() => {
    if (!node.parent) return [];
    if (!['method', 'function', 'constructor'].includes(node.type)) return [];
    return allNodes.filter(n =>
      n.parent === node.parent &&
      n.id !== node.id &&
      ['method', 'function', 'constructor'].includes(n.type)
    );
  }, [node, allNodes]);

  const constructorDependencies = useMemo(() => {
    if (node.type !== 'constructor' && node.name !== 'constructor') return [];
    const deps: Array<{ name: string; type?: string; node?: CASNode }> = [];
    if (signature?.parameters) {
      signature.parameters.forEach(param => {
        const depNode = allNodes.find(n =>
          n.name === param.type?.replace('[]', '') &&
          ['class', 'service', 'repository', 'controller', 'module', 'interface'].includes(n.type)
        );
        deps.push({
          name: param.name,
          type: param.type,
          node: depNode
        });
      });
    }
    return deps;
  }, [node, signature, allNodes]);

  const { filteredOutgoingConnections, inheritedConnections } = useMemo(() => {
    const extendsName = attributes?.extends;
    const implementsNames = attributes?.implements || [];
    const inheritanceNames = new Set([extendsName, ...implementsNames].filter(Boolean));

    const filtered: CASNode[] = [];
    const inherited: CASNode[] = [];

    outgoingConnections.forEach(conn => {
      const connNameLower = conn.name.toLowerCase();
      const isLikelyBaseClass = connNameLower.includes('base') ||
                                connNameLower.includes('abstract') ||
                                connNameLower.includes('entity');

      const isInheritance = inheritanceNames.has(conn.name) ||
        (CLASS_LIKE_TYPES.includes(node.type) && CLASS_LIKE_TYPES.includes(conn.type) && isLikelyBaseClass) ||
        (CLASS_LIKE_TYPES.includes(node.type) && conn.type === 'interface');

      if (isInheritance) {
        inherited.push(conn);
      } else {
        filtered.push(conn);
      }
    });

    return { filteredOutgoingConnections: filtered, inheritedConnections: inherited };
  }, [outgoingConnections, attributes, node.type]);

  const usedByClasses = useMemo(() => {
    if (!CLASS_LIKE_TYPES.includes(node.type)) {
      return [];
    }

    const nodeMap = new Map(allNodes.map(n => [n.id, n]));
    const classesUsingThis = new Map<string, CASNode>();
    const className = node.name;
    const classNameLower = className.toLowerCase();

    const addClassIfValid = (classNode: CASNode | undefined) => {
      if (classNode && classNode.id !== node.id && !classesUsingThis.has(classNode.id)) {
        classesUsingThis.set(classNode.id, classNode);
      }
    };

    const getParentClass = (n: CASNode): CASNode | undefined => {
      if (n.parent && n.parent !== node.id) {
        return nodeMap.get(n.parent);
      }
      if (CLASS_LIKE_TYPES.includes(n.type) && n.id !== node.id) {
        return n;
      }
      return undefined;
    };

    allNodes.forEach(n => {
      if (n.id === node.id || n.parent === node.id) return;

      if (n.signature?.parameters) {
        for (const p of n.signature.parameters) {
          if (p.type === className ||
              p.type?.includes(className) ||
              p.name?.toLowerCase().includes(classNameLower)) {
            addClassIfValid(getParentClass(n));
            break;
          }
        }
      }
    });

    incomingConnections.forEach(caller => {
      if (caller.id !== node.id && caller.parent !== node.id) {
        addClassIfValid(getParentClass(caller));
      }
    });

    const methodNames = new Set(childMethods.map(m => m.name.toLowerCase()));
    const methodNamesList = Array.from(methodNames);

    const methodsByName = new Map<string, CASNode[]>();
    allNodes.forEach(n => {
      if (n.type === 'method' && n.parent) {
        const existing = methodsByName.get(n.name) || [];
        existing.push(n);
        methodsByName.set(n.name, existing);
      }
    });

    const callEdges = allEdges.filter(e => e.type === 'calls');

    for (const edge of callEdges) {
      const targetLower = edge.target.toLowerCase();

      const targetHasMethod = methodNamesList.some(name => targetLower.includes(name)) ||
                              targetLower.includes(classNameLower);

      if (!targetHasMethod) continue;

      let sourceNode = nodeMap.get(edge.source);
      let sourceParentClass: CASNode | undefined;

      if (sourceNode?.parent) {
        sourceParentClass = nodeMap.get(sourceNode.parent);
      }

      if (!sourceParentClass) {
        const sourceIdParts = edge.source.split('_');
        const possibleMethodName = sourceIdParts[sourceIdParts.length - 2];

        if (possibleMethodName) {
          const candidates = methodsByName.get(possibleMethodName) || [];
          for (const candidate of candidates) {
            if (candidate.parent && candidate.parent !== node.id) {
              sourceParentClass = nodeMap.get(candidate.parent);
              break;
            }
          }
        }
      }

      if (sourceParentClass && sourceParentClass.id !== node.id) {
        addClassIfValid(sourceParentClass);
      }
    }

    return Array.from(classesUsingThis.values());
  }, [node, childMethods, allNodes, allEdges, incomingConnections]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Stack direction="row" spacing={1} alignItems="center">
            {canGoBack && onGoBack && (
              <IconButton size="small" onClick={onGoBack}>
                <ArrowBack fontSize="small" />
              </IconButton>
            )}
            <Box>
              <Typography variant="h6" fontWeight={600}>
                {node.name}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                <Chip
                  label={node.type}
                  size="small"
                  sx={{
                    bgcolor: `${typeColor}20`,
                    color: typeColor,
                    fontWeight: 500,
                  }}
                />
                {isEntryPoint && (
                  <Chip label="Entry" size="small" color="success" variant="outlined" />
                )}
                {isExitPoint && (
                  <Chip label="Exit" size="small" color="error" variant="outlined" />
                )}
              </Stack>
            </Box>
          </Stack>
          <IconButton size="small" onClick={onClose}>
            <Close fontSize="small" />
          </IconButton>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Stack spacing={2}>
          {node.source && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <FolderOpen fontSize="small" color="action" />
                <Box sx={{ flex: 1, overflow: 'hidden' }}>
                  <Typography variant="body2" fontFamily="monospace" noWrap>
                    {node.source.file}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Lines {node.source.line} - {node.source.end_line}
                  </Typography>
                </Box>
              </Stack>
            </Paper>
          )}

          {node.level !== undefined && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                Level:
              </Typography>
              <Chip
                label={node.level_name || `Level ${node.level}`}
                size="small"
                variant="outlined"
              />
            </Stack>
          )}

          {parentNode && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Parent Class
              </Typography>
              <ListItemButton
                onClick={() => onNodeClick(parentNode.id)}
                sx={{ mx: -1.5, borderRadius: 1 }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <KeyboardArrowUp sx={{ color: getNodeColor(parentNode.type) }} />
                </ListItemIcon>
                <ListItemText
                  primary={parentNode.name}
                  secondary={parentNode.type}
                  primaryTypographyProps={{ variant: 'body2', fontWeight: 500 }}
                  secondaryTypographyProps={{ variant: 'caption' }}
                />
              </ListItemButton>
            </Paper>
          )}

          {(attributes?.extends || (attributes?.implements && attributes.implements.length > 0) || inheritedConnections.length > 0) && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Inheritance
              </Typography>
              <Stack spacing={1}>
                {attributes?.extends && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 70 }}>
                      extends
                    </Typography>
                    <Chip label={attributes.extends} size="small" variant="outlined" />
                  </Stack>
                )}
                {attributes?.implements && attributes.implements.length > 0 && (
                  <Stack direction="row" spacing={1} alignItems="flex-start">
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 70, pt: 0.5 }}>
                      implements
                    </Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap">
                      {attributes.implements.map((impl, idx) => (
                        <Chip key={idx} label={impl} size="small" variant="outlined" />
                      ))}
                    </Stack>
                  </Stack>
                )}
                {inheritedConnections.length > 0 && !attributes?.extends && (
                  <List dense disablePadding>
                    {inheritedConnections.map((conn) => (
                      <ListItem key={conn.id} disablePadding>
                        <ListItemButton onClick={() => onNodeClick(conn.id)} sx={{ py: 0.5 }}>
                          <ListItemIcon sx={{ minWidth: 36 }}>
                            <Box sx={{ color: getNodeColor(conn.type) }}>
                              {getNodeIcon(conn.type)}
                            </Box>
                          </ListItemIcon>
                          <ListItemText
                            primary={conn.name}
                            secondary={conn.type === 'interface' ? 'implements' : 'extends'}
                            primaryTypographyProps={{ variant: 'body2' }}
                            secondaryTypographyProps={{ variant: 'caption' }}
                          />
                        </ListItemButton>
                      </ListItem>
                    ))}
                  </List>
                )}
              </Stack>
            </Paper>
          )}

          {nodeEntryPoint && (
            <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'success.main', bgcolor: 'success.50' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Http fontSize="small" sx={{ color: 'success.main' }} />
                <Typography variant="subtitle2" sx={{ color: 'success.main' }}>
                  HTTP Endpoint
                </Typography>
              </Stack>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    label={nodeEntryPoint.protocol_details?.method || 'GET'}
                    size="small"
                    sx={{
                      fontWeight: 600,
                      bgcolor: nodeEntryPoint.protocol_details?.method === 'POST' ? 'primary.main' :
                               nodeEntryPoint.protocol_details?.method === 'PUT' ? 'warning.main' :
                               nodeEntryPoint.protocol_details?.method === 'DELETE' ? 'error.main' :
                               'info.main',
                      color: 'white',
                    }}
                  />
                  <Typography variant="body2" fontFamily="monospace" fontWeight={500}>
                    {nodeEntryPoint.protocol_details?.path || nodeEntryPoint.name}
                  </Typography>
                </Stack>
                {nodeEntryPoint.authentication && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="caption" color="text.secondary">
                      Auth:
                    </Typography>
                    <Chip
                      label={nodeEntryPoint.authentication.required ? 'Required' : 'None'}
                      size="small"
                      color={nodeEntryPoint.authentication.required ? 'warning' : 'default'}
                      variant="outlined"
                      sx={{ height: 20, fontSize: '0.65rem' }}
                    />
                    {nodeEntryPoint.authentication.methods?.map((method, idx) => (
                      <Chip
                        key={idx}
                        label={method}
                        size="small"
                        variant="outlined"
                        sx={{ height: 20, fontSize: '0.65rem' }}
                      />
                    ))}
                  </Stack>
                )}
                {nodeEntryPoint.protocol_details?.parameters && nodeEntryPoint.protocol_details.parameters.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                      Route Parameters
                    </Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap">
                      {nodeEntryPoint.protocol_details.parameters.map((param, idx) => (
                        <Chip
                          key={idx}
                          label={`${param.name}: ${param.type}${param.required === false ? '?' : ''}`}
                          size="small"
                          variant="outlined"
                          sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
                        />
                      ))}
                    </Stack>
                  </Box>
                )}
              </Stack>
            </Paper>
          )}

          {nodeExitPointsTriggered.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'secondary.main', bgcolor: 'secondary.50' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Output fontSize="small" sx={{ color: 'secondary.main' }} />
                <Typography variant="subtitle2" sx={{ color: 'secondary.main' }}>
                  External Calls ({nodeExitPointsTriggered.length})
                </Typography>
              </Stack>
              <Stack spacing={0.5}>
                {nodeExitPointsTriggered.map((ep) => (
                  <Stack key={ep.id} direction="row" spacing={1} alignItems="center">
                    <Chip
                      label={ep.type}
                      size="small"
                      color="secondary"
                      variant="outlined"
                      sx={{ height: 20, fontSize: '0.65rem' }}
                    />
                    <Typography variant="body2" fontFamily="monospace">
                      {ep.name}
                    </Typography>
                    {ep.target.endpoint && (
                      <Typography variant="caption" color="text.secondary">
                        {ep.target.endpoint}
                      </Typography>
                    )}
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}

          {signature && (signature.parameters || signature.return_type) && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Functions fontSize="small" color="action" />
                <Typography variant="subtitle2">Signature</Typography>
                {signature.async && (
                  <Chip label="async" size="small" color="info" sx={{ height: 18, fontSize: '0.65rem' }} />
                )}
                {signature.visibility && (
                  <Chip label={signature.visibility} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                )}
              </Stack>
              {signature.parameters && signature.parameters.length > 0 && (
                <Box sx={{ mb: 1 }}>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                    Parameters
                  </Typography>
                  <Stack spacing={0.5}>
                    {signature.parameters.map((param, idx) => (
                      <Stack key={idx} direction="row" spacing={1} alignItems="center">
                        <Typography variant="body2" fontFamily="monospace" sx={{ fontWeight: 500 }}>
                          {param.name}
                          {param.optional && '?'}
                        </Typography>
                        {param.type && (
                          <Typography variant="caption" color="text.secondary">
                            : {param.type}
                          </Typography>
                        )}
                        {param.default_value && (
                          <Typography variant="caption" color="primary.main">
                            = {param.default_value}
                          </Typography>
                        )}
                      </Stack>
                    ))}
                  </Stack>
                </Box>
              )}
              {signature.return_type && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" color="text.secondary">
                    Returns:
                  </Typography>
                  <Typography variant="body2" fontFamily="monospace">
                    {signature.return_type}
                  </Typography>
                </Stack>
              )}
            </Paper>
          )}

          {nodeDecorators.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Label fontSize="small" color="action" />
                <Typography variant="subtitle2">Decorators</Typography>
              </Stack>
              <Stack spacing={1}>
                {nodeDecorators.map((dec) => (
                  <Box key={dec.id}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2" fontFamily="monospace" fontWeight={500}>
                        @{dec.decorator_info.name}
                      </Typography>
                      <Chip
                        label={dec.semantic_meaning.category}
                        size="small"
                        variant="outlined"
                        sx={{ height: 18, fontSize: '0.65rem' }}
                      />
                    </Stack>
                    {dec.routing_info && (
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        {dec.routing_info.method} {dec.routing_info.path}
                      </Typography>
                    )}
                    {dec.security_info?.authentication_required && (
                      <Typography variant="caption" color="warning.main" sx={{ ml: 1 }}>
                        Requires authentication
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            </Paper>
          )}

          {attributes?.decorators && attributes.decorators.length > 0 && nodeDecorators.length === 0 && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Label fontSize="small" color="action" />
                <Typography variant="subtitle2">Decorators</Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {attributes.decorators.map((dec, idx) => (
                  <Chip
                    key={idx}
                    label={`@${dec}`}
                    size="small"
                    variant="outlined"
                    sx={{ fontFamily: 'monospace' }}
                  />
                ))}
              </Stack>
            </Paper>
          )}

          {constructorDependencies.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'info.main', bgcolor: 'info.50' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <LinkIcon fontSize="small" sx={{ color: 'info.main' }} />
                <Typography variant="subtitle2" sx={{ color: 'info.main' }}>
                  Injected Dependencies ({constructorDependencies.length})
                </Typography>
              </Stack>
              <List dense disablePadding>
                {constructorDependencies.map((dep, idx) => (
                  <ListItem key={idx} disablePadding>
                    {dep.node ? (
                      <ListItemButton onClick={() => onNodeClick(dep.node!.id)} sx={{ py: 0.5 }}>
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          <Box sx={{ color: getNodeColor(dep.node.type) }}>
                            {getNodeIcon(dep.node.type)}
                          </Box>
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2" fontFamily="monospace">
                                {dep.name}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                : {dep.type}
                              </Typography>
                            </Stack>
                          }
                          secondary={dep.node.type}
                          secondaryTypographyProps={{ variant: 'caption' }}
                        />
                      </ListItemButton>
                    ) : (
                      <ListItem sx={{ py: 0.5 }}>
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2" fontFamily="monospace">
                                {dep.name}
                              </Typography>
                              {dep.type && (
                                <Typography variant="caption" color="text.secondary">
                                  : {dep.type}
                                </Typography>
                              )}
                            </Stack>
                          }
                        />
                      </ListItem>
                    )}
                  </ListItem>
                ))}
              </List>
            </Paper>
          )}

          {childMethods.length > 0 && (
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Functions fontSize="small" color="primary" />
                  <Typography variant="subtitle2">
                    Methods ({childMethods.length})
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                <List dense disablePadding>
                  {childMethods.map((method) => {
                    const methodSig = method.signature;
                    const params = methodSig?.parameters?.map(p => p.name).join(', ') || '';
                    return (
                      <ListItem key={method.id} disablePadding>
                        <ListItemButton onClick={() => onNodeClick(method.id)}>
                          <ListItemIcon sx={{ minWidth: 36 }}>
                            <Box sx={{ color: getNodeColor(method.type) }}>
                              {getNodeIcon(method.type)}
                            </Box>
                          </ListItemIcon>
                          <ListItemText
                            primary={
                              <Typography variant="body2" fontFamily="monospace">
                                {method.name}({params})
                              </Typography>
                            }
                            secondary={methodSig?.return_type || method.type}
                            secondaryTypographyProps={{ variant: 'caption' }}
                          />
                        </ListItemButton>
                      </ListItem>
                    );
                  })}
                </List>
              </AccordionDetails>
            </Accordion>
          )}

          {siblingMethods.length > 0 && (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Segment fontSize="small" color="action" />
                  <Typography variant="subtitle2">
                    Sibling Methods ({siblingMethods.length})
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                <List dense disablePadding>
                  {siblingMethods.map((method) => {
                    const methodSig = method.signature;
                    const params = methodSig?.parameters?.map(p => p.name).join(', ') || '';
                    return (
                      <ListItem key={method.id} disablePadding>
                        <ListItemButton onClick={() => onNodeClick(method.id)}>
                          <ListItemIcon sx={{ minWidth: 36 }}>
                            <Box sx={{ color: getNodeColor(method.type) }}>
                              {getNodeIcon(method.type)}
                            </Box>
                          </ListItemIcon>
                          <ListItemText
                            primary={
                              <Typography variant="body2" fontFamily="monospace">
                                {method.name}({params})
                              </Typography>
                            }
                            secondary={methodSig?.return_type || method.type}
                            secondaryTypographyProps={{ variant: 'caption' }}
                          />
                        </ListItemButton>
                      </ListItem>
                    );
                  })}
                </List>
              </AccordionDetails>
            </Accordion>
          )}

          {node.documentation && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" gutterBottom>
                Documentation
              </Typography>
              {node.documentation.summary && (
                <Typography variant="body2" color="text.secondary">
                  {node.documentation.summary}
                </Typography>
              )}
              {node.documentation.description && (
                <Typography variant="body2" sx={{ mt: 1 }}>
                  {node.documentation.description}
                </Typography>
              )}
            </Paper>
          )}

          {node.implementation_status && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                {node.implementation_status.status === 'complete' ? (
                  <CheckCircle color="success" fontSize="small" />
                ) : (
                  <Warning color="warning" fontSize="small" />
                )}
                <Typography variant="body2">
                  {node.implementation_status.status === 'complete' && 'Fully Implemented'}
                  {node.implementation_status.status === 'partial' && 'Partially Implemented'}
                  {node.implementation_status.status === 'stub' && 'Stub Implementation'}
                  {node.implementation_status.status === 'not-implemented' && 'Not Implemented'}
                  {node.implementation_status.status === 'deprecated' && 'Deprecated'}
                  {node.implementation_status.status === 'experimental' && 'Experimental'}
                </Typography>
                {node.implementation_status.completeness?.estimated_percentage !== undefined && (
                  <Chip
                    label={`${node.implementation_status.completeness.estimated_percentage}%`}
                    size="small"
                    sx={{ height: 18, fontSize: '0.65rem' }}
                    color={node.implementation_status.completeness.estimated_percentage === 100 ? 'success' : 'warning'}
                    variant="outlined"
                  />
                )}
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                {node.implementation_status.indicators.has_todo_markers && (
                  <Tooltip title="Contains TODO, FIXME, or HACK comments" arrow>
                    <Chip label="Has TODOs" size="small" color="warning" sx={{ height: 20, fontSize: '0.65rem' }} />
                  </Tooltip>
                )}
                {node.implementation_status.indicators.has_stub_returns && (
                  <Tooltip title="Returns placeholder values like null, [], or {}" arrow>
                    <Chip label="Stub Return" size="small" color="warning" sx={{ height: 20, fontSize: '0.65rem' }} />
                  </Tooltip>
                )}
                {node.implementation_status.indicators.has_not_implemented_exceptions && (
                  <Tooltip title="Throws NotImplementedError or similar" arrow>
                    <Chip label="Not Implemented" size="small" color="error" sx={{ height: 20, fontSize: '0.65rem' }} />
                  </Tooltip>
                )}
                {node.implementation_status.indicators.has_placeholder_code && (
                  <Tooltip title="Contains placeholder code with TODO in console logs" arrow>
                    <Chip label="Placeholder" size="small" color="warning" sx={{ height: 20, fontSize: '0.65rem' }} />
                  </Tooltip>
                )}
                {node.implementation_status.indicators.has_hardcoded_values && (
                  <Tooltip title="Contains hardcoded PLACEHOLDER or TEMP values" arrow>
                    <Chip label="Hardcoded" size="small" color="warning" sx={{ height: 20, fontSize: '0.65rem' }} />
                  </Tooltip>
                )}
                {node.implementation_status.indicators.has_commented_out_code && (
                  <Tooltip title="Contains commented-out code blocks" arrow>
                    <Chip label="Dead Code" size="small" color="default" sx={{ height: 20, fontSize: '0.65rem' }} />
                  </Tooltip>
                )}
              </Stack>
            </Paper>
          )}

          {usedByClasses.length > 0 && (
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <CallReceived fontSize="small" color="info" />
                  <Typography variant="subtitle2">
                    Used By ({usedByClasses.length})
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                <List dense disablePadding>
                  {usedByClasses.map((cls) => {
                    const fileName = cls.source?.file?.split('/').pop()?.replace('.ts', '') || '';
                    return (
                      <ListItem key={cls.id} disablePadding>
                        <ListItemButton onClick={() => onNodeClick(cls.id)}>
                          <ListItemIcon sx={{ minWidth: 36 }}>
                            <Box sx={{ color: getNodeColor(cls.type) }}>
                              {getNodeIcon(cls.type)}
                            </Box>
                          </ListItemIcon>
                          <ListItemText
                            primary={cls.name}
                            secondary={`${cls.type}${fileName ? ` - ${fileName}` : ''}`}
                            primaryTypographyProps={{ variant: 'body2' }}
                            secondaryTypographyProps={{ variant: 'caption' }}
                          />
                        </ListItemButton>
                      </ListItem>
                    );
                  })}
                </List>
              </AccordionDetails>
            </Accordion>
          )}

          <Accordion defaultExpanded={filteredOutgoingConnections.length > 0 || outgoingExitPoints.length > 0}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CallMade fontSize="small" color="primary" />
                <Typography variant="subtitle2">
                  Calls To ({filteredOutgoingConnections.length + outgoingExitPoints.length})
                </Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <List dense disablePadding>
                {filteredOutgoingConnections.map((conn) => {
                  const fileName = conn.source?.file?.split('/').pop()?.replace('.ts', '') || '';
                  const displayName = fileName ? `${fileName}::${conn.name}` : conn.name;
                  return (
                    <ListItem key={conn.id} disablePadding>
                      <ListItemButton onClick={() => onNodeClick(conn.id)}>
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          <Box sx={{ color: getNodeColor(conn.type) }}>
                            {getNodeIcon(conn.type)}
                          </Box>
                        </ListItemIcon>
                        <ListItemText
                          primary={displayName}
                          secondary={conn.type}
                          primaryTypographyProps={{ variant: 'body2' }}
                          secondaryTypographyProps={{ variant: 'caption' }}
                        />
                      </ListItemButton>
                    </ListItem>
                  );
                })}
                {outgoingExitPoints.map((ep) => {
                  const isExternalMethod = !ep.linkedNodeId;
                  const content = (
                    <ListItem disablePadding>
                      <ListItemButton
                        disabled={isExternalMethod}
                        onClick={() => ep.linkedNodeId && onNodeClick(ep.linkedNodeId)}
                        sx={{ opacity: isExternalMethod ? 0.7 : 1 }}
                      >
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          <Storage fontSize="small" color="secondary" />
                        </ListItemIcon>
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <Typography variant="body2" component="span">
                                {ep.name}
                              </Typography>
                              {isExternalMethod && (
                                <Chip
                                  label={ep.library || 'External'}
                                  size="small"
                                  sx={{
                                    height: 16,
                                    fontSize: '0.6rem',
                                    bgcolor: ep.library ? 'info.50' : 'grey.200',
                                    color: ep.library ? 'info.main' : 'text.secondary',
                                    borderColor: ep.library ? 'info.200' : undefined,
                                    border: ep.library ? '1px solid' : undefined,
                                  }}
                                />
                              )}
                            </Stack>
                          }
                          secondary={
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <Typography variant="caption" component="span">
                                {ep.type}
                              </Typography>
                              {ep.repository && (
                                <Chip
                                  label={ep.repository}
                                  size="small"
                                  sx={{ height: 16, fontSize: '0.65rem' }}
                                  color="secondary"
                                  variant="outlined"
                                />
                              )}
                            </Stack>
                          }
                        />
                      </ListItemButton>
                    </ListItem>
                  );

                  if (isExternalMethod) {
                    const tooltipTitle = ep.library
                      ? `Inherited from ${ep.library} (not defined in codebase)`
                      : 'Method not defined in codebase (inherited from library)';
                    return (
                      <Tooltip
                        key={ep.id}
                        title={tooltipTitle}
                        placement="left"
                        arrow
                      >
                        <span>{content}</span>
                      </Tooltip>
                    );
                  }
                  return <React.Fragment key={ep.id}>{content}</React.Fragment>;
                })}
                {filteredOutgoingConnections.length === 0 && outgoingExitPoints.length === 0 && (
                  <ListItem>
                    <ListItemText
                      primary="No outgoing connections"
                      primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                    />
                  </ListItem>
                )}
              </List>
            </AccordionDetails>
          </Accordion>

          <Accordion defaultExpanded={incomingConnections.length > 0}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CallReceived fontSize="small" color="success" />
                <Typography variant="subtitle2">
                  Called By ({incomingConnections.length})
                </Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <List dense disablePadding>
                {incomingConnections.map((conn) => {
                  const fileName = conn.source?.file?.split('/').pop()?.replace('.ts', '') || '';
                  const displayName = fileName ? `${fileName}::${conn.name}` : conn.name;
                  return (
                    <ListItem key={conn.id} disablePadding>
                      <ListItemButton onClick={() => onNodeClick(conn.id)}>
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          <Box sx={{ color: getNodeColor(conn.type) }}>
                            {getNodeIcon(conn.type)}
                          </Box>
                        </ListItemIcon>
                        <ListItemText
                          primary={displayName}
                          secondary={conn.type}
                          primaryTypographyProps={{ variant: 'body2' }}
                          secondaryTypographyProps={{ variant: 'caption' }}
                        />
                      </ListItemButton>
                    </ListItem>
                  );
                })}
                {incomingConnections.length === 0 && (
                  <ListItem>
                    <ListItemText
                      primary="No incoming connections"
                      primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                    />
                  </ListItem>
                )}
              </List>
            </AccordionDetails>
          </Accordion>

          {callChains.length > 0 && (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Timeline fontSize="small" color="warning" />
                  <Typography variant="subtitle2">
                    Call Chains ({callChains.length})
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <List dense disablePadding>
                  {callChains.slice(0, 5).map((chain) => (
                    <ListItem key={chain.id}>
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body2">
                              {chain.entry_point.method_name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              →
                            </Typography>
                            <Typography variant="body2">
                              {chain.exit_point?.method_name || '(dead-end)'}
                            </Typography>
                          </Stack>
                        }
                        secondary={
                          <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                            <Chip
                              label={chain.chain_type}
                              size="small"
                              variant="outlined"
                              sx={{ fontSize: '0.65rem', height: 18 }}
                            />
                            <Chip
                              label={chain.risk_analysis.risk_level}
                              size="small"
                              color={
                                chain.risk_analysis.risk_level === 'critical'
                                  ? 'error'
                                  : chain.risk_analysis.risk_level === 'high'
                                  ? 'warning'
                                  : 'default'
                              }
                              sx={{ fontSize: '0.65rem', height: 18 }}
                            />
                          </Stack>
                        }
                      />
                    </ListItem>
                  ))}
                  {callChains.length > 5 && (
                    <ListItem>
                      <ListItemText
                        primary={`+${callChains.length - 5} more chains`}
                        primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                      />
                    </ListItem>
                  )}
                </List>
              </AccordionDetails>
            </Accordion>
          )}

          {node.tags && node.tags.length > 0 && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Tags
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {node.tags.map((tag) => (
                  <Chip key={tag} label={tag} size="small" variant="outlined" />
                ))}
              </Stack>
            </Box>
          )}

          {node.metadata && Object.keys(node.metadata).length > 0 && (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Typography variant="subtitle2">Raw Metadata</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 1,
                    maxHeight: 200,
                    overflow: 'auto',
                    bgcolor: 'grey.50',
                  }}
                >
                  <Typography
                    variant="caption"
                    component="pre"
                    sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
                  >
                    {JSON.stringify(node.metadata, null, 2)}
                  </Typography>
                </Paper>
              </AccordionDetails>
            </Accordion>
          )}
        </Stack>
      </Box>
    </Box>
  );
};
