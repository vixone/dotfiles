# Direct example

Spec 005 rate-limit fix; mission m; task m.1; approved spec revision r.
Contract: reorder remaining-counter reset calculation, add boundary test.
Changed: src/middleware/rate-limit.ts and its approved test file.
Worker outcome: succeeded candidate; not closed.
Parent: reviewed exact diff, integrated approved files, ran npm test (exit 0; 14 pass, 0 fail, 0 skip; private log path recorded), drift none, constitution no blocking findings.
After parent checkpoint and current-revision receipt: m.1 closed. Local commit readiness offered; no push performed.
