import { InputAdornment, MenuItem, Select, Stack, TextField, type SelectChangeEvent } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import { KIND_META, type EntryKind } from '@/shared/components/entryPointKinds';

export type FlowRoleFilter = 'core' | 'supporting' | 'infrastructure' | 'unknown';
export type FlowSort = 'name' | 'steps-desc' | 'capabilities-desc';

export interface FlowFilterState {
  search: string;
  kind: EntryKind | 'all';
  role: FlowRoleFilter | 'all';
  sort: FlowSort;
}

export function FlowFilters({
  value,
  onChange,
  availableKinds,
}: {
  value: FlowFilterState;
  onChange: (next: FlowFilterState) => void;
  availableKinds: EntryKind[];
}) {
  const set = <K extends keyof FlowFilterState>(key: K, val: FlowFilterState[K]) => onChange({ ...value, [key]: val });

  return (
    <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <TextField
        size="small"
        placeholder="Search flows…"
        value={value.search}
        onChange={e => set('search', e.target.value)}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
        sx={{ minWidth: 280, flexGrow: 1 }}
      />
      <Select
        size="small"
        value={value.kind}
        onChange={(e: SelectChangeEvent) => set('kind', e.target.value as FlowFilterState['kind'])}
        startAdornment={<LocalOfferOutlinedIcon fontSize="small" sx={{ mr: 1 }} />}
        sx={{ minWidth: 160 }}
        aria-label="Entry modality"
      >
        <MenuItem value="all">All entry kinds</MenuItem>
        {availableKinds.map(kind => (
          <MenuItem key={kind} value={kind}>{KIND_META[kind].label}</MenuItem>
        ))}
      </Select>
      <Select
        size="small"
        value={value.role}
        onChange={(e: SelectChangeEvent) => set('role', e.target.value as FlowFilterState['role'])}
        startAdornment={<CategoryOutlinedIcon fontSize="small" sx={{ mr: 1 }} />}
        sx={{ minWidth: 150 }}
        aria-label="Type"
      >
        <MenuItem value="all">All types</MenuItem>
        <MenuItem value="core">Core</MenuItem>
        <MenuItem value="supporting">Supporting</MenuItem>
        <MenuItem value="infrastructure">Infrastructure</MenuItem>
        <MenuItem value="unknown">Unclassified</MenuItem>
      </Select>
      <Select
        size="small"
        value={value.sort}
        onChange={(e: SelectChangeEvent) => set('sort', e.target.value as FlowSort)}
        startAdornment={<SwapVertIcon fontSize="small" sx={{ mr: 1 }} />}
        sx={{ minWidth: 150 }}
        aria-label="Sort"
      >
        <MenuItem value="name">Name (A-Z)</MenuItem>
        <MenuItem value="steps-desc">Most steps</MenuItem>
        <MenuItem value="capabilities-desc">Most capabilities</MenuItem>
      </Select>
    </Stack>
  );
}
