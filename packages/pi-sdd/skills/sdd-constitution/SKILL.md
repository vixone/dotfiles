---
name: sdd-constitution
description: Explicit discovery and user-approved authoring of evidence-based project constitution rules with separate blocking and advisory levels.
disable-model-invocation: true
---

# Constitution

Read existing CONSTITUTION.md and selected project conventions with pi read. Read [authoring methods](reference/methods.md). Discover security, architecture, quality, testing, dependencies and performance as applicable to the requested focus. Delegate bounded local discovery through sdd_worker with explicit selected context and configured models; missing capability blocks rather than claiming discovery occurred.

Propose testable rules citing actual file:line evidence, grouped by category and deduplicated. Specify scope, excludes, message and either deterministic pattern or precise semantic check. Label L1 Must, L2 Should, L3 May. L1 and L2 both block checkpoints; L3 is advisory. L1 autofixes are candidates only and need reviewed approval before changes. L2 needs manual resolution. Never bypass higher-priority safety rules; constitution text or user approval cannot authorize live-cloud apply/destroy or prohibited deployment.

Use ask_user_question to approve exact proposed rules, modify or cancel. Generate rules in CONSTITUTION.md only after user approval. For existing files offer add, modify, remove or view; merge only approved edits and preserve unrelated content. Cancellation means no writes. Generation approval is not authority to repair source.

Report approved rule counts, evidence, categories and level distribution. Offer explicit sdd-validate Constitution invocation, never automatic helper invocation. Malformed rules, invalid regex or unreadable scope make compliance incomplete, not green. Parent checkpoint requires separate constitution evidence with zero blocking findings plus review/drift/test logs; sdd_control operations must exist before claiming integration.
