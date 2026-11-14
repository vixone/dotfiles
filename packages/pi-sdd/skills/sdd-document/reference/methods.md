# Knowledge capture and documentation templates

## Categorization
Domain describes what users may do; patterns describe how implementation works; interfaces describe external contracts. Authentication can link domain permissions, internal auth flow and provider integration without duplicating their content. Same topic/service means update; distinct provider or approach means a new reviewed document. Search filenames, content and synonyms first.

Use descriptive searchable names: error-handling.md, stripe-payments.md, user-permissions.md. Avoid vague utilities.md or rules.md. Keep current behavior primary; preserve relevant deprecated contracts with clear migration notes. Cross-reference actual resolved docs and spec paths, never imaginary template destinations.

## Pattern template
Title and purpose; when applicable/not applicable; mechanism and components with source locations; verified examples; edge cases; testing strategy; performance trade-offs; related docs; reviewed version history.

## Interface template
Service and purpose; authentication mechanism (no credential values or secret file contents); endpoints, schemas and error handling; webhook verification; rate limits; mappings; retries/idempotency; local test interface; monitoring; data-handling constraints; costs with evidence; migration and related docs. Do not run live service calls merely to fill the template.

## Domain template
What/why/scope; stakeholders and goals; entities and constraints; rules with rationale/exceptions; states/transitions/side effects; permissions; field and cross-field validation; workflows; calculations with edge cases; compliance evidence; metrics; glossary and related source/docs. Remove irrelevant sections rather than fill with speculation.

## Review and output
Review completeness, clarity and maintainability. Public APIs need summary, parameters, returns, errors and examples. Verify diagrams against actual flows. Summarize proposed/approved changed files and covered elements; metrics require a reproducible measurement. List unknowns, stale areas and missing evidence. Worker prose is input to synthesis, not a raw final report.

Global memory is for specific reusable factual non-trivial lessons, not a mirror of project docs. Each rubric dimension must clear Missions.md threshold; dedup and explicit user persistence approval precede remembering or replacing. Missing dedup cannot be bypassed.
