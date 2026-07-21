import { Box, Stack, Typography } from '@mui/material';
import { DecorativeStatIcon, type DecorativeStat } from '@/shared/components/icons/DecorativeStatIcon';

export function humanizeAge(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days < 0) return undefined;
  if (days < 1) return '<1d';
  if (days < 60) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

interface StatCardProps {
  label: string;
  value: string;
  caption: string;
  stat: DecorativeStat;
}

function StatCard({ label, value, caption, stat }: StatCardProps) {
  return (
    <Stack
      direction="row"
      sx={{
        flex: 1,
        height: 60,
        px: 3,
        border: '0.5px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <Stack spacing={0.25}>
        <Typography variant="caption" color="text.disabled">{label}</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
          <Typography variant="body2" color="text.primary">{value}</Typography>
          <Typography variant="caption" color="text.disabled">{caption}</Typography>
        </Stack>
      </Stack>
      <DecorativeStatIcon stat={stat} size={28} />
    </Stack>
  );
}

export interface CodebaseStatsProps {
  capabilityCount?: number;
  entryPointCount?: number;
  totalFiles?: number;
  contributorCount?: number;
  firstCommitAt?: string;
}

export function CodebaseStats({ capabilityCount, entryPointCount, totalFiles, contributorCount, firstCommitAt }: CodebaseStatsProps) {
  const age = humanizeAge(firstCommitAt);
  return (
    <Box sx={{ mb: 4 }}>
      <Stack direction="row" spacing={3}>
        <StatCard
          label="Capabilities"
          value={capabilityCount !== undefined ? String(capabilityCount) : '—'}
          caption="Core business domains"
          stat="capabilities"
        />
        <StatCard
          label="Entry points"
          value={entryPointCount !== undefined ? String(entryPointCount) : '—'}
          caption="HTTP + event triggers"
          stat="entryPoints"
        />
        <StatCard
          label="Contributors"
          value={contributorCount !== undefined ? String(contributorCount) : '—'}
          caption="From commit history"
          stat="contributors"
        />
        <StatCard
          label="Codebase age"
          value={age ?? '—'}
          caption={totalFiles !== undefined ? `${totalFiles} files` : 'Not available yet'}
          stat="age"
        />
      </Stack>
    </Box>
  );
}
