import React, { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Chip,
  LinearProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Divider,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  Shield as ShieldIcon,
  Security as SecurityIcon,
  Warning as WarningIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  LockOpen as LockOpenIcon,
  VpnKey as VpnKeyIcon,
  VerifiedUser as VerifiedUserIcon,
  GppBad as GppBadIcon,
  GppMaybe as GppMaybeIcon,
} from '@mui/icons-material';
import type { CASOutput, CASSecurityBoundary, CASSecurityContext as SecurityContextType } from '../../../types/cas.types';

export interface SecurityBoundariesViewProps {
  data: CASOutput;
  onNodeSelect?: (nodeId: string) => void;
}

const boundaryTypeIcons: Record<string, React.ReactNode> = {
  'authentication': <VpnKeyIcon />,
  'authorization': <VerifiedUserIcon />,
  'input-validation': <ShieldIcon />,
  'output-encoding': <SecurityIcon />,
  'rate-limiting': <LockOpenIcon />,
  'encryption': <SecurityIcon />,
};

const confidenceColors: Record<string, 'success' | 'warning' | 'error'> = {
  'enforced': 'success',
  'assumed': 'warning',
  'missing': 'error',
};

const trustLevelColors: Record<string, string> = {
  'untrusted': '#f44336',
  'partially-trusted': '#ff9800',
  'trusted': '#4caf50',
};

