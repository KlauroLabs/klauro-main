import { MenuItem, Select, type SelectChangeEvent } from '@mui/material';
import type { DasUnitSummary } from './dasIndex';

/**
 * The das_index picker — mirrors entry-points' DeployableSwitcher (same
 * bordered-pill select) since this is the same "always looking at one X,
 * switch to another" shape, one rung more specific (DAS unit, not
 * repo-level deployable). Hidden entirely below 2 units — a single unit
 * means the repo hasn't promoted, and DeployablePage renders the
 * not-promoted explanation instead of a picker with one disabled choice.
 */
export interface DasUnitPickerProps {
  units: DasUnitSummary[];
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
