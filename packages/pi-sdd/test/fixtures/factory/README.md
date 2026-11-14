# Factory offline cases

Adapted from pinned upstream happy-path, retry, max-iterations, parallel, resume and E2E-stubs semantics. factory.test.ts exercises real pure decision APIs; feedback.test.ts exercises the reviewed boundary with unique private sentinels. These are not full worker/integration/runner/beads acceptance fixtures. That integration remains a review gap, not a default-pass mock.

Upstream deviations: finite total attempt budget, no counter reset, no mutable manifest status, failed dependencies remain blocked, candidate changes invalidate evaluation, and passing units may need reevaluation but not recoding.