export const SecurityBoundariesView: React.FC<SecurityBoundariesViewProps> = ({
  data,
  onNodeSelect,
}) => {
  const [expandedBoundary, setExpandedBoundary] = useState<string | false>(false);

  const boundaries = data.security_boundaries || [];
  const securityContexts = data.security_contexts || [];
  const summary = data.security_summary;

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

  const boundariesByType = useMemo(() => {
    const grouped = new Map<string, CASSecurityBoundary[]>();
    boundaries.forEach(boundary => {
      const existing = grouped.get(boundary.boundary_type) || [];
      existing.push(boundary);
      grouped.set(boundary.boundary_type, existing);
    });
    return grouped;
  }, [boundaries]);

  const unprotectedOps = summary?.unprotected_sensitive_ops || [];
  const assumedVsEnforced = summary?.assumed_vs_enforced;

  const protectionScore = useMemo(() => {
    if (!assumedVsEnforced) return null;
    const total = assumedVsEnforced.enforced + assumedVsEnforced.assumed + assumedVsEnforced.missing;
    if (total === 0) return null;
    return Math.round((assumedVsEnforced.enforced / total) * 100);
  }, [assumedVsEnforced]);

  const handleAccordionChange = (boundaryId: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedBoundary(isExpanded ? boundaryId : false);
  };

  if (boundaries.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          No security boundaries detected in this codebase. Security boundaries are inferred from
          authentication middleware, authorization guards, input validation, and encryption patterns.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <ShieldIcon sx={{ fontSize: 32, color: 'primary.main' }} />
        <Box>
          <Typography variant="h5">Security Boundaries</Typography>
          <Typography variant="body2" color="text.secondary">
            Trust boundaries, enforcement points, and protection status
          </Typography>
        </Box>
      </Box>

      {assumedVsEnforced && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle2" gutterBottom>Protection Status</Typography>
          <Box sx={{ display: 'flex', gap: 3, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CheckCircleIcon sx={{ color: 'success.main', fontSize: 20 }} />
              <Typography variant="body2">
                Enforced: <strong>{assumedVsEnforced.enforced}</strong>
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <WarningIcon sx={{ color: 'warning.main', fontSize: 20 }} />
              <Typography variant="body2">
                Assumed: <strong>{assumedVsEnforced.assumed}</strong>
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <ErrorIcon sx={{ color: 'error.main', fontSize: 20 }} />
              <Typography variant="body2">
                Missing: <strong>{assumedVsEnforced.missing}</strong>
              </Typography>
            </Box>
          </Box>
          {protectionScore !== null && (
            <Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption">Enforcement Score</Typography>
                <Typography variant="caption">{protectionScore}%</Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={protectionScore}
                color={protectionScore >= 80 ? 'success' : protectionScore >= 50 ? 'warning' : 'error'}
              />
            </Box>
          )}
        </Paper>
      )}

      {unprotectedOps.length > 0 && (
        <Alert severity="error" sx={{ mb: 3 }} icon={<GppBadIcon />}>
          <Typography variant="subtitle2" gutterBottom>
            {unprotectedOps.length} Unprotected Sensitive Operations
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {unprotectedOps.slice(0, 10).map(nodeId => (
              <Chip
                key={nodeId}
                label={getNodeName(nodeId)}
                size="small"
                color="error"
                variant="outlined"
                onClick={() => onNodeSelect?.(nodeId)}
                sx={{ cursor: 'pointer' }}
              />
            ))}
            {unprotectedOps.length > 10 && (
              <Chip label={`+${unprotectedOps.length - 10} more`} size="small" />
            )}
          </Box>
        </Alert>
      )}

      {Array.from(boundariesByType.entries()).map(([type, typeBoundaries]) => (
        <Box key={type} sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            {boundaryTypeIcons[type] || <ShieldIcon />}
            <Typography variant="h6" sx={{ textTransform: 'capitalize' }}>
              {type.replace(/-/g, ' ')}
            </Typography>
            <Chip label={typeBoundaries.length} size="small" color="primary" />
          </Box>

          {typeBoundaries.map(boundary => (
            <Accordion
              key={boundary.id}
              expanded={expandedBoundary === boundary.id}
              onChange={handleAccordionChange(boundary.id)}
              sx={{ mb: 1 }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                  <Typography sx={{ fontWeight: 500, flex: 1 }}>{boundary.name}</Typography>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Chip
                      size="small"
                      label={`${boundary.trust_transition.from_trust_level} -> ${boundary.trust_transition.to_trust_level}`}
                      sx={{
                        background: `linear-gradient(90deg, ${trustLevelColors[boundary.trust_transition.from_trust_level]} 0%, ${trustLevelColors[boundary.trust_transition.to_trust_level]} 100%)`,
                        color: 'white',
                      }}
                    />
                    <Chip
                      size="small"
                      label={`${boundary.enforcement_points.length} points`}
                      variant="outlined"
                    />
                  </Box>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="subtitle2" gutterBottom>Enforcement Points</Typography>
                <List dense>
                  {boundary.enforcement_points.map((point, idx) => (
                    <ListItem
                      key={idx}
                      onClick={() => onNodeSelect?.(point.node_id)}
                      sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                    >
                      <ListItemIcon>
                        {point.confidence === 'enforced' && <CheckCircleIcon color="success" />}
                        {point.confidence === 'assumed' && <GppMaybeIcon color="warning" />}
                        {point.confidence === 'missing' && <GppBadIcon color="error" />}
                      </ListItemIcon>
                      <ListItemText
                        primary={getNodeName(point.node_id)}
                        secondary={point.mechanism}
                      />
                      <Chip
                        size="small"
                        label={point.confidence}
                        color={confidenceColors[point.confidence]}
                      />
                    </ListItem>
                  ))}
                </List>

                {boundary.sensitive_operations.length > 0 && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2" gutterBottom>
                      Protected Sensitive Operations ({boundary.sensitive_operations.length})
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                      {boundary.sensitive_operations.map(nodeId => (
                        <Chip
                          key={nodeId}
                          label={getNodeName(nodeId)}
                          size="small"
                          variant="outlined"
                          onClick={() => onNodeSelect?.(nodeId)}
                          sx={{ cursor: 'pointer' }}
                        />
                      ))}
                    </Box>
                  </>
                )}

                {boundary.bypass_risks && boundary.bypass_risks.length > 0 && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <Alert severity="warning" icon={<WarningIcon />}>
                      <Typography variant="subtitle2" gutterBottom>Potential Bypass Risks</Typography>
                      <List dense>
                        {boundary.bypass_risks.map((risk, idx) => (
                          <ListItem key={idx} sx={{ py: 0 }}>
                            <ListItemText primary={risk} />
                          </ListItem>
                        ))}
                      </List>
                    </Alert>
                  </>
                )}
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      ))}

      {securityContexts.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="h6" gutterBottom>Security-Relevant Nodes</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Nodes that handle sensitive data or require security protection
          </Typography>

          {securityContexts
            .filter((ctx: SecurityContextType) => ctx.security_relevant)
            .slice(0, 20)
            .map((context: SecurityContextType) => (
              <Paper
                key={context.node_id}
                sx={{
                  p: 2,
                  mb: 1,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover' }
                }}
                onClick={() => onNodeSelect?.(context.node_id)}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Box>
                    <Typography variant="subtitle2">{getNodeName(context.node_id)}</Typography>
                    {context.security_relevance_reason && (
                      <Typography variant="body2" color="text.secondary">
                        {context.security_relevance_reason}
                      </Typography>
                    )}
                  </Box>
                  <Chip
                    size="small"
                    label={context.trust_level}
                    sx={{
                      bgcolor: trustLevelColors[context.trust_level],
                      color: 'white',
                    }}
                  />
                </Box>
                {context.protection_gaps && context.protection_gaps.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="error.main">
                      Missing protections: {context.protection_gaps.join(', ')}
                    </Typography>
                  </Box>
                )}
              </Paper>
            ))}
        </Box>
      )}
    </Box>
  );
};
