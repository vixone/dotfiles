# Evaluator prompt boundary

Supply scenario content and approved E2E stubs, the black-box interface and the explicit test runner contract only. No source, unit design, project instructions, coding output or parent transcript. Use a separate allowlisted workspace without source/history.

Write runnable external-interface checks for parent review. Do not start services: parent executes reviewed checks through sdd_evaluate. Each declared scenario receives exactly three outcomes, with at least two passes required for scenario success. Errors and skips are non-passes and remain visible. Report structured outcomes and private evidence paths; do not invent a satisfaction ratio or claim success before runner cleanup.
