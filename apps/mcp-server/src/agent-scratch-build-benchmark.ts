import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { buildGreenfieldArchitectureGuidance, type GreenfieldReferenceAnalysis } from './greenfield-guidance';
import { buildGreenfieldBuildContext } from './greenfield-build-session';
import { getPreviewAnalysis, previewGreenfieldCodebase, type ProposedFileInput } from './proposal-preview';
import { evaluateLivePairDeterministically, runLiveAgentPair, runLiveAgentPairFromWorkspaces, type LiveAgentCommandConfig, type LiveAgentPairResult, type WithoutArmPromptOverrides } from './agent-live-trial';
import { isDirectCliInvocation } from './cli-invocation';

interface ScratchBuildReport {
  generated_at: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  task: {
    id: string;
    title: string;
    requirements: string;
  };
  guidance_summary: {
    status: string;
    reference_count: number;
    recommended_patterns: string[];
    file_plan: string[];
    reuse_decisions: number;
  };
  live_pair?: LiveAgentPairResult;
  continuation_pair?: LiveAgentPairResult;
  with_klauro: ScratchBuildScore;
  without_klauro: ScratchBuildScore;
  continuation?: {
    with_klauro: ScratchBuildScore;
    without_klauro: ScratchBuildScore;
    quality_delta: number;
    duplicate_concept_delta: number;
  };
  continuation_waves?: ScratchContinuationWaveReport[];
  without_arm_uncoached: boolean;
  comparison: {
    quality_delta: number;
    live_quality_delta?: number | null;
    token_reduction_percentage: number | null;
    quality_token_tradeoff_status?: 'clear-win' | 'acceptable' | 'quality-win-token-regression-too-large' | 'token-regression-without-quality-win' | 'unmeasured';
    time_reduction_percentage: number | null;
    changed_file_delta: number | null;
    duplicate_concept_delta: number;
  };
  artifacts: {
    seed_directory: string;
    output?: string;
    markdown?: string;
  };
}

interface ScratchBuildScore {
  score: number;
  status: 'pass' | 'warn' | 'fail';
  findings: string[];
  dimensions: Record<string, number>;
  file_count: number;
  source_files: number;
  tests: number;
  test_cases: number;
  migrations: number;
  duplicate_concepts: Array<{ concept: string; files: string[] }>;
  cas: {
    nodes: number;
    edges: number;
    entry_points: number;
    capabilities: number;
    domain_concepts: number;
    preview_id?: string;
    preview_url?: string;
  };
}

interface Args {
  live: boolean;
  withCmd?: string;
  withoutCmd?: string;
  timeoutMs?: number;
  workRoot: string;
  output?: string;
  markdown?: string;
  keepWorkspaces: boolean;
  references: string[];
  scoreExistingReport?: string;
  continuationOnlyFrom?: string;
  scenarioId?: string;
  listScenarios: boolean;
  multiWave: boolean;
  initialOnly: boolean;
  uncoachedBaseline: boolean;
}

interface ScratchContinuation {
  repo: string;
  taskId: string;
  taskLabel: string;
  target: string;
  instructions: string;
  successCriteria: string[];
  relatedPaths: string[];
  expectedOutcome: string;
  fileReadPlan: Array<{ file: string; reason: string }>;
  modelReuse: string[];
  boundaryRules: string[];
  doNotRebuild: string[];
  requiredTerms: Array<{ id: string; label: string; pattern: RegExp; points: number }>;
}

interface ScratchContinuationWaveReport {
  wave: number;
  task_id: string;
  title: string;
  live_pair?: LiveAgentPairResult;
  with_klauro: ScratchBuildScore;
  without_klauro: ScratchBuildScore;
  quality_delta: number;
  live_quality_delta: number | null;
  changed_file_precision_delta: number | null;
  completion_score_delta: number | null;
  duplicate_concept_delta: number;
  token_reduction_percentage: number | null;
  time_reduction_percentage: number | null;
  changed_file_delta: number | null;
}

interface ScratchScenario {
  id: string;
  title: string;
  repo: string;
  taskCategory: string;
  requirements: string;
  expectedOutcome: string;
  successCriteria: string[];
  validationCommand: string;
  score: {
    minSourceFiles: number;
    minInitialTests: number;
    minContinuationTests: number;
    needsEntry: boolean;
    needsService: boolean;
    needsDataAccess: boolean;
    needsDomain: boolean;
    needsTenantAuth: boolean;
    needsWorker: boolean;
    needsMigration: boolean;
    needsUi: boolean;
    duplicateConcepts: string[];
  };
  modelReuse: string[];
  boundaryRules: string[];
  continuation: ScratchContinuation;
  additionalContinuations?: ScratchContinuation[];
}

