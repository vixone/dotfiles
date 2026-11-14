# Specification storage reference

The TypeScript [store](../../../src/spec-store.ts) creates `.start/specs/NNN-slug/` and resolves current descriptors or legacy `docs/specs` artifacts. IDs are unused three-digit numbers. Slugs are lowercase words joined by hyphens. Creation does not choose a tier or create decomposition directories.

The [control tool](../../../src/control-tool.ts) supports `create`, `read`, `status`, `bind`, and `materialize`. Its operation objects require explicit projectRoot and, where applicable, target and missionId. All directory allocation uses the TypeScript store. There is no packaged script fallback.

The [schema](../../../src/spec-schema.ts) defines schemaVersion, specId, slug, tier, documents, omissions, tasks, and binding. Task fields are key, title, kind, phase, dependsOn, files, brief, unit, and scenarios. Paths are relative to the spec directory except task files, which are project-relative source scope. A brief points to an existing file, not a fragment-only path. Put section references inside the brief.

The content revision hashes the static descriptor, referenced documents, briefs, units, scenarios, and applicable project instructions. Mission bindings do not change the static revision. Scenario edits invalidate prior revision approval.

README is navigation only. Mission decision children store approved choices and rationale. Beads task metadata stores approvals and verification. Runtime logs are evidence, not authoritative task status.

Legacy resolution is read-only and signals import/approval required. Unsupported legacy locations need explicit user-selected source input. Import must create a new descriptor and reconcile verified state rather than transfer Markdown progress marks. Do not overwrite legacy documents or silently infer a selected tier from old file presence.
