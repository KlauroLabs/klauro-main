import { useNavigate } from 'react-router-dom';
import { Box, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import type { FlowConcept } from '../../api';
import { FlowRoleBadge } from './FlowRoleBadge';
import { entryKindFromFlow, linkedCapabilityCount } from './flowFormat';
import { EntryKindIcon } from '../../components/EntryKindIcon';
import { KIND_META } from '../../components/entryPointKinds';
import { encodeSlug } from '../../lib/slugs';

/**
 * The Flow List table (Figma node 2030:31178, "Table"). Columns match the
 * design 1:1: NAME, TYPE, CAPABILITIES, # OF STEPS, AVG. USER / MONTH,
 * AVG. BUGS / MONTH, EXECUTION TIME, then a trailing row-action column.
 * The last three metric columns have no backing data yet in FlowConcept —
 * rendered as an honest "—" per LANE-COMMON's DESIGN FIDELITY RULE rather
 * than omitted; see apps/app/docs/DESIGN-NOTES.md, "page-flows lane".
 */
export function FlowTable({ flows, projectId }: { flows: FlowConcept[]; projectId: string }) {
  const navigate = useNavigate();

  if (flows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No flows match the current filters.
      </Typography>
    );
  }

  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          Flows
          <Box component="span" sx={{ bgcolor: 'action.hover', borderRadius: 4, px: 1, fontSize: 12, fontWeight: 600 }}>
            {flows.length}
          </Box>
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Capabilities</TableCell>
              <TableCell># of steps</TableCell>
              <TableCell>
                <Tooltip title="Not tracked yet — see DESIGN-NOTES.md">
                  <span>Avg. user / month</span>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Tooltip title="Not tracked yet — see DESIGN-NOTES.md">
                  <span>Avg. bugs / month</span>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Tooltip title="Not tracked yet — see DESIGN-NOTES.md">
                  <span>Execution time</span>
                </Tooltip>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {flows.map(flow => {
              const kind = entryKindFromFlow(flow);
              return (
                <TableRow
                  key={flow.flow_id}
                  hover
                  onClick={() => navigate(`/codebases/${projectId}/flows/${encodeSlug({ id: flow.flow_id, name: flow.name })}`)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {kind ? (
                        <Tooltip title={KIND_META[kind].label}>
                          <span style={{ display: 'inline-flex' }}>
                            <EntryKindIcon kind={kind} size={16} />
                          </span>
                        </Tooltip>
                      ) : null}
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {flow.name}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <FlowRoleBadge role={flow.role} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{linkedCapabilityCount(flow)} linked</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{flow.steps.length}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.disabled">—</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.disabled">—</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.disabled">—</Typography>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
