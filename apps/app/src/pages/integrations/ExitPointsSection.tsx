import { Accordion, AccordionSummary, AccordionDetails, Typography, Chip, Stack, Box } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { EXIT_FAMILIES } from './exitPointFamilies';
import { FamilyExitList } from './FamilyExitList';
import type { ExitFamilyGroup } from '../../hooks/useExitPoints';

/**
 * Exit points grouped by family — the full section (page-entry-points
 * renders only a compact mirror summary via the shared ExitPointList; this
 * lane owns the complete view). Families with zero members for this
 * codebase simply don't render, same discipline as the entry-points family
 * mix ("a kind with zero entries... simply doesn't render, it is never a
 * surprise").
 */
export function ExitPointsSection({ familyGroups, projectId }: { familyGroups: ExitFamilyGroup[]; projectId: string }) {
  if (familyGroups.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No exit points reach outside this codebase — a real, common case for a pure library.
      </Typography>
    );
  }

  const total = familyGroups.reduce((sum, g) => sum + g.count, 0);

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
        {familyGroups.map(group => (
          <Chip
            key={group.family}
            size="small"
            variant="outlined"
            label={`${EXIT_FAMILIES[group.family].label} · ${group.count}`}
          />
        ))}
        <Chip size="small" label={`${total} total`} />
      </Stack>

      {familyGroups.map(group => {
        const meta = EXIT_FAMILIES[group.family];
        return (
          <Accordion key={group.family} defaultExpanded={group.family === 'db'} disableGutters variant="outlined" sx={{ mb: 1 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box>
                <Typography variant="subtitle2">
                  {meta.label} ({group.count})
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {meta.tagline}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <FamilyExitList exitPoints={group.exitPoints} projectId={projectId} />
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
}
