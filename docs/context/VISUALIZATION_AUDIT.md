# Visualization System Audit

## Executive Summary

The visualization system is fragmented across 15+ files with significant code duplication. This audit catalogs all unique functionality to ensure nothing is lost during consolidation.

## File Inventory

### Pages (Entry Points)

| File | Lines | Status | Data Source |
|------|-------|--------|-------------|
| `pages/visualization.tsx` | 2,013 | DEPRECATED | Hardcoded path, direct CAS API |
| `pages/workspace/[id]/codebase/[codebaseId]/visualization.tsx` | 2,018 | ACTIVE | Proper routing, auth, blueprint API |

**Analysis**: These are near-duplicates. The workspace version is the correct integration. The root `visualization.tsx` should be removed after consolidation.

### Main Components

| File | Lines | Purpose | Unique Features |
|------|-------|---------|-----------------|
| `InteractiveArchitectureDiagram.tsx` | 814 | Node focus + connection view | Connection bundling, focus history, filtered bundles |
| `DrillDownVisualization.tsx` | 629 | D3-based drill-down | D3 sections, animated transitions, health status |
| `CallChainVisualization.tsx` | 600 | Call chain tracing | Flow nodes, async/sync edges, bottleneck detection |
| `ExternalServicesView.tsx` | 500 | External services display | Service categories, direction filters, health status |
| `InteractiveCardSystem.tsx` | 536 | Card-based component grid | Card layout, hover states, grid organization |
| `ProgressiveLevelControl.tsx` | 293 | Level slider control | Progressive disclosure slider, level definitions |
| `HierarchicalFlow.tsx` | 287 | Hierarchical layout | D3 hierarchy, layer-based positioning |
| `ArchitectureFlow.tsx` | 247 | React Flow wrapper | React Flow integration, custom nodes |
| `ProgressiveTreeView.tsx` | 246 | Tree view component | Expandable tree, node icons |

### Schematic Components

| File | Lines | Purpose | Unique Features |
|------|-------|---------|-----------------|
| `SimpleSystemSchematic.tsx` | 300 | System overview | Status indicators, quick info tooltips |
| `SystemSchematic.tsx` | 300 | Full schematic | Complete schematic with all details |
| `ComponentDetailsPanel.tsx` | 400 | Component detail sidebar | Full metadata display, connections list |
| `SchematicNavigation.tsx` | 200 | Navigation breadcrumbs | Path-based navigation |
| `SystemViewer.tsx` | 250 | System viewer wrapper | Viewer orchestration |
| `IssuesPanel.tsx` | 250 | Issues display | Error/warning aggregation |

### Visualization Subfolder

| File | Lines | Purpose | Unique Features |
|------|-------|---------|-----------------|
| `BlueprintVisualization.tsx` | 200 | Blueprint wrapper | WebSocket telemetry, navigation stack |
| `VisualizationCanvas.tsx` | 220 | Canvas mode switcher | Blueprint vs Force-Graph toggle |
| `GraphControls.tsx` | 230 | Toolbar controls | Zoom, layout, search, export |

### Library Files

| File | Purpose | Status |
|------|---------|--------|
| `lib/d3/force-graph.ts` | D3 force graph | Referenced but possibly incomplete |
| `lib/blueprint/blueprint-renderer.ts` | Blueprint renderer | Referenced but possibly incomplete |

---

## Unique Functionality Catalog

### 1. Progressive Disclosure (CRITICAL)
**Source**: `ProgressiveLevelControl.tsx`, `pages/visualization.tsx`
- Level 0: Architecture groups (Controllers, Services, etc.)
- Level 1: Individual components within groups
- Level 2+: Methods, properties, details
- Slider control with level definitions

### 2. Node Focus + Connections (CRITICAL)
**Source**: `InteractiveArchitectureDiagram.tsx`
- Focus on single node
- Show incoming/outgoing connections
- Connection history navigation
- Bundle connections by type
- Filter bundle types

### 3. Call Chain Visualization (CRITICAL)
**Source**: `CallChainVisualization.tsx`
- Flow nodes with depth
- Entry/exit/internal/external types
- Sync/async/recursive edge types
- Hot path detection
- Bottleneck identification

### 4. External Services View (IMPORTANT)
**Source**: `ExternalServicesView.tsx`
- Database, API, cache categorization
- Direction filtering (consumption/production/bidirectional)
- Health status per service
- Connected nodes listing

### 5. D3 Force Layout (IMPORTANT)
**Source**: `DrillDownVisualization.tsx`
- D3-based force simulation
- Section-based grouping
- Animated transitions
- Curved connection paths

### 6. Component Details Panel (IMPORTANT)
**Source**: `ComponentDetailsPanel.tsx`, side panels in pages
- Full metadata display
- Connection lists (calls to/called by)
- Flags (entry point, orphaned, db exit)
- File path and line numbers

