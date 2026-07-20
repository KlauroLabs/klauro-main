// Shared sidebar nav row — mirrors the Figma "_Nav item base" component
// (226x44, icon + label, selected state = tinted background) used across
// every designed screen's sidebar. Single implementation so AppShell and any
// future nav section (workspace switcher, sub-project list) stay visually
// identical.
import type { ReactNode } from 'react';
import { ListItemButton, ListItemIcon, ListItemText, Typography } from '@mui/material';

export interface NavItemProps {
  icon: ReactNode;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  endAdornment?: ReactNode;
  dense?: boolean;
}

export function NavItem({ icon, label, selected, disabled, onClick, endAdornment, dense }: NavItemProps) {
  return (
    <ListItemButton
      selected={selected}
      disabled={disabled}
      onClick={onClick}
      sx={{
        height: 44,
        pl: dense ? 4 : 2,
        pr: 1.5,
        gap: 1,
        color: 'text.secondary',
        '&.Mui-selected': { color: 'primary.main' },
      }}
    >
      <ListItemIcon sx={{ minWidth: 0, mr: 1, color: 'inherit', display: 'flex', alignItems: 'center' }}>
        {icon}
      </ListItemIcon>
      <ListItemText
        primary={<Typography variant="body1" noWrap sx={{ color: 'inherit' }}>{label}</Typography>}
      />
      {endAdornment}
    </ListItemButton>
  );
}
