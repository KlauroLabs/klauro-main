# Entities: the important objects, and what's connected to what

A plain-language guide to a body of data Klauro produces, written so you can decide how and
where to present it. It describes what the information *is* and the shape it comes in — the
presentation is yours to design.

`Audience: design` · `Scope: one codebase at a time, repo-wide (not per-deployable)` ·
`Tests: out of scope` · `Numbers: from a live analysis` ·
`Counts: 0 (no database) to 100+ (a mature domain)`

No Figma screen covers this page. It's derived from the design language plus the two closest
designed screens (Flow List's catalog table, Flow Overview's stacked-section detail) — this
brief is the design contract for what got built.

---

## Start here: what we're describing

Klauro analyzes a codebase and, among many things, finds every **data entity** — every shape
of data the code treats as a first-class object, whether or not it's ever written to a
database. A customer order, a user session token, an API response envelope, a validation-only
request body: all entities, in the same sense, even though only some of them persist.

An entity is not "every class" or "every interface." It's built from **structural evidence** —
an ORM decorator, a request-validation schema, a response-shaping annotation, a value type with
fields and no behavior — never from a name that merely sounds like a noun. The job of this data
is to make the domain's important objects, and how they connect, legible at a glance: what
exists, what it's made of, who's allowed to touch it, and what it relates to.

> **Who looks at this, and why**
> A new engineer asking *"what does this system actually model — what are its nouns?"* · A
> security reviewer asking *"where does sensitive data live, and what can read or write it?"* ·
> Anyone about to change a shared shape asking *"what breaks if I touch this field?"* The
> through-line: **the domain's object model, made of evidence, not guesses.**

One thing to hold onto: this is repo-wide, not scoped to a single deployable the way entry
points are. A monorepo that ships two deployables from one database schema still has one shared
entity list — the object model is a property of the codebase's data layer, not of any one thing
that runs.

## The mental model: two views of the same object, joined by name

Every entity in this dataset is actually **two views**, computed independently and joined
client-side by name — because they answer different questions and one can exist without the
other:

**The domain view** (`data_entities`) — what the entity is *made of* and who *touches* it:
fields with a sensitivity flag per field, and a lifecycle of who creates, reads, updates, and
deletes it (as concrete function references, not just counts). Every entity that clears the
evidence bar has this view, whether or not it persists anywhere.

**The schema view** (`database_schema`) — what the entity looks like *as a table*: primary/
foreign-key flags, uniqueness, nullability, and its **relationships** to other tables, each one
carrying a real ORM relation kind (one-to-one, one-to-many, many-to-one, many-to-many) and the
field that declares it. Only entities an ORM actually persists have this view — a request DTO
or an in-memory value object has fields but no schema-view relationships, which is correct, not
missing.

An entity with a domain view but no schema view is drawn with fields and lifecycle, and zero
relationship lines — a real, common shape, not a loading failure.

## Evidence kinds

Every entity carries one deterministic **kind**, derived from the same structural evidence that
qualified it as an entity at all — never inferred from its name:

- **ORM** (`persisted-entity`) — backed by an ORM decorator/model; has a schema, gets written to
  a database.
- **DTO** (`request-dto`) — an inbound contract: a `@Body` parameter, a validation schema, a
  request shape. Never persisted directly.
- **Serialization** (`api-response`) — a response shape returned across a boundary — usually the
  terminal, outward-facing form of some internal data.
- **POCO** (`value-object`) — a field-only shape with no persistence and no route/API binding:
  an internal domain value passed between functions, nothing more.

These four are a **fixed, complete set** — same discipline as the entry-point family vocabulary
in the canonical brief. Any entity that clears the evidence bar gets exactly one of these; none
is rarer or more important than the others, though ORM entities are typically the majority in a
data-heavy codebase and DTOs/POCOs dominate in a thin, mostly-stateless API layer.

## Fields, and sensitivity

