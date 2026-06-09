Update `README.md`, `CLAUDE.md`, and the open PR body to reflect the current implementation state.

Steps:
1. Read the current content of `README.md` and `CLAUDE.md`.
2. Survey the actual code: check `src/`, `frontend/src/`, `test/`, and `migrations/` to identify what is implemented vs. what the docs claim.
3. Run `npm test` to get the current test count and file list.
4. Run `bd list --status=closed` to see recently completed work; run `bd list --status=in_progress` to see active work.
5. Update each document:
   - `README.md`: update the "What's built" table; keep the "Current capability" section accurate.
   - `CLAUDE.md`: keep the Worker architecture, frontend architecture, and test file descriptions in sync with the actual source files. Update the test count in the pre-commit checklist comment.
6. Find the open PR for the current branch using the GitHub MCP tools and update its body to match the current state of the branch.
7. Commit and push all changed docs files.
