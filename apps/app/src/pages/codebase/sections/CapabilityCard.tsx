// One capability card (Figma "Repo overview" section 01, node 1647:37723):
// icon, name, description, "N flows" + "N Entities" metrics. Colors here are
// a fixed rotating decorative palette (Figma assigns a distinct accent per
// card with no visible data mapping — see apps/app/docs/DESIGN-NOTES.md).
import { Box, Stack, Typography } from '@mui/material';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined';
import SpeedOutlinedIcon from '@mui/icons-material/SpeedOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import FindInPageOutlinedIcon from '@mui/icons-material/FindInPageOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import type { MergedCapability } from '../casSummary';

const iconCycle = [HubOutlinedIcon, BoltOutlinedIcon, PaidOutlinedIcon, SpeedOutlinedIcon, BarChartOutlinedIcon, FindInPageOutlinedIcon];
const accentCycle = ['#FF9800', '#59B6F9', '#B1E94B', '#9F86FF', '#87F1D4', '#168F42'];

export function CapabilityCard({ capability, index }: { capability: MergedCapability; index: number }) {
  const Icon = iconCycle[index % iconCycle.length];
  const accent = accentCycle[index % accentCycle.length];
  return (
    <Stack spacing={2} sx={{ p: 4, height: '100%' }}>
      <Stack spacing={2}>
        <Box sx={{ display: 'inline-flex', p: 1, borderRadius: 1, border: '0.5px solid', borderColor: `${accent}80` }}>
          <Icon sx={{ fontSize: 20, color: accent }} />
        </Box>
        <Typography variant="h3">{capability.name}</Typography>
      </Stack>
      <Stack spacing={3}>
        <Typography variant="body2" color="text.secondary" sx={{ minHeight: 44 }}>
          {capability.description || 'No description available yet.'}
        </Typography>
        <Stack direction="row" spacing={2}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <AccountTreeOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.primary">{capability.flowCount ?? '—'}</Typography>
            <Typography variant="caption" color="text.disabled">flows</Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StorageOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.primary">{capability.entityCount ?? '—'}</Typography>
            <Typography variant="caption" color="text.disabled">Entities</Typography>
          </Stack>
        </Stack>
      </Stack>
    </Stack>
  );
}