const SCRATCH_SCENARIOS: ScratchScenario[] = [
  {
    id: 'work-intake-backend',
    title: 'Build a complex work intake platform from an empty folder',
    repo: 'empty-greenfield-work-intake-platform',
    taskCategory: 'greenfield-scratch-build',
    requirements: [
      'Build a production-shaped multi-tenant work intake platform from an empty folder.',
      'The product must support organizations, members, role-scoped access, customers, intake requests, assignments, comments, SLA policies, notification preferences, audit events, and a scheduled escalation digest.',
      'Use TypeScript and include enough source, package scripts, persistence shape, and tests or test scaffolds to make the product direction concrete.',
      'Do not install dependencies.',
    ].join(' '),
    expectedOutcome: 'A coherent new backend codebase whose architecture supports continued growth without repeatedly rebuilding existing concepts.',
    successCriteria: [
      'A TypeScript project is created from scratch.',
      'The requested product capabilities are represented in source.',
      'Persistence shape and focused tests or test scaffolds are present.',
      'The project can be analyzed into a meaningful codebase graph.',
    ],
    validationCommand: [
      'test -f package.json',
      "test -d src",
      "find src -type f | grep -E '(route|controller|service|repository|model|entity|auth|worker)'",
      "find . -type f | grep -E '(test|spec|__tests__|migrations)'",
    ].join(' && '),
    score: {
      minSourceFiles: 8,
      minInitialTests: 2,
      minContinuationTests: 3,
      needsEntry: true,
      needsService: true,
      needsDataAccess: true,
      needsDomain: true,
      needsTenantAuth: true,
      needsWorker: true,
      needsMigration: true,
      needsUi: false,
      duplicateConcepts: ['organization', 'member', 'customer', 'request', 'comment', 'sla', 'notification', 'audit'],
    },
    modelReuse: [
      'Define each core concept once, then import/reuse it from routes, services, repositories, workers, and tests.',
      'Do not create per-feature Organization, Member, Request, Comment, SLA, Notification, or Audit stand-ins.',
      'When adding later slices, extend the existing service/model boundary instead of creating a parallel feature model.',
    ],
    boundaryRules: [
      'Keep HTTP entry points thin and delegate behavior to services/use-cases.',
      'Keep data access behind repositories or equivalent data modules.',
      'Keep tenant/role enforcement in auth or policy modules and call it from services/routes.',
      'Add migrations for persistence changes; do not represent persistence only as in-memory arrays.',
      'Add focused tests near the behavior they prove.',
    ],
    continuation: {
      repo: 'scratch-built-work-intake-platform',
      taskId: 'scratch-built-work-intake-platform-continuation',
      taskLabel: 'Continue a newly built work intake platform without rebuilding concepts',
      target: 'newly built work intake platform',
      instructions: [
        'Continue the existing codebase by adding customer portal request submission, request attachments, SLA breach notification records, saved operational views, and external webhook intake.',
        'Include persistence evidence and focused tests or test scaffolds for the continuation slice.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      successCriteria: [
        'Customer portal request submission is represented.',
        'Request attachments are represented.',
        'SLA breach notifications are represented.',
        'Saved operational views are represented.',
        'External webhook intake is represented.',
        'A continuation persistence change and focused tests or test scaffolds are present.',
      ],
      relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
      expectedOutcome: 'A second wave of product behavior that grows the scratch-built system without going back to the well on existing domain concepts.',
      fileReadPlan: [
        { file: 'src/models', reason: 'Existing domain concepts to reuse before adding continuation models.' },
        { file: 'src/services', reason: 'Existing behavior boundaries to extend rather than fork.' },
        { file: 'src/repositories', reason: 'Existing data access boundary for new persistence.' },
        { file: 'src/routes', reason: 'Existing route shape for new portal/webhook endpoints.' },
        { file: 'migrations', reason: 'Existing persistence baseline for a continuation migration.' },
        { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
      ],
      modelReuse: [
        'Import and extend existing domain models instead of defining feature-local duplicates.',
        'If a concept already exists, add fields/types near that concept or create a small extension type that references it.',
        'Reuse existing services and repositories as the continuity boundary.',
      ],
      boundaryRules: [
        'Add portal/webhook routes as entry points only; keep behavior in existing services or new services that import existing models.',
        'Add continuation migration files only; do not rewrite the initial schema.',
        'Add focused continuation tests that exercise the existing service boundary.',
      ],
      doNotRebuild: ['Organization', 'Member', 'Customer', 'Request', 'Comment', 'SLA', 'Notification', 'Audit'],
      requiredTerms: [
        { id: 'continuation_portal', label: 'customer portal submission', pattern: /portal|public/i, points: 5 },
        { id: 'continuation_attachments', label: 'request attachments', pattern: /attachment/i, points: 5 },
        { id: 'continuation_sla_breach', label: 'SLA breach notifications', pattern: /sla.*breach|breach.*sla/i, points: 5 },
        { id: 'continuation_views', label: 'saved operational views', pattern: /operational.*view|saved.*view|view.*filter/i, points: 5 },
        { id: 'continuation_webhook', label: 'external webhook intake', pattern: /webhook/i, points: 5 },
      ],
    },
    additionalContinuations: [
      {
        repo: 'scratch-built-work-intake-platform-wave-3',
        taskId: 'scratch-built-work-intake-platform-scale-wave',
        taskLabel: 'Add scale operations without forking the work intake domain',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding escalation windows, request audit exports, customer risk rollups, and digest subscriptions.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel reporting, digest, audit, customer, request, or SLA model chains.',
          'Include persistence evidence and focused tests or test scaffolds for this third slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Escalation windows are represented.',
          'Request audit exports are represented.',
          'Customer risk rollups are represented.',
          'Digest subscriptions are represented.',
          'The slice reuses existing work intake concepts and focused tests or scaffolds are present.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'A third wave of backend behavior that grows the platform through existing domain ownership instead of rebuilding reporting/audit concepts.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing request, SLA, audit, customer, and notification models instead of redefining them.',
          'Attach rollups, exports, subscriptions, and windows to existing IDs.',
          'Keep scale behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep reporting/export orchestration in services; repositories stay data-facing.',
          'Add focused tests for rollup/export/subscription behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'scale_escalation_windows', label: 'escalation windows', pattern: /escalation.*window|window.*escalation/i, points: 5 },
          { id: 'scale_audit_exports', label: 'request audit exports', pattern: /audit.*export|export.*audit/i, points: 5 },
          { id: 'scale_risk_rollups', label: 'customer risk rollups', pattern: /risk.*rollup|rollup.*risk/i, points: 5 },
          { id: 'scale_digest_subscriptions', label: 'digest subscriptions', pattern: /digest.*subscription|subscription.*digest/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-4',
        taskId: 'scratch-built-work-intake-platform-approvals-delegation-wave',
        taskLabel: 'Add approval chains and delegation without forking request ownership',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding approval chains for intake requests, assignment delegation, out-of-office coverage rules, approval audit events.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Approval chains are represented.',
          'Delegated assignments are represented.',
          'Out-of-office coverage is represented.',
          'Approvals append audit events through the existing audit chain.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'A wave of approval and delegation behavior grown through existing request ownership.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'approval_chains', label: 'approval chains', pattern: /approval.*chain|chain.*approval/i, points: 5 },
          { id: 'delegated_assignments', label: 'delegated assignments', pattern: /delegat/i, points: 5 },
          { id: 'out_of_office', label: 'out-of-office coverage', pattern: /out.?of.?office|coverage/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-5',
        taskId: 'scratch-built-work-intake-platform-customer-portal-wave',
        taskLabel: 'Add a customer-facing status surface without duplicating request models',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding customer-visible request status views, customer comment threads on requests, satisfaction ratings on resolution, customer notification preferences reuse.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Customer-visible request status is represented.',
          'Customer comment threads are represented.',
          'Satisfaction ratings are represented.',
          'The surface reuses existing request/comment/notification ownership.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'A customer-facing status surface reusing existing request and comment chains.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'customer_status', label: 'customer-visible status', pattern: /customer.*status|status.*view/i, points: 5 },
          { id: 'customer_comments', label: 'customer comment threads', pattern: /comment/i, points: 5 },
          { id: 'satisfaction_ratings', label: 'satisfaction ratings', pattern: /satisfaction|rating/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-6',
        taskId: 'scratch-built-work-intake-platform-sla-reporting-wave',
        taskLabel: 'Add SLA and workload reporting on top of existing domain chains',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding SLA compliance reports per organization, intake volume trends, assignment workload summaries, report export records.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'SLA compliance reporting is represented.',
          'Intake volume trends are represented.',
          'Workload summaries are represented.',
          'Reports read from existing request/SLA/assignment chains without parallel models.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'Reporting behavior reading from existing SLA and assignment chains.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'sla_compliance', label: 'SLA compliance reports', pattern: /sla.*(report|compliance)|compliance.*sla/i, points: 5 },
          { id: 'volume_trends', label: 'intake volume trends', pattern: /volume.*trend|trend.*volume|intake.*volume/i, points: 5 },
          { id: 'workload_summaries', label: 'workload summaries', pattern: /workload/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-7',
        taskId: 'scratch-built-work-intake-platform-webhook-integrations-wave',
        taskLabel: 'Add outbound webhook integrations without a parallel event system',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding webhook subscriptions for request lifecycle events, signed webhook payloads, delivery retry records, subscription management per organization.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Webhook subscriptions are represented.',
          'Signed payload handling is represented.',
          'Delivery retries are represented.',
          'Webhooks publish existing audit/lifecycle events rather than a new event chain.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'Outbound webhook behavior publishing existing lifecycle events.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'webhook_subscriptions', label: 'webhook subscriptions', pattern: /webhook.*subscript|subscript.*webhook/i, points: 5 },
          { id: 'signed_payloads', label: 'signed payloads', pattern: /sign(ed|ature).*(payload|webhook)|hmac/i, points: 5 },
          { id: 'delivery_retries', label: 'delivery retries', pattern: /retr(y|ies)/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-8',
        taskId: 'scratch-built-work-intake-platform-billing-quotas-wave',
        taskLabel: 'Add plan tiers and request quotas reusing organization ownership',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding per-organization plan tiers, request quotas and usage counters, overage events, invoice line generation for overages.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Plan tiers are represented.',
          'Request quotas and usage tracking are represented.',
          'Overage events are represented.',
          'Billing attaches to the existing organization chain with focused tests or scaffolds.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'Billing behavior attached to the existing organization chain.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'plan_tiers', label: 'plan tiers', pattern: /plan.*tier|tier.*plan/i, points: 5 },
          { id: 'request_quotas', label: 'request quotas', pattern: /quota/i, points: 5 },
          { id: 'overage_events', label: 'overage events', pattern: /overage/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-9',
        taskId: 'scratch-built-work-intake-platform-knowledge-layer-wave',
        taskLabel: 'Add canned responses and knowledge linking without duplicating comments',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding canned response templates, resolution templates, links from requests to knowledge articles, usage counts for templates.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Canned responses are represented.',
          'Resolution templates are represented.',
          'Request-to-article links are represented.',
          'Templates integrate with the existing comment/resolution chain.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'Knowledge behavior integrated with the existing comment and resolution chain.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'canned_responses', label: 'canned responses', pattern: /canned.*response|response.*template/i, points: 5 },
          { id: 'resolution_templates', label: 'resolution templates', pattern: /resolution.*template/i, points: 5 },
          { id: 'article_links', label: 'request-to-article links', pattern: /article|knowledge/i, points: 5 },
        ],
      },
      {
        repo: 'scratch-built-work-intake-platform-wave-10',
        taskId: 'scratch-built-work-intake-platform-retention-lifecycle-wave',
        taskLabel: 'Add archival and retention policies without forking request storage',
        target: 'growing work intake platform',
        instructions: [
          'Continue the existing codebase by adding archival policies per organization, data retention schedules, legal hold flags, restore workflows for archived requests.',
          'Reuse the existing organization/customer/request/SLA/notification/audit ownership chain and service/repository boundary.',
          'Do not create parallel model chains for concepts that already exist.',
          'Include persistence evidence and focused tests or test scaffolds for this slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Archival policies are represented.',
          'Retention schedules are represented.',
          'Legal hold is represented.',
          'Archive/restore reuses existing request persistence with focused tests or scaffolds.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'Archival and retention behavior reusing existing request persistence.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing organization, customer, request, SLA, notification, and audit models instead of redefining them.',
          'Attach the new records to existing IDs.',
          'Keep the new behavior under the existing service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep orchestration in services; repositories stay data-facing.',
          'Add focused tests for the new behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Customer', 'Request', 'SLA', 'Notification', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'archival_policies', label: 'archival policies', pattern: /archiv/i, points: 5 },
          { id: 'retention_schedules', label: 'retention schedules', pattern: /retention/i, points: 5 },
          { id: 'legal_hold', label: 'legal hold', pattern: /legal.?hold/i, points: 5 },
        ],
      },
    ],
  },
  {
    id: 'project-manager-saas',
    title: 'Build a project manager SaaS from an empty folder',
    repo: 'empty-greenfield-project-manager-saas',
    taskCategory: 'greenfield-scratch-build',
    requirements: [
      'Build a production-shaped multi-tenant project manager SaaS from an empty folder.',
      'The product must support organizations, workspaces, projects, lists, tasks, assignments, comments, labels, due dates, notification preferences, audit events, and a scheduled overdue-task digest.',
      'Use TypeScript and include enough source, package scripts, persistence shape, and tests or test scaffolds to make the product direction concrete.',
      'Do not install dependencies.',
    ].join(' '),
    expectedOutcome: 'A coherent project-management backend whose architecture supports continued growth without repeatedly rebuilding project, task, assignment, comment, or notification concepts.',
    successCriteria: [
      'A TypeScript project is created from scratch.',
      'Organizations, workspaces, projects, lists, tasks, assignments, comments, labels, due dates, notifications, audit events, and overdue digests are represented.',
      'Persistence shape and focused tests or test scaffolds are present.',
      'The project can be analyzed into a meaningful codebase graph.',
    ],
    validationCommand: [
      'test -f package.json',
      "test -d src",
      "find src -type f | grep -E '(route|controller|service|repository|model|entity|auth|worker|policy)'",
      "find . -type f | grep -E '(test|spec|__tests__|migrations)'",
    ].join(' && '),
    score: {
      minSourceFiles: 8,
      minInitialTests: 2,
      minContinuationTests: 3,
      needsEntry: true,
      needsService: true,
      needsDataAccess: true,
      needsDomain: true,
      needsTenantAuth: true,
      needsWorker: true,
      needsMigration: true,
      needsUi: false,
      duplicateConcepts: ['organization', 'workspace', 'project', 'list', 'task', 'assignment', 'comment', 'label', 'notification', 'audit', 'digest'],
    },
    modelReuse: [
      'Define Organization, Workspace, Project, ProjectList, Task, Assignment, Comment, Label, NotificationPreference, AuditEvent, and OverdueTaskDigest once.',
      'Do not create per-feature project, task, assignment, comment, label, notification, audit, or digest stand-ins.',
      'When adding later slices, extend the existing project/task service and model boundary instead of creating parallel boards, planning, reporting, or collaboration modules.',
    ],
    boundaryRules: [
      'Keep HTTP entry points thin and delegate behavior to services/use-cases.',
      'Keep project/task persistence behind repositories or equivalent data modules.',
      'Keep organization/workspace/role enforcement in auth or policy modules and call it from services/routes.',
      'Add migrations for persistence changes; do not represent project data only as in-memory arrays.',
      'Add focused tests near task planning, assignment, comment, and digest behavior.',
    ],
    continuation: {
      repo: 'scratch-built-project-manager-saas',
      taskId: 'scratch-built-project-manager-saas-continuation',
      taskLabel: 'Continue a project manager SaaS without rebuilding task ownership',
      target: 'newly built project manager SaaS',
      instructions: [
        'Continue the existing codebase by adding recurring tasks, task dependency links, saved board filters, project activity timelines, and external webhook task intake.',
        'Reuse the existing organization/workspace/project/list/task/assignment/comment/notification/audit/digest model chain and service/repository boundary.',
        'Include persistence evidence and focused tests or test scaffolds for the continuation slice.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      successCriteria: [
        'Recurring tasks are represented.',
        'Task dependency links are represented.',
        'Saved board filters are represented.',
        'Project activity timelines are represented.',
        'External webhook task intake is represented.',
        'A continuation persistence change and focused tests or test scaffolds are present.',
      ],
      relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'src/policies', 'migrations', 'tests'],
      expectedOutcome: 'A second wave of project-management behavior that grows the scratch-built system without rebuilding project/task/comment/assignment concepts.',
      fileReadPlan: [
        { file: 'src/models', reason: 'Existing project-management domain concepts to reuse before adding continuation models.' },
        { file: 'src/services', reason: 'Existing behavior boundaries to extend rather than fork.' },
        { file: 'src/repositories', reason: 'Existing data access boundary for project/task persistence.' },
        { file: 'src/routes', reason: 'Existing route shape for task/webhook endpoints.' },
        { file: 'migrations', reason: 'Existing persistence baseline for a continuation migration.' },
        { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
      ],
      modelReuse: [
        'Import and extend existing Organization, Workspace, Project, ProjectList, Task, Assignment, Comment, Label, NotificationPreference, AuditEvent, and OverdueTaskDigest models.',
        'If a concept already exists, add fields/types near that concept or create a small extension type that references it.',
        'Reuse existing services and repositories as the continuity boundary.',
      ],
      boundaryRules: [
        'Add recurring-task/webhook routes as entry points only; keep behavior in existing services or new services that import existing models.',
        'Add continuation migration files only; do not rewrite the initial schema.',
        'Add focused continuation tests that exercise the existing service boundary.',
      ],
      doNotRebuild: ['Organization', 'Workspace', 'Project', 'ProjectList', 'Task', 'Assignment', 'Comment', 'Label', 'NotificationPreference', 'AuditEvent', 'OverdueTaskDigest'],
      requiredTerms: [
        { id: 'continuation_recurring_tasks', label: 'recurring tasks', pattern: /recurring.*task|task.*recurr/i, points: 5 },
        { id: 'continuation_dependencies', label: 'task dependency links', pattern: /dependency|depends/i, points: 5 },
        { id: 'continuation_board_filters', label: 'saved board filters', pattern: /board.*filter|saved.*filter/i, points: 5 },
        { id: 'continuation_activity_timeline', label: 'project activity timelines', pattern: /activity.*timeline|timeline.*activity/i, points: 5 },
        { id: 'continuation_webhook', label: 'external webhook task intake', pattern: /webhook/i, points: 5 },
      ],
    },
    additionalContinuations: [
      {
        repo: 'scratch-built-project-manager-saas-wave-3',
        taskId: 'scratch-built-project-manager-saas-scale-wave',
        taskLabel: 'Add planning and reporting without forking project/task ownership',
        target: 'growing project manager SaaS',
        instructions: [
          'Continue the existing codebase by adding sprint planning windows, workload rollups, project audit export packs, and digest subscriptions.',
          'Reuse the existing organization/workspace/project/list/task/assignment/comment/notification/audit/digest ownership chain and service/repository boundary.',
          'Do not create parallel planning, reporting, board, task, assignment, comment, audit, or digest model chains.',
          'Include persistence evidence and focused tests or test scaffolds for this third slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Sprint planning windows are represented.',
          'Workload rollups are represented.',
          'Project audit export packs are represented.',
          'Digest subscriptions are represented.',
          'The slice reuses existing project-management concepts and focused tests or scaffolds are present.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'A third wave of project-management behavior that grows through existing project/task ownership instead of rebuilding planning/reporting concepts.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing project/task service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing project/task data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing project, task, assignment, comment, notification, audit, and digest models instead of redefining them.',
          'Attach planning windows, rollups, export packs, and subscriptions to existing IDs.',
          'Keep reporting/planning behavior under the existing project/task service and repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep reporting/export orchestration in services; repositories stay data-facing.',
          'Add focused tests for planning/rollup/export/subscription behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Workspace', 'Project', 'ProjectList', 'Task', 'Assignment', 'Comment', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'scale_sprint_windows', label: 'sprint planning windows', pattern: /sprint.*window|planning.*window/i, points: 5 },
          { id: 'scale_workload_rollups', label: 'workload rollups', pattern: /workload.*rollup|rollup.*workload/i, points: 5 },
          { id: 'scale_audit_exports', label: 'project audit export packs', pattern: /audit.*export|export.*audit|export.*pack/i, points: 5 },
          { id: 'scale_digest_subscriptions', label: 'digest subscriptions', pattern: /digest.*subscription|subscription.*digest/i, points: 5 },
        ],
      },
    ],
  },
  {
    id: 'compliance-evidence-backend',
    title: 'Build a compliance evidence platform from an empty folder',
    repo: 'empty-greenfield-compliance-evidence-platform',
    taskCategory: 'greenfield-scratch-build',
    requirements: [
      'Build a production-shaped multi-tenant compliance evidence platform from an empty folder.',
      'The product must support organizations, compliance programs, controls, evidence requests, evidence items, reviewers, control owners, exception policies, audit events, and a scheduled review digest.',
      'Use TypeScript and include enough source, package scripts, persistence shape, and tests or test scaffolds to make the product direction concrete.',
      'Do not install dependencies.',
    ].join(' '),
    expectedOutcome: 'A coherent new compliance backend whose architecture supports continued growth without repeatedly rebuilding evidence, control, reviewer, or audit concepts.',
    successCriteria: [
      'A TypeScript project is created from scratch.',
      'Compliance programs, controls, evidence requests/items, reviewers, owners, exceptions, audit events, and scheduled review digests are represented.',
      'Persistence shape and focused tests or test scaffolds are present.',
      'The project can be analyzed into a meaningful codebase graph.',
    ],
    validationCommand: [
      'test -f package.json',
      "test -d src",
      "find src -type f | grep -E '(route|controller|service|repository|model|entity|auth|worker|policy)'",
      "find . -type f | grep -E '(test|spec|__tests__|migrations)'",
    ].join(' && '),
    score: {
      minSourceFiles: 8,
      minInitialTests: 2,
      minContinuationTests: 3,
      needsEntry: true,
      needsService: true,
      needsDataAccess: true,
      needsDomain: true,
      needsTenantAuth: true,
      needsWorker: true,
      needsMigration: true,
      needsUi: false,
      duplicateConcepts: ['organization', 'program', 'control', 'evidence', 'reviewer', 'owner', 'exception', 'audit', 'digest'],
    },
    modelReuse: [
      'Define Program, Control, EvidenceRequest, EvidenceItem, Reviewer, ControlOwner, ExceptionPolicy, AuditEvent, and ReviewDigest once.',
      'Do not create per-feature control, evidence, reviewer, exception, audit, or digest stand-ins.',
      'When adding later slices, extend the existing compliance service/model boundary instead of creating parallel review or reporting modules.',
    ],
    boundaryRules: [
      'Keep HTTP entry points thin and delegate behavior to services/use-cases.',
      'Keep evidence persistence behind repositories or equivalent data modules.',
      'Keep organization/role enforcement in auth or policy modules and call it from services/routes.',
      'Add migrations for persistence changes; do not represent compliance evidence only as in-memory arrays.',
      'Add focused tests near control/evidence/review behavior.',
    ],
    continuation: {
      repo: 'scratch-built-compliance-evidence-platform',
      taskId: 'scratch-built-compliance-evidence-platform-continuation',
      taskLabel: 'Continue a compliance evidence platform without rebuilding controls',
      target: 'newly built compliance evidence platform',
      instructions: [
        'Continue the existing codebase by adding vendor attestation intake, evidence expiration alerts, reviewer assignment queues, saved evidence views, and external evidence webhook intake.',
        'Reuse the existing organization/program/control/evidence/reviewer/exception/audit/digest model chain and service/repository boundary.',
        'Include persistence evidence and focused tests or test scaffolds for the continuation slice.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      successCriteria: [
        'Vendor attestation intake is represented.',
        'Evidence expiration alerts are represented.',
        'Reviewer assignment queues are represented.',
        'Saved evidence views are represented.',
        'External evidence webhook intake is represented.',
        'A continuation persistence change and focused tests or test scaffolds are present.',
      ],
      relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'src/policies', 'migrations', 'tests'],
      expectedOutcome: 'A second wave of compliance behavior that grows the scratch-built system without rebuilding evidence/control/reviewer/audit concepts.',
      fileReadPlan: [
        { file: 'src/models', reason: 'Existing compliance domain concepts to reuse before adding continuation models.' },
        { file: 'src/services', reason: 'Existing behavior boundaries to extend rather than fork.' },
        { file: 'src/repositories', reason: 'Existing data access boundary for evidence persistence.' },
        { file: 'src/routes', reason: 'Existing route shape for attestation/webhook endpoints.' },
        { file: 'migrations', reason: 'Existing persistence baseline for a continuation migration.' },
        { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
      ],
      modelReuse: [
        'Import and extend existing Program, Control, EvidenceRequest, EvidenceItem, Reviewer, ExceptionPolicy, AuditEvent, and ReviewDigest models.',
        'If a concept already exists, add fields/types near that concept or create a small extension type that references it.',
        'Reuse existing services and repositories as the continuity boundary.',
      ],
      boundaryRules: [
        'Add attestation/webhook routes as entry points only; keep behavior in existing services or new services that import existing models.',
        'Add continuation migration files only; do not rewrite the initial schema.',
        'Add focused continuation tests that exercise the existing service boundary.',
      ],
      doNotRebuild: ['Organization', 'Program', 'Control', 'EvidenceRequest', 'EvidenceItem', 'Reviewer', 'ExceptionPolicy', 'AuditEvent', 'ReviewDigest'],
      requiredTerms: [
        { id: 'continuation_attestation', label: 'vendor attestation intake', pattern: /attestation/i, points: 5 },
        { id: 'continuation_expiration', label: 'evidence expiration alerts', pattern: /expiration|expire/i, points: 5 },
        { id: 'continuation_reviewer_queue', label: 'reviewer assignment queues', pattern: /reviewer.*queue|assignment.*queue|queue.*reviewer/i, points: 5 },
        { id: 'continuation_saved_views', label: 'saved evidence views', pattern: /saved.*evidence.*view|evidence.*view/i, points: 5 },
        { id: 'continuation_webhook', label: 'external evidence webhook intake', pattern: /webhook/i, points: 5 },
      ],
    },
    additionalContinuations: [
      {
        repo: 'scratch-built-compliance-evidence-platform-wave-3',
        taskId: 'scratch-built-compliance-evidence-platform-scale-wave',
        taskLabel: 'Add compliance reporting without forking evidence ownership',
        target: 'growing compliance evidence platform',
        instructions: [
          'Continue the existing codebase by adding control renewal windows, audit evidence export packs, program risk rollups, and review digest subscriptions.',
          'Reuse the existing organization/program/control/evidence/reviewer/exception/audit/digest ownership chain and service/repository boundary.',
          'Do not create parallel reporting, evidence, control, review, audit, or digest model chains.',
          'Include persistence evidence and focused tests or test scaffolds for this third slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Control renewal windows are represented.',
          'Audit evidence export packs are represented.',
          'Program risk rollups are represented.',
          'Review digest subscriptions are represented.',
          'The slice reuses existing compliance concepts and focused tests or scaffolds are present.',
        ],
        relatedPaths: ['src/models', 'src/services', 'src/repositories', 'src/routes', 'src/controllers', 'migrations', 'tests'],
        expectedOutcome: 'A third wave of compliance behavior that grows through existing evidence/control ownership instead of rebuilding reporting/audit concepts.',
        fileReadPlan: [
          { file: 'src/models', reason: 'Existing model ownership to extend.' },
          { file: 'src/services', reason: 'Existing compliance service boundary to reuse.' },
          { file: 'src/repositories', reason: 'Existing evidence data access shape to extend.' },
          { file: 'migrations', reason: 'Existing persistence history for a continuation migration.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Extend existing program, control, evidence, reviewer, exception, audit, and digest models instead of redefining them.',
          'Attach renewal windows, export packs, risk rollups, and subscriptions to existing IDs.',
          'Keep reporting behavior under the existing compliance service/repository ownership.',
        ],
        boundaryRules: [
          'Add only continuation migration files.',
          'Keep reporting/export orchestration in services; repositories stay data-facing.',
          'Add focused tests for renewal/export/rollup/subscription behavior through existing services.',
        ],
        doNotRebuild: ['Organization', 'Program', 'Control', 'Evidence', 'Reviewer', 'Exception', 'Audit', 'Digest', 'Report'],
        requiredTerms: [
          { id: 'scale_renewal_windows', label: 'control renewal windows', pattern: /renewal.*window|window.*renewal/i, points: 5 },
          { id: 'scale_export_packs', label: 'audit evidence export packs', pattern: /evidence.*export|export.*evidence|export.*pack/i, points: 5 },
          { id: 'scale_risk_rollups', label: 'program risk rollups', pattern: /risk.*rollup|rollup.*risk/i, points: 5 },
          { id: 'scale_digest_subscriptions', label: 'review digest subscriptions', pattern: /digest.*subscription|subscription.*digest/i, points: 5 },
        ],
      },
    ],
  },
  {
    id: 'operations-command-center-ui',
    title: 'Build a complex operations command center from an empty folder',
    repo: 'empty-greenfield-operations-command-center',
    taskCategory: 'greenfield-scratch-ui-build',
    requirements: [
      'Build a production-shaped operations command center UI from an empty folder.',
      'The product must support workspaces, dashboards, widgets, analysis readiness, proposal preview status, incidents, alerts, operator tasks, saved views, and notification preferences.',
      'Use TypeScript or JavaScript and include enough source, package scripts, domain contracts, route/view composition, components, services/hooks, and tests or test scaffolds to make the product direction concrete.',
      'Do not install dependencies.',
    ].join(' '),
    expectedOutcome: 'A coherent UI-heavy codebase whose architecture supports continued product growth without rebuilding status, dashboard, workspace, or widget concepts per page.',
    successCriteria: [
      'A TypeScript or JavaScript project is created from scratch.',
      'The requested UI/product capabilities are represented in source.',
      'Route/view, component, service/hook, domain contract, and focused test boundaries are present.',
      'The project can be analyzed into a meaningful codebase graph.',
    ],
    validationCommand: [
      'test -f package.json',
      "test -d src",
      "find src -type f | grep -E '(route|page|view|component|hook|service|model|domain|contract)'",
      "find . -type f | grep -E '(test|spec|__tests__)'",
    ].join(' && '),
    score: {
      minSourceFiles: 7,
      minInitialTests: 1,
      minContinuationTests: 2,
      needsEntry: true,
      needsService: true,
      needsDataAccess: false,
      needsDomain: true,
      needsTenantAuth: false,
      needsWorker: false,
      needsMigration: false,
      needsUi: true,
      duplicateConcepts: ['workspace', 'dashboard', 'widget', 'analysis', 'proposal', 'preview', 'incident', 'alert', 'task', 'view'],
    },
    modelReuse: [
      'Name Workspace, Dashboard, Widget, AnalysisStatus, ProposalPreview, Incident, Alert, and OperatorTask concepts once.',
      'Reuse those models/contracts from routes, components, hooks/services, and tests instead of defining page-local stand-ins.',
      'When adding later UI slices, compose existing services/hooks and components before adding new state models.',
    ],
    boundaryRules: [
      'Keep routes/pages as composition boundaries and keep behavior in services/hooks.',
      'Keep reusable visual sections in components and avoid duplicating status rendering per screen.',
      'Keep domain contracts separate from components so continuation slices can share them.',
      'Add focused tests for visible state and composition behavior.',
    ],
    continuation: {
      repo: 'scratch-built-operations-command-center',
      taskId: 'scratch-built-operations-command-center-continuation',
      taskLabel: 'Continue a newly built operations command center without rebuilding UI state concepts',
      target: 'newly built operations command center',
      instructions: [
        'Continue the existing UI codebase by adding proposal impact timelines, saved comparison overlays, alert triage queues, incident detail drawers, and workspace notification preferences.',
        'Reuse the existing workspace/dashboard/widget/status/preview model chain, route shape, services/hooks, and components.',
        'Include focused tests or test scaffolds for the continuation slice.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      successCriteria: [
        'Proposal impact timelines are represented.',
        'Saved comparison overlays are represented.',
        'Alert triage queues are represented.',
        'Incident detail drawers are represented.',
        'Workspace notification preferences are represented.',
        'Focused continuation tests or test scaffolds are present.',
      ],
      relatedPaths: ['src/domain', 'src/models', 'src/services', 'src/hooks', 'src/components', 'src/routes', 'src/pages', 'tests'],
      expectedOutcome: 'A second wave of UI behavior that grows the scratch-built command center without going back to the well on workspace/dashboard/widget/status concepts.',
      fileReadPlan: [
        { file: 'src/domain', reason: 'Existing UI/product contracts to reuse before adding continuation models.' },
        { file: 'src/services', reason: 'Existing behavior/query boundary to extend rather than fork.' },
        { file: 'src/hooks', reason: 'Existing state/data-loading boundary for UI composition.' },
        { file: 'src/components', reason: 'Existing component style and status rendering to reuse.' },
        { file: 'src/routes', reason: 'Existing route/view shape for new panels.' },
        { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
      ],
      modelReuse: [
        'Import or reference existing Workspace, Dashboard, Widget, AnalysisStatus, ProposalPreview, Incident, Alert, and OperatorTask contracts.',
        'Do not create per-panel workspace/dashboard/widget/status interfaces.',
        'Add continuation-specific models only when they point back to existing IDs.',
      ],
      boundaryRules: [
        'Add panels/components as presentation boundaries only; keep state and derivation in existing services/hooks or extensions.',
        'Keep routes under the existing workspace command-center shape.',
        'Add focused continuation tests that exercise composition through existing services/hooks.',
      ],
      doNotRebuild: ['Workspace', 'Dashboard', 'Widget', 'AnalysisStatus', 'ProposalPreview', 'Incident', 'Alert', 'OperatorTask'],
      requiredTerms: [
        { id: 'continuation_timeline', label: 'proposal impact timelines', pattern: /impact.*timeline|timeline.*impact/i, points: 5 },
        { id: 'continuation_overlays', label: 'saved comparison overlays', pattern: /comparison.*overlay|overlay.*comparison/i, points: 5 },
        { id: 'continuation_triage', label: 'alert triage queues', pattern: /triage/i, points: 5 },
        { id: 'continuation_drawer', label: 'incident detail drawers', pattern: /drawer/i, points: 5 },
        { id: 'continuation_preferences', label: 'workspace notification preferences', pattern: /notification.*preference|preference.*notification/i, points: 5 },
      ],
    },
    additionalContinuations: [
      {
        repo: 'scratch-built-operations-command-center-wave-3',
        taskId: 'scratch-built-operations-command-center-scale-wave',
        taskLabel: 'Add operator collaboration without forking command-center state',
        target: 'growing operations command center',
        instructions: [
          'Continue the existing UI codebase by adding operator handoff notes, incident acknowledgements, assignment rules, and workspace activity summaries.',
          'Reuse the existing workspace/dashboard/widget/status/preview/incident/alert/operator task model chain, route shape, services/hooks, and components.',
          'Do not create a separate collaboration module with its own workspace, incident, alert, task, or activity state models.',
          'Include focused tests or test scaffolds for this third slice.',
          'Write task_success and quality_score into the result JSON when finished.',
        ].join(' '),
        successCriteria: [
          'Operator handoff notes are represented.',
          'Incident acknowledgements are represented.',
          'Assignment rules are represented.',
          'Workspace activity summaries are represented.',
          'The slice reuses existing command-center concepts and focused tests or scaffolds are present.',
        ],
        relatedPaths: ['src/domain', 'src/models', 'src/services', 'src/hooks', 'src/components', 'src/routes', 'src/pages', 'tests'],
        expectedOutcome: 'A third wave of UI behavior that composes existing command-center state instead of rebuilding collaboration state per panel.',
        fileReadPlan: [
          { file: 'src/domain', reason: 'Existing domain contracts to reuse.' },
          { file: 'src/services', reason: 'Existing behavior/query boundary to extend.' },
          { file: 'src/hooks', reason: 'Existing state boundary for UI composition.' },
          { file: 'src/components', reason: 'Existing component style and status rendering to reuse.' },
          { file: 'tests', reason: 'Existing test style for focused continuation tests.' },
        ],
        modelReuse: [
          'Reference existing Workspace, Dashboard, Widget, AnalysisStatus, ProposalPreview, Incident, Alert, and OperatorTask contracts.',
          'Attach handoffs, acknowledgements, rules, and summaries to existing IDs.',
          'Compose through existing services/hooks instead of creating panel-local state silos.',
        ],
        boundaryRules: [
          'Keep routes/pages as composition boundaries.',
          'Keep collaboration derivation in services/hooks.',
          'Add focused tests for composition through existing services/hooks.',
        ],
        doNotRebuild: ['Workspace', 'Dashboard', 'Widget', 'AnalysisStatus', 'ProposalPreview', 'Incident', 'Alert', 'OperatorTask', 'Activity'],
        requiredTerms: [
          { id: 'scale_handoff_notes', label: 'operator handoff notes', pattern: /handoff.*note|note.*handoff/i, points: 5 },
          { id: 'scale_acknowledgements', label: 'incident acknowledgements', pattern: /acknowledg/i, points: 5 },
          { id: 'scale_assignment_rules', label: 'assignment rules', pattern: /assignment.*rule|rule.*assignment/i, points: 5 },
          { id: 'scale_activity_summaries', label: 'workspace activity summaries', pattern: /activity.*summar|summar.*activity/i, points: 5 },
        ],
      },
    ],
  },
];

export async function runAgentScratchBuildBenchmark(args: Args = parseArgs(process.argv.slice(2))): Promise<ScratchBuildReport> {
  if (args.listScenarios) {
    const scenario = scenarioById(args.scenarioId || 'work-intake-backend');
    const emptyScore = emptyScratchScore('list-scenarios');
    const report: ScratchBuildReport = {
      generated_at: new Date().toISOString(),
      status: 'warn',
      score: 0,
      task: {
        id: scenario.id,
        title: `Available scenarios: ${SCRATCH_SCENARIOS.map(item => item.id).join(', ')}`,
        requirements: scenario.requirements,
      },
      guidance_summary: { status: 'list-only', reference_count: 0, recommended_patterns: [], file_plan: [], reuse_decisions: 0 },
      with_klauro: emptyScore,
      without_klauro: emptyScore,
      without_arm_uncoached: args.uncoachedBaseline,
      comparison: { quality_delta: 0, token_reduction_percentage: null, time_reduction_percentage: null, changed_file_delta: null, duplicate_concept_delta: 0 },
      artifacts: { seed_directory: '', output: args.output, markdown: args.markdown },
    };
    await writeScratchBuildReportArtifacts(report, args);
    return report;
  }

  if (args.scoreExistingReport) {
    return rescoreExistingScratchBuildReport(args);
  }

  if (args.continuationOnlyFrom) {
    return runContinuationOnlyScratchBenchmark(args);
  }

  const scenario = scenarioById(args.scenarioId || 'work-intake-backend');
  const references = await loadReferences(args.references.length ? args.references : defaultReferencePaths());
  const guidance = buildGreenfieldArchitectureGuidance({
    planText: scenario.requirements,
    references,
  });
  const seedDirectory = await createEmptySeedDirectory(args.workRoot);
  const initialBuildContext = await buildGreenfieldBuildContext({
    workspacePath: seedDirectory,
    planText: scenario.requirements,
    references,
  });
  const commandConfig: LiveAgentCommandConfig = {
    withKlauro: args.withCmd,
    withoutKlauro: args.withoutCmd,
    workRoot: args.workRoot,
    keepWorkspaces: args.keepWorkspaces,
    timeoutMs: args.timeoutMs,
    testTimeoutMs: 60_000,
    testCommand: buildInitialValidationCommand(scenario),
  };
  let livePair: LiveAgentPairResult | undefined;

  if (args.live) {
    if (!args.withCmd || !args.withoutCmd) {
      throw new Error('Scratch live benchmark requires --agent-with-cmd and --agent-without-cmd.');
    }
    livePair = await runLiveAgentPair({
      repo: scenario.repo,
      repoPath: seedDirectory,
      taskId: scenario.id,
      taskLabel: scenario.title,
      taskCategory: scenario.taskCategory,
      task: {
        task_type: 'modify',
        target: 'empty folder',
        instructions: scenario.requirements,
        success_criteria: scenario.successCriteria,
        related_paths: [],
      } as any,
      expectedOutcome: scenario.expectedOutcome,
      fileReadPlan: [],
      selectedNode: null,
      withoutArmPromptOverrides: args.uncoachedBaseline
        ? buildUncoachedWithoutArmPromptOverrides({
          taskLabel: scenario.title,
          expectedOutcome: scenario.expectedOutcome,
          instructions: scenario.requirements,
          successCriteria: scenario.successCriteria,
        })
        : undefined,
      validationPlan: { commands: commandConfig.testCommand ? [{ command: commandConfig.testCommand }] : [] },
      idiomContext: {
        product: 'klauro_greenfield_scratch_build_guidance',
        plan_intent: guidance.plan_intent,
        reference_scope: guidance.reference_scope,
        capability_memory: guidance.capability_memory,
        existing_overlap: guidance.existing_overlap,
        recommended_architecture: guidance.recommended_architecture,
        build_capsule: initialBuildContext.agent_build_capsule,
        growth_control_plane: initialBuildContext.growth_control_plane,
        large_scale_build_strategy: (guidance as any).large_scale_build_strategy,
        risks: guidance.risks,
        model_reuse: scenario.modelReuse,
        boundary_rules: scenario.boundaryRules,
        validation: {
          needs_migration_evidence: scenario.score.needsMigration,
          min_focused_tests: scenario.score.minInitialTests,
        },
      },
    }, commandConfig);
  }

  const withWorkspace = livePair?.with_klauro.workspace || seedDirectory;
  const withoutWorkspace = livePair?.without_klauro.workspace || seedDirectory;
  const withScore = await scoreScratchWorkspace(withWorkspace, 'Scratch build with Klauro', scenario);
  const withoutScore = livePair
    ? await scoreScratchWorkspace(withoutWorkspace, 'Scratch build without Klauro', scenario)
    : emptyScratchScore('not-run');
  const continuationWaves = livePair && withScore.score > 0 && !args.initialOnly
    ? await runContinuationWavesFromScratchBuild(
      livePair.with_klauro.workspace,
      livePair.without_klauro.workspace,
      references,
      commandConfig,
      scenario,
      args.multiWave,
      args.uncoachedBaseline
    )
    : [];
  const firstContinuationWave = continuationWaves[0];
  const continuationPair = firstContinuationWave?.live_pair;
  const continuationWithScore = firstContinuationWave?.with_klauro;
  const continuationWithoutScore = firstContinuationWave?.without_klauro;
  const qualityDelta = withScore.score - withoutScore.score;
  const tokenReduction = livePair?.evaluation.token_reduction_percentage ?? null;
  const timeReduction = livePair ? percentReduction(livePair.without_klauro.duration_ms, livePair.with_klauro.duration_ms) : null;
  const duplicateConceptDelta = withoutScore.duplicate_concepts.length - withScore.duplicate_concepts.length;
  const continuationQualityDelta = continuationWaves.reduce((total, wave) => total + wave.quality_delta, 0);
  const continuationLiveQualityDelta = continuationWaves.reduce((total, wave) => total + (wave.live_quality_delta || 0), 0);
  const continuationPrecisionDelta = continuationWaves.reduce((total, wave) => total + (wave.changed_file_precision_delta || 0), 0);
  const continuationDuplicateDelta = continuationWaves.reduce((total, wave) => total + wave.duplicate_concept_delta, 0);
  const liveQualityDelta = livePair?.evaluation.quality_score_delta ?? null;
  const qualityTokenTradeoffStatus = classifyQualityTokenTradeoff(qualityDelta, tokenReduction, liveQualityDelta);
  const combinedContinuationDelta = continuationQualityDelta +
    continuationLiveQualityDelta +
    Math.min(20, Math.max(0, Math.round(continuationPrecisionDelta / 10)));
  const score = livePair
    ? Math.round((
      withScore.score +
      (continuationWaves.at(-1)?.with_klauro.score || withScore.score) +
      Math.max(-20, Math.min(30, qualityDelta + combinedContinuationDelta)) +
      (duplicateConceptDelta + continuationDuplicateDelta > 0 ? 5 : 0)
    ) / 2.35)
    : withScore.score;
  const baseStatus = livePair
    ? withScore.score >= 82 &&
      (!continuationWaves.length || continuationWaves.every(wave => wave.with_klauro.score >= 82)) &&
      (qualityDelta > 0 || combinedContinuationDelta > 0 || duplicateConceptDelta + continuationDuplicateDelta > 0)
      ? 'pass'
      : withScore.score >= 70 ? 'warn' : 'fail'
    : 'warn';
  const status = (
    qualityTokenTradeoffStatus === 'token-regression-without-quality-win' ||
    qualityTokenTradeoffStatus === 'quality-win-token-regression-too-large'
  ) && baseStatus === 'pass'
    ? 'warn'
    : baseStatus;

  const report: ScratchBuildReport = {
    generated_at: new Date().toISOString(),
    status,
    score: Math.min(100, Math.max(0, score)),
    task: {
      id: scenario.id,
      title: scenario.title,
      requirements: scenario.requirements,
    },
    guidance_summary: {
      status: String(guidance.status),
      reference_count: guidance.reference_scope.count,
      recommended_patterns: guidance.recommended_architecture.patterns.map(pattern => pattern.name).slice(0, 8),
      file_plan: guidance.recommended_architecture.file_plan.map(file => file.path).slice(0, 12),
      reuse_decisions: guidance.capability_memory.reuse_decisions_required.length,
    },
    live_pair: livePair,
    continuation_pair: continuationPair,
    continuation_waves: continuationWaves.length ? continuationWaves : undefined,
    without_arm_uncoached: args.uncoachedBaseline,
    with_klauro: withScore,
    without_klauro: withoutScore,
    continuation: continuationWithScore && continuationWithoutScore ? {
      with_klauro: continuationWithScore,
      without_klauro: continuationWithoutScore,
      quality_delta: continuationWithScore.score - continuationWithoutScore.score,
      duplicate_concept_delta: continuationWithoutScore.duplicate_concepts.length - continuationWithScore.duplicate_concepts.length,
    } : undefined,
    comparison: {
      quality_delta: qualityDelta,
      live_quality_delta: liveQualityDelta,
      token_reduction_percentage: tokenReduction,
      quality_token_tradeoff_status: qualityTokenTradeoffStatus,
      time_reduction_percentage: timeReduction,
      changed_file_delta: livePair ? livePair.without_klauro.files_changed - livePair.with_klauro.files_changed : null,
      duplicate_concept_delta: duplicateConceptDelta,
    },
    artifacts: {
      seed_directory: seedDirectory,
      output: args.output,
      markdown: args.markdown,
    },
  };

  await writeScratchBuildReportArtifacts(report, args);
  return report;
}

async function runContinuationOnlyScratchBenchmark(args: Args): Promise<ScratchBuildReport> {
  if (!args.continuationOnlyFrom) throw new Error('Missing --continuation-only-from');
  if (!args.live || !args.withCmd || !args.withoutCmd) {
    throw new Error('Continuation-only scratch benchmark requires --live, --agent-with-cmd, and --agent-without-cmd.');
  }
  const scenario = scenarioById(args.scenarioId || 'work-intake-backend');
  const sourceWorkspace = path.resolve(args.continuationOnlyFrom);
  const references = await loadReferences(args.references.length ? args.references : defaultReferencePaths());
  const commandConfig: LiveAgentCommandConfig = {
    withKlauro: args.withCmd,
    withoutKlauro: args.withoutCmd,
    workRoot: args.workRoot,
    keepWorkspaces: args.keepWorkspaces,
    timeoutMs: args.timeoutMs,
    testTimeoutMs: 60_000,
    testCommand: scenario.validationCommand,
  };
  const continuationPair = await runContinuationFromScratchBuild(
    sourceWorkspace,
    sourceWorkspace,
    await buildContinuationGuidance(sourceWorkspace, scenario, references),
    commandConfig,
    scenario,
    scenario.continuation,
    args.uncoachedBaseline
  );
  const continuationWithScore = await scoreScratchWorkspace(continuationPair.with_klauro.workspace, 'Scratch continuation with Klauro', scenario, 'continuation', scenario.continuation);
  const continuationWithoutScore = await scoreScratchWorkspace(continuationPair.without_klauro.workspace, 'Scratch continuation without Klauro', scenario, 'continuation', scenario.continuation);
  const continuationQualityDelta = continuationWithScore.score - continuationWithoutScore.score;
  const continuationDuplicateDelta = continuationWithoutScore.duplicate_concepts.length - continuationWithScore.duplicate_concepts.length;
  const score = Math.max(0, Math.min(100, Math.round((
    continuationWithScore.score +
    Math.max(-20, Math.min(20, continuationQualityDelta)) +
    Math.max(-10, Math.min(10, continuationPair.evaluation.token_reduction_percentage ?? 0))
  ) / 1.2)));
  const status = continuationWithScore.score >= 82 &&
    continuationQualityDelta >= 0 &&
    continuationPair.evaluation.with_klauro_success
    ? 'pass'
    : continuationWithScore.score >= 70 ? 'warn' : 'fail';

  const report: ScratchBuildReport = {
    generated_at: new Date().toISOString(),
    status,
    score,
    task: {
      id: scenario.continuation.taskId,
      title: scenario.continuation.taskLabel,
      requirements: scenario.continuation.instructions,
    },
    guidance_summary: {
      status: 'continuation-only',
      reference_count: references.length + 1,
      recommended_patterns: [],
      file_plan: (await buildContinuationFileReadPlan(sourceWorkspace, scenario, scenario.continuation)).map(item => item.file).slice(0, 12),
      reuse_decisions: 0,
    },
    continuation_pair: continuationPair,
    without_arm_uncoached: args.uncoachedBaseline,
    with_klauro: continuationWithScore,
    without_klauro: continuationWithoutScore,
    continuation: {
      with_klauro: continuationWithScore,
      without_klauro: continuationWithoutScore,
      quality_delta: continuationQualityDelta,
      duplicate_concept_delta: continuationDuplicateDelta,
    },
    comparison: {
      quality_delta: continuationQualityDelta,
      live_quality_delta: continuationPair.evaluation.quality_score_delta,
      token_reduction_percentage: continuationPair.evaluation.token_reduction_percentage,
      time_reduction_percentage: percentReduction(continuationPair.without_klauro.duration_ms, continuationPair.with_klauro.duration_ms),
      changed_file_delta: continuationPair.without_klauro.files_changed - continuationPair.with_klauro.files_changed,
      duplicate_concept_delta: continuationDuplicateDelta,
    },
    artifacts: {
      seed_directory: sourceWorkspace,
      output: args.output,
      markdown: args.markdown,
    },
  };
  await writeScratchBuildReportArtifacts(report, args);
  return report;
}

async function runContinuationWavesFromScratchBuild(
  initialWithWorkspace: string,
  initialWithoutWorkspace: string,
  references: GreenfieldReferenceAnalysis[],
  commandConfig: LiveAgentCommandConfig,
  scenario: ScratchScenario,
  multiWave: boolean,
  uncoachedBaseline: boolean
): Promise<ScratchContinuationWaveReport[]> {
  const continuations = multiWave
    ? [scenario.continuation, ...(scenario.additionalContinuations || [])]
    : [scenario.continuation];
  const waves: ScratchContinuationWaveReport[] = [];
  let withWorkspace = initialWithWorkspace;
  let withoutWorkspace = initialWithoutWorkspace;

  for (const [index, continuation] of continuations.entries()) {
    const guidance = await buildContinuationGuidance(withWorkspace, scenario, references, continuation);
    const livePair = await runContinuationFromScratchBuild(
      withWorkspace,
      withoutWorkspace,
      guidance,
      commandConfig,
      scenario,
      continuation,
      uncoachedBaseline
    );
    const withScore = await scoreScratchWorkspace(livePair.with_klauro.workspace, `Scratch continuation wave ${index + 1} with Klauro`, scenario, 'continuation', continuation);
    const withoutScore = await scoreScratchWorkspace(livePair.without_klauro.workspace, `Scratch continuation wave ${index + 1} without Klauro`, scenario, 'continuation', continuation);
    waves.push({
      wave: index + 1,
      task_id: continuation.taskId,
      title: continuation.taskLabel,
      live_pair: livePair,
      with_klauro: withScore,
      without_klauro: withoutScore,
      quality_delta: withScore.score - withoutScore.score,
      live_quality_delta: livePair.evaluation.quality_score_delta,
      changed_file_precision_delta: livePair.evaluation.changed_file_precision_delta,
      completion_score_delta: livePair.evaluation.completion_score_delta,
      duplicate_concept_delta: withoutScore.duplicate_concepts.length - withScore.duplicate_concepts.length,
      token_reduction_percentage: livePair.evaluation.token_reduction_percentage,
      time_reduction_percentage: percentReduction(livePair.without_klauro.duration_ms, livePair.with_klauro.duration_ms),
      changed_file_delta: livePair.without_klauro.files_changed - livePair.with_klauro.files_changed,
    });
    withWorkspace = livePair.with_klauro.workspace;
    withoutWorkspace = livePair.without_klauro.workspace;
  }

  return waves;
}

async function writeScratchBuildReportArtifacts(report: ScratchBuildReport, args: Args): Promise<void> {
  const outputPath = args.output ? resolveCliPath(args.output) : undefined;
  const markdownPath = args.markdown ? resolveCliPath(args.markdown) : undefined;
  if (outputPath) report.artifacts.output = outputPath;
  if (markdownPath) report.artifacts.markdown = markdownPath;
  if (args.output) {
    await fs.ensureDir(path.dirname(outputPath!));
    await fs.writeJson(outputPath!, report, { spaces: 2 });
  }
  if (args.markdown) {
    await fs.ensureDir(path.dirname(markdownPath!));
    await fs.writeFile(markdownPath!, formatScratchBuildMarkdown(report), 'utf8');
  }
}

async function rescoreExistingScratchBuildReport(args: Args): Promise<ScratchBuildReport> {
  if (!args.scoreExistingReport) throw new Error('Missing --score-existing-report');
  const previous = await fs.readJson(resolveReadableCliPath(args.scoreExistingReport)) as ScratchBuildReport;
  const scenario = scenarioById(args.scenarioId || previous.task?.id || 'work-intake-backend');
  const livePair = previous.live_pair;
  if (!livePair) throw new Error('Existing scratch report does not contain a live_pair to rescore.');
  const continuationPair = previous.continuation_pair;
  const liveEvaluationInput = await fs.readJson(livePair.artifacts.evaluation_input_file).catch(() => null);
  if (liveEvaluationInput?.input) {
    livePair.evaluation = await evaluateLivePairDeterministically(liveEvaluationInput.input, livePair.with_klauro, livePair.without_klauro);
  }
  const withScore = await scoreScratchWorkspace(livePair.with_klauro.workspace, 'Scratch build with Klauro', scenario);
  const withoutScore = await scoreScratchWorkspace(livePair.without_klauro.workspace, 'Scratch build without Klauro', scenario);
  const continuationWaves = previous.continuation_waves?.length
    ? await Promise.all(previous.continuation_waves.map(async (wave, index) => {
      const continuation = continuationByTaskId(scenario, wave.task_id);
      const liveWave = wave.live_pair;
      if (liveWave) {
        const evaluationInput = await fs.readJson(liveWave.artifacts.evaluation_input_file).catch(() => null);
        if (evaluationInput?.input) {
          liveWave.evaluation = await evaluateLivePairDeterministically(evaluationInput.input, liveWave.with_klauro, liveWave.without_klauro);
        }
      }
      const withWaveScore = liveWave
        ? await scoreScratchWorkspace(liveWave.with_klauro.workspace, `Scratch continuation wave ${index + 1} with Klauro`, scenario, 'continuation', continuation)
        : wave.with_klauro;
      const withoutWaveScore = liveWave
        ? await scoreScratchWorkspace(liveWave.without_klauro.workspace, `Scratch continuation wave ${index + 1} without Klauro`, scenario, 'continuation', continuation)
        : wave.without_klauro;
      return {
        ...wave,
        live_pair: liveWave,
        with_klauro: withWaveScore,
        without_klauro: withoutWaveScore,
        quality_delta: withWaveScore.score - withoutWaveScore.score,
        live_quality_delta: liveWave?.evaluation.quality_score_delta ?? wave.live_quality_delta ?? null,
        changed_file_precision_delta: liveWave?.evaluation.changed_file_precision_delta ?? wave.changed_file_precision_delta ?? null,
        completion_score_delta: liveWave?.evaluation.completion_score_delta ?? wave.completion_score_delta ?? null,
        duplicate_concept_delta: withoutWaveScore.duplicate_concepts.length - withWaveScore.duplicate_concepts.length,
        token_reduction_percentage: liveWave?.evaluation.token_reduction_percentage ?? wave.token_reduction_percentage,
        time_reduction_percentage: liveWave ? percentReduction(liveWave.without_klauro.duration_ms, liveWave.with_klauro.duration_ms) : wave.time_reduction_percentage,
        changed_file_delta: liveWave ? liveWave.without_klauro.files_changed - liveWave.with_klauro.files_changed : wave.changed_file_delta,
      };
    }))
    : [];
  if (!continuationWaves.length && continuationPair) {
    const continuationEvaluationInput = await fs.readJson(continuationPair.artifacts.evaluation_input_file).catch(() => null);
    if (continuationEvaluationInput?.input) {
      continuationPair.evaluation = await evaluateLivePairDeterministically(continuationEvaluationInput.input, continuationPair.with_klauro, continuationPair.without_klauro);
    }
  }
  const firstWave = continuationWaves[0];
  const continuationWithScore = firstWave?.with_klauro || (continuationPair
    ? await scoreScratchWorkspace(continuationPair.with_klauro.workspace, 'Scratch continuation with Klauro', scenario, 'continuation')
    : undefined);
  const continuationWithoutScore = firstWave?.without_klauro || (continuationPair
    ? await scoreScratchWorkspace(continuationPair.without_klauro.workspace, 'Scratch continuation without Klauro', scenario, 'continuation')
    : undefined);
  const qualityDelta = withScore.score - withoutScore.score;
  const continuationQualityDelta = continuationWaves.length
    ? continuationWaves.reduce((total, wave) => total + wave.quality_delta, 0)
    : continuationWithScore && continuationWithoutScore
      ? continuationWithScore.score - continuationWithoutScore.score
      : 0;
  const continuationLiveQualityDelta = continuationWaves.reduce((total, wave) => total + (wave.live_quality_delta || 0), 0);
  const continuationPrecisionDelta = continuationWaves.reduce((total, wave) => total + (wave.changed_file_precision_delta || 0), 0);
  const duplicateConceptDelta = withoutScore.duplicate_concepts.length - withScore.duplicate_concepts.length;
  const continuationDuplicateDelta = continuationWaves.length
    ? continuationWaves.reduce((total, wave) => total + wave.duplicate_concept_delta, 0)
    : continuationWithScore && continuationWithoutScore
      ? continuationWithoutScore.duplicate_concepts.length - continuationWithScore.duplicate_concepts.length
      : 0;
  const combinedContinuationDelta = continuationQualityDelta +
    continuationLiveQualityDelta +
    Math.min(20, Math.max(0, Math.round(continuationPrecisionDelta / 10)));
  const liveQualityDelta = livePair.evaluation.quality_score_delta ?? null;
  const qualityTokenTradeoffStatus = classifyQualityTokenTradeoff(qualityDelta, livePair.evaluation.token_reduction_percentage, liveQualityDelta);
  const score = Math.round((
    withScore.score +
    (continuationWithScore?.score || withScore.score) +
    Math.max(-20, Math.min(30, qualityDelta + combinedContinuationDelta)) +
    (duplicateConceptDelta + continuationDuplicateDelta > 0 ? 5 : 0)
  ) / 2.35);
  const baseStatus = withScore.score >= 82 &&
    (!continuationWaves.length || continuationWaves.every(wave => wave.with_klauro.score >= 82)) &&
    (qualityDelta > 0 || combinedContinuationDelta > 0 || duplicateConceptDelta + continuationDuplicateDelta > 0)
    ? 'pass'
    : withScore.score >= 70 ? 'warn' : 'fail';
  const status = (
    qualityTokenTradeoffStatus === 'token-regression-without-quality-win' ||
    qualityTokenTradeoffStatus === 'quality-win-token-regression-too-large'
  ) && baseStatus === 'pass'
    ? 'warn'
    : baseStatus;

  const report: ScratchBuildReport = {
    ...previous,
    generated_at: new Date().toISOString(),
    status,
    score: Math.min(100, Math.max(0, score)),
    without_arm_uncoached: previous.without_arm_uncoached ?? false,
    with_klauro: withScore,
    without_klauro: withoutScore,
    continuation_waves: continuationWaves.length ? continuationWaves : previous.continuation_waves,
    continuation: continuationWithScore && continuationWithoutScore ? {
      with_klauro: continuationWithScore,
      without_klauro: continuationWithoutScore,
      quality_delta: continuationQualityDelta,
      duplicate_concept_delta: continuationDuplicateDelta,
    } : undefined,
    comparison: {
      quality_delta: qualityDelta,
      live_quality_delta: liveQualityDelta,
      token_reduction_percentage: livePair.evaluation.token_reduction_percentage,
      quality_token_tradeoff_status: qualityTokenTradeoffStatus,
      time_reduction_percentage: percentReduction(livePair.without_klauro.duration_ms, livePair.with_klauro.duration_ms),
      changed_file_delta: livePair.without_klauro.files_changed - livePair.with_klauro.files_changed,
      duplicate_concept_delta: duplicateConceptDelta,
    },
    artifacts: {
      ...previous.artifacts,
      output: args.output,
      markdown: args.markdown,
    },
  };
  await writeScratchBuildReportArtifacts(report, args);
  return report;
}

function resolveCliPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const initCwd = process.env.INIT_CWD;
  if (initCwd && value.startsWith('apps/')) return path.resolve(initCwd, value);
  return path.resolve(value);
}

function resolveReadableCliPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const direct = path.resolve(value);
  if (fs.existsSync(direct)) return direct;
  const initCwd = process.env.INIT_CWD;
  if (initCwd) {
    const fromInit = path.resolve(initCwd, value);
    if (fs.existsSync(fromInit)) return fromInit;
  }
  return direct;
}

async function runContinuationFromScratchBuild(
  withRepoPath: string,
  withoutRepoPath: string,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>,
  config: LiveAgentCommandConfig,
  scenario: ScratchScenario,
  continuation: ScratchContinuation,
  uncoachedBaseline: boolean
): Promise<LiveAgentPairResult> {
  const fileReadPlan = await buildContinuationFileReadPlan(withRepoPath, scenario, continuation);
  const continuationBuildContext = await buildGreenfieldBuildContext({
    workspacePath: withRepoPath,
    planText: continuation.instructions,
  });
  const continuationValidationCommand = buildContinuationValidationCommand(scenario, continuation);
  const continuationConfig = {
    ...config,
    testCommand: continuationValidationCommand,
  };
  return runLiveAgentPairFromWorkspaces({
    repo: continuation.repo,
    repoPath: withRepoPath,
    taskId: continuation.taskId,
    taskLabel: continuation.taskLabel,
    taskCategory: `${scenario.taskCategory}-continuation`,
    task: {
      task_type: 'modify',
      target: continuation.target,
      instructions: continuation.instructions,
      success_criteria: continuation.successCriteria,
      related_paths: continuation.relatedPaths,
    } as any,
    expectedOutcome: continuation.expectedOutcome,
    fileReadPlan,
    selectedNode: null,
    withoutArmPromptOverrides: uncoachedBaseline
      ? buildUncoachedWithoutArmPromptOverrides({
        taskLabel: continuation.taskLabel,
        expectedOutcome: continuation.expectedOutcome,
        instructions: continuation.instructions,
        successCriteria: continuation.successCriteria,
      })
      : undefined,
    validationPlan: { commands: [{ command: continuationValidationCommand }] },
    idiomContext: {
      product: 'klauro_scratch_continuation_guidance',
      continuation_execution_brief: buildContinuationExecutionBrief(fileReadPlan, scenario, continuation),
      plan_intent: guidance.plan_intent,
      capability_memory: guidance.capability_memory,
      recommended_architecture: guidance.recommended_architecture,
      build_capsule: continuationBuildContext.agent_build_capsule,
      growth_control_plane: continuationBuildContext.growth_control_plane,
      large_scale_build_strategy: (guidance as any).large_scale_build_strategy,
      model_reuse: continuation.modelReuse,
      boundary_rules: continuation.boundaryRules,
      do_not_rebuild: continuation.doNotRebuild,
    },
  }, continuationConfig, { withKlauroRepoPath: withRepoPath, withoutKlauroRepoPath: withoutRepoPath });
}

