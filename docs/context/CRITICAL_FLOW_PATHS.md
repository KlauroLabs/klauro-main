# Unravl - Critical User Flow Paths

**Purpose:** Page-to-page user journey reference for designers

---

## User Roles

| Role | Description |
|------|-------------|
| **New User** | No account yet |
| **Individual User** | Has account, personal workspaces |
| **Org Owner** | Created an organization |
| **Org Admin** | Can manage org members and workspaces |
| **Org Member** | Access to assigned workspaces only |

---

## Flow 1: New User First-Time Experience

```
Landing Page
    |
    +-- [Click "Sign Up"]
    |
    v
Registration Page
    |
    +-- [Fill form, submit]
    |       |
    |       +-- [Validation errors] --> Stay, show errors
    |       |
    |       +-- [Success]
    |               |
    |               v
    |       Workspaces Page (empty state)
    |               |
    |               +-- [Click "Create Your First Workspace"]
    |                       |
    |                       v
    |               Create Workspace Modal
    |                       |
    |                       +-- [Cancel] --> Back to empty Workspaces
    |                       |
    |                       +-- [Fill & submit]
    |                               |
    |                               v
    |                       Workspace Dashboard (empty, no codebases)
    |                               |
    |                               +-- [Click "Add Codebase"]
    |                                       |
    |                                       v
    |                               Add Codebase Modal
    |                                       |
    |                                       +-- [Enter repo, submit]
    |                                               |
    |                                               v
    |                                       Workspace Dashboard
    |                                       (codebase shows "Analyzing")
    |                                               |
    |                                               +-- [Wait...]
    |                                                       |
    |                                                       v
    |                                               Workspace Dashboard
    |                                               (codebase shows "Ready")
    |                                                       |
    |                                                       +-- [Click codebase]
    |                                                               |
    |                                                               v
    |                                                       System Overview
    v
[OR Click "Login"] --> Login Page
```

---

## Flow 2: Returning User Login

```
Landing Page
    |
    +-- [Click "Login"]
    |
    v
Login Page
    |
    +-- [Enter credentials, submit]
            |
            +-- [Invalid] --> Stay, show error
            |
            +-- [Valid]
                    |
                    v
            Workspaces Page
                    |
                    +-- [Has workspaces] --> Shows list of workspace cards
                    |
                    +-- [No workspaces] --> Shows empty state
```

---

## Flow 3: Visualization Navigation (The Core Experience)

This is the main product - exploring a codebase visually.

```
Workspace Dashboard
    |
    +-- [Click a codebase card]
    |
    v
System Overview
    |
    |   Shows: System name, tech stack summary, architecture layers, section cards
    |
    +-- [Click a Section card] (e.g., "Authentication", "Users", "Billing")
    |       |
    |       v
    |   Section View
    |       |
    |       |   Shows: All endpoints/capabilities in that section
    |       |
    |       +-- [Click an endpoint] (e.g., "POST /login", "GET /users")
    |       |       |
    |       |       v
    |       |   Flow View
    |       |       |
    |       |       |   Shows: The request journey as a call tree
    |       |       |
    |       |       +-- [Click a node in the tree]
    |       |       |       |
    |       |       |       v
    |       |       |   Node Detail Panel (slides in from right)
    |       |       |       |
    |       |       |       +-- [Click X] --> Panel closes
    |       |       |       |
    |       |       |       +-- [Click a connected node] --> Panel shows that node
    |       |       |
    |       |       +-- [Click Back button] --> Section View
    |       |
    |       +-- [Click Back button] --> System Overview
    |
    +-- [Click "View Architecture Diagram"]
    |       |
    |       v
    |   Graph View (full architecture diagram)
    |       |
    |       +-- [Click a node] --> Node Detail Panel opens
    |       |
    |       +-- [Pan/zoom around]
    |       |
    |       +-- [Click Back] --> System Overview
    |
    +-- [Click "Patterns" card]
    |       |
    |       v
    |   Patterns View
    |       |
    |       +-- [Click a pattern] --> Pattern Detail View --> [Back] --> Patterns View
    |       |
    |       +-- [Back] --> System Overview
    |
    +-- [Click "Testing" card]
    |       |
    |       v
    |   Tests View
    |       |
    |       +-- [Click a test area] --> Test Area View --> [Back] --> Tests View
    |       |
    |       +-- [Back] --> System Overview
    |
    +-- [Click "Needs Attention" card]
            |
            v
        Health View
            |
            +-- [Click an item] --> Node Detail Panel
            |
            +-- [Back] --> System Overview
```

---

## Flow 4: Switching Workspaces

```
Any page (when logged in)
    |
    +-- [Click workspace dropdown in sidebar/header]
    |
    v
Workspace Selector Dropdown
    |
    +-- [Click different workspace] --> That Workspace Dashboard
    |
    +-- [Click "Create New Workspace"] --> Create Workspace Modal
    |
    +-- [Click "View All"] --> Workspaces Page (list of all workspaces)
```

