import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Typography, Stack, TablePagination, Box,
} from '@mui/material';
import { EvidenceKindBadge } from '../../components/entities/EvidenceKindBadge';
import type { DataEntity } from '../../hooks/useEntities';
import { encodeSlug } from '../../lib/slugs';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

/**
 * The catalog table — name, field count, evidence kind, readers/writers.
 * Client-side paging mirrors the entry-points lane's EntryPointTable
 * convention (same reasoning: no virtualization dependency in this app yet).
 * Derived layout (no Figma frame) — see docs/DESIGN-NOTES.md and
 * docs/briefs/entities.md; mirrors the Flow List screen's bordered table
 * card with a header row and per-row click-into-detail.
 */
export function EntityTable({ entities, projectId }: { entities: DataEntity[]; projectId: string }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  if (entities.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No entities match the current filters.
      </Typography>
    );
  }

  const start = page * pageSize;
  const rows = entities.slice(start, start + pageSize);

  return (
    <Paper variant="outlined">
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Fields</TableCell>
              <TableCell>Evidence kind</TableCell>
              <TableCell>Readers / writers</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(entity => {
              const readers = entity.lifecycle.read_by.length;
              const writers = entity.lifecycle.created_by.length + entity.lifecycle.updated_by.length + entity.lifecycle.deleted_by.length;
              return (
                <TableRow
                  key={entity.id}
                  hover
                  onClick={() => navigate(`/codebases/${projectId}/entities/${encodeSlug({ id: entity.id, name: entity.name })}`)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{entity.name}</Typography>
                    {entity.schema_source ? (
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 420, fontFamily: 'monospace' }}>
                        {entity.schema_source}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{entity.fields?.length ?? 0}</Typography>
                  </TableCell>
                  <TableCell>
                    <EvidenceKindBadge kind={entity.kind} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      <Typography variant="body2" color="text.secondary">{readers} readers</Typography>
                      <Typography variant="body2" color="text.secondary">·</Typography>
                      <Typography variant="body2" color="text.secondary">{writers} writers</Typography>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
        <TablePagination
          component="div"
          count={entities.length}
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