function buildContinuationExecutionBrief(
  fileReadPlan: Array<{ file: string; reason: string }>,
  scenario: ScratchScenario,
  continuation: ScratchContinuation
) {
  return {
    task: continuation.taskLabel,
    read_first: fileReadPlan.slice(0, 4).map(item => ({
      file: item.file,
      reason: item.reason,
    })),
    update_scope: [
      'Extend the existing owner files named in read_first before creating a new boundary.',
      scenario.score.needsMigration
        ? 'Create only files needed for the requested continuation behavior, focused tests, and a new migration file under migrations/; updating an existing schema file alone does not count as continuation migration evidence.'
        : 'Create only files needed for the requested continuation behavior and focused tests.',
      'Do not re-list the whole repository, read generated output, or read unrelated reference projects unless read_first proves insufficient.',
    ],
    must_represent: continuation.requiredTerms.slice(0, 6).map(term => term.label),
    reuse: continuation.modelReuse.slice(0, 3),
    boundaries: continuation.boundaryRules.slice(0, 4),
    validation: {
      command: buildContinuationValidationCommand(scenario, continuation),
      needs_migration_evidence: scenario.score.needsMigration,
      min_focused_tests: scenario.score.minContinuationTests,
    },
  };
}

function buildContinuationValidationCommand(scenario: ScratchScenario, continuation: ScratchContinuation): string {
  const requiredPatterns = continuation.requiredTerms.map(term => ({
    id: term.id,
    label: term.label,
    source: term.pattern.source,
    flags: term.pattern.flags.includes('i') ? term.pattern.flags : `${term.pattern.flags}i`,
  }));
  const script = `
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const ignored = new Set(['.git','node_modules','dist','build','target','coverage','.next','.turbo','.cache','.venv','venv','env']);
const files = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\\\/g, '/'));
  }
}
visit(root);
const candidateFiles = files.filter(file => /\\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md)$/i.test(file) && !/(^|\\/)\\.klauro-live-(metrics|result)\\.json$/.test(file));
const text = candidateFiles.map(file => file + '\\n' + fs.readFileSync(path.join(root, file), 'utf8')).join('\\n');
const sourceFiles = candidateFiles.filter(file => /(^|\\/)(src|app|lib|packages|services)\\//.test(file) && /\\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
const tests = candidateFiles.filter(file => /(^|\\/)(test|tests|__tests__)\\/|(\\.|-)(test|spec)\\./i.test(file));
const testCases = (text.match(/\\b(?:it|test)\\s*\\(/g) || []).length;
const migrations = candidateFiles.filter(file => /(^|\\/)migrations?\\//i.test(file) || /migration/i.test(file)).length;
const missing = [];
if (!sourceFiles.length) missing.push('source files');
if (tests.length < ${scenario.score.minContinuationTests} && testCases < ${scenario.score.minContinuationTests}) missing.push('focused continuation tests');
${scenario.score.needsMigration ? "if (migrations < 2) missing.push('continuation migration evidence');" : ''}
for (const term of ${JSON.stringify(requiredPatterns)}) {
  const regex = new RegExp(term.source, term.flags);
  if (!regex.test(text)) missing.push(term.label);
}
if (missing.length) {
  console.error('Missing continuation evidence: ' + missing.join(', '));
  process.exit(1);
}
`;
  return `node -e ${shellSingleQuote(script)}`;
}