### 7. Filtering System (IMPORTANT)
**Source**: Multiple files
- By type (controller, service, etc.)
- By status (critical, orphaned, entry)
- By perspective (NestJS, TypeScript, React)
- Framework concepts only toggle

### 8. Pan/Zoom Controls (BASIC)
**Source**: Multiple files
- Mouse wheel zoom
- Drag to pan
- Center/reset view
- Zoom buttons

### 9. Connection Lines (BASIC)
**Source**: SVG in pages, D3 in components
- Curved paths
- Arrowhead markers
- Opacity based on weight
- Dashed for async

---

## CAS Data Usage Analysis

### Currently Used

| CAS Field | Where Used | How Used |
|-----------|------------|----------|
| `nodes` | All visualizations | Component cards |
| `edges` | Connection lines | callsTo/calledBy |
| `system.name` | Header | Repository name |
| `system.type` | Chips | System type badge |
| `analyzer_contributions` | Sidebar | Framework detection |

### NOT Used (Available in CAS)

| CAS Field | Potential Use |
|-----------|---------------|
| `architecture_summary` | System overview panel |
| `route_table` | API endpoints view |
| `database_schema` | Entity relationship diagram |
| `external_services` | External services view |
| `entry_points` | Entry point highlighting |
| `exit_points` | Exit point highlighting |
| `progressive_levels` | Level definitions |

---

## Consolidation Strategy

### Phase 1: Create Unified Data Layer
1. Create `useCASVisualization` hook that:
   - Fetches CAS data via workspace/codebase API
   - Builds edge maps for quick lookup
   - Computes derived data (groups, connections)
   - Provides level filtering

### Phase 2: Create Core Visualization Component
1. Single `ArchitectureVisualization` component that:
   - Renders nodes on canvas
   - Draws connection lines
   - Handles pan/zoom
   - Supports progressive disclosure

### Phase 3: Create View Modules
1. `ArchitectureSummaryView` - Uses architecture_summary
2. `RouteTableView` - Uses route_table
3. `DatabaseSchemaView` - Uses database_schema
4. `ExternalServicesView` - Uses external_services
5. `CallChainView` - Uses edges for tracing

### Phase 4: Create Detail Panels
1. `NodeDetailPanel` - Component/function details
2. `EndpointDetailPanel` - HTTP endpoint details
3. `EntityDetailPanel` - Database entity details

### Phase 5: Remove Deprecated Files
1. Delete `pages/visualization.tsx`
2. Archive unused components
3. Update imports

---

## Risk Mitigation

### Before Any Changes
1. Screenshot current visualization states
2. Document all keyboard shortcuts
3. Note all hover/click interactions
4. Record any animation behaviors

### During Migration
1. Migrate one feature at a time
2. Compare behavior against screenshots
3. Test all interactions
4. Verify data accuracy

### After Migration
1. Full regression test
2. Performance comparison
3. User acceptance testing

---

## Recommended Architecture

```
legacy/web/src/
  features/
    visualization/
      components/
        ArchitectureCanvas.tsx        # Main canvas with pan/zoom
        NodeCard.tsx                  # Individual node rendering
        ConnectionLine.tsx            # SVG connection line
        LevelControl.tsx              # Progressive disclosure slider
        ViewModeSelector.tsx          # Switch between views
      views/
        ArchitectureOverview.tsx      # Groups view (level 0)
        ComponentsView.tsx            # Components view (level 1)
        DetailsView.tsx               # Method/property view (level 2+)
        RouteTableView.tsx            # API endpoints
        DatabaseSchemaView.tsx        # Entity diagram
        ExternalServicesView.tsx      # External deps
        CallChainView.tsx             # Trace execution
      panels/
        NodeDetailPanel.tsx           # Right sidebar
        AnalysisInfoPanel.tsx         # Left sidebar
        FilterPanel.tsx               # Filter controls
      hooks/
        useCASVisualization.ts        # Data fetching + processing
        usePanZoom.ts                 # Pan/zoom state
        useNodeSelection.ts           # Selection state
        useFilters.ts                 # Filter state
      types/
        visualization.types.ts        # Unified types
      utils/
        layoutAlgorithms.ts           # Force, grid, hierarchy
        colorSchemes.ts               # Type-based colors
        connectionUtils.ts            # Edge processing
      index.ts                        # Public exports
  pages/
    workspace/
      [id]/
        codebase/
          [codebaseId]/
            visualization.tsx         # Single entry point
```

This architecture:
1. Separates concerns clearly
2. Makes features independently testable
3. Allows gradual migration
4. Preserves all functionality
5. Enables easy addition of new views
