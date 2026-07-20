// Section-nav tab bar for the CAS home shell (router.tsx nests every CAS
// section under /codebases/:projectId as children of CodebasePage). Implements
// LANE-COMMON's progressive-disclosure ladder as navigation: Overview ->
// Capabilities -> Flows -> Entities -> Architecture -> Dependencies. No
// distinct Figma frame shows this exact tab bar (the "Repo overview" screen
// is itself the Overview destination, not a tab strip above it) — derived
// from the design language's MuiTabs theme overrides; see
// apps/app/docs/DESIGN-NOTES.md.
import { Tabs, Tab } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';

const sections = [
  { value: '', label: 'Overview' },
  { value: 'capabilities', label: 'Capabilities' },
  { value: 'flows', label: 'Flows' },
  { value: 'entities', label: 'Entities' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'dependencies', label: 'Dependencies' },
];

export function CodebaseSectionNav({ projectId }: { projectId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const base = `/codebases/${projectId}`;
  const rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length).replace(/^\//, '') : '';
  const activeSegment = rest.split('/')[0] || '';
  const current = sections.some(s => s.value === activeSegment) ? activeSegment : '';

  return (
    <Tabs
      value={current}
      onChange={(_event, value: string) => navigate(value ? `${base}/${value}` : base)}
      sx={{ mb: 3, borderBottom: '1px solid', borderColor: 'divider' }}
    >
      {sections.map(section => (
        <Tab key={section.value} value={section.value} label={section.label} />
      ))}
    </Tabs>
  );
}
