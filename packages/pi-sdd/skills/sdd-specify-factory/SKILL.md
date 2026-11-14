---
name: sdd-specify-factory
description: Explicit Factory decomposition helper for public behavioral units, separate reviewed holdout scenarios, requirement coverage, and a validated dependency descriptor.
disable-model-invocation: true
---
# Define Factory artifacts

Read the [unit template](templates/unit.md), [scenario template](templates/scenario.md), [E2E stub template](templates/e2e-stubs.md), [manifest template](templates/manifest.md), [decomposition and scenario guide](reference/factory.md), and [examples](examples/factory.md) with pi `read`. Resolve bundled links from this directory.

Read requirements and solution before decomposition. If either is missing, inform the user and ask through `ask_user_question` to approve an omission and its rationale. Do not silently proceed on missing design. Read actual project conventions, external interfaces, and test framework configuration. This helper plans work only.

## Review public units

Write units to `units/key.md`. Use stable position-independent keys, explicit dependencies, and one-session-sized deliverables. Every unit contains public behavioral requirements and constraints. Do not hide required behavior from coders. Do not include holdout case bodies, secret expected values, scenario names, evaluation transcripts, or implementation prescriptions in unit instructions.

Every task brief includes exact affected files, discovered test commands, red/green intent, public acceptance, and a requirement-to-task-key coverage section. Optional public interface contracts may identify shared boundaries. Keep evaluator-only cases in scenarios, not in coder briefs or mission descriptions.

Present units, coverage matrix, and dependency graph for user review before generating holdouts. Split shared prerequisites into explicit units where necessary. Use bounded local `sdd_worker` research only with approved selected context; workers cannot browse or delegate.

## Review scenarios and stubs

Write scenarios to `scenarios/key/name.md`. Each scenario has a stable scenario ID, task key, public requirement coverage IDs, priority P0/P1/P2, action, and unambiguous observable outcome. Ground API, UI, or CLI behavior in actual interfaces without importing implementation internals. Every unit needs P0 coverage. No unknown unit, uncovered public requirement, duplicate scenario ID, or empty scenario suite is acceptable.

Detect the actual test framework before writing E2E stubs alongside scenarios. Map each stub to a scenario ID and priority. Name runnable checks after behavior, not orchestration keys. Pending stubs are not passing evidence. If the framework or runtime interface is unknown, report blocked evaluation setup and request an explicit contract; do not guess a start command, health URL, or port.

Present all scenarios and stubs to the user, separately from public units. Obtain explicit approval before execution. Coders receive only public units, selected project context, and later parent-reviewed observable symptoms. Evaluators receive holdouts and a black-box interface only. Separate snapshots omit accidental holdout/history leakage, but this is cooperative same-user isolation, not an OS sandbox. Stop if hard isolation is required.

## Describe topology and validate

A static manifest may explain dependency groups but owns no status, checkboxes, tier, or task identity. spec.json supplies the selected Factory tier and task definitions. Use [parseSpec](../../src/spec-schema.ts) for unknown dependencies, cycles, duplicate keys, and missing task scenario coverage. Separately check scenario IDs, public requirement coverage, P0 coverage, local paths, and complete briefs.

Review evaluation configuration, threshold, and total attempt budget with the user when runtime schema support exists. Do not add unsupported descriptor fields or invent control operations. Without a validated evaluation contract, specification can be reviewed but Factory execution remains blocked.

Show units, scenarios, descriptor, and content revision for user approval, then materialize once with `sdd_control` into the explicit binding. No second create-mission prompt follows approval. Changes to scenarios change the revision and require new approval. Existing artifacts or old progress marks do not establish completion on resume.