function buildInitialValidationCommand(scenario: ScratchScenario): string {
  const minimumSourceFiles = Math.min(5, scenario.score.minSourceFiles);
  const script = `
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const ignored = new Set(['.git','node_modules','dist','build','target','coverage','.next','.turbo','.cache','.venv','venv','env']);
const files = [];
function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\\\/g, '/'));
  }
}
visit(root);
const candidateFiles = files.filter(file => /\\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md)$/i.test(file) && !/(^|\\/)\\.klauro-live-(metrics|result)\\.json$/.test(file));
const text = candidateFiles.map(file => file + '\\n' + fs.readFileSync(path.join(root, file), 'utf8')).join('\\n');
const sourceFiles = candidateFiles.filter(file => /(^|\\/)(src|app|lib|packages|services)\\//.test(file) && /\\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
const tests = candidateFiles.filter(file => /(^|\\/)(test|tests|__tests__)\\/|(\\.|-)(test|spec)\\./i.test(file));
const testCases = (text.match(/\\b(?:it|test)\\s*\\(/g) || []).length;
const migrations = candidateFiles.filter(file => /(^|\\/)migrations?\\//i.test(file) || /migration/i.test(file)).length;
const missing = [];
if (!fs.existsSync(path.join(root, 'package.json'))) missing.push('package manifest');
if (!fs.existsSync(path.join(root, 'src'))) missing.push('src directory');
if (sourceFiles.length < ${minimumSourceFiles}) missing.push('source structure');
if (tests.length < ${scenario.score.minInitialTests} && testCases < ${scenario.score.minInitialTests}) missing.push('focused tests');
${scenario.score.needsMigration ? "if (migrations < 1) missing.push('migration evidence');" : ''}
if (missing.length) {
  console.error('Missing initial evidence: ' + missing.join(', '));
  process.exit(1);
}
`;
  return `node -e ${shellSingleQuote(script)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function buildContinuationGuidance(
  repoPath: string,
  scenario: ScratchScenario,
  references: GreenfieldReferenceAnalysis[],
  continuation: ScratchContinuation = scenario.continuation
): Promise<ReturnType<typeof buildGreenfieldArchitectureGuidance>> {
  try {
    const cas = await analyzeForBench(repoPath);
    return buildGreenfieldArchitectureGuidance({
      planText: continuation.instructions,
      references: [
        {
          path: repoPath,
          name: `scratch-${scenario.id}`,
          cas,
        },
        ...references,
      ],
    });
  } catch {
    return buildGreenfieldArchitectureGuidance({
      planText: continuation.instructions,
      references,
    });
  }
}

async function buildContinuationFileReadPlan(repoPath: string, scenario: ScratchScenario, continuation: ScratchContinuation = scenario.continuation): Promise<Array<{ file: string; reason: string }>> {
  const files = await listWorkspaceFiles(repoPath);
  const continuationText = `${continuation.instructions}\n${continuation.requiredTerms.map(term => term.label).join('\n')}`.toLowerCase();
  const ranked = files
    .filter(file => isSourcePath(file) || isTestPath(file) || /migrations?\//i.test(file))
    .filter(file => !/(^|\/)(dist|build|coverage)\//i.test(file))
    .map(file => ({
      file,
      score: scoreContinuationReadFile(file, continuationText),
      reason: continuationReadReason(file, continuation.taskLabel),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const unique = new Map<string, { file: string; reason: string }>();
  for (const item of ranked) {
    if (!unique.has(item.file)) unique.set(item.file, { file: item.file, reason: item.reason });
  }
  const result = Array.from(unique.values()).slice(0, 8);
  return result.length ? result : continuation.fileReadPlan;
}

function scoreContinuationReadFile(file: string, continuationText: string): number {
  const normalized = file.toLowerCase();
  let score = 0;
  if (/src\/services\//.test(normalized)) score += 60;
  if (/src\/http|src\/routes|src\/controllers/.test(normalized)) score += 42;
  if (/src\/models|src\/domain|entities/.test(normalized)) score += 36;
  if (/src\/repositories|src\/persistence/.test(normalized)) score += 30;
  if (/migrations?\//.test(normalized)) score += 72;
  if (isTestPath(file)) score += 18;
  if (/index\./.test(normalized)) score -= 20;
  if (/package\.json|tsconfig|readme|docs\//.test(normalized)) score -= 50;
  for (const token of ['evidence', 'compliance', 'review', 'digest', 'control', 'program', 'audit', 'request', 'sla', 'notification', 'dashboard', 'widget', 'workspace']) {
    if (continuationText.includes(token) && normalized.includes(token)) score += 18;
  }
  return score;
}

function continuationReadReason(file: string, taskLabel: string): string {
  if (/src\/services\//i.test(file)) return `Primary service owner to extend for ${taskLabel}.`;
  if (/src\/http|src\/routes|src\/controllers/i.test(file)) return `Thin entry boundary to extend after service behavior exists.`;
  if (/src\/models|src\/domain|entities/i.test(file)) return `Existing model owner to reference or extend without duplicate concepts.`;
  if (/src\/repositories|src\/persistence/i.test(file)) return `Existing data-access boundary to extend after model/service changes.`;
  if (/migrations?\//i.test(file)) return `Existing persistence history for the required continuation migration.`;
  if (isTestPath(file)) return `Existing focused test style to extend after behavior changes.`;
  return `Existing artifact to reuse for ${taskLabel}.`;
}

async function scoreScratchWorkspace(
  workspace: string,
  title: string,
  scenario: ScratchScenario,
  mode: 'initial' | 'continuation' = 'initial',
  continuation: ScratchContinuation = scenario.continuation
): Promise<ScratchBuildScore> {
  const files = await filesFromWorkspace(workspace);
  if (!files.length) return emptyScratchScore('no-files');
  const preview = await previewGreenfieldCodebase({
    title,
    planText: scenario.requirements,
    proposedFiles: files,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const payload = await getPreviewAnalysis(preview.preview.id);
  const cas = payload.proposed_cas as any;
  const paths = files.map(file => file.path);
  const content = files.map(file => `${file.path}\n${file.content || ''}`).join('\n');
  const findings: string[] = [];
  const dimensions: Record<string, number> = {};
  const sourceFiles = paths.filter(isSourcePath).length;
  const tests = paths.filter(isTestPath).length;
  const testCases = countMatches(content, /\b(?:it|test)\s*\(/g);
  const migrations = paths.filter(file => /(^|\/)migrations?\//i.test(file) || /migration/i.test(file)).length;
  const duplicateConcepts = findDuplicateConcepts(paths, content, scenario.score.duplicateConcepts);
  const hasRoutes = /route|router|controller|http/i.test(paths.join('\n'));
  const hasServices = /service|usecase|use-case|interactor/i.test(paths.join('\n'));
  const hasRepositories = /repository|repositories|persistence|data-access|dao|store/i.test(paths.join('\n'));
  const hasModels = /model|models|entity|entities|domain|schema/i.test(paths.join('\n'));
  const hasUi = /component|page|view|screen|hook/i.test(paths.join('\n'));
  const hasAuthTenant = /auth|tenant|organization|role|permission|policy/i.test(content);
  const hasWorker = /worker|job|digest|schedule|queue/i.test(paths.join('\n') + content);
  const hasSingleSourceImports = /(from ['"].*(models|entities|domain|contracts)|import type .* from)/.test(content);
  const hasPackage = paths.includes('package.json');
  const hasCasGraph = (cas?.nodes?.length || 0) > 0 && (cas?.edges?.length || 0) > 0;
  const capabilities = cas?.system_capabilities?.length || 0;
  const domainConcepts = cas?.domain_concepts?.length || 0;
  const requiredBoundariesPresent = [
    !scenario.score.needsEntry || hasRoutes || hasUi,
    !scenario.score.needsService || hasServices,
    !scenario.score.needsDataAccess || hasRepositories,
    !scenario.score.needsDomain || hasModels,
    !scenario.score.needsUi || hasUi,
    !scenario.score.needsTenantAuth || hasAuthTenant,
    !scenario.score.needsWorker || hasWorker,
  ].every(Boolean);
  const compactCoherentStructure = sourceFiles >= 5 && domainConcepts >= 8 && requiredBoundariesPresent;
  const compactRichStructure = sourceFiles >= 5 && capabilities >= 8 && domainConcepts >= 8;
  const sourceStructureOk = sourceFiles >= scenario.score.minSourceFiles || compactRichStructure || compactCoherentStructure;
  const casCapabilityOk = capabilities >= 4 || (domainConcepts >= 10 && requiredBoundariesPresent);
  const testThreshold = mode === 'continuation' ? scenario.score.minContinuationTests : scenario.score.minInitialTests;
  const migrationThreshold = mode === 'continuation' ? 2 : 1;

  let score = 100;
  const penalize = (condition: boolean, points: number, finding: string, dimension: string) => {
    dimensions[dimension] = condition ? 100 : 0;
    if (!condition) {
      score -= points;
      findings.push(finding);
    }
  };

  penalize(hasPackage, 5, 'No package manifest.', 'package');
  penalize(sourceStructureOk, 10, 'Too little source structure for a complex product.', 'source_structure');
  if (scenario.score.needsEntry) penalize(hasRoutes || hasUi, 10, 'No route/controller/view entry boundary.', 'entry_boundary');
  if (scenario.score.needsService) penalize(hasServices, 10, 'No service/use-case/hook boundary.', 'service_boundary');
  if (scenario.score.needsDataAccess) penalize(hasRepositories, 10, 'No repository/data-access boundary.', 'data_access_boundary');
  if (scenario.score.needsDomain) penalize(hasModels, 8, 'No model/entity/domain boundary.', 'domain_model_boundary');
  if (scenario.score.needsUi) penalize(hasUi, 8, 'No UI page/component/hook boundary.', 'ui_boundary');
  if (scenario.score.needsTenantAuth) penalize(hasAuthTenant, 8, 'No visible tenant/auth/role boundary.', 'tenant_auth_boundary');
  if (scenario.score.needsWorker) penalize(hasWorker, 6, 'No worker/background boundary.', 'worker_boundary');
  if (scenario.score.needsMigration) penalize(migrations >= migrationThreshold, mode === 'continuation' ? 10 : 8, mode === 'continuation' ? 'No continuation migration evidence.' : 'No migration evidence.', 'migration_evidence');
  penalize(tests >= testThreshold || testCases >= testThreshold, mode === 'continuation' ? 9 : 8, mode === 'continuation' ? 'Too little focused continuation test evidence.' : 'Too little focused test evidence.', 'test_evidence');
  penalize(hasSingleSourceImports, 7, 'Does not visibly reuse domain types across boundaries.', 'domain_reuse');
  penalize(duplicateConcepts.length === 0, 12, `Potential duplicate concepts: ${duplicateConcepts.map(item => item.concept).join(', ')}`, 'duplicate_concepts');
  penalize(hasCasGraph, 5, 'Klauro preview did not produce a meaningful graph.', 'cas_graph');
  penalize(casCapabilityOk, 5, 'CAS detected too few capabilities for the product scope.', 'cas_capabilities');

  if (mode === 'continuation') {
    for (const term of continuation.requiredTerms) {
      penalize(term.pattern.test(content), term.points, `Continuation does not represent ${term.label}.`, term.id);
    }
  }

  if (findings.length >= 3) score = Math.min(score, 82);
  if (findings.some(finding => /No route\/controller|No service|No repository|No model/.test(finding))) score = Math.min(score, 88);

  return {
    score: Math.max(0, Math.min(100, score)),
    status: score >= 82 ? 'pass' : score >= 65 ? 'warn' : 'fail',
    findings,
    dimensions,
    file_count: files.length,
    source_files: sourceFiles,
    tests,
    test_cases: testCases,
    migrations,
    duplicate_concepts: duplicateConcepts,
    cas: {
      nodes: cas?.nodes?.length || 0,
      edges: cas?.edges?.length || 0,
      entry_points: cas?.entry_points?.length || 0,
      capabilities,
      domain_concepts: domainConcepts,
      preview_id: preview.preview.id,
      preview_url: preview.preview.preview_url,
    },
  };
}

function emptyScratchScore(reason: string): ScratchBuildScore {
  return {
    score: 0,
    status: 'fail',
    findings: [reason],
    dimensions: {},
    file_count: 0,
    source_files: 0,
    tests: 0,
    test_cases: 0,
    migrations: 0,
    duplicate_concepts: [],
    cas: { nodes: 0, edges: 0, entry_points: 0, capabilities: 0, domain_concepts: 0 },
  };
}

async function createEmptySeedDirectory(workRoot: string): Promise<string> {
  const root = path.join(path.resolve(workRoot), `empty-greenfield-seed-${Date.now()}`);
  await fs.ensureDir(root);
  return root;
}

async function loadReferences(paths: string[]): Promise<GreenfieldReferenceAnalysis[]> {
  const references: GreenfieldReferenceAnalysis[] = [];
  for (const referencePath of paths) {
    const absolute = path.resolve(referencePath);
    if (!(await fs.pathExists(absolute))) continue;
    try {
      const cas = await analyzeForBench(absolute);
      references.push({
        path: absolute,
        name: cas.system?.name || path.basename(absolute),
        cas,
      });
    } catch {
      // Reference context is helpful but not required for the scratch proof.
    }
  }
  return references;
}

function defaultReferencePaths(): string[] {
  return [
    '/Users/michaelshattuck/dev/unravl/proof-of-concept',
    '/Users/michaelshattuck/dev/zerac/zerac-api',
    '/Users/michaelshattuck/dev/soon/soon-ui',
    '/Users/michaelshattuck/dev/money',
    '/Users/michaelshattuck/dev/kadra',
  ];
}

async function filesFromWorkspace(workspace: string): Promise<ProposedFileInput[]> {
  const files = await listWorkspaceFiles(workspace);
  const proposed: ProposedFileInput[] = [];
  for (const file of files) {
    const absolute = path.join(workspace, file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > 500_000) continue;
    proposed.push({ path: file, content: await fs.readFile(absolute, 'utf8'), status: 'added' });
  }
  return proposed;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv']);
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && isCandidateFile(relative)) {
        results.push(relative);
      }
    }
  };
  await visit(root);
  return results.sort();
}

function isCandidateFile(filePath: string): boolean {
  if (/(^|\/)\.klauro-live-(metrics|result)\.json$/.test(filePath)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|php|dart|json|sql|toml|yaml|yml|md)$/.test(filePath);
}

function isSourcePath(filePath: string): boolean {
  return /(^|\/)(src|app|lib|packages|services)\//.test(filePath) && /\.(ts|tsx|js|jsx|py|rs|go|java|cs|php|dart)$/.test(filePath);
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\./i.test(filePath);
}

function findDuplicateConcepts(paths: string[], content: string, concepts: string[]): Array<{ concept: string; files: string[] }> {
  return concepts.flatMap(concept => {
    const matchingFiles = paths.filter(file => {
      const base = path.basename(file).toLowerCase();
      return base.includes(concept) && /model|entity|schema|type|interface|repository|service/i.test(file);
    });
    const conceptName = pascalCaseConcept(concept);
    const definitionCount = countMatches(content, new RegExp(`\\b(interface|class|type)\\s+${conceptName}\\b`, 'g'));
    const distinctDefinitionFiles = matchingFiles.filter(file => /model|entity|schema|type/i.test(file));
    if (definitionCount > 1 && distinctDefinitionFiles.length > 1) {
      return [{ concept, files: matchingFiles.slice(0, 8) }];
    }
    return [];
  });
}

function pascalCaseConcept(concept: string): string {
  return concept
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

const REUSE_COACHING_SENTENCE_PATTERNS: RegExp[] = [
  /reuse the existing/i,
  /reuse existing/i,
  /reuses existing/i,
  /do not create parallel/i,
  /do not create per-feature/i,
  /without parallel models/i,
  /rather than a new event chain/i,
  /through the existing/i,
  /attaches to the existing/i,
  /integrates? with the existing/i,
  /instead of (?:rebuilding|redefining|duplicating|creating a parallel)/i,
];

const REUSE_COACHING_CLAUSE_PATTERNS: RegExp[] = [
  /\s+without (?:repeatedly )?(?:rebuilding|duplicating|forking|going back to the well)[^.]*/gi,
  /\s+instead of (?:rebuilding|redefining|duplicating)[^.]*/gi,
  /\s+(?:grown\s+)?through (?:the\s+)?existing[^.]*/gi,
  /\s+reusing (?:the\s+)?existing[^.]*/gi,
  /\s+reading from (?:the\s+)?existing[^.]*/gi,
  /\s+attached to the existing[^.]*/gi,
  /\s+integrated with the existing[^.]*/gi,
  /\s+on top of existing[^.]*/gi,
];

function containsReuseCoaching(text: string): boolean {
  return REUSE_COACHING_SENTENCE_PATTERNS.some(pattern => pattern.test(text));
}

export function stripReuseCoachingSentences(text: string): string {
  return text
    .split(/(?<=\.)\s+/)
    .filter(sentence => !containsReuseCoaching(sentence))
    .join(' ')
    .trim();
}

export function stripReuseCoachingCriteria(criteria: string[]): string[] {
  return criteria
    .map(line => {
      if (!containsReuseCoaching(line)) return line;
      return /focused tests|test scaffolds|scaffolds/i.test(line)
        ? 'Focused tests or test scaffolds are present.'
        : '';
    })
    .filter(Boolean);
}

export function stripReuseCoachingClauses(text: string): string {
  let result = text;
  for (const pattern of REUSE_COACHING_CLAUSE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(/\bexisting\s+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

export function buildUncoachedWithoutArmPromptOverrides(source: {
  taskLabel: string;
  expectedOutcome: string;
  instructions: string;
  successCriteria: string[];
}): WithoutArmPromptOverrides {
  return {
    taskLabel: stripReuseCoachingClauses(source.taskLabel),
    expectedOutcome: stripReuseCoachingClauses(source.expectedOutcome),
    instructions: stripReuseCoachingSentences(source.instructions),
    successCriteria: stripReuseCoachingCriteria(source.successCriteria),
  };
}

export function scenarioById(id: string): ScratchScenario {
  const scenario = SCRATCH_SCENARIOS.find(item => item.id === id);
  if (!scenario) {
    throw new Error(`Unknown scratch scenario "${id}". Available scenarios: ${SCRATCH_SCENARIOS.map(item => item.id).join(', ')}`);
  }
  return scenario;
}

function continuationByTaskId(scenario: ScratchScenario, taskId: string): ScratchContinuation {
  return [scenario.continuation, ...(scenario.additionalContinuations || [])].find(continuation => continuation.taskId === taskId)
    || scenario.continuation;
}

function countMatches(text: string, regex: RegExp): number {
  return Array.from(text.matchAll(regex)).length;
}

function percentReduction(before: number, after: number): number | null {
  if (!before || before <= 0) return null;
  return Math.round(((before - after) / before) * 100);
}

function classifyQualityTokenTradeoff(
  qualityDelta: number,
  tokenReduction: number | null,
  liveQualityDelta?: number | null,
): NonNullable<ScratchBuildReport['comparison']['quality_token_tradeoff_status']> {
  if (tokenReduction === null) return 'unmeasured';
  const bestQualitySignal = Math.max(qualityDelta, liveQualityDelta ?? Number.NEGATIVE_INFINITY);
  if (tokenReduction >= 0 && bestQualitySignal > 0) return 'clear-win';
  if (tokenReduction >= 0) return 'acceptable';
  if (bestQualitySignal > 0) return tokenReduction >= -5 ? 'acceptable' : 'quality-win-token-regression-too-large';
  return 'token-regression-without-quality-win';
}

function formatScratchBuildMarkdown(report: ScratchBuildReport): string {
  return [
    '# Klauro Scratch Greenfield Build Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Without-arm uncoached: ${report.without_arm_uncoached}`,
    '',
    '## Result',
    '',
    `With Klauro score: ${report.with_klauro.score}/100`,
    `Without Klauro score: ${report.without_klauro.score}/100`,
    `Quality delta: ${report.comparison.quality_delta}`,
    `Live evaluator quality delta: ${report.comparison.live_quality_delta ?? 'unknown'}`,
    `Token reduction: ${report.comparison.token_reduction_percentage ?? 'unknown'}%`,
    `Quality/token tradeoff: ${report.comparison.quality_token_tradeoff_status || 'unknown'}`,
    `Time reduction: ${report.comparison.time_reduction_percentage ?? 'unknown'}%`,
    `Duplicate concept delta: ${report.comparison.duplicate_concept_delta}`,
    report.continuation ? `Continuation with Klauro score: ${report.continuation.with_klauro.score}/100` : '',
    report.continuation ? `Continuation without Klauro score: ${report.continuation.without_klauro.score}/100` : '',
    report.continuation ? `Continuation quality delta: ${report.continuation.quality_delta}` : '',
    report.continuation_waves?.length ? `Continuation waves: ${report.continuation_waves.length}` : '',
    '',
    '## Guidance',
    '',
    `References: ${report.guidance_summary.reference_count}`,
    `Patterns: ${report.guidance_summary.recommended_patterns.join(', ') || 'none'}`,
    `File plan: ${report.guidance_summary.file_plan.join(', ') || 'none'}`,
    `Reuse decisions: ${report.guidance_summary.reuse_decisions}`,
    '',
    '## With Klauro Findings',
    '',
    ...(report.with_klauro.findings.length ? report.with_klauro.findings.map(finding => `- ${finding}`) : ['- none']),
    '',
    '## Without Klauro Findings',
    '',
    ...(report.without_klauro.findings.length ? report.without_klauro.findings.map(finding => `- ${finding}`) : ['- none']),
    '',
    ...(report.continuation ? [
      '## Continuation With Klauro Findings',
      '',
      ...(report.continuation.with_klauro.findings.length ? report.continuation.with_klauro.findings.map(finding => `- ${finding}`) : ['- none']),
      '',
      '## Continuation Without Klauro Findings',
      '',
      ...(report.continuation.without_klauro.findings.length ? report.continuation.without_klauro.findings.map(finding => `- ${finding}`) : ['- none']),
      '',
    ] : []),
    ...(report.continuation_waves?.length ? [
      '## Continuation Waves',
      '',
      ...report.continuation_waves.map(wave => [
        `### Wave ${wave.wave}: ${wave.title}`,
        '',
        `With Klauro score: ${wave.with_klauro.score}/100`,
        `Without Klauro score: ${wave.without_klauro.score}/100`,
        `Workspace quality delta: ${wave.quality_delta}`,
        `Live evaluator quality delta: ${wave.live_quality_delta ?? 'unknown'}`,
        `Changed-file precision delta: ${wave.changed_file_precision_delta ?? 'unknown'}`,
        `Completion score delta: ${wave.completion_score_delta ?? 'unknown'}`,
        `Duplicate concept delta: ${wave.duplicate_concept_delta}`,
        `Token reduction: ${wave.token_reduction_percentage ?? 'unknown'}%`,
        `Changed file delta: ${wave.changed_file_delta ?? 'unknown'}`,
        '',
      ].join('\n')),
    ] : []),
    '## CAS',
    '',
    `With Klauro: ${report.with_klauro.cas.nodes} nodes, ${report.with_klauro.cas.edges} edges, ${report.with_klauro.cas.capabilities} capabilities`,
    `Without Klauro: ${report.without_klauro.cas.nodes} nodes, ${report.without_klauro.cas.edges} edges, ${report.without_klauro.cas.capabilities} capabilities`,
    '',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    live: false,
    workRoot: path.join(process.env.HOME || process.cwd(), '.klauro', 'scratch-build-benchmark'),
    keepWorkspaces: true,
    references: [],
    scenarioId: undefined,
    listScenarios: false,
    multiWave: false,
    initialOnly: false,
    uncoachedBaseline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') args.live = true;
    else if (arg === '--agent-with-cmd') args.withCmd = argv[++index];
    else if (arg === '--agent-without-cmd') args.withoutCmd = argv[++index];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (arg === '--work-root') args.workRoot = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--markdown') args.markdown = argv[++index];
    else if (arg === '--reference') args.references.push(argv[++index]);
    else if (arg === '--score-existing-report') args.scoreExistingReport = argv[++index];
    else if (arg === '--continuation-only-from') args.continuationOnlyFrom = argv[++index];
    else if (arg === '--scenario') args.scenarioId = argv[++index];
    else if (arg === '--list-scenarios') args.listScenarios = true;
    else if (arg === '--multi-wave') args.multiWave = true;
    else if (arg === '--initial-only') args.initialOnly = true;
    else if (arg === '--uncoached-baseline') args.uncoachedBaseline = true;
    else if (arg === '--discard-workspaces') args.keepWorkspaces = false;
  }
  return args;
}

if (isDirectCliInvocation('agent-scratch-build-benchmark')) {
  runAgentScratchBuildBenchmark()
    .then(report => {
      process.stdout.write(`Scratch build benchmark: ${report.status.toUpperCase()} (${report.score}/100)\n`);
      process.stdout.write(`Scenario: ${report.task.id} - ${report.task.title}\n`);
      process.stdout.write(`With Klauro: ${report.with_klauro.score}/100 | Without Klauro: ${report.without_klauro.score}/100 | Delta: ${report.comparison.quality_delta}\n`);
      if (report.artifacts.output) process.stdout.write(`Report: ${report.artifacts.output}\n`);
      if (report.artifacts.markdown) process.stdout.write(`Markdown: ${report.artifacts.markdown}\n`);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
