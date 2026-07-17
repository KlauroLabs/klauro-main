import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, formatPort, numericPorts, safeDeployableName } from '../util';

/** K8s resource kinds that actually RUN a workload (a scheduled pod running
 *  container images) — the only kinds that count as independent Tier-1 ship
 *  declarations. Service/ServiceAccount/Ingress/ConfigMap/Secret/HPA/
 *  Certificate/etc. are wiring, identity, routing, or config resources
 *  ATTACHED to a workload; they are evidence for that workload's boundary,
 *  never ship units in their own right (SPEC-DEPLOYABLE-DETECTION.md §2). */
const WORKLOAD_KUBERNETES_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job']);

/** A real bundle-member name (bin/crate/service name), as opposed to a
 *  base-image `FROM` ref, a registry image ref, or a CLI-flag/prose token that
 *  can leak in from a loosely-matched COPY/RUN line. `ships_paths` must carry
 *  ONLY these — downstream (context-fabric bundle rendering, cross-codebase
 *  `bundled_into` resolution) treats every entry as a real member name and
 *  matches it against sibling app names, so image refs cause false bundling.
 *  Kept at the SOURCE so the downstream filters are belt-and-suspenders. */
function isRealMemberToken(token: string): boolean {
  const t = token.trim();
  if (!t || t.length < 2) return false;
  // Image refs: `node:22-alpine`, `alpine:3.19`, `library/redis:7`, `${VAR}`.
  if (t.includes(':')) return false;
  if (/^\$?\{?[A-Z0-9_]+\}?$/.test(t) && /\$|\{/.test(t)) return false; // build-arg placeholder like ${BASE}
  if (/\b(alpine|debian|ubuntu|distroless|scratch|buster|bookworm|slim|busybox)\b/i.test(t)) return false;
  // Bare CLI/tooling tokens and shell noise that can slip through a COPY/RUN match.
  if (/^(--?[a-z].*|&&|\|\||;|\.|\.\.|-p|from|as)$/i.test(t)) return false;
  // Trailing prose punctuation ("below.", "bastion,") is arg noise, not a member.
  if (/[.,;]$/.test(t)) return false;
  return true;
}

/** Parse a Dockerfile's real bundle membership: `cargo build -p X -p Y`
 *  package args, `COPY [--from=stage] .../release/<bin> <dest>` targets, and
 *  the ENTRYPOINT/CMD primary binary. Falls back to no members (caller uses
 *  base images) when the Dockerfile doesn't match any of these patterns. */
export function parseDockerfileMembers(projectPath: string, relativeFile: string): { members: string[]; entrypointMember?: string } {
  if (!relativeFile) return { members: [] };
  let content = '';
  try {
    content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
  } catch {
    return { members: [] };
  }

  const members = new Set<string>();
  // Real COMPILED build-output binaries (cargo -p package args, or a COPY
  // sourced from a release/debug build dir) — as opposed to auxiliary
  // scripts/tools that merely get COPYed alongside into the same bin
  // directory (e.g. a `fetch_access_token` helper script copied to
  // /usr/local/bin/ next to the actual service binary). Both count as
  // `members` (real bundle membership — the auxiliary file DOES ship in the
  // image), but only builtBinaries are candidates for the sole-member
  // entrypoint fallback below: a helper script is never "the" service.
  const builtBinaries = new Set<string>();
  for (const match of content.matchAll(/^\s*RUN\s+.*cargo\s+(?:build|install)\b[^\n]*/gim)) {
    for (const pkgMatch of match[0].matchAll(/-p\s+([A-Za-z0-9_-]+)/g)) {
      members.add(pkgMatch[1]);
      builtBinaries.add(pkgMatch[1]);
    }
  }
  for (const match of content.matchAll(/^\s*COPY\s+(?:--from=\S+\s+)?(\S+)\s+(\S+)\s*$/gim)) {
    const source = match[1];
    const dest = match[2];
    const binName = path.basename(source);
    const isBuildOutput = /\/(release|debug)\//.test(source);
    if (isBuildOutput || /^\/usr\/local\/bin\//.test(dest) || /\/bin\//.test(dest)) {
      if (binName && binName !== '.' && !/\.(sh|sql|json|yaml|yml|toml|txt|md)$/i.test(binName)) {
        members.add(binName);
        if (isBuildOutput) builtBinaries.add(binName);
      }
    }
  }

  // Real Docker semantics: ENTRYPOINT is the fixed executable, CMD supplies
  // its default arguments. A very common pattern (seen in real repos) wraps
  // several binaries behind one ENTRYPOINT script (e.g.
  // `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]` + `CMD ["coordinator"]`,
  // where entrypoint.sh execs "$1"). In that shape the ENTRYPOINT's own
  // basename is a dispatcher/wrapper, not a shipped member — CMD's basename
  // is the actual default-selected binary and the one that should win as
  // primary. Resolution order: (1) ENTRYPOINT basename if it names a real
  // member, (2) else CMD basename if it names a real member (the wrapper
  // case above), (3) else ENTRYPOINT basename as a last resort (single-bin
  // images with no members list still need SOME name), (4) else CMD.
  const firstToken = (raw: string): string => {
    const jsonArray = raw.match(/\[\s*"([^"]+)"/);
    const token = jsonArray ? jsonArray[1] : raw.trim().split(/\s+/)[0];
    return path.basename(token.replace(/["'\[\],]/g, ''));
  };
  const entrypointRawMatch = content.match(/^\s*ENTRYPOINT\s+(.+)$/im);
  const cmdRawMatch = content.match(/^\s*CMD\s+(.+)$/im);
  const entrypointBaseName = entrypointRawMatch ? firstToken(entrypointRawMatch[1]) : undefined;
  const cmdBaseName = cmdRawMatch ? firstToken(cmdRawMatch[1]) : undefined;

  let entrypointMember: string | undefined;
  if (entrypointBaseName && members.has(entrypointBaseName)) entrypointMember = entrypointBaseName;
  else if (cmdBaseName && members.has(cmdBaseName)) entrypointMember = cmdBaseName;
  else if (builtBinaries.size === 1) {
    // Neither ENTRYPOINT nor CMD names a real member — often because the
    // actual binary is selected by a runtime override this Dockerfile can't
    // see (e.g. a docker-compose `entrypoint:`/`command:` override passing
    // the bin name as an argument to a generic wrapper script, so the
    // Dockerfile itself only ever names the wrapper). When this Dockerfile
    // only builds exactly ONE real compiled binary (ignoring auxiliary
    // helper scripts merely copied alongside it), there is no ambiguity —
    // it must be that one, regardless of what the wrapper script is called.
    entrypointMember = [...builtBinaries][0];
  } else entrypointMember = entrypointBaseName || cmdBaseName;

  // Final source-side scrub: drop any token that isn't a real member name
  // (image refs / CLI-flag / prose noise that slipped through the COPY/RUN
  // matchers). ships_paths must carry only true bundle members.
  const cleanMembers = [...members].filter(isRealMemberToken);
  const cleanEntrypoint =
    entrypointMember && isRealMemberToken(entrypointMember) ? entrypointMember : undefined;
  return { members: cleanMembers, entrypointMember: cleanEntrypoint };
}

/** Clean deployable name for a Dockerfile — NEVER the node's display label.
 *  A `container_image_definition` node's `.name` is a human label
 *  ("Docker image definition: apps/admin-api/Dockerfile"); if that leaks into
 *  DeployableEvidence.name it flows onto the DEPLOYS edge's `deployable`
 *  attribute and shows up alongside the clean name ("admin-api") in
 *  runtime_topology. Derive a clean, still-distinguishing name from the path:
 *   - A NAMED Dockerfile (`docker/BinA.Dockerfile`, `Dockerfile.web`) carries
 *     the distinguishing token in its FILENAME stem (`bina`, `web`) — use it,
 *     so two Dockerfiles sharing a `docker/` dir don't collapse to one name.
 *   - A PLAIN `Dockerfile` takes its identity from the build-context DIR
 *     basename (`apps/admin-api/Dockerfile` -> `admin-api`).
 *   - A root-level plain `Dockerfile` falls back to a pre-inferred non-hash
 *     `service_aliases[0]`, else the project display name.
 *  All paths run through safeDeployableName so a hash workspace basename never
 *  leaks. */
function dockerfileDeployableName(
  file: string,
  metadata: Record<string, any>,
  ctx: EvidenceCollectionContext,
): string {
  const norm = file.replace(/\\/g, '/');
  const base = path.basename(norm); // e.g. "Dockerfile", "BinA.Dockerfile", "Dockerfile.web"
  // Distinguishing token from a named Dockerfile: "BinA.Dockerfile" -> "BinA",
  // "Dockerfile.web" -> "web". A plain "Dockerfile" has no such token.
  const namedStem =
    base !== 'Dockerfile'
      ? base.replace(/\.?dockerfile$/i, '').replace(/^dockerfile\.?/i, '') || ''
      : '';
  if (namedStem) return safeDeployableName(namedStem.toLowerCase());

  const dir = path.dirname(norm).replace(/\/+$/, '');
  const dirBase = dir && dir !== '.' ? path.basename(dir) : '';
  if (dirBase) return safeDeployableName(dirBase);

  // Root-level plain Dockerfile: prefer a real inferred alias, else display name.
  const alias = arrayOf(metadata.service_aliases)[0];
  if (alias) return safeDeployableName(alias);
  return safeDeployableName(ctx.displayName || path.basename(ctx.projectPath));
}

/** Dockerfiles (container_image_definition nodes), compose services
 *  (compose_service nodes), and kubernetes_* nodes. */
function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, nodes } = ctx;
  const out: DeployableEvidence[] = [];

  for (const node of nodes) {
    if (node.type === 'container_image_definition') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`Dockerfile: ${file}`];
      const baseImages: string[] = arrayOf(metadata.base_images);
      if (baseImages.length) evidence.push(`FROM ${baseImages.join(', ')}`);
      if (metadata.command) evidence.push(`entrypoint/cmd: ${metadata.command}`);
      const exposedPorts: string[] = arrayOf(metadata.exposed_ports);
      if (exposedPorts.length) evidence.push(`EXPOSE ${exposedPorts.join(', ')}`);

      // Real bundle membership: parse the Dockerfile itself for what it
      // actually builds/COPYs/ships, rather than base-image lineage (which is
      // useless for membership — every stage in a multi-stage build often
      // shares the same FROM images regardless of what binaries it packages).
      // ships_paths carries ONLY real members: base-image FROM refs stay in
      // `evidence` (kept above) for context but are deliberately NOT a fallback
      // here, because every downstream consumer treats a ships_paths entry as a
      // real member name (context-fabric bundle rendering, cross-codebase
      // bundled_into resolution) — an image ref there causes false bundling.
      const dockerfileMembers = parseDockerfileMembers(projectPath, file);
      const shipsPaths = dockerfileMembers.members;
      if (dockerfileMembers.members.length) {
        evidence.push(`builds/copies: ${dockerfileMembers.members.join(', ')}`);
      }
      if (dockerfileMembers.entrypointMember) {
        evidence.push(`entrypoint-member: ${dockerfileMembers.entrypointMember}`);
      }

      out.push({
        root_path: path.dirname(file) || '.',
        name: dockerfileDeployableName(file, metadata, ctx),
        tier: 1,
        kind: 'container',
        evidence,
        ships_paths: shipsPaths.length ? shipsPaths : undefined,
        ports: numericPorts(exposedPorts),
        entrypoint_member: dockerfileMembers.entrypointMember,
      });
    }

    if (node.type === 'compose_service') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';

      // A compose service with no `build:` context ships someone else's
      // pre-built image (redis, rabbitmq, postgres, nginx:alpine, ...) — it
      // is a DEPENDENCY this workspace runs against, not a ship/run artifact
      // OF this workspace (see SPEC-DEPLOYABLE-DETECTION.md §2: "a deployable
      // is an independent SHIP/RUN artifact"). container-topology-analyzer.ts
      // already records these as external-service exit points; emitting a
      // Tier-1 DeployableEvidence for every image-only service over-splits
      // the deployable count (e.g. a 6-node Redis cluster becoming 6+
      // "deployables" of the repo that merely runs a Redis client against
      // it). Only services this repo actually BUILDS are ship declarations.
      if (!metadata.build) continue;

      const evidence: string[] = [`compose service: ${metadata.deployment_service_name || node.name} (${file})`];
      if (metadata.image) evidence.push(`image: ${metadata.image}`);
      evidence.push(`build: ${metadata.build}`);
      const ports: Array<{ host?: string; container: string }> = Array.isArray(metadata.ports) ? metadata.ports : [];
      if (ports.length) evidence.push(`ports: ${ports.map(formatPort).join(', ')}`);

      // A compose `build: context` path is relative to the COMPOSE FILE's
      // directory, not the project root — `context: .` in a nested app's
      // compose.yml means that app's own subdirectory, not the repo root.
      // Resolving it against path.dirname(file) keeps two same-named build
      // contexts in different compose files (or a nested-app compose file)
      // from colliding on the same evidence root_path.
      const composeDir = path.dirname(file) || '.';
      const buildContext = String(metadata.build);
      const rootPath = path.normalize(path.join(composeDir === '.' ? '' : composeDir, buildContext)) || '.';

      out.push({
        root_path: rootPath,
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'compose-service',
        evidence,
        ports: numericPorts(ports.map(p => p.container)),
      });
    }

    if (typeof node.type === 'string' && node.type.startsWith('kubernetes_')) {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const attributes = (metadata.attributes || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const kind = String(metadata.kubernetes_kind || attributes.kubernetes_kind || '');

      // A Helm chart already contributes exactly ONE Tier-1 ship declaration
      // for the whole chart (deploy-manifests.ts's collectHelm, keyed on
      // Chart.yaml + templates/). Every individual rendered resource inside
      // that chart's templates/ (Deployment, Service, ServiceAccount,
      // Ingress, ...) is a NODE emitted by HelmAnalyzer for graph detail, not
      // a second independent ship unit — counting them here on top of the
      // chart-level evidence is what over-splits one Helm-deployed app into
      // N+1 "deployables". Skip Helm-origin kubernetes_* nodes entirely.
      const isHelmOrigin = metadata.language === 'Helm' || attributes.topology_surface === 'helm';
      if (isHelmOrigin) continue;

      // Among PLAIN (non-Helm) k8s manifest resources, only WORKLOAD kinds
      // are ship/run declarations. Service/ServiceAccount/Ingress/ConfigMap/
      // Secret/HorizontalPodAutoscaler are wiring, identity, and routing
      // resources attached to a workload — evidence for that workload's
      // boundary, never independent ship units of their own (see
      // SPEC-DEPLOYABLE-DETECTION.md doctrine: "a deployable is an
      // independent SHIP/RUN artifact").
      if (!WORKLOAD_KUBERNETES_KINDS.has(kind)) continue;

      const evidence: string[] = [`kubernetes ${kind || node.type}: ${metadata.deployment_service_name || node.name} (${file})`];
      const images: string[] = arrayOf(metadata.images);
      if (images.length) evidence.push(`images: ${images.join(', ')}`);
      const ports: string[] = arrayOf(metadata.ports);
      if (ports.length) evidence.push(`ports: ${ports.join(', ')}`);

      // Roll sibling wiring/identity/routing resources declared in the SAME
      // manifest file into this workload's evidence trail (citations, not
      // separate ship units) — Service/Ingress/ServiceAccount are evidence
      // FOR this boundary per the doctrine above.
      const siblingCitations = nodes
        .filter(sibling =>
          sibling !== node &&
          typeof sibling.type === 'string' &&
          sibling.type.startsWith('kubernetes_') &&
          (sibling.source?.file || '') === file &&
          !WORKLOAD_KUBERNETES_KINDS.has(String((sibling.metadata as any)?.kubernetes_kind || (sibling.metadata as any)?.attributes?.kubernetes_kind || '')),
        )
        .map(sibling => `${(sibling.metadata as any)?.kubernetes_kind || sibling.type}: ${(sibling.metadata as any)?.deployment_service_name || sibling.name}`);
      if (siblingCitations.length) evidence.push(`attached resources: ${siblingCitations.join(', ')}`);

      out.push({
        root_path: path.dirname(file) || '.',
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'k8s',
        evidence,
        ships_paths: images,
        ports: numericPorts(ports),
      });
    }
  }

  // External service exit points recorded by the compose analyzer (image-only
  // services with no own build) are dependencies, not ship-declarations of
  // this workspace — intentionally excluded here.
  void ctx.exitPoints;

  return out;
}

export const containerProvider: EvidenceProvider = {
  id: 'container',
  tier: 1,
  collect,
};
