# Visualization Consolidation Implementation Plan

## Overview

This plan consolidates 15+ fragmented visualization files into a single, coherent system while preserving ALL unique functionality. The goal: make the visualization as powerful for humans as the CAS JSON is for AI.

## Current Architecture (Before)

```
legacy/web/src/
  pages/
    visualization.tsx                    # DEPRECATED - hardcoded path, no auth
    workspace/[id]/codebase/[codebaseId]/
      visualization.tsx                  # ACTIVE - 2018 lines, kitchen sink
  components/
    visualization/
      BlueprintVisualization.tsx         # Custom renderer wrapper
      VisualizationCanvas.tsx            # Blueprint/ForceGraph toggle
      GraphControls.tsx                  # Toolbar controls
      CallChainVisualization.tsx         # Call chain tracing (unique)
      ExternalServicesView.tsx           # External services (unique)
    InteractiveArchitectureDiagram.tsx   # Connection bundling (unique)
    DrillDownVisualization.tsx           # D3 force layout (unique)
    ProgressiveLevelControl.tsx          # Level slider (unique)
    InteractiveCardSystem.tsx            # Card grid
    HierarchicalFlow.tsx                 # React Flow wrapper
    ArchitectureFlow.tsx                 # React Flow wrapper
    ProgressiveTreeView.tsx              # Tree view
    AnalysisInfoPanel.tsx                # Analysis sidebar
    schematic/
      SystemSchematic.tsx
      SimpleSystemSchematic.tsx
      ComponentDetailsPanel.tsx
      SchematicNavigation.tsx
      SystemViewer.tsx
      IssuesPanel.tsx
```

## Target Architecture (After)

```
legacy/web/src/
  features/
    visualization/
      index.ts                           # Public exports
      types/
        index.ts                         # Re-export CAS types + view types
      hooks/
        useCASVisualization.ts           # Main data hook
        usePanZoom.ts                    # Pan/zoom state (extract from existing)
        useNodeSelection.ts              # Selection + history state
        useFilters.ts                    # Filter state management
      components/
        VisualizationContainer.tsx       # Main container with navigation
        VisualizationSidebar.tsx         # Left sidebar - views + filters
        VisualizationToolbar.tsx         # Top toolbar - zoom, export
        NodeDetailPanel.tsx              # Right panel - selected node details
      canvas/
        ArchitectureCanvas.tsx           # Main SVG canvas with pan/zoom
        NodeCard.tsx                     # Individual node rendering
        ConnectionLine.tsx               # SVG connection lines
        GroupBox.tsx                     # Visual grouping container
      views/
        ArchitectureOverview.tsx         # System overview with groups
        EntryPointsView.tsx              # HTTP routes, CLI, events
        ExitPointsView.tsx               # Database, API, file operations
        CallChainsView.tsx               # Execution path tracing
        ExternalServicesView.tsx         # External dependencies
        ComponentDetailView.tsx          # Deep dive into single component
      controls/
        LevelControl.tsx                 # Progressive disclosure slider
        PerspectiveSelector.tsx          # Framework perspective toggle
        FilterPanel.tsx                  # Type/status filters
      utils/
        layoutAlgorithms.ts              # Force, grid, hierarchy layouts
        colorSchemes.ts                  # Type-based colors
        connectionUtils.ts               # Edge processing utilities
  pages/
    workspace/[id]/codebase/[codebaseId]/
      visualization.tsx                  # Thin wrapper, imports feature
```

## Unique Functionality Preservation Matrix

| Feature | Source File | Target Location | Status |
|---------|-------------|-----------------|--------|
| Connection bundling by type | InteractiveArchitectureDiagram | canvas/NodeCard + utils/connectionUtils | MIGRATE |
| Focus history navigation | InteractiveArchitectureDiagram | hooks/useNodeSelection | MIGRATE |
| Call chain flow visualization | CallChainVisualization | views/CallChainsView | MIGRATE |
| Bottleneck detection | CallChainVisualization | views/CallChainsView | MIGRATE |
| Hot path highlighting | CallChainVisualization | views/CallChainsView | MIGRATE |
| External service categories | ExternalServicesView | views/ExternalServicesView | MIGRATE |
| Direction filters | ExternalServicesView | views/ExternalServicesView | MIGRATE |
| D3 force simulation | DrillDownVisualization | utils/layoutAlgorithms | MIGRATE |
| Progressive disclosure | ProgressiveLevelControl | controls/LevelControl | MIGRATE |
| Pan/zoom controls | Multiple files | hooks/usePanZoom | CONSOLIDATE |
| Level slider | ProgressiveLevelControl | controls/LevelControl | MIGRATE |
| Component detail panel | ComponentDetailsPanel | NodeDetailPanel | MIGRATE |
| Analysis info sidebar | AnalysisInfoPanel | VisualizationSidebar | MIGRATE |
| SVG curved connections | workspace visualization.tsx | canvas/ConnectionLine | EXTRACT |

## CAS Data Utilization Plan

### Currently Used
- `nodes` - Component cards
- `edges` - Connection lines
- `system.name/type` - Header

