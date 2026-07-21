// "System Complexity" card (Figma node 1748:6595, frame "Frame 1597881800":
// title+subtitle, a radial icon, "Complexity Score X/100", "Trend Y% vs last
// 30 days", "View Analysis ->" link). No field in the served WAS graph
// computes a complexity score or trend delta — built as the exact card shell
// with an honest empty state in place of the metric. See DESIGN-NOTES.md.
import { Box, Stack, Typography } from '@mui/material';
import { EmptyState } from '../../layout/EmptyState';
import { SystemComplexityGlyph } from '../../components/icons/SystemComplexityGlyph';

export function SystemComplexityCard() {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 4 }}>
      <Stack spacing={3}>
        <Stack spacing={0.5}>
          <Typography variant="h6" component="h2">
            System Complexity
          </Typography>
          <Typography variant="body2" color="text.secondary">
            How complex is your System
          </Typography>
        </Stack>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
          <SystemComplexityGlyph size={72} />
          <EmptyState title="Not computed yet" description="A workspace-level complexity score isn't produced by the current analysis." />
        </Stack>
      </Stack>
    </Box>
  );
}
