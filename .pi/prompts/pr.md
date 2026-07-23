---
description: Review GitHub pull requests from URLs
argument-hint: "<PR-URL>"
---
You are given one or more GitHub PR URLs: $@

For each PR:

1. Read its description, comments, commits, changed files, and linked issues in full.
2. Do not check out or switch to the PR branch. Use `gh pr view`, `gh pr diff`, `gh api`, and local Git inspection.
3. Read all relevant implementation files in full, including adjacent code required to validate behavior.
4. Check for behavioral regressions, incorrect error handling, security concerns, and missing tests.

Output this structure:

PR: <url>
What it does:
- ...
Good:
- ...
Bad:
- ...
Ugly:
- ...
Tests:
- ...

If no issues are found, say so under Bad and Ugly.
