---
name: sdd-writing-skills
description: Internal pi guidance for creating, auditing or converting explicit skills and evaluating their instructions before release.
disable-model-invocation: true
---
# SDD writing skills

## Workflow
1. Choose create, audit or convert. Search installed/package skills for duplicate capabilities before creating a new one. Read existing skill and all supporting files completely before audit/conversion. Approve exact file scope before edits.
2. Read [authoring methods](reference/methods.md). Use current Agent Skills spec and pi frontmatter: name matching directory, nonempty description at most 1024 characters, lowercase hyphenated name at most 64 characters, and disable-model-invocation true for SDD. No unsupported invocation fields, argument substitution or shell preprocessing. Pi appends command arguments as the user request.
3. Write direct imperative steps, constraints and output contracts. Use Persona/Interface/Constraints/Workflow only when helpful, not as ceremonial boilerplate. Keep SKILL.md under 25KB; load conditional supporting references explicitly through relative links rooted at the skill directory.
4. Name only available tools: read, bounded bash, sdd_control, sdd_worker and installed ask_user_question. Check capabilities; missing tools block dependent operations. Workers receive explicit context, not inherited skills, and have no web/MCP or nested workers. Avoid external broken links or platform-specific orchestration instructions.
5. Write failing content/test lint before adapting. Verify frontmatter with the package parser, size, forbidden tokens and all local links, then run npm run check. Preserve approval, scope, evidence and cancellation gates in examples as well as core instructions.
6. Evaluate discipline skills with pressure scenarios combining deadline, sunk cost and authority cues. Capture baseline failures, rerun with skill, compare observed actions and close loopholes. Offline contract fixtures are not proof of model compliance. Provider-backed evaluations require separate authorization; never claim they ran merely because static lint passed.
7. Report exact changed paths, lint/test evidence, unresolved evaluation gaps and readiness. An unverified pressure test prevents claiming behavioral verification.
