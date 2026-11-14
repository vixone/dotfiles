# Example: public validation unit and private scenario

## Public unit

Goal: validate submitted SQL without executing it.

R1: accept supported SELECT syntax and report parsed table and column references.
R2: reject dangerous statement types with a clear error.
R3: reject empty input with correction guidance.

Constraints: use the approved public response contract and avoid execution of submitted SQL. The generated task brief must identify actual files, red/green commands, acceptance, and coverage mapping. No secret input or evaluator transcript belongs here.

## Private scenario

ID: reject-destructive-statement
Task key: validation
Requirement coverage: R2
Priority: P0

Action: submit a SELECT followed by a destructive statement to the approved validation API.
Expected: a documented rejection response rather than execution or an internal server error.

This separate evaluator context is not included in the public unit or mission child description.

## Static topology

Data contracts precede validation. Sanitization and rate limiting can follow validation independently only if actual file scopes are disjoint. The descriptor owns these task dependencies; this example does not record task progress.
