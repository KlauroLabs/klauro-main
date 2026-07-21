import { Box, Paper } from '@mui/material';
import { SectionHeader } from './SectionHeader';
import { CapabilityCard } from './CapabilityCard';
import type { MergedCapability } from '@/app/Codebase/casSummary';

export function CapabilitiesSection({ projectId, capabilities }: { projectId: string; capabilities: MergedCapability[] }) {
  const preview = capabilities.slice(0, 6);
  return (
    <Box component="section" sx={{ mb: 6 }}>
      <SectionHeader
        index="01"
        title="Capabilities"
        subtitle="Core business functions, not infrastructure."
        seeAllHref={`/codebases/${projectId}/capabilities`}
        seeAllLabel="See all Capabilities"
      />
      {preview.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          No capabilities were found for this codebase.
        </Paper>
      ) : (
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {preview.map((capability, index) => (
              <Box
                key={capability.id ?? capability.name}
                sx={{
                  borderRight: index % 3 !== 2 ? '0.5px solid' : 'none',
                  borderTop: index >= 3 ? '0.5px solid' : 'none',
                  borderColor: 'divider',
                }}
              >
                <CapabilityCard capability={capability} index={index} />
              </Box>
            ))}
          </Box>
        </Paper>
      )}
    </Box>
  );
}
