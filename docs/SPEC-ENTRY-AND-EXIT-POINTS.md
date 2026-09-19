# Entry and exit points

Pass 1.4 names the code a system runs when something outside it asks, and the calls that leave
the process. Pass 1.6 measures reachability from the first of these, so a surface that is not
found reports working code as unreachable.

## What makes a declaration an entry point

An entry point is never inferred from a name. Four classes of evidence, each examined in turn:

| Evidence | Shape | Example |
|---|---|---|
| Registration | A call registers a handler under a label | `app.get("/users", handler)` |
| Decorator | An annotation on the declaration names the surface | `@GetMapping("/users")` |
| Callback | A function is passed to a registrar | `describe("x", () => {})` |
| Heritage | The declaration's supertype is a framework entry base | `class Foo(graphene.ObjectType)` |

### Heritage

A declaration whose supertype reaches a base in the table — transitively, through the
`extends` and `implements` edges 1.3 emits — is an entry point of that kind. Where a base admits
many members, a member rule names which of them qualify.

| Base type | Kind | Members |
|---|---|---|
| `graphene.ObjectType`, `graphene.Mutation`, `graphene.Subscription` | graphql | `resolve_*`, `mutate`, `mutate_and_get_payload`, `perform_mutation` |
| `ComponentActivity`, `AppCompatActivity`, `Fragment`, `BroadcastReceiver`, `Application`, `Worker` | lifecycle | the type itself |
| `BaseCommand` | cli | `execute`, `handle` |

A base has to be specific enough to mean only what it names. Bare `Activity` and `Service` are
not: a publishing protocol's `Activity` and every service object in a framework that names them
so would match.

Which type names reach a base is settled once for the whole index rather than walked again for
each type, because a large schema declares hundreds of types sharing a base name.

### Registration

A registration is an HTTP route when its label reads as a path, or when a router vouches for it.
A router is a receiver named `Route`, `Router`, `router`, `blueprint`, `bp`, `mux` or `route`;
frameworks that write a path without a leading slash are routes on its word, while reading a key
off a collection with the same verb is not.

A handler names a function, a local, or the type that serves the route. A type is addressable by
name only where the name picks out exactly one and that one is written in the same language as
the registration — a section of a workflow file is a declared type as readily as a controller.
An entry point attached to a type seeds pass 1.6 from that type's members.

A framework may mount a resource rather than name a route: the path, the method and the handler
sit on different calls of one chain. A registration whose own arguments carry no label takes the
path mounted inside them, and a route whose registrar is not itself a verb takes the method from
the call that hands the handler over. A route that declares no method answers any.

## What makes a call an exit point

A call leaves the process when the module it reaches says so. Three shapes carry a module:

| Shape | Example | Where the module comes from |
|---|---|---|
| Imported name | `fetch(url)` | the file's imports |
| Qualified call | `fs::metadata(path)` | the root segment, through imports, else read literally |
| Static type | `File.ReadAllBytes(path)` | the receiver itself |

The module is authoritative and may reach more than one thing: `os` opens files and shells out,
so `os.readfile` is a file exit, `os.execute` is a process exit, and `os.getenv` is neither. An
operation that is none of its module's own is not an exit, rather than falling through to be
claimed by another kind.

Only modules that leave the process belong in the table. A path module manipulates strings.

### Receivers that are their own evidence

A receiver path is stronger evidence than a verb. A query reaches the database because of what
it is addressed through, whatever the verb:

| Manager | Kind | Shape |
|---|---|---|
| `objects` | database | a model manager |
| `session`, `db_session` | database | a session, for its own operations |
| `*Queries` | database | a generated query object, whose method names are per table |

### What reaches nothing

The package a value's type came from does not make every member of it an exit. A request's
`Header`, `Body`, `URL`, `Form`, `Query`, `Params`, `Cookies`, `TLS` and `Trailer` hold data;
reading one leaves nothing, though the value itself came from a network package.

A chain crosses the boundary once. Each link after the first is reached through the previous
link's own text, so an exit whose receiver extends another exit's receiver at the same place was
already counted there. Where no inner exit exists, the outer call is the boundary.

## What stays out

A composable function is not an entry point: it is called by another composable, and only the
component hosting the tree is an entry.

A test function is an entry point and stays one. Reachability is reported from the served
surface separately, because a repository declares test entries in numbers that would otherwise
bury the handful that serve.

## Limits

Reading a header off a request is counted as a network exit where the receiver's root resolves
to a network package: separating them needs the receiver's type rather than its root.

Every vocabulary here is read with a binary search, which answers "absent" for a table that is
merely unsorted — a silence that stops a rule without failing. A test holds them sorted.
