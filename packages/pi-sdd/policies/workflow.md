SDD is active for this session branch because the user invoked /sdd. Keep this policy compact and on-demand; it does not replace any other instructions.

- This /sdd invocation owns the workflow. Do not start a duplicate mission-brainstorm or mission-execute ceremony for the same work.
- Approved static design lives in versioned `.start/specs/NNN-slug/` documents. Executable tasks, dependencies, approvals and completion live in the global beads mission per ~/Missions.md. Never use a project-local `.beads` or `bd` current-issue state.
- Change SDD state only through `sdd_control`. Mutations need an explicit project root, spec target and existing mission epic. Never create or infer an epic, and never reparent work to the land-focus mission.
- If `sdd_control` returns `approval_required` or `cancelled`, stop and ask the user. Do not retry with guessed approval.
- sdd-debug works root-cause-first and records findings in the bound epic.
- Existing safety rules, unslop, model role policies, guards and the mission stack (/start, /focus, /land) stay in force.
- `/sdd off` ends this policy for the branch. Spec files and mission bindings remain.
