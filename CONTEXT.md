# Unravl - Architecture Diagrams Come Alive

## The Vision

Take your typical architecture diagram - boxes, arrows, labels. Now imagine if you could click on any box and zoom into it, seeing all its internals. Click on any arrow and watch data actually flowing through it. See problems light up in red the moment they happen. Follow any path from entry to exit. Get descriptions and documentation right where you need them. 

This is Unravl: architecture diagrams on steroids. Living, breathing, interactive blueprints that show you everything at a glance, then let you drill into any detail you need.

## Understanding at a Glance

When you first open Unravl, you see your entire system laid out visually, like an interactive architecture diagram. Not as files and folders, but as a living architecture:

- **Major components** arranged logically, sized by importance or complexity
- **Connections flowing between them** - thick lines for heavy traffic, thin for occasional calls
- **Entry points clearly marked** - API endpoints, user interfaces, event listeners, scheduled jobs
- **Exit points visible** - database writes, external API calls, file outputs, message publishing
- **Real-time activity overlay** - see which parts are active RIGHT NOW
- **Health indicators** - green for healthy, yellow for stressed, red for failing

In seconds, you understand:
- What your system does
- How it's structured  
- Where data enters and exits
- How components relate to each other
- What's currently happening
- Where problems exist

## The Power of Interactive Exploration

### Click to Drill Down
See a component that interests you? Click it. You're now inside, seeing:
- All the classes, functions, or modules within
- Internal data flow between them
- Local state and configuration
- Performance metrics for this component
- Detailed documentation and descriptions

Click deeper. Now you see individual functions with:
- **Full signatures and parameters**
- **Purpose and behavior descriptions**  
- **Entry points** - what calls this function
- **Exit points** - databases accessed, APIs called, messages sent
- **Data transformations** - how input becomes output
- **Current values** when running

### Follow the Flow
See data enter your system and follow its journey:
- User clicks submit → API endpoint receives POST
- Request validates → Data transforms → Business logic processes
- Database transaction begins → Multiple tables update
- Message publishes to queue → Email service triggered
- Response returns to user → UI updates

Every step is visible, traceable, understandable.

### Descriptions Everywhere
Hover over anything for instant context:
- **Components** show their purpose and responsibilities
- **Connections** describe what data flows through them
- **Functions** explain what they do and why
- **Variables** show current values and constraints
- **Configurations** display settings and their effects
- **Entry points** document expected inputs and authentication
- **Exit points** detail external dependencies and contracts

## See How Everything Connects

### Visual Connection Intelligence
- **Dependency arrows** show what depends on what
- **Data flow lines** animate with actual traffic
- **Event streams** pulse when messages pass through
- **API calls** light up during execution
- **Database queries** show which tables are accessed
- **Message queues** reveal pub/sub relationships
- **WebSocket connections** display real-time subscriptions

### Connection Details
Click any connection to understand:
- **What flows through it** - data types, formats, examples
- **How often** - requests per second, data volume
- **Performance** - latency, throughput, error rates
- **Contract** - expected inputs/outputs, validation rules
- **Problems** - failures, bottlenecks, timeout issues

## Entry and Exit Points - Crystal Clear

### Entry Points Are Obvious
Every way into your system is clearly marked:
- **REST endpoints** with methods, paths, and parameters
- **GraphQL queries** with schemas and resolvers
- **WebSocket listeners** with event types
- **Message queue consumers** with topics and handlers
- **Scheduled jobs** with cron expressions
- **CLI commands** with arguments and options
- **UI interactions** with user flows

### Exit Points Are Transparent  
Every external dependency is visible:
- **Database operations** showing exact queries, tables, and connections
- **External APIs** with endpoints, retry logic, and fallbacks
- **File operations** with paths and permissions
- **Message publishing** with topics and payloads
- **Email sending** with templates and providers
- **Cache operations** with keys and TTLs
- **Background jobs** with queues and priorities

