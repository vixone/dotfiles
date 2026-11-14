# Factory topology

List the public unit navigation links and explanatory dependency groups after files exist. Groups derive from the validated descriptor DAG, never from mutable checkboxes.

spec.json owns tier, task keys, files, dependencies, and artifact paths. Beads owns approval, attempts, verification, and completion. The manifest owns none of those fields.

Evaluation requires a separately reviewed runtime contract; see [evaluation configuration](evaluation.md). Display validated settings only when supported by the descriptor schema; do not add unsupported fields to spec.json. Factory configuration requires the shared descriptor extension before persistence: threshold >0 and <=1, maxAttempts integer 1..10, default five TOTAL including initial run. Until that extension is installed, block execution rather than omit the approved budget.
