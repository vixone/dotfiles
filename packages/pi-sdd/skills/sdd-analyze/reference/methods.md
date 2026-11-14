# Discovery methods

Business: trace complete workflows, guards, entities and state transitions; distinguish implicit rules from documented policy.
Technical: trace dependency chains and boundaries; explain the problem a pattern solves and the cost of changing it.
Security: trace authentication, authorization and trust boundaries without copying secrets.
Performance: measure hot paths, complexity, query counts and cache invalidation; avoid unsupported bottleneck guesses.
Integration: map request/response transformations, rate limits, retries, timeouts and failure propagation.
Data: map cardinality, cascade behavior, indexes, access patterns and migration history.

## Output contract
Group mechanism findings by theme. Each includes What, How, Why/So what, actual file:line evidence and uncertainty. Then report cross-cutting connections, clean recommendations (files, migration, scope, risks) and open questions. Ask for the next cycle or persistence review; do not write during preview.

## Example (illustrative, not repository evidence)
What: payment transitions emit events. How: emission precedes storage and errors propagate independently. Why: consumers could observe an event whose state was never stored. Verify the ordering at actual source lines before recommending an outbox. Propose migration and consumer idempotency tests; no code or docs change follows from discovery alone.
