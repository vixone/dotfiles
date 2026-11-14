# Evidence-based rule authoring

Discover actual security/authentication/input patterns, architecture layers and module boundaries, naming/import/error/logging conventions, behavioral tests, dependency governance and performance budgets. Focus on requested areas or all when unspecified. Framework requests select relevant hooks/components, API conventions or package boundaries. Cite actual file:line evidence for every proposal, not generic framework assumptions.

Rule format under category and rule headings:
```yaml
level: L2
check: Database calls must remain inside the established repository layer
scope: "src/**/*.ts"
exclude: "src/repositories/**, **/*.test.ts"
message: Move direct database access to the repository layer
```
Use pattern for literal deterministic violations and check for precise semantic constraints. Specify valid/invalid cases for semantic checks. Regex escaping must be valid in YAML; test patterns locally on reviewed examples, not external sites with project source. Narrow scopes and specific exclusions reduce false positives. Malformed or unreadable rules cannot be silently skipped as compliant.

L1 Must blocks; candidate autofix needs reviewed approval. L2 Should also blocks and needs manual judgment. L3 May is advisory. No rule bypasses higher-priority safety constraints. Examples such as banning eval, hardcoded secrets or focused committed tests must still be justified by discovered conventions and not blindly generated from a template.

Use category IDs such as SEC, ARCH, QUAL, TEST, CUST or a stable custom prefix. Report proposed categories, levels, evidence and exact rule text for approve/modify/cancel. Existing constitution offers add/modify/remove/view with precise diffs. Write only approved rules and preserve unrelated content. Summary lists path, counts and level distribution, followed by optional explicit validation.

Creation scenario: no constitution exists; discover patterns, present testable rules, user cancels: no file written. Update scenario: user requests testing rules; inspect existing testing conventions, propose additions and write only after exact approval. Compliance scenario: L2 direct database access violation remains a checkpoint blocker even if ordinary review approves.

Template shape (not a generated policy): Project Constitution heading, version/date/project type established by discovery, category headings, rule headings and YAML rule blocks. No placeholder rules are installed. Maintain only approved project rules; no mutable task progress or execution ledger in this document.