### NOT Used (Must Implement)

| CAS Field | Target View | UI Component |
|-----------|-------------|--------------|
| `entry_points` | EntryPointsView | HTTP routes table, auth badges |
| `exit_points` | ExitPointsView | Database ops, API calls table |
| `external_services` | ExternalServicesView | Service cards with direction |
| `call_chains` | CallChainsView | Flow diagram + bottleneck alerts |
| `method_calls` | CallChainsView | Detailed call info on hover |
| `decorators` | ComponentDetailView | Decorator list with semantics |
| `documentation_summary` | VisualizationSidebar | Doc coverage stats |
| `todos_summary` | VisualizationSidebar | TODO/FIXME counts |
| `implementation_health` | VisualizationSidebar | Health score + breakdown |
| `perspectives` | PerspectiveSelector | Framework-specific views |

## Implementation Phases

### Phase 1: Foundation (No Breaking Changes)

Create new feature folder structure alongside existing code.

**Tasks:**
1. Create `features/visualization/` folder structure
2. Create `hooks/useCASVisualization.ts` - data fetching + processing
3. Create `hooks/usePanZoom.ts` - extract from existing
4. Create `hooks/useNodeSelection.ts` - selection + history
5. Create `types/index.ts` - re-export + extend CAS types

**useCASVisualization Hook Signature:**
```typescript
interface UseCASVisualizationResult {
  // Raw CAS data
  cas: CASOutput | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;

  // Computed data
  nodesByType: Map<string, CASNode[]>;
  edgeMap: Map<string, CASEdge[]>;  // source -> edges
  reverseEdgeMap: Map<string, CASEdge[]>;  // target -> edges

  // Entry/Exit points
  httpEndpoints: EntryPoint[];
  databaseOps: ExitPoint[];
  externalCalls: ExitPoint[];

  // Call chains
  criticalPaths: CASCallChain[];
  hotPaths: CASCallChain[];

  // Filtering
  filteredNodes: CASNode[];
  filters: FilterState;
  setFilters: (filters: FilterState) => void;

  // Selection
  selectedNode: CASNode | null;
  setSelectedNode: (nodeId: string | null) => void;

  // Helpers
  getNodeConnections: (nodeId: string) => { incoming: CASNode[]; outgoing: CASNode[] };
  getNodeById: (id: string) => CASNode | undefined;
}
```

### Phase 2: Core Canvas Components

**Tasks:**
1. Create `canvas/ArchitectureCanvas.tsx` - main SVG with pan/zoom
2. Create `canvas/NodeCard.tsx` - styled node rendering
3. Create `canvas/ConnectionLine.tsx` - SVG curved lines
4. Create `canvas/GroupBox.tsx` - visual grouping

**ArchitectureCanvas Props:**
```typescript
interface ArchitectureCanvasProps {
  nodes: CASNode[];
  edges: CASEdge[];
  selectedNodeId?: string;
  onNodeSelect: (nodeId: string) => void;
  layout: 'force' | 'grid' | 'hierarchical';
  groupBy?: 'type' | 'level' | 'perspective';
  showConnections?: boolean;
  highlightedPaths?: string[];  // For call chain highlighting
}
```

### Phase 3: View Components

**Tasks:**
1. Create `views/ArchitectureOverview.tsx` - main overview with groups
2. Create `views/EntryPointsView.tsx` - HTTP routes, auth status
3. Create `views/ExitPointsView.tsx` - database, API, file ops
4. Create `views/CallChainsView.tsx` - execution paths
5. Create `views/ExternalServicesView.tsx` - external deps
6. Create `views/ComponentDetailView.tsx` - single component deep dive

**EntryPointsView Structure:**
```
+-------------------------------------------+
| HTTP Endpoints (46 authenticated, 42 public)
+-------------------------------------------+
| Method | Path           | Handler      | Auth  |
|--------|----------------|--------------|-------|
| GET    | /workspaces    | find()       | Yes   |
| POST   | /workspaces    | create()     | Yes   |
| GET    | /workspaces/:id| findOne()    | Yes   |
| ...    | ...            | ...          | ...   |
+-------------------------------------------+
| Click row to see call chain from entry to exit
+-------------------------------------------+
```

**CallChainsView Structure:**
```
+-------------------------------------------+
| Call Chains | Filter: [Critical ▼] [Hot Paths ▼]
+-------------------------------------------+
| Chain: POST /workspaces/:id/codebases
|   Entry -> WorkspacesController.createCodebase
|          -> CodebasesService.create
|          -> CodebaseRepository.persist
|          -> [EXIT: Database INSERT]
|
| Risk: HIGH | Depth: 4 | Has DB: Yes | Async: No
| Bottleneck: CodebasesService.create (reason)
+-------------------------------------------+
```

### Phase 4: Container + Navigation

**Tasks:**
1. Create `components/VisualizationContainer.tsx` - main layout
2. Create `components/VisualizationSidebar.tsx` - view navigation
3. Create `components/VisualizationToolbar.tsx` - zoom, export
4. Create `components/NodeDetailPanel.tsx` - right sidebar
5. Create `controls/LevelControl.tsx` - progressive disclosure
6. Create `controls/PerspectiveSelector.tsx` - framework views

