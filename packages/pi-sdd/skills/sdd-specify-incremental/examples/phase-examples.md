# Example: notification phase

## Phase 1 context

Deliver an idempotent notification endpoint. Public requirement R1 maps to task `publish`. Read the approved solution endpoint and repository contracts before coding.

## Task publish

Files: `src/notifications.ts`, `test/notifications.test.ts`.

Prime: read the public notification requirements and solution sections on request validation and idempotency.

Test: run `node --test test/notifications.test.ts`. Before implementation, valid publication and repeated-key behavior fail.

Implement: valid requests create one notification; retrying the same key returns the existing ID; invalid requests produce correction guidance.

Validate: run `node --test test/notifications.test.ts` and the project's configured full suite. The focused tests must turn green without weakening assertions.

Acceptance: publication and repeated-key behavior satisfy R1; invalid input satisfies R2. Coverage maps R1 and R2 to `publish`.

This is illustrative. Replace paths, references, commands, and scope with actual project values before using the brief.
