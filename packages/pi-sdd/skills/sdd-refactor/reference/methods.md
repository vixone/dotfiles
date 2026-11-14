# Refactoring methods

Smells are investigation cues, not automatic edit authority. Long methods may justify extraction; nested conditionals may justify guard clauses; duplication may justify shared helpers; data clumps may justify a parameter object. God classes, feature envy, circular dependencies, shotgun surgery and message chains need dependency/blast-radius analysis. Inline speculative generality or unused abstraction only after proving callers and side effects unaffected.

Prefer descriptive names, obvious control flow, named constants and narrow cohesive functions over clever one-liners. Preserve evaluation order, exception timing, public names, numeric semantics and observable side effects. Moving a method can change callers and ownership; guard clauses can change branch precedence; extraction can change closure behavior. Tests must cover those risks.

## Reports
Baseline: commands, pass/fail/skip counts, coverage evidence and representative outputs.
Analysis: impact, location, specific technique, risk and file allowlist. Sequence independent low-risk changes first.
Recovery: candidate change, failed command/output, disposition and user choices. No blanket checkout/reset of user files.
Completion: before/after by allowed file, output comparison, relevant full suite results, coverage changes with evidence and skipped items. Failed or skipped required tests cannot be labeled behavior preserved.
