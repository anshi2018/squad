---
"@bradygaster/squad-cli": patch
"@bradygaster/squad-sdk": patch
---

Hardened the Squad GH-AW (GitHub Agentic Workflows) source contract against nine confirmed GA-review findings:

- **`squad-improvement-gate.mjs`**: closed a test-coverage gap for rejecting a content-only modification of an already-tracked executable (`100755`) Markdown improvement target (the production `ALLOWED_FILE_MODE` guard was already correct; added realistic Git-mode regression/mutation tests).
- **`squad_approval_relay` contract**: made the `squad.md` → `squad-improvement-worker.md`/gate producer/receiver contract for the approval relay payload unambiguous as a JSON string end-to-end, preserving the distinct `squad_approval_relay` input name (gh-aw overwrites `aw_context`). Added compiled assertion/mutation coverage.
- **`squad-review-guard.mjs`**: confirmed and regression-tested that unauthorized/malformed override markers are rejected by authorized-admin-human filtering *before* cardinality/record parsing, so a malformed authorized record still fails closed and an unauthorized marker can never be counted.
- **`squad-planning-ontology.md`**: normalized the result-line template from `Result: ✅ PASS` to the exact `RESULT: PASS` string required by downstream parsers.
- **`squad-install-verifier.mjs`**: confirmed `verifyInstalledBytes()` normalizes only the one documented injected `source:` ownership-binding line before hashing, and fails closed on any other tamper; existing mutation-test table already covers this.
- **Numeric identity canonicalization**: numeric issue/comment IDs arriving via `issue_comment` are canonicalized to safe-integer strings before comparison against `workflow_dispatch` string inputs, with invalid forms rejected; covered by direct and relayed regression/mutation tests.
- **`squad-command-router.md`**: blocked replay of bot-authored standalone `/squad` issue/comment text while preserving trusted `workflow_dispatch` continuation and documented bot command behavior, covering both `created` and `edited` events.
- **`can_approve_pull_request_reviews`**: proved from gh-aw source that this is a single combined toggle gating both `GITHUB_TOKEN` PR creation *and* PR-review approval — it cannot be split via job-level `permissions:`. Per least-privilege policy (no weakened independent-human review gate), flipped to `false` across all public/enlistment/setup copies and added a fallback-to-issue mechanism (with a manual compare-URL link) to `squad-bootstrap.md` for when the push succeeds but the PR cannot be opened.
- **Mutable installation channel**: eliminated resolution of a mutable `commits/dev` ref for GA installs; setup now requires an explicit, pre-validated 40-character `SQUAD_SHA`, synchronized across public/enlistment docs and skill mirrors, while exact-SHA fixture testing remains unaffected.

No stable release is published by this change. Real (non-mocked) `gh aw compile --strict` against the canonical `workflows/*.md` sources continues to produce exactly the two documented warnings (`pull_request_target` advisory on `squad-review.md`, bot-trigger advisory on `squad.md`).