## Real-Time Intelligence

### Watch Your System Breathe
The diagram isn't static - it's alive:
- **Traffic flows** through connections in real-time
- **Components pulse** with activity
- **Queues fill and empty** visually
- **Memory usage** grows and shrinks
- **CPU utilization** shows as heat
- **Response times** color-code from fast (blue) to slow (red)

### Problems Jump Out
When something goes wrong:
- **Failed components turn red** immediately
- **Error cascades** show as spreading red
- **Bottlenecks glow yellow** then orange then red
- **Deadlocks** show as circular red arrows
- **Memory leaks** display as growing dark areas
- **Infinite loops** pulse rapidly

Click any problem to drill straight to its source.

## The Architecture Diagram Evolved

Traditional architecture diagrams are:
- Static snapshots that go stale
- High-level abstractions lacking detail
- Disconnected from actual code
- Missing runtime behavior
- Hard to navigate for specifics

Unravl makes architecture diagrams:
- **Living documents** that update with your code
- **Infinitely detailed** - drill as deep as you need
- **Directly connected** to actual implementation
- **Runtime-aware** showing real behavior
- **Navigable** like exploring a building

## For Every Question, A Visual Answer

**"How does authentication work?"**
See the auth flow highlighted - from login endpoint through middleware to token generation.

**"What happens when an order is placed?"**
Watch the entire order flow animate - validation, inventory check, payment processing, fulfillment trigger.

**"Why is this slow?"**
Heat map shows the bottleneck - click through to see the specific slow query or algorithm.

**"What talks to the user service?"**
Filter to highlight all components connected to user service - see every dependency.

**"Where do we use Redis?"**
All Redis connections light up - see cache operations, pub/sub channels, session storage.

**"What's our API surface?"**
Every endpoint is visible with methods, auth requirements, and usage patterns.

The visualization adapts to make YOUR system understandable.

## The Ultimate Goal

In 30 seconds: Understand the entire system architecture
In 5 minutes: Identify all major components and flows
In 10 minutes: Trace any feature from entry to exit
In 30 minutes: Have deep enough understanding to make architectural decisions

A newly hired director of engineering can look at Unravl and immediately understand:
- The complete system architecture
- How everything connects and why
- Where data flows and how it transforms
- What the entry and exit points are
- Which parts are complex or problematic
- How the system behaves under load
- Where to focus improvement efforts

They can speak intelligently about any aspect because they can SEE it - not in abstract boxes and arrows, but as a living, interactive, infinitely explorable visualization that makes everything obvious. I want to UNRAVEL the mysteries of the codebase. Turn the lights on. Make it visible. Easy to understand. Think Apple iOS. The interface is simple, and easy to use, but it allows for DEEP navigation, discovery, exposure, interactivity. I want anything and everything analyzable. I want to package an entire codebase into a package of information that could be used to inform something like claude code (to an mcp or something like that) so that claude code can work on a system with ALL of the context it needs without needing to read every file (just as one example). I want the UI to be a delight to work through. I like to two UIs (a drop down list and a diagram). That is the vision. I need enough data that I can support that. Enough that when errors occur we can expose them in a way that even a non-technical person could point to exactly where the issue is. Let me explain myself. If we detect it's a nestjs app I want to see those sections (controllers, which are the entrypoints) that maybe connect to services, then to repos, maybe to mikroorm. Then I can click on controllers to see them all. Then I can click on a single controller to see what endpoints it has and what it connects to, the functions it calls, etc. I should be able to traverse that to EVERY CONNECTED function, variable, import EVERYTHING. Let's say it's a react app. We probably have an App.tsx or maybe an index.html, then we have views/pages, auth, contexts, hooks, etc. Maybe we have a repo that has both, so I see frontend and backend with some context inside. I can click on the frontend and drill into it. Maybe it's a django app, and I can see those elements. MAybe it's flask. Maybe it's express with javascript, etc. Maybe someone connects multiple repos and we can deterministically link two codebase analysis by the API calls they make, or the message they publish and listen to. Maybe they both connect to the same database. I should see what the database looks like from the perspective of the code. I should see the data schema. The flow of data. In the future I should see the flow of traffic through these. I want analyzers for big things like languages, frameworks. I want them for smaller things like libraries. I want any number of analyzers to be detected and involved. I want the analysis tagged. I want ALL of the data so I can easily "see" what the app "looks" like. 

