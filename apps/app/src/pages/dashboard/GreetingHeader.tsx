import { Box, Stack, Typography } from '@mui/material';
import CircleIcon from '@mui/icons-material/Circle';

function timeOfDayGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Figma "Home" (node 1698-13626): greeting + one-line subtitle, with a small
 * "Updated Xh ago" freshness indicator at top right. The freshness value is
 * real (the latest `generated_at` across the account's project revisions,
 * passed in by DashboardPage) — never a fabricated "just synced" claim.
 */
export function GreetingHeader({ name, freshnessLabel }: { name: string; freshnessLabel: string | null }) {
  const greeting = timeOfDayGreeting(new Date().getHours());
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h4" component="h1" sx={{ color: 'primary.main', fontWeight: 700 }}>
          {greeting} {name}
        </Typography>
        {freshnessLabel ? (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <CircleIcon sx={{ fontSize: 6, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.disabled">
              Updated {freshnessLabel}
            </Typography>
          </Stack>
        ) : null}
      </Stack>
      <Box>
        <Typography variant="body2" color="text.secondary">
          Here&rsquo;s what&rsquo;s changed across your engineering systems.
        </Typography>
      </Box>
    </Stack>
  );
}
