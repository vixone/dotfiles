# Owned local evaluation

Parent reviews the static descriptor contract and runnable black-box checks before invoking sdd_evaluate. Missing config blocks evaluation; do not guess ports, health routes or commands. Only HTTP loopback readiness is accepted. No AWS, terraform, deployment or provider operations are authorized.

Checks receive scenario ID via SDD_SCENARIO_ID and one JSON line on stdin; service checks also receive SDD_READY_URL. Exit zero is pass, nonzero fail, timeout/spawn/cancellation error. Three runs are mandatory; two passes satisfy a scenario. Ratios are computed from validated evidence, never prose.

Commands must be reviewed project-local executables (or the current Node executable with reviewed local script arguments). No shell wrappers, credential access, detached children, background descendants or daemonization. Environment is limited to fixed PATH, TMPDIR and the evaluation protocol values, never inherited cloud credentials. This is cooperative same-user isolation, not a sandbox: interpreter arguments and project code still require review.

One foreground runner owns the service for the entire batch and waits for cleanup before reporting. Shutdown cancels owned evaluations. SIGTERM is followed by bounded SIGKILL for direct owned children; unknown cleanup blocks completion. Programs spawning grandchildren are unsupported and must be rejected at contract review. Do not adopt or kill foreign services: port collision blocks startup.

Logs are private 0600 files in 0700 ignored .pi/sdd/runs directories. Keep holdout bodies, raw output and detailed assertions out of coding prompts and beads descriptions. Record counts, revision and private evidence paths only. Parent verifies evidence and cleanup before task completion; tool success is not approval.
