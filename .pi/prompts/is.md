---
description: Analyze a GitHub issue without implementation
argument-hint: "<issue>"
---
Analyze GitHub issue(s): $ARGUMENTS

For each issue:

1. Read the issue, comments, linked issues, and linked PRs in full.
2. Independently verify reported behavior against the code. Do not trust proposed root causes or implementations without checking them.
3. For a bug, trace the relevant execution path, identify the root cause, and propose the smallest correct fix.
4. For a feature, identify affected files and propose the smallest implementation approach.
5. Do not implement unless explicitly asked.

Report the evidence, proposed changes, risks, and tests needed.
