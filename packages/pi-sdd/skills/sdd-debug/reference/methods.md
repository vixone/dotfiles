# Investigation methods

## Hypothesis hygiene
Every evidence claim must come from a file actually read or command actually run. A fitting explanation is not a root cause. Status transitions are pending to supported, ruled out or demonstrated. Deferred hypotheses retain a reason; do not erase them. Describe confidence using observations and falsifiers, not percentages.

Evaluate user pushback on substance: acknowledge missed evidence precisely, otherwise explain the supporting evidence. User-proposed hypotheses enter as hypotheses, not facts. Lead requests for help with observations so helpers do not inherit a favored explanation.

At ten turns or thirty minutes, restate all hypotheses, cited observations and the next falsifying experiment in bounded mission comments. Private runtime logs can carry verbose evidence, not a second authoritative task ledger.

## Investigation ladder
1. Read the entire failing path, from entry through every layer to failure.
2. Propose boundary probes with correlation IDs; source edits need approval. Compare working and failing traces. Logging may perturb timing, so disappearance is not proof of resolution.
3. Capture minimal redacted input and intermediate state sufficient for offline reconstruction.
4. Anchor the symptom with a failing test.
5. Bisect code, history or inputs in owned disposable contexts; shrink to a minimal failure without altering the user's checkout.
6. Use debugger/REPL inspection when available and bounded.

Select error trace, code path, dependencies, state, environment or recent changes lenses. Contradictory evidence, non-reproduction, multiple live hypotheses or failed prior fixes warrant independent perspectives, not mandatory unsupported coordination.

## Example
An invoice total differs by cents. Reconstruct inputs in a local fixture; read discount, tax and rounding paths completely. H1 predicts float drift; H2 predicts round-half-even. Probe outputs falsify both, explicitly close them. H3 predicts discount applied after rounding. Test the ordering in a reviewed disposable experiment. Only a toggle reproducing and removing the error earns demonstrated status. Ask separately before applying production fix and regression test; report exact commands and results. Unknown reproduction remains unresolved, never transient by assertion.
