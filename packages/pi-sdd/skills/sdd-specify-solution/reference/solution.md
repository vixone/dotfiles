# Design focus and validation

Design explains HOW the change works, WHERE code belongs, WHAT interfaces exist, and WHY choices fit the constraints.

## Coverage and consistency

Each component has one distinct responsibility. Assign every public requirement to one owner and resolve overlap. Document every component-to-component and external communication path. Each entity owns distinct domain data; model every field referenced by interfaces. Map every public acceptance criterion to system behavior.

Check consistent names across diagrams, directory maps, endpoints, and data definitions. Specify request, response, authentication, errors, and retry behavior. Ensure dependency direction has no cycles. Do not invent infrastructure for no-change scope.

## Evidence and review

Read existing patterns before choosing alternatives. Discover commands rather than assume them. For each research finding, explain mechanism, project fit, migration, dependencies, and test implications. Confirm every architectural choice with the user through `ask_user_question`; cancellation pauses.

Verify schema examples against migrations. Trace complex query evaluation using concrete rows. Explain no rows, NULL, zero, and failure behavior. Numeric quality requirements need a measurement method.

Before final design approval, require complete sections, no unresolved markers, known context relevance, complete interfaces, error and security coverage, measurable quality, and no requirements scope creep. Compare constitution rules separately. The report lists confirmed decision IDs and unresolved questions, not a fabricated confidence score.
