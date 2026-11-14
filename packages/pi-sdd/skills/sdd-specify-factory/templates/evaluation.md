# Reviewed evaluation contract

Include evaluation in spec.json and in its content revision. Choose command or service explicitly; never infer commands or ports. User approval covers this contract and all holdouts.

Command example:
```json
{"kind":"command","cwd":".","command":"node","args":["checks.mjs"],"timeoutMs":30000,"scenarioIds":["core-1"]}
```

Service example:
```json
{"kind":"service","cwd":".","start":{"command":"node","args":["service.mjs"]},"readyUrl":"http://127.0.0.1:43123/ready","readyTimeoutMs":10000,"check":{"command":"node","args":["checks.mjs"]},"timeoutMs":30000,"scenarioIds":["core-1"]}
```

Factory extension: `factory: {threshold: 0.9, maxAttempts: 5}`. Threshold is >0 and <=1; maxAttempts is integer 1..10, default 5 TOTAL including initial attempt. No mutable counters in the descriptor. Use project-local reviewed commands and credential-free environment. Exact scenario IDs must match reports; each has three outcomes. Evaluator inputs include black-box interface and runner contract, not project instructions/source. Coding inputs include public requirements only. Parent reviews group integration before evaluation and reruns affected checks after shared candidate changes.
