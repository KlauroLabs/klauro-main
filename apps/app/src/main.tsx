import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  Database,
  Edit2,
  Grid2X2,
  HelpCircle,
  Home,
  Inbox,
  Layers2,
  Layers3,
  Link2,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  Star,
  Users,
} from 'lucide-react';
import {
  addWorkspaceMember,
  apiBaseUrl,
  AppStateData,
  ConceptualResponse,
  createProject,
  createWorkspace,
  FlowConcept,
  FlowStep,
  getProjectAnalysis,
  getProjectConceptual,
  loadAppData,
  Project,
  ProjectAnalysisResponse,
  ProjectRevision,
  reanalyzeProject,
  registerAccount,
  signIn,
  Workspace,
} from './api';
import './styles.css';

type Route =
  | { type: 'home' }
  | { type: 'workspace'; workspaceId: string }
  | { type: 'project'; workspaceId: string; projectId: string };

type Modal = 'auth' | 'workspace' | 'project' | 'member' | null;

const tokenKey = 'klauro_session_token';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [data, setData] = useState<AppStateData | null>(null);
  const [route, setRoute] = useState<Route>({ type: 'home' });
  const [modal, setModal] = useState<Modal>(token ? null : 'auth');
  const [error, setError] = useState('');

  async function refresh(nextToken = token) {
    if (!nextToken) return;
    const loaded = await loadAppData(nextToken);
    setData(loaded);
    if (route.type !== 'home' && !loaded.workspaces.some(workspace => workspace.id === route.workspaceId)) {
      setRoute({ type: 'home' });
    }
  }

  useEffect(() => {
    refresh().catch(() => {
      localStorage.removeItem(tokenKey);
      setToken('');
      setModal('auth');
    });
  }, []);

  function saveSession(nextToken: string) {
    localStorage.setItem(tokenKey, nextToken);
    setToken(nextToken);
    setModal(null);
    return refresh(nextToken);
  }

  function signOut() {
    localStorage.removeItem(tokenKey);
    setToken('');
    setData(null);
    setRoute({ type: 'home' });
    setModal('auth');
  }

  const projects = useMemo(() => allProjects(data), [data]);
  const selectedWorkspace = route.type !== 'home' ? data?.workspaces.find(workspace => workspace.id === route.workspaceId) : undefined;
  const selectedProject = route.type === 'project' ? projects.find(project => project.id === route.projectId) : undefined;

  return (
    <>
      <div className="shell">
        <Sidebar
          data={data}
          route={route}
          onHome={() => setRoute({ type: 'home' })}
          onWorkspace={workspaceId => setRoute({ type: 'workspace', workspaceId })}
          onProject={(workspaceId, projectId) => setRoute({ type: 'project', workspaceId, projectId })}
          onAddWorkspace={() => setModal('workspace')}
          onAddMember={() => selectedWorkspace && setModal('member')}
        />
        <main className="main">
          <section className="surface">
            <Topbar
              route={route}
              workspace={selectedWorkspace}
              project={selectedProject}
              userLabel={data?.user.name || data?.user.email || 'K'}
              onSignOut={signOut}
            />
            {route.type === 'home' && (
              <HomeView
                data={data}
                projects={projects}
                onWorkspace={workspaceId => setRoute({ type: 'workspace', workspaceId })}
                onProject={(workspaceId, projectId) => setRoute({ type: 'project', workspaceId, projectId })}
              />
            )}
            {route.type === 'workspace' && selectedWorkspace && (
              <WorkspaceView
                workspace={selectedWorkspace}
                projects={data?.projectsByWorkspace[selectedWorkspace.id] || []}
                members={data?.membersByWorkspace[selectedWorkspace.id] || []}
                revisionsByProject={data?.revisionsByProject || {}}
                onProject={projectId => setRoute({ type: 'project', workspaceId: selectedWorkspace.id, projectId })}
                onAddProject={() => setModal('project')}
                onAddMember={() => setModal('member')}
              />
            )}
            {route.type === 'project' && selectedProject && selectedWorkspace && (
              <RepoOverview
                token={token}
                workspace={selectedWorkspace}
                project={selectedProject}
                members={data?.membersByWorkspace[selectedWorkspace.id] || []}
                revisions={data?.revisionsByProject[selectedProject.id] || []}
                onReanalyzed={() => refresh()}
              />
            )}
          </section>
        </main>
      </div>

      {modal === 'auth' && (
        <AuthModal
          error={error}
          onError={setError}
          onLogin={async input => saveSession((await signIn(input.email, input.password)).token)}
          onRegister={async input => saveSession((await registerAccount(input)).token)}
        />
      )}
      {modal === 'workspace' && (
        <WorkspaceModal
          onClose={() => setModal(null)}
          onSubmit={async name => {
            await createWorkspace(token, name);
            setModal(null);
            await refresh();
          }}
        />
      )}
      {modal === 'project' && selectedWorkspace && (
        <ProjectModal
          onClose={() => setModal(null)}
          onSubmit={async input => {
            await createProject(token, selectedWorkspace.id, input);
            setModal(null);
            await refresh();
          }}
        />
      )}
      {modal === 'member' && selectedWorkspace && (
        <MemberModal
          onClose={() => setModal(null)}
          onSubmit={async input => {
            await addWorkspaceMember(token, selectedWorkspace.id, input);
            setModal(null);
            await refresh();
          }}
        />
      )}
      <div className="api-chip">API {apiBaseUrl}</div>
    </>
  );
}

