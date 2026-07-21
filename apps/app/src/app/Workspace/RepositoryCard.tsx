import { Avatar, AvatarGroup, Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import { Link as RouterLink } from 'react-router-dom';
import { formatRelativeTime } from '@/app/Dashboard/formatRelativeTime';
import { initials, type WorkspaceContributor, type WorkspaceInputRef } from './workspaceHelpers';
import { StatGlyphIcon } from '@/shared/components/icons/StatGlyphIcon';
import { stackTagColor } from './stackTagColor';
import { encodeSlug } from '@/shared/lib/slugs';

export interface RepositoryCardProps {
  name: string;
  projectId?: string;
  tags: string[];
  input?: WorkspaceInputRef;
  contributors: WorkspaceContributor[];
}

export function RepositoryCard({ name, projectId, tags, input, contributors }: RepositoryCardProps) {
  const relative = formatRelativeTime(input?.cas_generated_at);
  const projectSlug = projectId ? encodeSlug({ id: projectId, name }) : undefined;
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 36, height: 36, borderRadius: 1, border: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <StatGlyphIcon glyph="repositories" size={20} />
          </Box>
          <Typography variant="h6" component="h3">
            {name}
          </Typography>
        </Stack>
        <Tooltip title={projectId ? 'Open codebase' : 'No codebase page linked yet'}>
          <span>
            {projectSlug ? (
              <IconButton
                component={RouterLink}
                to={`/codebases/${projectSlug}`}
                size="small"
                sx={{ border: 1, borderColor: 'divider' }}
                aria-label={`Open ${name}`}
              >
                <ArrowOutwardIcon fontSize="small" />
              </IconButton>
            ) : (
              <IconButton disabled size="small" sx={{ border: 1, borderColor: 'divider' }} aria-label={`Open ${name}`}>
                <ArrowOutwardIcon fontSize="small" />
              </IconButton>
            )}
          </span>
        </Tooltip>
      </Stack>

      {tags.length === 0 ? (
        <Typography variant="body2" color="text.disabled">
          No stack summary yet.
        </Typography>
      ) : null}

      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {tags.slice(0, 4).map(tag => {
          const color = stackTagColor(tag);
          return (
            <Chip
              key={tag}
              size="small"
              label={tag}
              sx={{ bgcolor: color.bg, color: color.fg, fontWeight: 600 }}
            />
          );
        })}
      </Stack>

      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2, mt: 'auto' }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              Assignees
            </Typography>
            {contributors.length === 0 ? (
              <Typography variant="caption" color="text.disabled">
                None attributed yet
              </Typography>
            ) : (
              <AvatarGroup max={4} sx={{ justifyContent: 'flex-start', '& .MuiAvatar-root': { width: 28, height: 28, fontSize: 11 } }}>
                {contributors.map(contributor => (
                  <Tooltip key={contributor.name} title={contributor.name}>
                    <Avatar>{initials(contributor.name)}</Avatar>
                  </Tooltip>
                ))}
              </AvatarGroup>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {relative ? `Last analyzed - ${relative}` : 'Last analyzed - unknown'}
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
}