---

## Flow 5: Adding a Codebase

```
Workspace Dashboard
    |
    +-- [Click "+" button OR "Add Codebase"]
    |
    v
Add Codebase Modal
    |
    +-- [Select source: Repository URL / Local Path]
    |
    +-- [Enter URL or path]
    |
    +-- [Optional: configure settings]
    |
    +-- [Click "Add Codebase"]
            |
            v
    Workspace Dashboard
    (new codebase card appears with status indicator)
```

---

## Flow 6: Org Owner - Inviting Team Members

```
Workspace Dashboard (for an org workspace)
    |
    +-- [Click "Organization" in sidebar]
    |
    v
Organization Dashboard
    |
    |   Shows: Org stats, member list, workspace list
    |
    +-- [Click "Invite Member"]
            |
            v
    Invite Member Modal
            |
            +-- [Enter email]
            |
            +-- [Select role: Admin / Member / Viewer]
            |
            +-- [Click "Send Invite"]
                    |
                    v
            Organization Dashboard
            (new row in members with "Pending" badge)
```

---

## Flow 7: Invited User Accepts Invitation

```
Email Inbox
    |
    +-- [Click invite link in email]
    |
    v
Accept Invitation Page
    |
    +-- [Already has account]
    |       |
    |       v
    |   Login Page --> [Login] --> Workspaces Page (now includes org workspace)
    |
    +-- [No account]
            |
            v
        Registration Page --> [Register] --> Workspaces Page (includes org workspace)
```

---

## Flow 8: Changing Member Roles (Org Owner/Admin)

```
Organization Dashboard
    |
    +-- [Click on a member row OR member's menu button]
    |
    v
Member Actions
    |
    +-- [Change Role dropdown] --> Select role --> Role updates
    |
    +-- [Remove] --> Confirm dialog --> Member removed
```

---

## Flow 9: Workspace Settings

```
Workspace Dashboard
    |
    +-- [Click gear icon OR "Settings" in sidebar]
    |
    v
Workspace Settings Page
    |
    +-- [General tab] --> Edit name, description --> Save
    |
    +-- [Members tab] (org workspaces) --> Manage access
    |
    +-- [Integrations tab] --> Configure webhooks
    |
    +-- [Click Back or sidebar link] --> Workspace Dashboard
```

---

## Flow 10: User Account Settings

```
Any page
    |
    +-- [Click user avatar in header]
    |
    v
User Menu Dropdown
    |
    +-- [Settings] --> User Settings Page
    |       |
    |       +-- [Profile tab] --> Edit name, password
    |       |
    |       +-- [Notifications tab] --> Toggle preferences
    |       |
    |       +-- [Integrations tab] --> Connect GitHub/GitLab
    |       |
    |       +-- [API Keys tab] --> Manage keys
    |
    +-- [Logout] --> Landing Page
```

---

## Flow 11: Billing & Upgrade

```
User Settings Page OR Organization Dashboard
    |
    +-- [Click "Billing" in sidebar]
    |
    v
Billing Page
    |
    |   Shows: Current plan, usage stats, payment method, invoices
    |
    +-- [Click "Upgrade" or "Change Plan"]
    |       |
    |       v
    |   Plan Selection
    |       |
    |       +-- [Select plan, Continue]
    |               |
    |               v
    |           Stripe Checkout
    |               |
    |               +-- [Complete payment]
    |                       |
    |                       v
    |               Billing Page (shows new plan)
    |
    +-- [Update Payment Method]
            |
            v
        Payment Modal --> Update --> Billing Page
```

---

## Flow 12: Codebase States & Actions

From **Workspace Dashboard**, each codebase card shows a status:

```
Codebase Card
    |
    +-- Status: PENDING (gray)
    |       Actions: Delete, Settings
    |
    +-- Status: ANALYZING (spinner)
    |       Actions: Cancel
    |
    +-- Status: READY (green)
    |       Actions: View (opens visualization), Re-analyze, Settings, Delete
    |       |
    |       +-- [Click card or "View"] --> System Overview
    |
    +-- Status: FAILED (red)
            Actions: Retry, View Error, Settings, Delete
```

---

## Flow 13: Switching Codebases Within a Workspace

```
Visualization (any level)
    |
    +-- [Click workspace name in breadcrumb]
    |
    v
Workspace Dashboard
    |
    +-- [Click different codebase card]
    |
    v
System Overview (for new codebase)
```

---

## Key UI Elements for Navigation

### Sidebar (visible on all authenticated pages)
- Workspace selector dropdown
- List of codebases in current workspace
- Organization link (if applicable)
- Settings link

### Header
- Logo (click → Workspaces Page)
- Breadcrumbs (in visualization: Workspace > Codebase > Section > Endpoint)
- Search bar
- User avatar dropdown

### Breadcrumb Navigation (visualization only)
- Each level is clickable
- Clicking goes back to that level
- Example: `My Workspace > Backend > Authentication > POST /login`
