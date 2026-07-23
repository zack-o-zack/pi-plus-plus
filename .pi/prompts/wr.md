---
description: Finish the current task with validation and an optional commit
argument-hint: "[instructions]"
---
Wrap up the current task.

Additional instructions: $ARGUMENTS

1. Determine the requested outcome from the conversation.
2. Run the smallest relevant validation for the changes made.
3. Summarize the changed files and validation result.
4. Commit only if the user explicitly requested a commit.

Never stage unrelated files. Use explicit paths with `git add`; never use `git add .` or `git add -A`. Do not push or open a PR unless explicitly asked.
