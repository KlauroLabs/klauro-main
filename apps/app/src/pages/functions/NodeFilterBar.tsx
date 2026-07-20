import { Autocomplete, InputAdornment, Stack, TextField, createFilterOptions } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import type { FacetCount } from '../../hooks/useFileNodes';

/**
 * Search + two facets (type, file). Both facets are computed from the loaded
 * node set, not a fixed vocabulary — CASNode.type is analyzer-authored free
 * text and file paths are obviously open-ended (docs/briefs/functions.md,
 * "Data reality"). A codebase can carry thousands of distinct files, so the
 * file Autocomplete caps rendered options after filtering
 * (createFilterOptions' `limit`) rather than materializing every option's
 * DOM node — the same "page honestly, never render everything" stance
 * EntryPointTable takes for rows.
 */
const fileFilterOptions = createFilterOptions<FacetCount>({ limit: 50, stringify: o => o.value });
const typeFilterOptions = createFilterOptions<FacetCount>({ limit: 50, stringify: o => o.value });

export interface NodeFilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  types: FacetCount[];
  type: string | null;
  onTypeChange: (value: string | null) => void;
  files: FacetCount[];
  file: string | null;
  onFileChange: (value: string | null) => void;
}

export function NodeFilterBar({
  search, onSearchChange, types, type, onTypeChange, files, file, onFileChange,
}: NodeFilterBarProps) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
      <TextField
        size="small"
        placeholder="Search by name, qualified name, or file…"
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
        sx={{ flex: 1, minWidth: 240 }}
      />
      <Autocomplete
        size="small"
        options={types}
        filterOptions={typeFilterOptions}
        getOptionLabel={o => `${o.value} (${o.count})`}
        isOptionEqualToValue={(o, v) => o.value === v.value}
        value={type ? types.find(t => t.value === type) ?? null : null}
        onChange={(_e, v) => onTypeChange(v?.value ?? null)}
        renderInput={params => <TextField {...params} label="Type" />}
        sx={{ width: { xs: '100%', sm: 220 } }}
      />
      <Autocomplete
        size="small"
        options={files}
        filterOptions={fileFilterOptions}
        getOptionLabel={o => `${o.value} (${o.count})`}
        isOptionEqualToValue={(o, v) => o.value === v.value}
        value={file ? files.find(f => f.value === file) ?? null : null}
        onChange={(_e, v) => onFileChange(v?.value ?? null)}
        renderInput={params => <TextField {...params} label="File" />}
        sx={{ width: { xs: '100%', sm: 320 } }}
      />
    </Stack>
  );
}
