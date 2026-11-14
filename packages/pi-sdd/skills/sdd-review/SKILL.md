---
name: sdd-review
description: Explicit evidence-based review of local changes with conditional perspectives, breaking-first reporting and actionable findings.
disable-model-invocation: true
---

# Code review

Resolve staged, branch or file target and capture full relevant file context plus diff, interfaces, callers and tests using pi read and guarded local commands. Do not review a diff without surrounding context. Remote PR access or comments require explicit authorization and approved gh host routing; no automatic push, merge or PR comments.

Read [review methods](reference/methods.md). Delegate bounded independent perspectives through sdd_worker using configured review models, selected context and explicit role instructions. Always assess security, simplification, performance, quality and testing. Conditional perspectives: concurrency for async/shared state; dependency supply chain for manifest changes; compatibility for APIs/schemas/configuration; accessibility for UI; constitution when present. No worker capability inheritance is assumed.

Findings use ReviewFinding: severity critical/high/medium/low, confidence high/medium/low, path, line, title, issue, fix and breaking null or consumers/migration. Each finding must identify an actual issue and actionable fix. Breaking is orthogonal to severity: even a clean API rename breaks consumers.

Parent deduplicates by same path within five lines, keeps highest severity/confidence and merges complementary issue/fix and migration details. Sort by severity then confidence. Report breaking changes FIRST after verdict and before severity tables; omit the section if none. Breaking findings also remain in severity counts. Include critical before/after fixes and non-obvious high fix examples, strengths and evidence gaps. Never forward raw reviewer dumps as the final report.

Use synthesizeReview: any breaking or critical, or more than three high, requests changes; one to three high or any medium approves with comments; otherwise approves. L1/L2 constitution violations separately block checkpoints regardless of this verdict. Accepting a migration proposal does not silently clear a breaking finding.

Use ask_user_question for approved scoped fixes, explanation or follow-up proposals. Review authority does not authorize repair or remote operations. Parent checkpoint requires integrated revision, actual test logs, approved review evidence and zero blocking constitution findings. Missing evidence blocks; do not claim that APPROVE alone closes a task. Use existing sdd_control checkpoint operations only if available.
