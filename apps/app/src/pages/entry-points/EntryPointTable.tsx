import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Typography, Chip, Stack, TablePagination, Box,
} from '@mui/material';
import { EntryKindIcon } from '../../components/EntryKindIcon';
import { KIND_META, isKnownKind } from '../../components/entryPointKinds';
import type { EntryPoint } from '../../hooks/useEntryPoints';
import { formatTrigger, looksLikeRawToken, securityLabel } from './formatEntryPoint';
import { encodeSlug } from '../../lib/slugs';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

/**
 * The catalog table. Data realities from the brief: counts run a dozen to
 * 2000+, extremely lopsided by kind, and no virtualization library is
 * present in this app yet (package.json has no react-window/react-virtual)
 * — so this pages honestly (client-side, page-size selectable) rather than
 * rendering every row or silently truncating. A future lane adding a
 * virtualization dependency can drop it in here without changing the row
 * shape.
 *
 * Derived layout (see DESIGN-NOTES.md): mirrors the Flow List screen's
 * bordered table card with a header row and per-row chevron-into-detail.
 */
export function EntryPointTable({ entryPoints, projectId }: { entryPoints: EntryPoint[]; projectId: string }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  if (entryPoints.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No entry points match the current filters.
      </Typography>
    );
  }

  const start = page * pageSize;
  const rows = entryPoints.slice(start, start + pageSize);

  return (
    <Paper variant="outlined">
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Kind</TableCell>
              <TableCell>Address</TableCell>
              <TableCell>Security</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(ep => {
              const trigger = formatTrigger(ep);
              const security = securityLabel(ep);
              return (
                <TableRow
                  key={ep.id}
                  hover
                  onClick={() => navigate(`/codebases/${projectId}/entry-points/${encodeSlug({ id: ep.id, name: ep.name })}`)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {ep.name}
                    </Typography>
                    {ep.description && !looksLikeRawToken(ep.name) ? (
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 360 }}>
                        {ep.description}
                      </Typography>
                    ) : null}
                    {looksLikeRawToken(ep.name) && ep.description ? (
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 360 }}>
                        {ep.description}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      {isKnownKind(ep.type) ? (
                        <>
                          <EntryKindIcon kind={ep.type} size={16} />
                          <Typography variant="body2">{KIND_META[ep.type].label}</Typography>
                        </>
                      ) : (
                        <Typography variant="body2">{ep.type}</Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" component="code" sx={{ fontFamily: 'monospace' }}>
                      {trigger ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={security.open ? 'default' : 'success'}
                      label={security.label}
                    />
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
          count={entryPoints.length}
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
