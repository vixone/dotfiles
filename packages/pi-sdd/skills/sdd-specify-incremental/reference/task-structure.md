# Task structure and validation

Track deliverables such as Payment Entity, Repository, API, or Form. Reading context, an individual assertion, or running lint is part of a task, not a separate deliverable. Embed the full red-green-refactor method in each brief.

Static metadata in spec.json supplies key, phase, kind, dependencies, files, brief path, optional unit, and scenarios. Use section references inside the brief; a descriptor path must resolve to a file. No worker assignments or duration estimates belong here.

Before approval, verify all phases and briefs are linked, no orphan phase exists, every public requirement maps to task keys, every solution component has implementation coverage, and all commands and file paths match the project. Reject empty briefs, unfinished markers, missing acceptance, unknown dependencies, cycles, and backward phase dependencies. Final integration includes required E2E rather than treating absent setup as green.

Report static coverage gaps and missing references with paths. Do not auto-fix a plan without approval. Proposed deviations require a user decision, updated approved design, and a fresh content revision. Beads owns completion and phase approval, not the plan.
