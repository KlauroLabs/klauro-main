import type { CASOutput, CASSystemCatalogEntry } from '../../../packages/analyzer-core/src/types/cas.types';

export interface DescribedSubProject extends CASSystemCatalogEntry {
  name: string;
  root_path: string;
}

export function describedSubProjects(cas: CASOutput): DescribedSubProject[] {
  return (cas.children ?? []).flatMap(part => part.system.catalog
    ? [{ name: part.system.name, root_path: part.system.root_path, ...part.system.catalog }]
    : []);
}

export function describedSubProjectsField(cas: CASOutput): { sub_projects?: DescribedSubProject[] } {
  const described = describedSubProjects(cas);
  return described.length > 0 ? { sub_projects: described } : {};
}