Each field carries a name, a type (as written in the source — including inline object/union
types, not just simple scalars), and a boolean **sensitivity** flag. Sensitivity is evidence-
based (a `password`/`token`/`email`/`ssn`-shaped field, a `@Sensitive`-style annotation — the
same signal the analyzer's broader sensitive-data detection uses elsewhere), not a guess from a
short field name in isolation. A schema-view field additionally carries primary/unique/nullable
flags when the ORM declares them.

## Relationships, and relationship sparsity

A relationship is a directed edge — `field` on the source entity, pointing at a `target` entity,
carrying a cardinality (1–1, 1–N, N–1, N–N). Every edge is **evidence-gated**: it exists because
an ORM decorator declared it, never because a field happened to be named `userId`. This means
the relationship graph is real but **sparse** by construction — DTOs and POCOs never have
relationship edges at all, and even among persisted entities, plenty are genuinely standalone
(a lookup table, a settings singleton). A domain with 40 entities might have only a dozen
relationship edges; that's the schema's actual shape, not an extraction gap, and the diagram
should read that way rather than implying a denser graph than exists.

## The diagram (ERD)

The relationship graph renders as construction lines, not a force-directed graph-library canvas
— consistent with the rest of the product's stroke system. Layout is deterministic: entities
group into columns by the module their source file lives in (e.g. `database/entities` vs.
`auth`) once the entity count passes roughly ten; below that, one column is enough to stay
legible. Clicking an entity in the diagram is the same navigation as clicking its table row —
the diagram is a second view of the same catalog, not a separate dataset.

## Lineage

Lineage answers "who's allowed to touch this" as a concrete list of functions, grouped into
created / read / updated / deleted — not just counts. A heavily-read, rarely-written entity
(most reference/lookup data) looks different at a glance from a heavily-written one (an event
log, an audit table), and that shape is the point: it's a fast way to spot an entity with an
unexpectedly wide blast radius (many writers) or a suspiciously narrow one (a "shared" entity
that's actually only touched by one service).

## Data realities

- **Counts run from zero to 100+.** A repo with no database and no request/response shaping
  layer (a pure library, a CLI with no persistence) has zero entities — a real, common case,
  shown as an honest empty state, not an error. A mature multi-service domain can clear a
  hundred; this dataset does not cap or sample entities the way some other Klauro views do (see
  below), so very large domains are the one case where the list view genuinely needs paging.
- **Two data sources for the same object, by design.** The domain view and schema view are
  joined by entity name, case-insensitively, client-side. A rename that only touches one side
  (e.g. an ORM `@Entity('users')` table name diverging from the class name) can, in principle,
  break the join; this hasn't been observed in practice because both views are read off the same
  class declaration in the same analysis pass, but it's worth knowing the join is name-based, not
  id-based.
- **No dedicated ERD endpoint exists yet — the page reads the full CAS instead.** The MCP tool
  `get_erd` reshapes `database_schema` server-side, but no HTTP route mirrors it; the raw
  `database_schema` this page needs is already present on `GET /api/projects/:id/cas` (which the
  entry-points lane established as this app's mirroring convention for `cas.entry_points`), so no
  new endpoint was needed. See `apps/app/docs/DESIGN-NOTES.md` for the full accounting, including
  why this page also skips the *paginated* `/entities` REST route (it silently drops the `kind`
  field this page's evidence-kind column needs).
- **Semantic role (core/supporting/infrastructure) exists elsewhere in the product and is
  intentionally absent here.** It's a separate, on-the-fly classification that needs a relation
  index this page doesn't otherwise build; the brief above doesn't ask for it, so it wasn't
  half-reproduced. See DESIGN-NOTES.md if a future lane wants it.
- **A no-database codebase is a real, common case, not a degraded one.** A pure frontend, a
  stateless proxy, or a CLI tool built around someone else's API can legitimately have zero
  entities of every kind. The empty state says so directly rather than implying something failed
  to load.
