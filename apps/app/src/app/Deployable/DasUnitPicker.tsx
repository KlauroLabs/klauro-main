import { MenuItem, Select, type SelectChangeEvent } from '@mui/material';
import type { RemoteDasUnit } from '@/shared/hooks/useDasUnits';

export interface DasUnitPickerProps {
  units: RemoteDasUnit[];
  value: string | undefined;
  onChange: (unitId: string) => void;
}

export function DasUnitPicker({ units, value, onChange }: DasUnitPickerProps) {
  if (units.length <= 1) return null;
  const handleChange = (event: SelectChangeEvent<string>) => onChange(event.target.value);
  return (
    <Select
      size="small"
      value={value ?? units[0]?.id ?? ''}
      onChange={handleChange}
      displayEmpty
      sx={{ minWidth: 220 }}
      aria-label="Deployable unit"
    >
      {units.map(u => (
        <MenuItem key={u.id} value={u.id}>
          {u.name}
        </MenuItem>
      ))}
    </Select>
  );
}
