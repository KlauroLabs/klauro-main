import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Typography, Chip, Box, TablePagination,
} from '@mui/material';
import type { CasNode } from '../../hooks/useFileNodes';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

/**
 * The node catalog table — data realities from docs/briefs/functions.md:
 * counts run 800 to 47,000+ per codebase, so this ONLY ever renders one
 * page of rows (client-side paging, page-size selectable), never the full
 * filtered set at once. Mirrors EntryPointTable's precedent exactly (no
 * virtualization dependency is present in this app yet — a future lane
 * adding one can drop it in here without changing the row shape).
 */
export function NodeList({ nodes, projectId }: { nodes: CasNode[]; projectId: string }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  if (nodes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No nodes match the current filters.
      </Typography>
    );
  }

  const start = page * pageSize;
  const rows = nodes.slice(start, start + pageSize);

  return (
    <Paper variant="outlined">
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>File : line</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(node => (
              <TableRow
                key={node.id}
                hover
                onClick={() => navigate(`/codebases/${projectId}/functions/${encodeURIComponent(node.id)}`)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell>
                  <Typography variant="body2" component="code" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
                    {node.name}
                  </Typography>
                  {node.description ? (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 420 }}>
                      {node.description}
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Chip size="small" variant="outlined" label={node.type} />
                </TableCell>
                <TableCell>
                  <Typography variant="body2" component="code" sx={{ fontFamily: 'monospace' }} noWrap>
                    {node.source?.file ?? '—'}
                    {node.source?.line ? `:${node.source.line}` : ''}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
        <TablePagination
          component="div"
          count={nodes.length}
          page={page}
          onPageChange={(_e, next) => setPage(next)}
          rowsPerPage={pageSize}
          rowsPerPageOptions={PAGE_SIZE_OPTIONS}
          onRowsPerPageChange={e => {
            setPageSize(parseInt(e.target.value, 10));
            setPage(0);
          }}
        />
      </Box>
    </Paper>
  );
}
