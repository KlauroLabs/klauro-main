import { MenuItem, Select, type SelectChangeEvent } from '@mui/material';
import type { DeployableOption } from '@/shared/hooks/useEntryPoints';

export interface DeployableSwitcherProps {
  deployables: DeployableOption[];
  value: string | undefined;
  onChange: (deployableId: string) => void;
}

export function DeployableSwitcher({ deployables, value, onChange }: DeployableSwitcherProps) {
  if (deployables.length <= 1) return null;
  const handleChange = (event: SelectChangeEvent<string>) => onChange(event.target.value);
  return (
    <Select
      size="small"
      value={value ?? deployables[0]?.id ?? ''}
      onChange={handleChange}
      displayEmpty
      sx={{ minWidth: 200 }}
      aria-label="Deployable"
    >
      {deployables.map(d => (
        <MenuItem key={d.id} value={d.id}>
          {d.name}
        </MenuItem>
      ))}
    </Select>
  );
}