**VisualizationContainer Layout:**
```
+-----+--------------------------------+--------+
| Nav |         Main Canvas            | Detail |
|     |                                | Panel  |
| [O] |  +------------------------+    |        |
| [E] |  |                        |    | Name   |
| [X] |  |     Architecture       |    | Type   |
| [C] |  |       Canvas           |    | File   |
| [S] |  |                        |    |        |
|     |  +------------------------+    | Calls  |
|     |  [Level: 0 - 1 - 2 - 3]       | From   |
|     |                                |        |
+-----+--------------------------------+--------+
  80px        flex-grow: 1               320px
```

### Phase 5: Integration

**Tasks:**
1. Update `pages/workspace/[id]/codebase/[codebaseId]/visualization.tsx` to use new feature
2. Add route for component deep-link: `/visualization?node=<id>`
3. Add route for view selection: `/visualization?view=entry-points`
4. Test all functionality against screenshots

### Phase 6: Cleanup

**Tasks:**
1. Mark old components as deprecated with JSDoc
2. Update any other imports that reference old components
3. Delete `pages/visualization.tsx` (deprecated root page)
4. Create migration guide for any external references

## View Navigation Structure

```
Views (Sidebar):
├── Overview          # ArchitectureOverview - nodes grouped by type
├── Entry Points      # EntryPointsView - HTTP, CLI, events, scheduled
├── Exit Points       # ExitPointsView - Database, API, file, cache
├── Call Chains       # CallChainsView - execution paths with risk
├── External Services # ExternalServicesView - dependencies
└── Component Detail  # ComponentDetailView - when node selected
```

## Component State Flow

```
VisualizationContainer
  ├── useCASVisualization() - provides CAS data + computed values
  │
  ├── VisualizationSidebar
  │     ├── View selector (Overview, Entry Points, etc.)
  │     ├── Filter controls
  │     ├── Analysis stats (from cas.documentation_summary, todos_summary)
  │     └── Health indicators (from cas.implementation_health)
  │
  ├── VisualizationToolbar
  │     ├── Zoom controls
  │     ├── Layout selector
  │     ├── Search
  │     └── Export (SVG, PNG)
  │
  ├── [Current View Component]
  │     └── Renders based on selected view
  │
  └── NodeDetailPanel (when node selected)
        ├── Node info
        ├── Source location (clickable)
        ├── Documentation
        ├── Connections (incoming/outgoing)
        └── Call chains through this node
```

## Risk Mitigation

### Before Each Phase
1. Screenshot current functionality
2. Document all keyboard shortcuts
3. Note all hover/click behaviors
4. Record animation behaviors

### During Migration
1. Create parallel implementation (don't delete old code yet)
2. A/B compare behavior against screenshots
3. Test all interactions
4. Verify data accuracy

### After Migration
1. Keep old files for 2 weeks with `@deprecated` markers
2. Monitor for any broken functionality reports
3. Delete only after full verification

## File-by-File Migration Plan

| Old File | Action | New Location |
|----------|--------|--------------|
| `pages/visualization.tsx` | DELETE | N/A |
| `pages/workspace/.../visualization.tsx` | SIMPLIFY | Same (thin wrapper) |
| `InteractiveArchitectureDiagram.tsx` | EXTRACT | Multiple (hooks, utils) |
| `CallChainVisualization.tsx` | MIGRATE | views/CallChainsView.tsx |
| `ExternalServicesView.tsx` | MIGRATE | views/ExternalServicesView.tsx |
| `DrillDownVisualization.tsx` | EXTRACT | utils/layoutAlgorithms.ts |
| `ProgressiveLevelControl.tsx` | MIGRATE | controls/LevelControl.tsx |
| `BlueprintVisualization.tsx` | EVALUATE | May deprecate if unused |
| `VisualizationCanvas.tsx` | EVALUATE | May deprecate if unused |
| `GraphControls.tsx` | MIGRATE | VisualizationToolbar.tsx |
| `schematic/*` | EVALUATE | Keep if unique, else deprecate |

## Success Criteria

1. **No functionality loss** - Every feature from the audit doc works
2. **All CAS data visualized** - entry_points, exit_points, call_chains, etc.
3. **Single entry point** - One page, multiple views
4. **Deep navigation** - Can trace from entry point to exit point visually
5. **AI parity** - Human can answer same questions AI can with CAS JSON
6. **Performance** - Handles 500+ nodes smoothly
7. **Clean architecture** - Feature folder, clear separation of concerns

## Timeline (Task Order, No Dates)

1. Phase 1: Foundation (~20 files)
2. Phase 2: Canvas Components (~5 files)
3. Phase 3: View Components (~6 files)
4. Phase 4: Container + Navigation (~6 files)
5. Phase 5: Integration (~2 files)
6. Phase 6: Cleanup (delete ~10 files)

Total new files: ~40
Total files to delete: ~10
Net change: +30 files (but much better organized)
