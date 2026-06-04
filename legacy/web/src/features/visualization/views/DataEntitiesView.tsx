import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Tabs,
  Tab,
  Badge,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  DataObject as DataObjectIcon,
  Add as AddIcon,
  Visibility as VisibilityIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Transform as TransformIcon,
  Lock as LockIcon,
  Warning as WarningIcon,
  CheckCircle as CheckCircleIcon,
  Rule as RuleIcon,
} from '@mui/icons-material';
import type { CASOutput, CASDataEntity } from '../../../types/cas.types';

export interface DataEntitiesViewProps {
  data: CASOutput;
  onNodeSelect?: (nodeId: string) => void;
}

const crudIcons = {
  created_by: <AddIcon sx={{ color: '#4caf50' }} />,
  read_by: <VisibilityIcon sx={{ color: '#2196f3' }} />,
  updated_by: <EditIcon sx={{ color: '#ff9800' }} />,
  deleted_by: <DeleteIcon sx={{ color: '#f44336' }} />,
};

const crudLabels = {
  created_by: 'Create',
  read_by: 'Read',
  updated_by: 'Update',
  deleted_by: 'Delete',
};

export const DataEntitiesView: React.FC<DataEntitiesViewProps> = ({
  data,
  onNodeSelect,
}) => {
  const [expandedEntity, setExpandedEntity] = useState<string | false>(false);
  const [activeTab, setActiveTab] = useState(0);

  const entities = data.data_entities || [];
  const summary = data.data_summary;

  const nodeMap = useMemo(() => {
    const map = new Map<string, { name: string; file?: string }>();
    data.nodes?.forEach(node => {
      map.set(node.id, { name: node.name, file: node.source?.file });
    });
    return map;
  }, [data.nodes]);

  const getNodeName = (nodeId: string) => {
    const node = nodeMap.get(nodeId);
    return node?.name || nodeId;
  };

  const sensitiveEntities = useMemo(() =>
    entities.filter(e => e.fields?.some(f => f.is_sensitive)),
    [entities]
  );

  const validationGaps = summary?.validation_gaps || [];
  const sensitiveDataNodes = summary?.sensitive_data_nodes || [];

  const handleAccordionChange = (entityId: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedEntity(isExpanded ? entityId : false);
  };

  if (entities.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          No data entities detected. Data entities are inferred from database models, ORM definitions,
          schema files, and type definitions that represent domain objects.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <DataObjectIcon sx={{ fontSize: 32, color: 'primary.main' }} />
        <Box>
          <Typography variant="h5">Data Entities</Typography>
          <Typography variant="body2" color="text.secondary">
            Domain objects, their lifecycle, and data flow through the system
          </Typography>
        </Box>
      </Box>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 3 }}>
          <Box>
            <Typography variant="h4">{entities.length}</Typography>
            <Typography variant="body2" color="text.secondary">Total Entities</Typography>
          </Box>
          <Divider orientation="vertical" flexItem />
          <Box>
            <Typography variant="h4" color="warning.main">{sensitiveEntities.length}</Typography>
            <Typography variant="body2" color="text.secondary">With Sensitive Data</Typography>
          </Box>
          <Divider orientation="vertical" flexItem />
          <Box>
            <Typography variant="h4" color="error.main">{validationGaps.length}</Typography>
            <Typography variant="body2" color="text.secondary">Validation Gaps</Typography>
          </Box>
        </Box>
      </Paper>

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="All Entities" />
          <Tab
            label={
              <Badge badgeContent={sensitiveEntities.length} color="warning">
                <Box sx={{ pr: 2 }}>Sensitive Data</Box>
              </Badge>
            }
          />
          <Tab
            label={
              <Badge badgeContent={validationGaps.length} color="error">
                <Box sx={{ pr: 2 }}>Validation Gaps</Box>
              </Badge>
            }
          />
        </Tabs>
      </Box>

      {activeTab === 0 && (
        <Box>
          {entities.map(entity => (
            <Accordion
              key={entity.id}
              expanded={expandedEntity === entity.id}
              onChange={handleAccordionChange(entity.id)}
              sx={{ mb: 1 }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                  <DataObjectIcon color="primary" />
                  <Typography sx={{ fontWeight: 500, flex: 1 }}>{entity.name}</Typography>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    {entity.fields?.some(f => f.is_sensitive) && (
                      <Chip
                        size="small"
                        icon={<LockIcon />}
                        label="Sensitive"
                        color="warning"
                      />
                    )}
                    {entity.fields && (
                      <Chip
                        size="small"
                        label={`${entity.fields.length} fields`}
                        variant="outlined"
                      />
                    )}
                  </Box>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {entity.schema_source && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                    Source: {entity.schema_source}
                  </Typography>
                )}

                {entity.fields && entity.fields.length > 0 && (
                  <>
                    <Typography variant="subtitle2" gutterBottom>Fields</Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                      {entity.fields.map((field, idx) => (
                        <Chip
                          key={idx}
                          label={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              {field.is_sensitive && <LockIcon sx={{ fontSize: 14 }} />}
                              <span>{field.name}</span>
                              <Typography component="span" variant="caption" color="text.secondary">
                                : {field.type}
                              </Typography>
                            </Box>
                          }
                          variant={field.is_sensitive ? 'filled' : 'outlined'}
                          color={field.is_sensitive ? 'warning' : 'default'}
                          size="small"
                        />
                      ))}
                    </Box>
                  </>
                )}

                <Typography variant="subtitle2" gutterBottom>Lifecycle Operations</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 2, mb: 2 }}>
                  {(['created_by', 'read_by', 'updated_by', 'deleted_by'] as const).map(operation => {
                    const nodes = entity.lifecycle[operation];
                    if (nodes.length === 0) return null;

                    return (
                      <Paper key={operation} variant="outlined" sx={{ p: 1.5 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                          {crudIcons[operation]}
                          <Typography variant="subtitle2">{crudLabels[operation]}</Typography>
                          <Chip label={nodes.length} size="small" />
                        </Box>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {nodes.slice(0, 5).map(nodeId => (
                            <Chip
                              key={nodeId}
                              label={getNodeName(nodeId)}
                              size="small"
                              variant="outlined"
                              onClick={() => onNodeSelect?.(nodeId)}
                              sx={{ cursor: 'pointer' }}
                            />
                          ))}
                          {nodes.length > 5 && (
                            <Chip label={`+${nodes.length - 5}`} size="small" />
                          )}
                        </Box>
                      </Paper>
                    );
                  })}
                </Box>

                {entity.transformations && entity.transformations.length > 0 && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2" gutterBottom>
                      <TransformIcon sx={{ fontSize: 16, mr: 0.5, verticalAlign: 'middle' }} />
                      Transformations
                    </Typography>
                    <List dense>
                      {entity.transformations.map((transform, idx) => (
                        <ListItem key={idx}>
                          <ListItemText
                            primary={
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Chip
                                  label={getNodeName(transform.from_node)}
                                  size="small"
                                  onClick={() => onNodeSelect?.(transform.from_node)}
                                  sx={{ cursor: 'pointer' }}
                                />
                                <Typography variant="body2">-&gt;</Typography>
                                <Chip
                                  label={transform.transformation_type}
                                  size="small"
                                  color="info"
                                />
                                <Typography variant="body2">-&gt;</Typography>
                                <Chip
                                  label={getNodeName(transform.to_node)}
                                  size="small"
                                  onClick={() => onNodeSelect?.(transform.to_node)}
                                  sx={{ cursor: 'pointer' }}
                                />
                              </Box>
                            }
                          />
                        </ListItem>
                      ))}
                    </List>
                  </>
                )}

                {entity.invariants && entity.invariants.length > 0 && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2" gutterBottom>
                      <RuleIcon sx={{ fontSize: 16, mr: 0.5, verticalAlign: 'middle' }} />
                      Data Invariants
                    </Typography>
                    <List dense>
                      {entity.invariants.map((invariant, idx) => (
                        <ListItem key={idx}>
                          <ListItemIcon>
                            <CheckCircleIcon color="success" fontSize="small" />
                          </ListItemIcon>
                          <ListItemText
                            primary={invariant.description}
                            secondary={
                              <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
                                <Chip label={invariant.source} size="small" variant="outlined" />
                                {invariant.enforced_by.slice(0, 3).map(nodeId => (
                                  <Chip
                                    key={nodeId}
                                    label={getNodeName(nodeId)}
                                    size="small"
                                    onClick={() => onNodeSelect?.(nodeId)}
                                    sx={{ cursor: 'pointer' }}
                                  />
                                ))}
                              </Box>
                            }
                          />
                        </ListItem>
                      ))}
                    </List>
                  </>
                )}
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}

      {activeTab === 1 && (
        <Box>
          <Alert severity="warning" sx={{ mb: 2 }}>
            These entities contain sensitive fields (PII, credentials, tokens) that require special handling.
          </Alert>
          {sensitiveEntities.length === 0 ? (
            <Typography color="text.secondary">No entities with sensitive data detected</Typography>
          ) : (
            sensitiveEntities.map(entity => {
              const sensitiveFields = entity.fields?.filter(f => f.is_sensitive) || [];
              return (
                <Paper key={entity.id} sx={{ p: 2, mb: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <LockIcon color="warning" />
                    <Typography variant="subtitle1">{entity.name}</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Sensitive Fields:
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {sensitiveFields.map((field, idx) => (
                      <Chip
                        key={idx}
                        label={`${field.name}: ${field.type}`}
                        size="small"
                        color="warning"
                      />
                    ))}
                  </Box>
                </Paper>
              );
            })
          )}

          {sensitiveDataNodes.length > 0 && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" gutterBottom>
                Nodes Handling Sensitive Data ({sensitiveDataNodes.length})
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {sensitiveDataNodes.slice(0, 20).map(nodeId => (
                  <Chip
                    key={nodeId}
                    label={getNodeName(nodeId)}
                    size="small"
                    color="warning"
                    variant="outlined"
                    onClick={() => onNodeSelect?.(nodeId)}
                    sx={{ cursor: 'pointer' }}
                  />
                ))}
                {sensitiveDataNodes.length > 20 && (
                  <Chip label={`+${sensitiveDataNodes.length - 20} more`} size="small" />
                )}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {activeTab === 2 && (
        <Box>
          <Alert severity="error" sx={{ mb: 2 }}>
            These entities have missing or incomplete validation that could lead to data integrity issues.
          </Alert>
          {validationGaps.length === 0 ? (
            <Typography color="text.secondary">No validation gaps detected</Typography>
          ) : (
            validationGaps.map((gap, idx) => {
              const entity = entities.find(e => e.id === gap.entity_id);
              return (
                <Paper key={idx} sx={{ p: 2, mb: 1, borderLeft: '4px solid #f44336' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <WarningIcon color="error" fontSize="small" />
                    <Typography variant="subtitle2">{entity?.name || gap.entity_id}</Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Missing: {gap.missing_validation}
                  </Typography>
                </Paper>
              );
            })
          )}
        </Box>
      )}
    </Box>
  );
};