function Sidebar(props: {
  data: AppStateData | null;
  route: Route;
  onHome: () => void;
  onWorkspace: (workspaceId: string) => void;
  onProject: (workspaceId: string, projectId: string) => void;
  onAddWorkspace: () => void;
  onAddMember: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="brand">
          <div className="brand-name"><LogoMark /> <span>klauro</span></div>
          <button className="icon-plain" aria-label="Collapse sidebar">▥</button>
        </div>
        <nav className="side-section flush">
          <button className={navClass(props.route.type === 'home')} onClick={props.onHome}><Grid2X2 size={16} /> Home</button>
          <button className="nav-item"><Inbox size={16} /> Inbox <span className="badge">0</span></button>
          <button className="nav-item"><Activity size={16} /> Activity</button>
        </nav>
        <div className="side-section">
          <div className="side-label">Workspace</div>
          <div className="workspace-nav">
            {(props.data?.workspaces || []).map(workspace => {
              const active = props.route.type !== 'home' && props.route.workspaceId === workspace.id;
              const projects = props.data?.projectsByWorkspace[workspace.id] || [];
              return (
                <div key={workspace.id}>
                  <button className={navClass(active)} onClick={() => props.onWorkspace(workspace.id)}>
                    <Layers3 size={16} /> <span className="nav-text">{workspace.name}</span> <span className="badge">{workspace.project_count}</span> <ChevronDown size={14} />
                  </button>
                  {active && projects.length > 0 && (
                    <div className="sub-projects">
                      {projects.slice(0, 5).map(project => (
                        <button key={project.id} className="sub-project" onClick={() => props.onProject(workspace.id, project.id)}>
                          <Layers2 size={14} /> {project.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button className="add-workspace" onClick={props.onAddWorkspace}><Plus size={15} /> Add Workspace</button>
        </div>
        <div className="side-section">
          <div className="side-label">Organization</div>
          <button className="nav-item" onClick={props.onAddMember}><Users size={16} /> Members</button>
          <button className="nav-item"><Link2 size={16} /> Integrations</button>
          <button className="nav-item"><Database size={16} /> Billing</button>
        </div>
      </div>
      <div className="side-bottom">
        <button className="nav-item"><HelpCircle size={16} /> Help</button>
        <button className="nav-item"><Settings size={16} /> Settings</button>
      </div>
    </aside>
  );
}

function Topbar(props: { route: Route; workspace?: Workspace; project?: Project; userLabel: string; onSignOut: () => void }) {
  const crumbs = props.route.type === 'home'
    ? ['Home']
    : props.route.type === 'workspace'
      ? ['Home', props.workspace?.name || 'Workspace']
      : ['Home', props.workspace?.name || 'Workspace', props.project?.name || 'Repository'];
  return (
    <header className="topbar">
      <div className="crumbs">
        {crumbs.map((crumb, index) => (
          <React.Fragment key={`${crumb}-${index}`}>
            {index > 0 && <ChevronRight size={14} />}
            <span className={index > 0 ? 'crumb-chip' : ''}>{index === 0 ? <Home size={16} /> : crumb}</span>
          </React.Fragment>
        ))}
        {props.route.type !== 'home' && <Star size={16} className="muted-icon" />}
      </div>
      <div className="top-actions">
        <button className="icon-button" aria-label="Search"><Search size={16} /></button>
        <button className="icon-button" aria-label="Notifications"><Bell size={16} /></button>
        <button className="avatar" onClick={props.onSignOut} title="Sign out">{initials(props.userLabel)}</button>
      </div>
    </header>
  );
}

function HomeView(props: {
  data: AppStateData | null;
  projects: Project[];
  onWorkspace: (workspaceId: string) => void;
  onProject: (workspaceId: string, projectId: string) => void;
}) {
  const jump = props.projects[0];
  const activities = buildActivities(props.data);
  return (
    <div className="content home-grid">
      <div>
        <p className="eyebrow">Good morning {firstName(props.data?.user.name || props.data?.user.email || 'there')}</p>
        <p className="subtle">Here is what is happening with your systems.</p>
        <div className="search-box"><Search size={16} /><input placeholder="Search workspace, repositories, entities..." /><span className="kbd">⌘K</span></div>
        <h2 className="section-title">Jump Back In</h2>
        {jump ? (
          <button className="jump-card card" onClick={() => props.onProject(jump.workspace_id || '', jump.id)}>
            <div><Pill label="Repo" /><h3>{jump.name}</h3><Meta parts={[workspaceName(props.data, jump.workspace_id), sourceLabel(jump)]} /></div>
            <span className="round-arrow">↗</span>
          </button>
        ) : <EmptyState text="Create a workspace and add a repository to start building shared Klauro context." />}
        <h2 className="section-title roomy">Workspaces</h2>
        <div className="workspace-list">
          {(props.data?.workspaces || []).map(workspace => <WorkspaceRow key={workspace.id} workspace={workspace} onOpen={() => props.onWorkspace(workspace.id)} />)}
          {!props.data?.workspaces.length && <EmptyState text="No workspaces yet." />}
        </div>
      </div>
      <ActivityPanel activities={activities} />
    </div>
  );
}

function WorkspaceView(props: {
  workspace: Workspace;
  projects: Project[];
  members: unknown[];
  revisionsByProject: Record<string, ProjectRevision[]>;
  onProject: (projectId: string) => void;
  onAddProject: () => void;
  onAddMember: () => void;
}) {
  const activities = buildActivitiesForProjects(props.projects, props.revisionsByProject);
  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <div className="updated"><span className="status-dot" />Updated {lastWorkspaceUpdate(props.projects, props.revisionsByProject)}</div>
        <div className="title-row"><h1>{props.workspace.name}</h1><span className="source-badge">Workspace</span></div>
        <p>{workspaceDescription(props.workspace, props.projects)}</p>
        <Meta parts={[plural(props.projects.length, 'Repository'), plural(props.members.length || props.workspace.user_count, 'Contributor'), plural(props.projects.filter(project => project.analysis_id).length, 'Analyzed project')]} />
      </div>
      <div className="workspace-grid">
        <section className="panel map-card">
          <h2>System Map</h2>
          <p className="subtle">Visual overview of this workspace architecture</p>
          <SystemMap projects={props.projects} onProject={props.onProject} />
        </section>
        <aside className="right-rail">
          <section className="panel complexity-card">
            <div className="orb">◎</div>
            <div><h2>System Complexity</h2><p className="subtle">How complex is your system</p><strong>{complexityScore(props.projects)}<span>/100</span></strong><button>View Analysis ›</button></div>
          </section>
          <ActivityPanel activities={activities} compact />
        </aside>
      </div>
      <div className="repo-toolbar">
        <h2>Repositories <span>External services this system relies on</span></h2>
        <div className="top-actions"><button className="button" onClick={props.onAddMember}>Members</button><button className="button primary icon-only" onClick={props.onAddProject}><Plus size={18} /></button></div>
      </div>
      <div className="repo-grid">
        {props.projects.map(project => <RepoCard key={project.id} project={project} revisions={props.revisionsByProject[project.id] || []} onOpen={() => props.onProject(project.id)} />)}
        {!props.projects.length && <EmptyState text="No repositories yet. Add one to start analysis." />}
      </div>
    </div>
  );
}

function RepoOverview(props: { token: string; workspace: Workspace; project: Project; members: unknown[]; revisions: ProjectRevision[]; onReanalyzed: () => void }) {
  const latest = props.revisions[0];
  const [analysis, setAnalysis] = useState<ProjectAnalysisResponse | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState('');
  const [tab, setTab] = useState<'overview' | 'conceptual'>('overview');

  useEffect(() => {
    setAnalysis(null);
    setAnalysisError('');
    if (!props.project.analysis_id) return;
    let cancelled = false;
    getProjectAnalysis(props.token, props.project.id)
      .then(result => { if (!cancelled) setAnalysis(result); })
      .catch(error => { if (!cancelled) setAnalysisError(error instanceof Error ? error.message : 'Failed to load analysis'); });
    return () => { cancelled = true; };
  }, [props.token, props.project.id, props.project.analysis_id]);

  async function handleReanalyze() {
    setReanalyzing(true);
    setReanalyzeError('');
    try {
      await reanalyzeProject(props.token, props.project);
      props.onReanalyzed();
      const result = await getProjectAnalysis(props.token, props.project.id);
      setAnalysis(result);
    } catch (error) {
      setReanalyzeError(error instanceof Error ? error.message : 'Re-analysis failed');
    } finally {
      setReanalyzing(false);
    }
  }

  const productMap = analysis?.status === 'ready' ? analysis.product_map : undefined;
  const capabilities = productMap?.capabilities || [];
  const entityNames = (productMap?.data.exposure_highlights.map(highlight => highlight.entity) || []).slice(0, 8);

  return (
    <div className="repo-overview">
      <div className="workspace-header repo-head">
        <div className="updated"><span className="status-dot" />Updated {latest ? relativeTime(latest.generated_at) : 'after first analysis'}</div>
        <div className="title-row"><h1>{props.project.name}</h1><span className="source-badge">{props.project.repo_url ? 'GitHub' : 'Project'}</span></div>
        <p>{productMap?.identity.description || repoSummary(props.project)}</p>
        <div className="repo-actions">
          <button className="button"><Edit2 size={16} /> Edit Summary</button>
          <button className="button primary" onClick={handleReanalyze} disabled={reanalyzing}>
            <RefreshCcw size={16} /> {reanalyzing ? 'Analyzing…' : 'Re-Analyze'}
          </button>
        </div>
        {reanalyzeError && <p className="error">{reanalyzeError}</p>}
      </div>
      <div className="repo-tabs">
        <button className={`repo-tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`repo-tab${tab === 'conceptual' ? ' active' : ''}`} onClick={() => setTab('conceptual')}>Conceptual</button>
      </div>
      {tab === 'overview' && (
        <>
          <div className="metric-strip">
            <Metric label="Capabilities" value={capabilities.length ? String(capabilities.length) : props.project.analysis_id ? 'Available' : 'Pending'} hint="Core business domains" />
            <Metric label="Entry points" value={String(latest?.nodes || 0)} hint="Known graph nodes" />
            <Metric label="Contributors" value={String(props.members.length || '-')} hint="Workspace users" />
            <Metric label="Analysis" value={latest?.source || 'Not run'} hint={latest ? relativeTime(latest.generated_at) : 'Awaiting run'} />
            {productMap?.health.score !== undefined && (
              <Metric label="Health" value={`${productMap.health.score}`} hint={productMap.health.status || 'System complexity'} />
            )}
          </div>
          {!props.project.analysis_id && (
            <EmptyState text="No analysis attached to this project yet. Click Re-Analyze to run Klauro on this repository and populate real capabilities, entities, and health." />
          )}
          {props.project.analysis_id && analysisError && (
            <EmptyState text={`Could not load the analysis for this project: ${analysisError}`} />
          )}
          {props.project.analysis_id && analysis?.status === 'no_analysis' && (
            <EmptyState text="This project has an analysis_id, but no stored analysis was found for it yet. Click Re-Analyze to generate one." />
          )}
          <section className="repo-section">
            <h2>Capabilities <span>Core business functions or infrastructure</span></h2>
            {capabilities.length ? (
              <div className="data-grid">
                {capabilities.slice(0, 12).map(capability => <CapabilityCell key={capability.name} capability={capability} />)}
              </div>
            ) : (
              <EmptyState text={props.project.analysis_id ? 'Analysis attached but no capabilities were detected yet.' : 'Run analysis to discover this repository’s real capabilities.'} />
            )}
          </section>
          <section className="repo-section">
            <h2>Critical Flows <span>Analysis-backed revision paths</span></h2>
            <div className="flow-list">
              {props.revisions.length ? props.revisions.slice(0, 4).map(revision => <RevisionFlow key={`${revision.analysis_revision}-${revision.generated_at}`} revision={revision} />) : <EmptyState text="No analyzed revisions yet. Re-analyze this project to populate critical flows from CAS." />}
            </div>
          </section>
          <section className="repo-section">
            <h2>Key Entities <span>Sensitive/high-exposure data entities from CAS</span></h2>
            {entityNames.length ? (
              <div className="entity-grid">
                {(productMap?.data.exposure_highlights || []).slice(0, 8).map(highlight => <EntityCard key={highlight.entity} name={highlight.entity} detail={`${highlight.sensitive_fields.length} sensitive field(s), ${highlight.unguarded_paths} unguarded path(s)`} />)}
              </div>
            ) : (
              <EmptyState text={props.project.analysis_id ? 'No sensitive data entities were flagged by analysis.' : 'Available after CAS analysis is attached to this project.'} />
            )}
          </section>
        </>
      )}
      {tab === 'conceptual' && (
        <ConceptualView token={props.token} project={props.project} />
      )}
    </div>
  );
}

function ConceptualView(props: { token: string; project: Project }) {
  const [data, setData] = useState<ConceptualResponse | null>(null);
  const [error, setError] = useState('');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError('');
    setSelectedFlowId(null);
    setSelectedStepId(null);
    if (!props.project.analysis_id) return;
    let cancelled = false;
    getProjectConceptual(props.token, props.project.id)
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load conceptual layer'); });
    return () => { cancelled = true; };
  }, [props.token, props.project.id, props.project.analysis_id]);

  if (!props.project.analysis_id) {
    return <EmptyState text="No analysis attached yet. Re-analyze to compute the conceptual layer (capabilities, flows, steps, structural perspectives)." />;
  }
  if (error) {
    return <EmptyState text={`Could not load the conceptual layer: ${error}`} />;
  }
  if (!data) {
    return <EmptyState text="Loading conceptual layer…" />;
  }
  if (data.status === 'no_analysis') {
    return <EmptyState text={`No stored analysis found yet${data.error ? `: ${data.error}` : '.'} Re-analyze to generate it.`} />;
  }

  const flows = data.flows?.flows || [];
  const capabilitiesById = new Map((data.capabilities || []).map(capability => [capability.id, capability]));
  const selectedFlow = flows.find(flow => flow.flow_id === selectedFlowId) || null;
  const selectedStep = selectedFlow?.steps.find(step => step.step_id === selectedStepId) || null;

  return (
    <div className="conceptual-view">
      <section className="repo-section">
        <h2>Capability → Flow → Step → Function <span>The behavioral hierarchy — what the system does, as it runs</span></h2>
        {data.flows?.gaps && data.flows.gaps.length > 0 && (
          <div className="gap-banner">{data.flows.gaps.join(' ')}</div>
        )}
        {flows.length ? (
          <div className="conceptual-columns">
            <div className="concept-column">
              <div className="concept-column-label">Flows ({flows.length})</div>
              <div className="concept-list">
                {flows.map(flow => {
                  const capability = flow.capability_id ? capabilitiesById.get(flow.capability_id) : undefined;
                  return (
                    <button
                      key={flow.flow_id}
                      className={`concept-item${selectedFlowId === flow.flow_id ? ' active' : ''}`}
                      onClick={() => { setSelectedFlowId(flow.flow_id); setSelectedStepId(null); }}
                    >
                      <strong>{flow.name}</strong>
                      {capability ? <span className="concept-sub">{capability.name}</span> : <span className="concept-sub gap">no capability link</span>}
                      <span className="concept-meta">{flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="concept-column">
              <div className="concept-column-label">Steps {selectedFlow ? `(${selectedFlow.steps.length})` : ''}</div>
              {selectedFlow ? (
                <div className="concept-list">
                  {selectedFlow.steps.map(step => (
                    <button
                      key={step.step_id}
                      className={`concept-item${selectedStepId === step.step_id ? ' active' : ''}`}
                      onClick={() => setSelectedStepId(step.step_id)}
                    >
                      <strong>{step.order + 1}. {step.name}</strong>
                      <span className="concept-sub">{step.description}</span>
                      <span className="concept-meta">{stepMappingLabel(step)}</span>
                    </button>
                  ))}
                </div>
              ) : <EmptyState text="Select a flow to see its ordered steps." />}
            </div>
            <div className="concept-column concept-detail">
              <div className="concept-column-label">Contract</div>
              {selectedStep ? (
                <ContractCard title={selectedStep.name} contract={selectedStep.contract} functions={selectedStep.functions} />
              ) : selectedFlow ? (
                <ContractCard title={`${selectedFlow.name} (flow-level)`} contract={selectedFlow.contract} entities={selectedFlow.entities} />
              ) : (
                <EmptyState text="Select a flow, then a step, to see its Input / Logic / Side-effects / Output / Constraints." />
              )}
            </div>
          </div>
        ) : (
          <EmptyState text="No flows could be derived from this analysis (no entry points, or none traceable to steps)." />
        )}
      </section>
      <StructuralPerspectivePanel structural={data.structural} />
    </div>
  );
}

function stepMappingLabel(step: FlowStep): string {
  if (step.functions.length === 0) return 'no function ref (gap)';
  if (step.functions.length > 1) return `1:many — ${step.functions.length} functions`;
  const fn = step.functions[0];
  if (fn.section) return `sub-section — lines ${fn.section.start_line}-${fn.section.end_line}${fn.section.label ? ` (${fn.section.label})` : ''}`;
  return '1:1 function';
}

function ContractCard(props: { title: string; contract: FlowConcept['contract']; functions?: FlowStep['functions']; entities?: string[] }) {
  const { contract } = props;
  return (
    <div className="contract-card">
      <h3>{props.title}</h3>
      <ContractRow label="Input" values={contract.input} emptyText="no inputs derived" />
      <ContractRow label="Logic" values={contract.logic ? [contract.logic] : []} emptyText="no logic summary" />
      <ContractRow label="Side-effects: state changes" values={contract.side_effects.state_changes} emptyText="none observed (gap or side-effect-free)" />
      <ContractRow label="Side-effects: external integrations" values={contract.side_effects.external_integrations} emptyText="none observed" />
      <ContractRow label="Output" values={contract.output} emptyText="no outputs derived" />
      <ContractRow label="Constraints" values={contract.constraints} emptyText="none derived (no guard clauses/invariants found)" />
      {props.entities && props.entities.length > 0 && (
        <ContractRow label="Entities touched" values={props.entities} emptyText="" />
      )}
      {props.functions && props.functions.length > 0 && (
        <div className="contract-row">
          <div className="contract-row-label">Function(s)</div>
          <div className="contract-row-values">
            {props.functions.map(fn => (
              <span key={fn.function_id} className="function-chip">
                {fn.function_id}{fn.section ? ` [${fn.section.start_line}-${fn.section.end_line}]` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContractRow({ label, values, emptyText }: { label: string; values: string[]; emptyText: string }) {
  if (!values.length) {
    return emptyText ? (
      <div className="contract-row">
        <div className="contract-row-label">{label}</div>
        <div className="contract-row-values gap">{emptyText}</div>
      </div>
    ) : null;
  }
  return (
    <div className="contract-row">
      <div className="contract-row-label">{label}</div>
      <div className="contract-row-values">{values.map((value, index) => <span key={`${value}-${index}`} className="value-chip">{value}</span>)}</div>
    </div>
  );
}

function StructuralPerspectivePanel({ structural }: { structural: ConceptualResponse['structural'] }) {
  if (!structural) return null;
  const { architectural, paradigms, perspectives } = structural;
  const conflicts = (architectural?.conflicts || []) as Array<Record<string, unknown>>;
  const violations = (architectural?.violations || []) as Array<Record<string, unknown>>;
  return (
    <section className="repo-section">
      <h2>Structural Perspectives <span>How the system is built — architecture and paradigm, the same code seen from another angle</span></h2>
      <div className="structural-grid">
        <div className="panel structural-card">
          <h3>Architectural conflicts</h3>
          {architectural?.analysis_version_notice && <p className="subtle">{architectural.analysis_version_notice}</p>}
          {conflicts.length || violations.length ? (
            <ul className="structural-list">
              {conflicts.slice(0, 8).map((conflict, index) => (
                <li key={`conflict-${index}`}>
                  <span className={`severity-dot severity-${conflict.severity as string}`} />
                  {String(conflict.description || conflict.name || 'Conflict')}
                </li>
              ))}
              {violations.slice(0, 8).map((violation, index) => (
                <li key={`violation-${index}`}>
                  <span className="severity-dot severity-medium" />
                  {String(violation.description || violation.principle || 'Principle violation')}
                </li>
              ))}
            </ul>
          ) : <EmptyState text="No architectural conflicts or principle violations detected." />}
        </div>
        <div className="panel structural-card">
          <h3>Paradigm conformance</h3>
          {paradigms?.analysis_version_notice && <p className="subtle">{paradigms.analysis_version_notice}</p>}
          {paradigms?.paradigms.length ? (
            <ul className="structural-list">
              {paradigms.paradigms.map(paradigm => (
                <li key={paradigm.paradigm}>
                  <strong>{paradigm.paradigm}</strong> — {paradigm.description || 'No description.'}
                  <span className="concept-meta">{paradigm.deviation_count} deviation{paradigm.deviation_count === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState text="No paradigm conformance data on this analysis." />}
        </div>
        <div className="panel structural-card">
          <h3>Perspectives</h3>
          {perspectives && perspectives.length ? (
            <ul className="structural-list">
              {perspectives.slice(0, 8).map((perspective, index) => (
                <li key={index}>{typeof perspective === 'string' ? perspective : JSON.stringify(perspective)}</li>
              ))}
            </ul>
          ) : <EmptyState text="No additional perspectives recorded for this analysis." />}
        </div>
      </div>
    </section>
  );
}

function CapabilityCell({ capability }: { capability: { name: string; description: string; criticality: string; category: string; risk_level: string } }) {
  return (
    <div className="data-cell">
      <span className="mini-icon">□</span>
      <h3>{capability.name}</h3>
      <p>{capability.description || `${capability.category} capability, ${capability.criticality} criticality, ${capability.risk_level} risk.`}</p>
    </div>
  );
}

function WorkspaceRow({ workspace, onOpen }: { workspace: Workspace; onOpen: () => void }) {
  return (
    <button className="workspace-row" onClick={onOpen}>
      <div className="workspace-row-main"><span className="workspace-icon"><Layers3 size={20} /></span><div><strong>{workspace.name}</strong><span>{workspace.role || 'Workspace'}</span></div></div>
      <div className="workspace-stats"><Stat value={workspace.project_count} label="Repositories" /><Stat value={workspace.user_count} label="Contributors" /><span className="round-arrow">↗</span></div>
    </button>
  );
}

function ActivityPanel({ activities, compact = false }: { activities: ActivityItem[]; compact?: boolean }) {
  return (
    <aside className={`panel activity-panel ${compact ? 'compact' : ''}`}>
      <h2>Change Activity</h2>
      <p className="subtle">Recent changes across your system</p>
      {activities.length ? (
        <div className="activity-list">
          {activities.slice(0, compact ? 4 : 5).map((activity, index) => (
            <div className="activity-item" key={`${activity.title}-${index}`}>
              <span className="activity-dot" />
              <div><Pill label={activity.project.name} /><strong>{activity.title}</strong><small>{activity.detail}</small></div>
              <time>{activity.time}</time>
            </div>
          ))}
        </div>
      ) : <EmptyState text="No analyzed revisions yet. Run Klauro analysis to populate activity." />}
      <button className="text-button">See all activity ›</button>
    </aside>
  );
}

function SystemMap({ projects, onProject }: { projects: Project[]; onProject: (id: string) => void }) {
  if (!projects.length) return <EmptyState text="Add repositories to generate the workspace map." />;
  const positions = [[16, 37], [16, 65], [39, 53], [55, 34], [58, 74], [76, 42], [78, 69], [91, 54]];
  return (
    <div className="map-stage">
      {projects.slice(1, 8).map((project, index) => <MapLine key={project.id} from={positions[0]} to={positions[index + 1]} />)}
      {projects.slice(0, 8).map((project, index) => (
        <button key={project.id} className="map-node" style={{ left: `${positions[index][0]}%`, top: `${positions[index][1]}%` }} onClick={() => onProject(project.id)}>
          <span className="cube"><Layers3 size={22} /></span>
          <strong>{project.name}</strong>
          <small>{projectKind(project)}</small>
        </button>
      ))}
    </div>
  );
}

function MapLine({ from, to }: { from: number[]; to: number[] }) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return <span className="map-line" style={{ left: `${from[0]}%`, top: `${from[1]}%`, width: `${length}%`, transform: `rotate(${angle}deg)` }} />;
}

function RepoCard({ project, revisions, onOpen }: { project: Project; revisions: ProjectRevision[]; onOpen: () => void }) {
  return (
    <button className="repo-card card" onClick={onOpen}>
      <span className="round-arrow">↗</span>
      <div><h3><Layers2 size={18} /> {project.name}</h3><p>{repoSummary(project)}</p><div className="tags">{projectTags(project).map(tag => <span key={tag}>{tag}</span>)}</div></div>
      <div className="repo-bottom"><div><small>Assignees</small><div className="avatar-stack"><span /><span /><span /></div></div><small>{revisions[0] ? `Last analyzed - ${relativeTime(revisions[0].generated_at)}` : 'Not analyzed yet'}</small></div>
    </button>
  );
}

function EntityCard({ name, detail }: { name: string; detail?: string }) {
  return <div className="entity-card"><span className="cube"><Layers3 size={18} /></span><h3>{name}</h3><p>{detail || 'No exposure detail available.'}</p></div>;
}

function RevisionFlow({ revision }: { revision: ProjectRevision }) {
  return (
    <div className="flow-card">
      <Pill label={revision.branch || 'branch'} />
      <h3>{revision.commit ? 'Commit analysis' : 'Project analysis'}</h3>
      <div className="flow-steps"><span>{revision.files} files</span><span>{revision.nodes} nodes</span><span>{revision.edges} edges</span></div>
      <Meta parts={[revision.source, relativeTime(revision.generated_at)]} />
    </div>
  );
}

function AuthModal(props: { error: string; onError: (error: string) => void; onLogin: (input: { email: string; password: string }) => Promise<void>; onRegister: (input: { email: string; name?: string; password: string; workspace_name?: string }) => Promise<void> }) {
  return (
    <div className="modal">
      <div className="modal-card auth-card">
        <div className="brand-name"><LogoMark /> <span>klauro</span></div>
        <p className="eyebrow">Sign in to Klauro</p>
        <p className="subtle">Manage workspaces, projects, hosted analyses, and the context your local MCP uses while you work.</p>
        <div className="auth-grid">
          <AuthForm title="Existing account" submitLabel="Sign in" onSubmit={props.onLogin} onError={props.onError} />
          <AuthForm title="Create account" submitLabel="Create account" register onSubmit={props.onRegister} onError={props.onError} />
        </div>
        {props.error && <p className="error">{props.error}</p>}
      </div>
    </div>
  );
}

function AuthForm(props: { title: string; submitLabel: string; register?: boolean; onError: (error: string) => void; onSubmit: (input: any) => Promise<void> }) {
  return (
    <form className="form-grid" onSubmit={async event => {
      event.preventDefault();
      props.onError('');
      const form = new FormData(event.currentTarget);
      try {
        await props.onSubmit(Object.fromEntries(form.entries()));
      } catch (error) {
        props.onError(error instanceof Error ? error.message : String(error));
      }
    }}>
      <strong>{props.title}</strong>
      <label>Email<input name="email" type="email" required /></label>
      {props.register && <label>Name<input name="name" /></label>}
      <label>Password<input name="password" type="password" required minLength={8} /></label>
      {props.register && <label>Workspace<input name="workspace_name" placeholder="Engineering" /></label>}
      <button className={props.register ? 'button' : 'button primary'}>{props.submitLabel}</button>
    </form>
  );
}

function WorkspaceModal(props: { onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  return <TextModal title="Add Workspace" label="Name" placeholder="Soon" submit="Create workspace" onClose={props.onClose} onSubmit={value => props.onSubmit(value)} />;
}

function ProjectModal(props: { onClose: () => void; onSubmit: (input: { name: string; repo_url?: string; local_path?: string; analysis_id?: string }) => Promise<void> }) {
  return (
    <ModalFrame title="Add Repository" onClose={props.onClose}>
      <form className="form-grid" onSubmit={event => submitForm(event, props.onSubmit)}>
        <label>Name<input name="name" placeholder="backend" required /></label>
        <label>Repo URL<input name="repo_url" placeholder="https://github.com/acme/backend" /></label>
        <label>Local path<input name="local_path" placeholder="/Users/me/dev/acme/backend" /></label>
        <label>Analysis ID<input name="analysis_id" placeholder="optional" /></label>
        <div className="form-actions"><button type="button" className="button" onClick={props.onClose}>Cancel</button><button className="button primary">Add repository</button></div>
      </form>
    </ModalFrame>
  );
}

function MemberModal(props: { onClose: () => void; onSubmit: (input: { email: string; role: string }) => Promise<void> }) {
  return (
    <ModalFrame title="Add Member" onClose={props.onClose}>
      <form className="form-grid" onSubmit={event => submitForm(event, props.onSubmit)}>
        <label>Email<input name="email" type="email" required /></label>
        <label>Role<select name="role"><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option></select></label>
        <div className="form-actions"><button type="button" className="button" onClick={props.onClose}>Cancel</button><button className="button primary">Add member</button></div>
      </form>
    </ModalFrame>
  );
}

function TextModal(props: { title: string; label: string; placeholder: string; submit: string; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  return (
    <ModalFrame title={props.title} onClose={props.onClose}>
      <form className="form-grid" onSubmit={event => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get('value') || '');
        props.onSubmit(value);
      }}>
        <label>{props.label}<input name="value" placeholder={props.placeholder} required /></label>
        <div className="form-actions"><button type="button" className="button" onClick={props.onClose}>Cancel</button><button className="button primary">{props.submit}</button></div>
      </form>
    </ModalFrame>
  );
}

function ModalFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal"><div className="modal-card"><h2>{title}</h2><button className="modal-close" onClick={onClose}>×</button>{children}</div></div>;
}

async function submitForm<T>(event: FormEvent<HTMLFormElement>, onSubmit: (input: T) => Promise<void>) {
  event.preventDefault();
  await onSubmit(Object.fromEntries(new FormData(event.currentTarget).entries()) as T);
}

function LogoMark() {
  return <span className="logo-mark"><span /></span>;
}

function Pill({ label }: { label: string }) {
  return <span className="pill"><span className="status-dot" />{label}</span>;
}

function Meta({ parts }: { parts: Array<string | undefined> }) {
  return <div className="meta">{parts.filter(Boolean).map(part => <span key={part}>{part}</span>)}</div>;
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="metric"><div><small>{label}</small><strong>{value}</strong><span>{hint}</span></div><Layers3 size={28} /></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

interface ActivityItem {
  project: Project;
  title: string;
  detail: string;
  time: string;
  generatedAt: string;
}

function buildActivities(data: AppStateData | null): ActivityItem[] {
  if (!data) return [];
  return buildActivitiesForProjects(allProjects(data), data.revisionsByProject);
}

function buildActivitiesForProjects(projects: Project[], revisionsByProject: Record<string, ProjectRevision[]>): ActivityItem[] {
  return projects.flatMap(project => (revisionsByProject[project.id] || []).slice(0, 4).map(revision => ({
    project,
    title: revision.commit ? 'Commit analyzed' : 'Analysis updated',
    detail: [revision.branch, revision.nodes ? `${revision.nodes} nodes` : '', revision.edges ? `${revision.edges} edges` : ''].filter(Boolean).join(' - ') || sourceLabel(project),
    time: relativeTime(revision.generated_at),
    generatedAt: revision.generated_at,
  }))).sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
}

function allProjects(data: AppStateData | null): Project[] {
  if (!data) return [];
  return Object.values(data.projectsByWorkspace).flat();
}

function workspaceName(data: AppStateData | null, workspaceId?: string) {
  return data?.workspaces.find(workspace => workspace.id === workspaceId)?.name || 'Workspace';
}

function workspaceDescription(workspace: Workspace, projects: Project[]) {
  if (!projects.length) return 'This workspace is ready to collect repository analyses. Add projects to build the shared system map and agent context.';
  const kinds = Array.from(new Set(projects.map(projectKind))).slice(0, 4).join(', ');
  return `${workspace.name} contains ${plural(projects.length, 'project')} spanning ${kinds}. Klauro uses pushed-code analyses from these projects to build shared workspace context, change activity, and MCP guidance for local agents.`;
}

function repoSummary(project: Project) {
  if (project.analysis_id) return `Connected to Klauro analysis ${project.analysis_id}. Serves as a ${projectKind(project).toLowerCase()} project in this workspace.`;
  return `Tracks ${sourceLabel(project)}. Run analysis to populate capabilities, flows, entities, risks, and MCP agent contexts.`;
}

function sourceLabel(project: Project) {
  return project.repo_url || project.local_path || project.analysis_id || 'No source attached yet';
}

function projectKind(project: Project) {
  const value = [project.name, sourceLabel(project)].join(' ').toLowerCase();
  if (/web|front|ui|app/.test(value)) return 'Frontend';
  if (/api|server|backend|service/.test(value)) return 'Backend';
  if (/worker|job|queue|sync/.test(value)) return 'Worker';
  if (/mobile|ios|android|flutter/.test(value)) return 'Mobile';
  if (/infra|terraform|deploy|ci/.test(value)) return 'Infrastructure';
  return 'Project';
}

function projectTags(project: Project) {
  const value = sourceLabel(project).toLowerCase();
  const tags = [];
  if (value.includes('github')) tags.push('GitHub');
  if (value.includes('gitlab')) tags.push('GitLab');
  if (/node|api|web|front|backend/.test(value)) tags.push('TypeScript');
  if (/infra|terraform|deploy/.test(value)) tags.push('Infra');
  if (!tags.length) tags.push(projectKind(project));
  return tags.slice(0, 4);
}

function complexityScore(projects: Project[]) {
  if (!projects.length) return 0;
  return Math.min(100, Math.max(12, projects.length * 11 + projects.filter(project => project.analysis_id).length * 7));
}

function lastWorkspaceUpdate(projects: Project[], revisionsByProject: Record<string, ProjectRevision[]>) {
  const dates = projects.flatMap(project => (revisionsByProject[project.id] || []).map(revision => revision.generated_at));
  if (!dates.length) return 'after repositories are analyzed';
  return relativeTime(dates.sort().slice(-1)[0]);
}

function relativeTime(value: string) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const minutes = Math.floor(Math.max(0, Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function firstName(value: string) {
  return value.split('@')[0].split(/\s+/)[0] || 'there';
}

function initials(value: string) {
  return (value.trim()[0] || 'K').toUpperCase();
}

function navClass(active: boolean) {
  return `nav-item${active ? ' active' : ''}`;
}

createRoot(document.getElementById('root')!).render(<App />);
