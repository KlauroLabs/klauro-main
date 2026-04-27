# Unravl Platform - Design Flow Paths

**Purpose:** Designer reference for creating UI prototypes
**Version:** 1.0
**Last Updated:** 2026-01-24

This document maps all user journeys through the Unravl platform, focused on UI screens, interactions, and user experience - not technical implementation details.

---

## Table of Contents

1. [User Roles](#user-roles)
2. [Authentication Screens](#authentication-screens)
3. [Onboarding Experience](#onboarding-experience)
4. [Workspace Dashboard](#workspace-dashboard)
5. [Codebase Management](#codebase-management)
6. [Architecture Visualization](#architecture-visualization)
7. [Organization & Team Management](#organization--team-management)
8. [Settings & Billing](#settings--billing)

---

## User Roles

| Role | Description | Access Level |
|------|-------------|--------------|
| **Individual User** | Personal account, free or paid tier | Own workspaces only |
| **Organization Owner** | Created the organization | Full organization access, billing, member management |
| **Organization Admin** | Elevated team member | Member management, workspace creation |
| **Organization Member** | Standard team member | Assigned workspaces only |
| **Viewer** | Read-only access | View visualization only, no edits |

---

## Authentication Screens

### Login Screen (`/login`)

**Layout:**
- Dark themed background (#0a0a0a)
- Centered card with frosted glass effect
- Gradient button (purple to blue)

**Elements:**
- Heading: "Login to Unravl"
- Email input field
- Password input field
- "Login" button (primary action)
- "Don't have an account? Register here" link
- Error alert banner (appears on failed login)

**User Actions:**
- Enter credentials and submit
- Click "Register here" to go to registration

**Next Screen:** Workspaces Dashboard

---

### Registration Screen (`/register`)

**Layout:**
- Same dark themed design as login
- Slightly taller card to accommodate more fields

**Elements:**
- Heading: "Create Account"
- Email input (required)
- Name input (required)
- Password input with strength indicator
- Confirm Password input
- Organization Name input (optional)
- "Create Account" button
- "Already have an account? Login here" link
- Error alert banner

**Validation Messages:**
- "Password must be at least 8 characters"
- "Password must contain uppercase, lowercase, number, and special character"
- "Passwords do not match"

**User Actions:**
- Fill out form and submit
- Click "Login here" to return to login

**Next Screen:** Onboarding Wizard OR Workspaces Dashboard

---

## Onboarding Experience

### Welcome Screen (First-time users)

**When Shown:** User has no workspaces

**Layout:**
- Centered content with illustration
- Business icon in avatar
- Clear call-to-action

**Elements:**
- Large icon (Business/Workspace icon)
- Heading: "Welcome to Unravl"
- Subtext: "Create your first workspace to start visualizing and analyzing your codebase architecture"
- "Create Your First Workspace" button (prominent)

**User Actions:**
- Click to open Create Workspace modal

**Next Screen:** Create Workspace Modal

---

### Create Workspace Modal

**Layout:**
- Modal dialog, centered
- Form fields stacked vertically
- Two-column radio button options

**Elements:**

1. **Workspace Name** (required)
   - Text input
   - Helper: "A descriptive name for your workspace"

2. **Slug** (auto-generated)
   - Text input, pre-filled from name
   - Helper: "URL-friendly identifier (auto-generated from name)"

3. **Description** (optional)
   - Multiline text area
   - 3 rows

4. **Workspace Type** (radio buttons)
   - **Personal** (icon: Person)
     - "For individual projects and personal use"
   - **Organization** (icon: Business)
     - "For team collaboration and shared projects"
     - Disabled if user has no organizations

5. **Organization Selector** (conditional)
   - Dropdown, only shown if "Organization" selected
   - Lists user's organizations

6. **Visibility** (radio buttons)
   - **Private:** "Only invited users can access"
   - **Internal:** "All organization members can access" (disabled for personal)

**Footer Actions:**
- "Cancel" button
- "Create Workspace" button

**Next Screen:** Workspace Dashboard (with empty state)

---

## Workspace Dashboard

### Dashboard Screen (`/workspaces`)

**Layout:**
- Left sidebar navigation
- Main content area with header and cards
- Floating action button (bottom right)

**Header Section:**
- Workspace name with avatar (Person or Business icon)
- Workspace description
- Chip showing "personal" or "organization"
- "Add Codebase" button

**Stats Grid (4 cards):**
1. **Total Codebases** - Blue themed, Code icon
2. **Analyses This Month** - Green themed, Analytics icon
3. **Storage Used** - Orange themed, Storage icon
4. **Team Members** - Pink themed, People icon

Each stat card shows:
- Large number
- Label
- Trend indicator or percentage

**Empty State (No Codebases):**
- Info alert: "No codebases yet. Add your first codebase to start analyzing your architecture."
- "Get Started" button

**Codebases Section:**
- Section header: "Codebases" with count chip
- Search bar: "Search codebases by name or description..."
- Grid of codebase cards (3 columns on desktop)

**Codebase Card Elements:**
- Repository icon (GitHub, GitLab, or folder)
- Codebase name
- Description
- Status chip (Pending, Analyzing, Ready, Failed)
- Language/framework tags
- Last analyzed date
- Actions: "View", "Analyze", "Settings"

**Floating Action Button:**
- "+" icon
- Opens Add Codebase modal

---

### Add Codebase Modal

**Layout:**
- Wide modal dialog
- Segmented source type selector at top
- Form fields below

**Elements:**

1. **Source Type Selector** (toggle buttons)
   - **Repository URL** (icon: Link) - default
   - **Local Path** (icon: Folder)
   - **Upload** (icon: CloudUpload) - "Coming Soon" badge

2. **Codebase Name** (required)
   - Auto-populates from URL/path

3. **Repository URL** (if URL selected)
   - Placeholder: "https://github.com/username/repository"
   - Helper: "Link to your Git repository for automatic updates"

4. **Branch** (if URL provided)
   - Default: "main"

5. **Local Path** (if Local selected)
   - Placeholder: "/Users/username/projects/my-app"
   - Helper: "Absolute path to the codebase directory"

6. **Description** (optional)
   - Multiline, 3 rows

**Analysis Settings Section:**
- Divider with "Analysis Settings" heading

7. **Auto-analyze on changes** (toggle switch)
   - Helper: "Automatically run analysis when repository is updated"

8. **Analysis Schedule** (dropdown)
   - Options: "Manual only", "Daily", "Weekly", "Monthly"

9. **Max File Size** (number input)
   - Default: 10 MB
   - Helper: "Files larger than this will be skipped"

10. **Ignore Patterns** (tag input)
    - Pre-filled: node_modules/**, .git/**, etc.
    - Autocomplete suggestions

11. **Include Patterns** (tag input)
    - Optional
    - Helper: "If specified, only matching files will be analyzed"

**Notifications Section:**
- Toggle switches:
  - "Analysis completion"
  - "Analysis failures"
  - "Issues detected"

**Footer:**
- "Cancel" button
- "Add Codebase" button

---

## Architecture Visualization

This is the core experience - the "living blueprint" that makes codebases understandable.

### System Overview (`/workspace/[id]?codebase=[id]`)

**Layout:**
- Full-height viewport
- Three-column grid on large screens
- Scrollable content area
- Breadcrumb navigation at top (when drilling down)

**Header Area:**
- System name (large, bold)
- System type chip (e.g., "NestJS Backend")
- Auth strategy chip (e.g., "JWT")

**Overview Cards (3 columns):**

1. **Tech Stack Card**
   - "Languages" section with progress bars (TypeScript 85%, etc.)
   - "Frameworks" section with colored chips (NestJS, React, etc.)

2. **Architecture Card**
   - Layer breakdown:
     - Presentation Layer: Controllers count, Guards count
     - Business Layer: Services count
     - Data Layer: Repositories count
   - "View Architecture Diagram" link

3. **Entry Points Card**
   - List of entry point types with counts:
     - HTTP (icon: Hub) - 88
     - WebSocket (icon: Dns) - 2
     - CLI (icon: Terminal) - 5
   - Protected/Public endpoint counts

**Optional Cards (shown based on data):**

4. **Testing Card** (if tests detected)
   - Total tests count
   - Coverage percentage
   - Type breakdown bar (Unit/Integration/E2E)
   - Top test areas list
   - "View all tests" link

5. **Patterns Card** (if patterns detected)
   - Design Patterns count
   - Anti-Patterns count
   - Top patterns list
   - Critical/Warning deviations count
   - "View all patterns" link

6. **Needs Attention Card** (if issues found)
   - Partial implementations count
   - Stub implementations count
   - Contains TODOs count
   - "View all items" link

7. **External Integrations Card**
   - Grid of external services
   - Each shows: icon, name, type

**Sections Area (bottom):**
- Heading: "API Domains" or "Application Sections"
- Grid of section cards

**Section Card Elements:**
- Icon in colored box
- Section name (e.g., "Authentication", "Workspaces", "Billing")
- Entry count badge
- Tags: Auth required, Database, External calls

---

### Domain/Section View

**When Shown:** User clicks a section card

**Breadcrumb:** System > [Section Name]

**Layout:**
- Back button
- Section header with icon and name
- Stats row (entry points, components, etc.)
- Grid of capability cards

**Capability Card Elements:**
- HTTP method chip (GET, POST, PUT, DELETE)
- Endpoint path
- Capability name/description
- Auth indicator (lock icon)
- "View Flow" action

---

### Flow View (Request Trace)

**When Shown:** User clicks a capability/endpoint

**Breadcrumb:** System > [Section] > [Capability]

**Header:**
- Back button
- Capability name
- Auth status chip (Authenticated/Public)
- HTTP method and path
- Stats: Steps count, Max Depth, Database indicator, Async indicator

**Flow Content:**

**Explanation Text:**
- "How does this work?"
- "Follow the journey of a request from when it arrives to when it completes. Click any step to see more details."

**Bottleneck Alert** (if detected):
- Warning box listing potential performance issues

**Call Tree Visualization:**
- Hierarchical tree showing execution flow
- Each node shows:
  - Expand/collapse toggle
  - Node name
  - Node type chip (colored by type)
  - Exit point chips (Database, External API icons)
- Lines connecting parent to children
- Clickable nodes open detail panel

---

### Node Detail Panel (Right Sidebar)

**When Shown:** User clicks any node in visualization

**Layout:**
- 400px width sidebar on right
- Slides in from right
- Close button (X) at top

**Panel Sections:**

1. **Header**
   - Node type chip (colored)
   - Node name (large)
   - Close button

2. **Source Location**
   - File path
   - Line number
   - "View Source" link

3. **Documentation** (if available)
   - Description text
   - JSDoc/docstring content

4. **Parameters** (for functions/methods)
   - List of parameters with types
   - Required/optional indicator

5. **Return Type**
   - Type definition

6. **Connections**
   - "Incoming" section - what calls this
   - "Outgoing" section - what this calls
   - Each connection is clickable

7. **Exit Points** (if applicable)
   - Database operations
   - External API calls
   - Each shows type and details

8. **Call Chains**
   - Traces this node appears in
   - Entry point to exit point visualization

9. **Navigation**
   - "Back" button (history)
   - Previous/Next node navigation

---

### Graph View (Architecture Diagram)

**When Shown:** User clicks "View Architecture Diagram"

**Breadcrumb:** System > Graph

**Layout:**
- Full canvas area
- Floating control panel
- Minimap in corner

**Control Panel:**
- Zoom in/out buttons
- Fit to screen button
- Layout toggle (hierarchical, force-directed)
- Filter dropdown (by type, by layer)
- Search input

**Graph Elements:**
- Nodes as cards with:
  - Type icon
  - Name
  - Colored border by type
- Edges as curved lines
- Edge labels (optional)
- Clustering by domain/layer

**Interactions:**
- Click node: select and show detail panel
- Double-click node: drill into children
- Drag to pan
- Scroll to zoom
- Hover for tooltips

---

### Patterns View

**When Shown:** User clicks Patterns card

**Breadcrumb:** System > Patterns

**Layout:**
- Grid of pattern cards
- Filter sidebar

**Pattern Card:**
- Pattern name
- Instance count
- Brief description
- Deviation warning badge (if any)

**Pattern Detail View:**
- Pattern description
- List of instances
- Each instance shows:
  - Component name
  - Conformance status (check/warning icons)
  - Deviations list

---

### Tests View

**When Shown:** User clicks Testing card

**Breadcrumb:** System > Tests

**Layout:**
- Summary stats at top
- Test type breakdown chart
- Grid of test area cards

**Test Area Card:**
- Area name (e.g., "AuthService Tests")
- Test count
- Type breakdown
- Click to see individual tests

**Test Detail:**
- Test name and description
- Test type (unit/integration/e2e)
- Target component link
- Mock dependencies list

---

### Implementation Health View

**When Shown:** User clicks Needs Attention card

**Breadcrumb:** System > Implementation Health

**Layout:**
- Filter bar by status
- List of items needing attention

**Item Card:**
- Status badge (Partial, Stub, TODO)
- Component name
- Issue description
- File location
- Click to view in detail panel

---

## Organization & Team Management

### Organization Dashboard

**Layout:**
- Org header with logo/avatar
- Stats overview
- Member list
- Workspace list

**Header:**
- Organization avatar
- Organization name
- Role badge (Owner, Admin)
- Settings button

**Stats:**
- Total Members
- Total Workspaces
- Active Analyses
- Storage Used

**Members Section:**
- Table with columns:
  - Avatar + Name
  - Email
  - Role (dropdown for admins)
  - Joined date
  - Actions (remove, change role)
- "Invite Member" button

**Workspaces Section:**
- Grid of workspace cards
- "Create Workspace" button

---

### Invite Member Modal

**Elements:**
- Email input
- Role selector (Admin, Member, Viewer)
- Optional: workspace access selection
- "Send Invitation" button

**Invitation States:**
- Pending (shows in members list with pending badge)
- Accepted (normal member row)
- Expired (can resend)

---

## Settings & Billing

### User Settings

**Tabs:**
1. **Profile**
   - Avatar upload
   - Name
   - Email
   - Change password

2. **Notifications**
   - Email preferences toggles
   - Analysis notifications
   - Team updates

3. **Integrations**
   - GitHub connection status
   - GitLab connection status
   - Connect/Disconnect buttons

4. **API Keys**
   - List of active keys
   - Create new key
   - Revoke key

---

### Workspace Settings

**Tabs:**
1. **General**
   - Name, slug, description
   - Visibility
   - Delete workspace (danger zone)

2. **Members** (org workspaces only)
   - Access list
   - Add/remove members
   - Change permissions

3. **Integrations**
   - Webhook configuration
   - CI/CD integrations

---

### Billing (Organization/User)

**Layout:**
- Current plan card
- Usage stats
- Payment method
- Invoice history

**Plan Card:**
- Plan name (Free, Pro, Enterprise)
- Price
- Features list
- "Upgrade" or "Change Plan" button

**Usage Stats:**
- Workspaces: X of Y
- Codebases: X of Y
- Analyses this month: X of Y
- Storage: X GB of Y GB

**Payment Method:**
- Card on file (masked number)
- "Update" button

**Invoices:**
- Table with date, amount, status
- Download PDF links

---

## Navigation Structure

```
/ (Landing Page - Marketing)
/login
/register
/workspaces (Dashboard - requires auth)
/workspace/[id] (Workspace Dashboard)
/workspace/[id]?codebase=[codebaseId] (Visualization)
/workspace/[id]/settings
/workspace/[id]/codebase/[id]/settings
/organization/[id] (Org Dashboard)
/organization/[id]/settings
/organization/[id]/billing
/settings (User Settings)
```

---

## State Indicators

### Codebase States
| State | Visual | Description |
|-------|--------|-------------|
| Pending | Gray chip | Just added, not analyzed |
| Cloning | Blue spinner | Fetching repository |
| Analyzing | Blue spinner with progress | Running analyzers |
| Ready | Green chip | Analysis complete |
| Failed | Red chip | Analysis error |

### Node Type Colors
| Type | Color | Usage |
|------|-------|-------|
| Controller | #e0234e | API entry points |
| Service | #3949ab | Business logic |
| Repository | #00897b | Data access |
| Guard | #ff9800 | Auth/security |
| Module | #7e57c2 | NestJS modules |
| Component | #2196f3 | React components |
| Hook | #9c27b0 | React hooks |
| Function | #607d8b | General functions |

---

## Responsive Breakpoints

| Breakpoint | Width | Adjustments |
|------------|-------|-------------|
| Mobile | < 600px | Single column, collapsed sidebar |
| Tablet | 600-960px | 2 columns, hamburger menu |
| Desktop | 960-1280px | 3 columns, full sidebar |
| Large | > 1280px | 4 columns, expanded panels |

---

## Accessibility Notes

- All interactive elements have focus states
- Color is not the only indicator (icons + text)
- Keyboard navigation throughout
- Screen reader labels on icons
- Sufficient color contrast (dark theme optimized)
- Animations respect reduced-motion preference
