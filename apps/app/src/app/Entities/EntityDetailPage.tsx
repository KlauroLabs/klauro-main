import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Card, CardContent, Grid, Stack, Typography } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useDataEntity } from '@/shared/hooks/useEntities';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { encodeSlug } from '@/shared/lib/slugs';
import { EvidenceKindBadge } from '@/shared/components/entities/EvidenceKindBadge';
import { EntityFieldsTable } from '@/shared/components/entities/EntityFieldsTable';
import { EntityRelationshipsList } from '@/shared/components/entities/EntityRelationshipsList';
import { EntityLineage } from '@/shared/components/entities/EntityLineage';
import { ERDCanvas } from '@/shared/components/entities/ERDCanvas';

export function EntityDetailPage() {
  const { projectId: routeParam, entityId: routeEntityId } = useParams<{ projectId: string; entityId: string }>();
  const navigate = useNavigate();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const query = useDataEntity(projectId, routeEntityId);

  useEffect(() => {
    if (!routeParam || !routeEntityId || !query.entity) return;
    const canonical = encodeSlug(query.entity);
    if (routeEntityId !== canonical) navigate(`/codebases/${routeParam}/entities/${canonical}`, { replace: true });
  }, [routeParam, routeEntityId, query.entity, navigate]);

  const entityIdByNameLower = useMemo(
    () => new Map(query.entities.map(e => [e.name.toLowerCase(), { id: e.id, name: e.name }])),
    [query.entities],
  );

  const neighborhood = useMemo(() => {
    if (!query.entity || !query.databaseEntity) return [];
    const relatedNames = new Set(query.databaseEntity.relationships.map(r => r.target.toLowerCase()));
    return query.entities.filter(e => e.id === query.entity!.id || relatedNames.has(e.name.toLowerCase()));
  }, [query.entity, query.databaseEntity, query.entities]);

  if (!projectId || !routeEntityId) return null;
  if (query.isLoading) return <LoadingState label="Loading entity…" />;
  if (query.isError) return <ErrorState message="Could not load this entity." />;

  if (!query.entity) {
    return (
      <EmptyState
        title="Entity not found"
        description="This entity may have been removed by a re-analysis, or the link is stale."
      />
    );
  }

  const entity = query.entity;

  return (
    <Box>
      <PageHeader
        title={entity.name}
        subtitle={entity.schema_source}
        actions={<EvidenceKindBadge kind={entity.kind} />}
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        {entity.description ? (
          <Typography variant="body1" color="text.secondary">{entity.description}</Typography>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            No description generated for this entity yet.
          </Typography>
        )}

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 7 }}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
                  Fields ({entity.fields?.length ?? 0})
                </Typography>
                <EntityFieldsTable fields={entity.fields ?? []} databaseFields={query.databaseEntity?.fields} />
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, md: 5 }}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
                  Relationships ({query.databaseEntity?.relationships.length ?? 0})
                </Typography>
                <EntityRelationshipsList
                  relationships={query.databaseEntity?.relationships ?? []}
                  projectId={routeParam ?? projectId}
                  entityIdByNameLower={entityIdByNameLower}
                />
              </CardContent>
            </Card>
          </Grid>

          <Grid size={12}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Lineage</Typography>
                <EntityLineage lifecycle={entity.lifecycle} projectId={routeParam ?? projectId} />
              </CardContent>
            </Card>
          </Grid>

          {neighborhood.length > 1 ? (
            <Grid size={12}>
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Neighborhood</Typography>
                  <ERDCanvas
                    projectId={routeParam ?? projectId}
                    entities={neighborhood}
                    databaseEntityByNameLower={query.databaseEntityByNameLower}
                    focusEntityId={entity.id}
                  />
                </CardContent>
              </Card>
            </Grid>
          ) : null}
        </Grid>
      </Stack>
    </Box>
  );
}
