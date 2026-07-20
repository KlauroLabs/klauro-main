import { MenuItem, Select, type SelectChangeEvent } from '@mui/material';
import type { DeployableOption } from '../../hooks/useEntryPoints';

/**
 * Entry points are ALWAYS scoped to one deployable at a time (the brief:
 * "the viewer is always looking at one deployable, with the ability to
 * switch to another") — this is the switcher, never a flat repo-wide list.
 *
 * Derived layout (no Figma precedent scopes by deployable — see
 * apps/app/docs/DESIGN-NOTES.md): a bordered-pill select, matching the
 * visual weight of the Flow List screen's Tags/Type/Sort filter badges.
 */
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
