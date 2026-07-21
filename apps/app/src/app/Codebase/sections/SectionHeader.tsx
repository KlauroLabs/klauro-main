import { Stack, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Link as RouterLink } from 'react-router-dom';

export interface SectionHeaderProps {
  index: string;
  title: string;
  subtitle: string;
  seeAllHref?: string;
  seeAllLabel?: string;
}

export function SectionHeader({ index, title, subtitle, seeAllHref, seeAllLabel }: SectionHeaderProps) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="caption" color="text.disabled" sx={{ fontVariantNumeric: 'tabular-nums' }}>{index}</Typography>
        <Typography variant="h3">{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>{subtitle}</Typography>
      </Stack>
      {seeAllHref ? (
        <Stack
          component={RouterLink}
          to={seeAllHref}
          direction="row"
          spacing={0.5}
          sx={{ alignItems: 'center', color: 'primary.main', textDecoration: 'none', typography: 'caption', flexShrink: 0, mt: 0.5 }}
        >
          <span>{seeAllLabel ?? 'See all'}</span>
          <ArrowForwardIcon sx={{ fontSize: 14 }} />
        </Stack>
      ) : null}
    </Stack>
  );
}
