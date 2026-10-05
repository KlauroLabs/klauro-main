# Analysis Markdown export

`export_analysis` with `format: markdown` renders a stored analysis as one Markdown document meant to be committed, reviewed and diffed. Two exports of the same analysis are byte-identical; two analyses of nearby revisions differ only where the analysis differs.

## Determinism

- No identifier, timestamp or score appears in the document.
- Every table's body rows are sorted as text. Lists inside a cell are sorted.
- A cell holds one line: line breaks become spaces and `|` is escaped as `\|`.
- A section with nothing to list holds the single line `_None recorded._`. This is the normal state of Capabilities for an analysis that ran without AI interpretation, and of every section for a repository the analysis found nothing in.

## Structure

The document is a title and six sections, always in this order.

| Section | Columns | Source |
| --- | --- | --- |
| `# <system name>` | none | the analysed system's name |
| `## Sub-projects` | name, root, nodes, entry points, capabilities, flows | the declared sub-projects; a repository with none is one row whose root is `.` |
| `## Capabilities` | name, category, operations, description | the capabilities of the analysis |
| `## Flows` | name, standing, steps, entities | the flows of the analysis |
| `## Entities` | name, fields, relations | the data entities, with field names and the entities they relate to |
| `## Seams` | source, target, modality, contract | the communication seams between sub-projects, and from a sub-project to a service outside the repository |
| `## Link coverage` | sub-project, detected, linked, unlinked | per sub-project, how many detected cross-boundary links were matched to the other side |

`root` is relative to the analysed directory. `modality` is `sync`, `async` or `passive`. `contract` is the route, command or service the seam goes through.

## Related exports

`format: mermaid` draws the Sub-projects and Seams sections as a flowchart, and `format: c4` writes them as C4-style model-as-code text. Both read the same model, so a seam appears in all three exports or in none.
