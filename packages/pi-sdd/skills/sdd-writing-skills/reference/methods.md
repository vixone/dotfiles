# Pi authoring methods

## Progressive disclosure
Keep core instructions short; put conditional protocols in reference/, document shapes in templates/ and verified scenarios in examples/. Explicitly tell the reader when to read a supporting file. Relative paths resolve from the skill directory, not the working repository.

Names and descriptions guide discovery, not execution. Descriptions state what/when; the body carries imperative steps, scope, approvals and outputs. Linear workflows use numbered headings; branched workflows need a clear starting route. Data contracts can use TypeScript-like fields, but avoid decorative schemas and duplicated constraints.

## Common failures
Declarative advice does not specify action: replace 'review should check input' with 'trace input validation and cite the guard'. Missing tool availability checks cause invented capabilities. Large skills hide safety gates: externalize catalogs, not approval rules. Audits without complete reading miss contradictions. Conversion must preserve behavior, not just formatting. Examples must obey the same approval rules as the skill.

## Verification
Parse frontmatter; check name/description/explicit invocation, byte size, resolvable links, unsupported syntax and test evidence. Run offline fixtures before release. Static tests catch contract regressions, not whether a model follows a workflow.

For pressure evaluation, record baseline actions without the skill, then repeat the same scenario with it and retain observed tool evidence. Combine at least three pressures (time, sunk cost, authority, exhaustion, economic or social). Test cancellation, missing capability and attempts to reinterpret diagnosis/design approval as code authority. Capture rationalizations, clarify the specific loophole, rerun. Never claim a skill is bulletproof from one compliant response.

Use bright-line constraints for genuine safety boundaries, explicit commitments and falsifiable evidence. Avoid manipulative claims of universal success, sycophancy, fabricated research certainty and destructive 'delete everything' advice. Evaluation must serve the user's interests and preserve owned-file boundaries.

## Audit output
Path, mode, duplicate search, frontmatter/link/size results, concrete issue and root cause, proposed fix, executed checks, pressure-eval status and unresolved gaps. If a required evaluation was not run, readiness remains qualified.
