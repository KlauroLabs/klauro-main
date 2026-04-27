# Workspace Frontend Implementation Notes

This document summarizes an earlier Phase 1 frontend implementation pass for the workspace/codebase structure in Unravl.

Treat this as implementation context, not a current-state guarantee. Before relying on any item here, verify the referenced frontend files, backend endpoints, and authentication flow against the current code.

The product framing is unchanged: workspaces and codebases are the organizing layer for CAS-backed inspection. The UI should help humans see what was built, where analysis is fresh or stale, and how to drill from product-level structure into behavior-level graph detail.

## Components Described Here

### 1. Type Definitions
- **`/src/types/workspace.types.ts`** - Workspace and codebase type definitions
- **`/src/types/billing.types.ts`** - Billing tiers, limits, and utility functions
- **`/src/types/codebase.types.ts`** - Analysis types and codebase management

### 2. API Client Integration
- **`/src/services/api.ts`** - Workspace/codebase endpoint support
  - Workspace CRUD operations
  - Codebase management
  - Analysis operations
  - User access control
  - Authentication handling

### 3. State Management
- **`/src/contexts/WorkspaceContext.tsx`** - Workspace state management
  - Current workspace tracking
  - Workspace switching
  - CRUD operations
  - Error handling
  - Local storage persistence

### 4. Custom Hooks
- **`/src/hooks/useWorkspaces.ts`** - Workspace data management and validation
- **`/src/hooks/useCodebases.ts`** - Codebase operations and analysis management
- **`/src/hooks/useBilling.ts`** - Billing limits, usage tracking, and upgrade prompts

### 5. Core Components

#### Workspace Components (`/src/components/workspace/`)
- **`WorkspaceSelector`** - Dropdown/switcher with multiple variants (dropdown, compact, detailed)
- **`WorkspaceCard`** - Display workspace info with stats and actions (3 variants)
- **`WorkspaceCreate`** - Form for creating workspaces with settings

#### Codebase Components (`/src/components/codebase/`)
- **`CodebaseCard`** - Display codebase info with analysis status (3 variants)
- **`CodebaseCreate`** - Comprehensive form for adding codebases with Git integration

#### Navigation Components (`/src/components/navigation/`)
- **`AppNavigation`** - Workspace-aware top navigation with user menu
- **`AppBreadcrumbs`** - Context-aware breadcrumb navigation
- **`AppLayout`** - Layout wrapper with responsive sidebar

### 6. Dashboard Pages
- **`/src/pages/WorkspaceDashboard.tsx`** - Main workspace overview with stats and codebase grid
- **`/src/pages/CodebasesDashboard.tsx`** - Advanced codebase management with filtering and sorting

## Key Features Implemented

### User Experience
- **Responsive Design** - Mobile-friendly across all components
- **Permission Awareness** - UI adapts based on user access level
- **Billing Integration** - Upgrade prompts and limit notifications
- **Smart Defaults** - Sensible settings and auto-population
- **Progressive Enhancement** - Works without breaking existing functionality

### Workspace Management
- **Multi-tenant Support** - Personal and organization workspaces
- **Easy Switching** - Quick workspace context changes
- **Rich Metadata** - Tags, descriptions, and settings
- **Access Control** - Role-based permissions (viewer, contributor, admin, owner)

### Codebase Management
- **Git Integration** - Repository URL linking with branch support
- **Analysis Configuration** - Ignore patterns, file size limits, scheduling
- **Status Tracking** - Real-time analysis status with progress indicators
- **Search & Filter** - Advanced filtering by status, tags, and text search

### Navigation & Context
- **Breadcrumb Navigation** - Clear hierarchy showing workspace > codebase > feature
- **Workspace Awareness** - All components understand current workspace context
- **Mobile Support** - Collapsible navigation and touch-friendly controls

### Performance & Quality
- **Optimistic Updates** - UI updates immediately with proper error handling
- **Loading States** - Skeleton loading and progress indicators
- **Error Boundaries** - Graceful error handling throughout
- **TypeScript Strict Mode** - Full type safety across all components

## Integration Points

### Backend API
Verify these against the active backend before treating them as supported endpoints:
```
GET    /workspaces                    # List user workspaces
POST   /workspaces/user              # Create personal workspace
POST   /workspaces/organization/:id  # Create org workspace
GET    /workspaces/:id               # Get workspace details
PATCH  /workspaces/:id               # Update workspace
GET    /workspaces/:id/codebases     # List codebases
POST   /workspaces/:id/codebases     # Create codebase
```

### Authentication
- Token-based auth with localStorage
- Automatic retry and error handling
- User context and billing tier integration

### State Persistence
- Current workspace stored in localStorage
- Form state preservation across navigation
- Optimistic updates with rollback capability

## Usage Examples

### Basic Layout
```tsx
import { AppLayout } from './components/navigation';

function App() {
  return (
    <AppLayout
      userEmail="user@example.com"
      userBillingTier="pro"
      onUpgrade={() => console.log('Upgrade clicked')}
    >
      <YourPageContent />
    </AppLayout>
  );
}
```

### Workspace Dashboard
```tsx
import { WorkspaceDashboard } from './pages/WorkspaceDashboard';

// Automatically shows current workspace with codebases
<WorkspaceDashboard />
```

### Custom Breadcrumbs
```tsx
import { AppBreadcrumbs } from './components/navigation';

<AppBreadcrumbs
  items={[
    { label: 'Analysis', icon: <AnalyticsIcon />, isActive: true }
  ]}
  currentCodebase={codebase}
/>
```

## Next Steps

### Phase 2 Recommendations
1. **Settings Pages** - Workspace and codebase settings management
2. **Team Management** - User invitation and access control UI
3. **Billing Dashboard** - Usage tracking and upgrade flows
4. **Analysis Viewer** - Integration with existing visualization components
5. **Notifications** - Real-time updates and alert system

### Integration Tasks
1. Connect to real backend endpoints
2. Add authentication flow
3. Implement WebSocket for real-time updates
4. Add error tracking and analytics
5. Performance monitoring and optimization

The next checkpoint is to verify these notes against the live frontend and backend, then connect the workspace screens directly to CAS-backed analysis status, errors, and relationship graph drilldown.
