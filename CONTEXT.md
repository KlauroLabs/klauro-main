# Unravl - Architecture Diagrams Come Alive

## The Vision

Take your typical architecture diagram - boxes, arrows, labels. Now imagine if you could click on any box and zoom into it, seeing all its internals. Click on any arrow and watch data actually flowing through it. See problems light up in red the moment they happen. Follow any path from entry to exit. Get descriptions and documentation right where you need them. 

This is Unravl: architecture diagrams on steroids. Living, breathing, interactive blueprints that show you everything at a glance, then let you drill into any detail you need.

## Understanding at a Glance

When you first open Unravl, you see your entire system laid out spatially. Not as files and folders, but as a living architecture:

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

## Spatial Understanding

Your codebase becomes a navigable space:
- **Frontend** might be the upper floors
- **Backend services** form the middle layers
- **Databases** anchor the foundation
- **External services** connect via bridges
- **Message queues** run like highways between sections

Or adapt the metaphor to your system:
- **Microservices** become a city of buildings
- **Monoliths** become large multi-floor structures
- **Serverless** becomes an event-driven factory
- **Mobile apps** become device floor plans

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

They can speak intelligently about any aspect because they can SEE it - not in abstract boxes and arrows, but as a living, interactive, infinitely explorable visualization that makes everything obvious.

This is Unravl: Making the invisible visible, the complex simple, and months of learning into minutes of exploration.