To be clear, the metaphore helps illustrate the thinking vision as a metaphore. I don't want to double down on building or architecting that metaphore. For example, I don't want hallways, rooms, decks, buildings, or anything like that in my actual code. I don't want to refer to anything in the system based on the metaphore. Here's what I mean:
- Let's imagine we have a monorepo with two applications, a frontend and a backend, that connects to a couple external services (like google analytics) and a postgresql database. I would imagine that the first thing I would see in the diagram would be two cards (UI / API) that connect to eachother, and a few branches out from those to the external services and database. Let's say I click on the API, which then expands to take over the screen. Imagine it's an API built with typescript using NestJS and mikroorm. I would like to see an arrow/line coming in from the left, to an expanded card (API) that then splits and points to 3 different controller sub cards (one for each nestjs controller). Perhaps right outside of that card, or maybe in front of it we see a validator (for input validation), and maybe some auth decorators/guards. The controllers then point to services, which point to repositories. The repositories come together and point to postgresql (offscreen to the right). Maybe then I click on a service, which expands, and there I see functions, variables, proparties, etc, which have arrows to any other functions they call (perhaps offscreen between the are outside of the functions). Each card could have a leaf that opens to the right that has a heavy amount of detail such as names, descriptions, comments, functions, variables, etc. This is the diagram view with cards that point to other cards. I'd also like to see another type of view where there are dropdowns that expose the information, with the same leaf that opens up. Clicking on anything should show navigate to that element. The spec shouldn't have anything to do with visualization. That algorithm will be exclusive to our platform. The spec should essentially represent a complete and total analysis of a system; maybe nodes and edges, with titled categories, tags, metadata, etc, then having levels of categories to show (i.e. the first level of a nestjs app might be controllers, services, etc. The second might be specific API endpoints or some other level of architecture, third might be specific functions, properties, variables, etc). I want this spec to truly be universal, for any type of app. I want it good enough that we could create an UNRAVL mcp for it, that claude code and other could use to get an entire picture of a system, how it works, what is connected to what, what behaviors are supported etc. Basically synthesizing an ENTIRE codebase into a context document. Also consider connections to external services (google analytics, datadog, postgresql, etc agnostic of what it is). Classify if they are for consumption or production. Also entrypoints and exit points. An entry point might be an API endpoint, or different pages (based on routes). Protected areas (for frontends that have protected routes/pages). Exit points would be production to an external service, such as as calling an another API, using an SDK (api wrapper), saving data to a database, etc. Also include a way to link to other repositories. Agnostic, but powerful. I also want to be able to see the package manager it uses, the libraries it connected, a description, code coverage, etc. Remember this needs to be project, language, and framework agnostic, but needs to support a robust view of a system. It also needs to work with multiple analyzers. For example, for a react app we may have an analyzer with specifics for react systems (components, contexts, hooks, etc) and also something like redux (with reducers, etc). The entyr and exit points need to link to their respective nodes. One significant goal is to support progressive disclosure, meaning the UI (and MCP consumers) could get only the level needed, and could dig when needed. Claude code, for example, could get only the first level or two at first, then dig in to specific sections if needed. The beauty of this is that it would prevent claude code from needing to read all of the code to see how it connects, while still having all the context it needs in a progressively disclosed manner. Same with the UI. The CAS isn't focused on files, it's focused on code elements like categories, classes, functions, etc, how they are interconnected, grouped by the concepts that are unique to the languages, frameworks, libraries, etc. It should include filenames/paths as part of the output, but not as the name of each node. Having multiple analyzers IS intentional, but it shouldn't create a bunch of duplicate data, it should all come together to enhance and hydrate the data.

