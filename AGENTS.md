# Development Rules

## Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- Use direct technical prose; avoid filler.
- Answer questions before editing files or running implementation commands.

## Code Quality

- Follow the [Pi extension documentation](https://pi.dev/docs/latest/extensions) for extension APIs and conventions.
- Read a file in full before making broad changes to it.
- Do not use `any` unless it is necessary.
- Check installed dependency types rather than guessing external APIs.
- Use top-level imports only.
- Ask before removing intentional functionality.
- Do not add backward compatibility unless requested.
- Do not use `unknown` type and `isRecord` utility function, both are 'code smell'.
- Avoid unnecessary abstractions and utility functions; inline code unless asked otherwise.

## Commands

- After code changes, run the smallest relevant validation command.
- Do not run a full build or test suite unless requested.
- Run any test you add or change.
- Never commit unless requested.

## Dependencies

- Treat dependency and lockfile changes as reviewed code.
- Pin direct external dependencies to exact versions.
- Install dependencies with `npm install --ignore-scripts` unless lifecycle scripts are explicitly required.

## Git

Multiple Pi sessions may modify this working tree concurrently.

- Commit only files changed in the current session.
- Stage explicit paths; never use `git add .` or `git add -A`.
- Inspect `git status` before committing.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.
- Never force-push.

## Pull Requests

- Do not check out or switch to a PR branch unless explicitly asked.
- Review with `gh pr view`, `gh pr diff`, `gh api`, and local Git inspection.
- Read relevant code in full before reporting findings.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

The repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.

## User Override

If user instructions conflict with this document, ask for explicit confirmation before overriding it.
