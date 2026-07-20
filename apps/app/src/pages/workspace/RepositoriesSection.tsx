// "Repositories" section (Figma node 1748:6595, "Frame 1597881514" header +
// "Frame 1597881840" card grid): title+subtitle, Tags/Sort filter badges, an
// Add ("+") button, then the repository card grid. The Add button opens
// AttachProjectDialog — the brief's attach-project flow lives here since
// Figma shows no other add/attach affordance on this screen.
import { useMemo, useState } from 'react';
import { Chip, Grid, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import LayersOutlined from '@mui/icons-material/LayersOutlined';
import SwapHorizOutlined from '@mui/icons-material/SwapHorizOutlined';
import AddIcon from '@mui/icons-material/Add';
import { EmptyState } from '../../layout/EmptyState';
import { RepositoryCard } from './RepositoryCard';
import { AttachProjectDialog } from './AttachProjectDialog';
import {
  contributorsForProject,
  inputForCodebase,
  projectIdFromCodebasePath,
  type WorkspaceContributor,
  type WorkspaceInputRef,
} from './workspaceHelpers';
import type { WorkspaceAnalysisResponse } from '../../api';

type Codebase = NonNullable<NonNullable<WorkspaceAnalysisResponse['analysis']>['codebases']>[number];

export interface RepositoriesSectionProps {
  workspaceId: string;
  codebases: Codebase[];
  inputs: WorkspaceInputRef[];
  contributors: WorkspaceContributor[];
  memberProjectIds: string[];
}

type SortKey = 'name' | 'last-analyzed';

export function RepositoriesSection({ workspaceId, codebases, inputs, contributors, memberProjectIds }: RepositoriesSectionProps) {
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [tagsMenuAnchor, setTagsMenuAnchor] = useState<HTMLElement | null>(null);
  const [sortMenuAnchor, setSortMenuAnchor] = useState<HTMLElement | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const codebase of codebases) {
      for (const tag of [...(codebase.languages ?? []), ...(codebase.frameworks ?? [])]) set.add(tag);
    }
    return Array.from(set).sort();
  }, [codebases]);

  const rows = useMemo(() => {
    const filtered = tagFilter
      ? codebases.filter(codebase => [...(codebase.languages ?? []), ...(codebase.frameworks ?? [])].includes(tagFilter))
      : codebases;
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'name') return (a.name ?? '').localeCompare(b.name ?? '');
      const inputA = inputForCodebase(inputs, a.id)?.cas_generated_at ?? '';
      const inputB = inputForCodebase(inputs, b.id)?.cas_generated_at ?? '';
      return inputB.localeCompare(inputA);
    });
    return sorted;
  }, [codebases, tagFilter, sortKey, inputs]);

  return (
    <Stack spacing={3}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <LayersOutlined fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="h6" component="h2">
            Repositories
          </Typography>
          <Typography variant="body2" color="text.secondary">
            External services this system relies on
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Chip
            size="small"
            variant="outlined"
            icon={<span style={{ display: 'flex' }}>🏷</span>}
            label={tagFilter ?? 'Tags'}
            onClick={event => setTagsMenuAnchor(event.currentTarget)}
            onDelete={tagFilter ? () => setTagFilter(null) : undefined}
          />
          <Menu anchorEl={tagsMenuAnchor} open={Boolean(tagsMenuAnchor)} onClose={() => setTagsMenuAnchor(null)}>
            {allTags.length === 0 ? (
              <MenuItem disabled>No tags yet</MenuItem>
            ) : (
              allTags.map(tag => (
                <MenuItem key={tag} selected={tag === tagFilter} onClick={() => { setTagFilter(tag); setTagsMenuAnchor(null); }}>
                  {tag}
                </MenuItem>
              ))
            )}
          </Menu>

          <Chip
            size="small"
            variant="outlined"
            icon={<SwapHorizOutlined fontSize="small" />}
            label={sortKey === 'name' ? 'Sort: Name' : 'Sort: Last analyzed'}
            onClick={event => setSortMenuAnchor(event.currentTarget)}
          />
          <Menu anchorEl={sortMenuAnchor} open={Boolean(sortMenuAnchor)} onClose={() => setSortMenuAnchor(null)}>
            <MenuItem selected={sortKey === 'name'} onClick={() => { setSortKey('name'); setSortMenuAnchor(null); }}>Name</MenuItem>
            <MenuItem selected={sortKey === 'last-analyzed'} onClick={() => { setSortKey('last-analyzed'); setSortMenuAnchor(null); }}>Last analyzed</MenuItem>
          </Menu>

          <Tooltip title="Add a repository">
            <IconButton size="small" color="primary" sx={{ border: 1, borderColor: 'primary.main' }} onClick={() => setAttachOpen(true)}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {rows.length === 0 ? (
        <EmptyState title="No repositories yet" description="Attach a project to this workspace to see it here." />
      ) : (
        <Grid container spacing={3}>
          {rows.map(codebase => {
            const projectId = projectIdFromCodebasePath(codebase.path);
            const input = inputForCodebase(inputs, codebase.id);
            return (
              <Grid key={codebase.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <RepositoryCard
                  name={codebase.name ?? codebase.id}
                  projectId={projectId}
                  tags={[...(codebase.languages ?? []), ...(codebase.frameworks ?? [])]}
                  input={input}
                  contributors={contributorsForProject(contributors, projectId)}
                />
              </Grid>
            );
          })}
        </Grid>
      )}

      <AttachProjectDialog
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        workspaceId={workspaceId}
        currentMemberProjectIds={memberProjectIds}
      />
    </Stack>
  );
}
