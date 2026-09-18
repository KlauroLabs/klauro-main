# Pass 1.4 — entry and exit points

What makes a declaration an entry point, what makes a call an exit point, and how each is
proved. Pass 1.6 consumes this directly: reachability is measured from entry points, so a
missing entry point silently reports working code as unreachable.

## Evidence classes

An entry point is never inferred from a name alone. Four evidence classes, in the order a
declaration is examined:

| Evidence | Shape | Example |
|---|---|---|
| Registration | A call registers a handler under a label | `app.get("/users", handler)` |
| Decorator | An annotation on the declaration names the surface | `@GetMapping("/users")` |
| Callback | A function is passed to a registrar | `describe("x", () => {})` |
| **Heritage** | The declaration's supertype is a framework entry base | `class Foo(graphene.ObjectType)` |

The first three exist. **Heritage does not, and that is the gap.** T3 already derives roles
from annotations, inheritance and registration; 1.4 uses only two of the three.

## Measured gaps

Counted against the corpus, not asserted.

| Repo | Surface | Found | Actual | Cause |
|---|---|---:|---:|---|
| saleor | graphene resolvers | 0 | 1,056 | no heritage rule |
| saleor | Django ORM writes | 0 | 10,208 | no receiver-shape rule |
| tivi | Android components | 1 | 4 | no heritage rule |

Saleor's HTTP surface is 7 of ~11 `re_path` entries, which is correct — it funnels through a
single GraphQL endpoint. The served surface is the resolver set, and it is entirely missing.

## Rule 1 — heritage entry points

A declaration whose supertype (transitively, through the `extends`/`implements` edges 1.3
already emits) matches a base type in the table is an entry point of that kind. Where a base
type admits many members, a member rule names which ones qualify.

| Base type | Kind | Members |
|---|---|---|
| `graphene.ObjectType`, `graphene.Mutation`, `graphene.Subscription` | graphql | `resolve_*`, `mutate`, `perform_mutation` |
| `ComponentActivity`, `AppCompatActivity`, `Activity`, `Fragment`, `Service`, `BroadcastReceiver`, `Application`, `Worker` | lifecycle | the type itself |
| `Command`, `BaseCommand` | cli | `handle`, `execute` |

The base type is matched on its last segment, so an import alias does not defeat it. A
declaration matching no base type is not an entry point — absence of evidence is not a guess.

## Rule 2 — receiver-shape exit points

Today an exit is classified from the operation name plus, for file and network, the origin.
Database operations are classified on the operation name alone, which is why generic ORM verbs
(`get`, `filter`, `create`, `all`) cannot be added: they would fire everywhere.

A receiver path is stronger evidence than a verb. `Model.objects.filter(...)` is a Django
query because of `.objects.`, whatever the verb. The rule: a receiver path whose last segment
is a manager makes the call a database exit regardless of operation.

| Manager segment | Kind | Stack |
|---|---|---|
| `objects` | database | Django |
| `session`, `db_session` | database | SQLAlchemy |
| `*Queries` | database | SQLDelight, whose generated method names are per-table |

## Rule 3 — the module names what it reaches

`is_file_origin` and `is_network_origin` tested substrings — `origin.contains("http")` — which
covers the JavaScript ecosystem and nothing else. A declarative table of module specifiers
replaces them: `std::fs` and `System.IO` reach the filesystem, `reqwest` and `okhttp3` reach the
network, `psycopg2` reaches a database. `std::path` reaches nothing and is absent by design.

The module is authoritative. An operation that is not one of that module's operations is not an
exit, rather than falling through to be claimed by another kind — `os.execute` shells out, and
must not become a database query because "execute" reads as a database verb.

Three call shapes carry a module:

| Shape | Example | Where the module comes from |
|---|---|---|
| Imported name | `fetch(url)` | the file's imports |
| Qualified bare call | `fs::metadata(path)` | the root segment, through imports, else read literally |
| Static I/O type | `File.ReadAllBytes(path)` | the receiver itself |

## Measured

Exit points per repo, before and after:

| Repo | Stack | Before | After |
|---|---|---:|---:|
| saleor | Django | 0 | 9,573 |
| jellyfin | .NET | 1 | 541 |
| neovim | Lua | 1 | 455 |
| tivi | Kotlin, SQLDelight | 2 | 293 |
| meilisearch | Rust | 1 | 177 |
| monica | Laravel, Vue | 4 | 101 |
| ripgrep | Rust | 0 | 44 |
| traefik | Go | 824 | 790 |

traefik falls because verb-only classification was claiming calls that reach nothing.

## Three zeroes, two of them correct

Three repos reported no served entry points at all. Only one was a defect.

- **bumblebee** has no Phoenix router, no Plug, no web file of any kind. It is a library, and
  zero served entry points is the right answer.
- **scalatra** is the framework that *defines* the `get("/path")` DSL. Its only uses of it are
  in tests and in doc comments, so zero is right again.
- **servant** was the real one: its 50 `main` bindings were invisible because Haskell writes a
  zero-argument binding as `bind`, not `function`, and only `function` was extracted.

## Known imprecision

`req.Header.Get` is counted as a network exit in Go: the receiver root resolves to `net/http`
and `get` is a network operation, but reading a header leaves nothing. Separating it needs the
receiver's type, not its root. Shelling out (`os.execute`, `subprocess.run`) is currently no
exit at all — it wants a `process` kind rather than a wrong one.

## What stays out

- Compose `@Composable` functions are not entry points. A composable is called by another
  composable; only the Activity that hosts the tree is an entry.
- A test function is an entry point and stays one, but 1.6 must report reachability from
  non-test entry points separately — saleor's 12,817 test entries drown 7 real ones.

## Gate

The sweep gates coverage, speed and determinism, which is why this rotted undetected. Add,
per repo with a known served surface: a floor on non-test entry points and on reachable
units. Red means someone acts.
