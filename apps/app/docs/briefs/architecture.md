# Architecture: how the system is built

A plain-language guide to a body of data Klauro produces, written so you can decide how and
where to present it. It describes what the information *is* and the shape it comes in — the
presentation is yours to design.

`Audience: design` · `Scope: one codebase at a time, repo-wide` · `Tests: out of scope` ·
`Numbers: from a live analysis` · `Patterns detected: 0 (undetermined) to 8+ (a layered system)`

No Figma screen covers the full `/architecture` page — the Repo overview screen (node
1647:37709, section 04) shows a summary card of it. This brief is the design contract for the
full page, derived from that section plus the design language.

---

## Start here: what we're describing

"Architecture" here means three separate, independently computed facts about how the codebase
is *built*, not how it behaves at runtime:

1. **System type** — a single label (e.g. "Modular monolith," "Microservices," "Layered
   backend") describing the codebase's overall shape, evidence-derived from module boundaries
   and dependency direction, never guessed from a folder name.
2. **Architectural patterns** — a list of named patterns actually detected in the code
   (Repository, MVC, Dependency Injection, Event-Driven, ...), each with a confidence score and
   a category. A repo can show several at once — patterns are not mutually exclusive.
3. **Architectural inventory** — counts of structural elements the pattern detectors found
   evidence for (layers, boundaries, interfaces), keyed by kind.

> **Who looks at this, and why**
> A new engineer asking *"how is this thing actually organized?"* · An architect asking *"does
> the code match our intended pattern, and how confident is that read?"* · Anyone weighing a
> refactor asking *"what structural conventions am I about to break?"*

## Data realities

- **No node-link diagram exists yet.** Figma shows a "System Connection Map" / "Architecture
  Diagram" panel; the live API has no component/connection topology to draw it from today (see
  `apps/app/docs/DESIGN-NOTES.md`, "page-codebase lane"). Until a backend lane exposes one, this
  page shows an honest placeholder in the diagram's place rather than a fabricated graph.
- **Confidence is per-pattern, not per-system.** A repo can have a high-confidence Repository
  pattern and a low-confidence Event-Driven pattern side by side — don't average them into one
  score.
- **Pattern balance**, where present, is a set of named ratios (e.g. sync-vs-async communication
  share) — not every analysis computes it; when absent, omit the section rather than showing
  empty bars.
- A repo with zero detected patterns and an undetermined system type is a real, common shape for
  a very small or very early-stage codebase — not a failed analysis.
