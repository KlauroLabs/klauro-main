// The 4-card stat row directly under the header (Figma "Repo overview",
// frame 1647:40214): Capabilities / Entry points / Contributors / Codebase
// age. Contributors and codebase-age have no live data source yet (see
// apps/app/docs/DESIGN-NOTES.md) — built with an honest "—" value rather
// than invented numbers, per LANE-COMMON's DESIGN FIDELITY RULE.
import { Box, Stack, Typography } from '@mui/material';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import type { SvgIconComponent } from '@mui/icons-material';

interface StatCardProps {
  label: string;
  value: string;
  caption: string;
  icon: SvgIconComponent;
}

function StatCard({ label, value, caption, icon: Icon }: StatCardProps) {
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
      <Icon sx={{ color: 'text.disabled', fontSize: 28 }} />
    </Stack>
  );
}

export interface CodebaseStatsProps {
  capabilityCount?: number;
  entryPointCount?: number;
  totalFiles?: number;
}

export function CodebaseStats({ capabilityCount, entryPointCount, totalFiles }: CodebaseStatsProps) {
  return (
    <Box sx={{ mb: 4 }}>
      <Stack direction="row" spacing={3}>
        <StatCard
          label="Capabilities"
          value={capabilityCount !== undefined ? String(capabilityCount) : '—'}
          caption="Core business domains"
          icon={HubOutlinedIcon}
        />
        <StatCard
          label="Entry points"
          value={entryPointCount !== undefined ? String(entryPointCount) : '—'}
          caption="HTTP + event triggers"
          icon={CodeOutlinedIcon}
        />
        <StatCard
          label="Contributors"
          value="—"
          caption="Not available yet"
          icon={GroupOutlinedIcon}
        />
        <StatCard
          label="Codebase age"
          value="—"
          caption={totalFiles !== undefined ? `${totalFiles} files` : 'Not available yet'}
          icon={HistoryOutlinedIcon}
        />
      </Stack>
    </Box>
  );
}