This is Unravl: Making the invisible visible, the complex simple, and months of learning into minutes of exploration.

## MCP (Model Context Protocol) Integration

Unravl provides three distinct MCP services for AI assistants like Claude Code, Cursor, and other tools:

### 1. `unravl-analysis-mcp` - Static Codebase Synthesis
- Provides complete codebase understanding without reading every file
- Progressive disclosure through hierarchical levels (n levels)
- Synthesizes entire systems into comprehensive context documents
- Combines multiple analyzer outputs (language + framework + library)
- Enables AI to understand architecture, relationships, and implementations
- Example queries: "Show me all controllers", "What calls UserService?", "Trace authentication flow"

### 2. `unravl-telemetry-mcp` - Live Operational Data
- Real-time performance metrics and health indicators
- Active traffic flows and current system state
- Error tracking and bottleneck identification
- Memory usage, CPU utilization, response times
- Live debugging assistance
- Example queries: "What's currently slow?", "Show active errors", "Which endpoints are hot?"

### 3. `unravl-flows-mcp` - Dynamic Flow Tracing
- Step-by-step request tracing through the system
- Data transformation visualization
- Runtime behavior analysis
- Debug specific user journeys
- Performance profiling of actual flows
- Example queries: "Trace this request ID", "Show order flow performance", "What's blocking?"


🎯 Real Pain Points This Solves:

1. Context Window Limitations
  - Current: AI assistants waste tokens reading files to understand structure
  - With Unravl: Get complete understanding in a single context document
2. "Where is X?" Questions
  - Current: Grep through files, hope you find it
  - With Unravl: "Show me all authentication code" → instant results
3. Understanding New Codebases
  - Current: Spend days/weeks exploring
  - With Unravl: 30 seconds to understand architecture
4. Impact Analysis
  - Current: "If I change this, what breaks?"
  - With Unravl: See complete dependency graph instantly

💡 Specific Use Cases:

Claude Code Users:
"I need to add a new feature to the user service"
→ MCP loads only user service context (level 2-3)
→ Claude understands all connections without reading 1000 files
→ Suggests exactly where to add code

Cursor Users:
"Refactor this to use dependency injection"
→ MCP provides complete dependency map
→ Cursor knows every usage point
→ Safe, comprehensive refactoring

Documentation:
New developer: "How does authentication work?"
→ MCP traces auth flow from entry to exit
→ Complete understanding in minutes

📊 Market Validation:

Similar tools already proving demand:
- Sourcegraph - Code intelligence platform ($125M funding)
- CodeSee - Visual code maps
- AppMap - Runtime code analysis
- Tabnine - AI understanding codebases

But none provide the comprehensive synthesis Unravl offers.

🚀 Competitive Advantage:

1. Universal - Works with any language/framework
2. Progressive - Only load what you need
3. Complete - Every relationship captured
4. Extensible - Multiple analyzers contribute

💰 Value Proposition:

For a 100k line codebase:
- Without Unravl: AI reads ~500 files, uses 200k tokens, partial understanding
- With Unravl: AI gets complete context in 10k tokens, total understanding

10-20x more efficient + actually complete understanding

🔮 Future Potential:

- AI Code Reviews: "Does this PR break anything?"
- Automated Refactoring: "Modernize this legacy code"
- Security Audits: "Find all data flow vulnerabilities"
- Migration Assistant: "Convert this to TypeScript"

Verdict: This could fundamentally change how AI tools understand code. The value is enormous.

These MCP services enable AI assistants to have complete system context (static) plus real-time awareness (dynamic), making them exponentially more effective at understanding and debugging codebases.