# Coding prompt boundary

Supply public task/unit behavioral requirements, exact writable files, acceptance, test commands, relevant approved project instructions and parent-reviewed short symptoms only. Preserve public requirements; holdouts are not a reason to hide required behavior.

Require red-green-refactor: write and run a failing test first, implement minimally, then refactor and rerun the full public suite. Report changed files, commands, exit codes and blockers. Name tests after public features rather than internal orchestration IDs.

Use a fresh allowlisted snapshot with a local baseline. Exclude holdout files, scenario tests/E2E stubs, full parent transcript, evaluator output, original Git history, credentials and runtime artifacts. Do not read scenarios, update beads, create nested agents or start services. Retry symptoms come only from sanitizeFeedback after parent review, never extracted raw evaluator lines.
