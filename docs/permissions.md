# Permissions

Control which actions the Pi agent can take, and when it has to ask first.

- This extension reads a `ppp.permission` block from your Pi settings and decides for every supported tool call whether to **allow**, **ask**, or **deny** it.
- Rules match file paths and Bash commands by glob or regular expression, and the last matching rule wins.

## Actions

Every rule resolves to one of three actions:

- `"allow"` — run without approval.
- `"ask"` — prompt for approval
- `"deny"` — block the action

### Important
> The `"ask"` doesn't work without a TUI or interface, so in headless (RPC, JSON, print, etc.) executions these rules are just ignored.

## Configuration

Permissions live under the `ppp.permission` key in your Pi settings. 
Use the global settings file (`~/.pi/agent/settings.json`) for rules that apply everywhere, and the project file (`.pi/settings.json`) for project-specific rules.

.pi/settings.json

```json
{
  "ppp": {
    "permission": {
      "read": { "*.env": "deny" },
      "write": { "*": "deny", "/docs/*.md": "allow" },
      "bash": { "rm *": "ask" }
    }
  }
}
```

Each key (`read`, `write`, `bash`) maps pattern strings to actions. Rules are evaluated in declaration order and the **last matching rule wins**.

## Rule syntax

- **Glob**: Examples: `**`, `src/**`, `*.env`, `packages/*/README.md`.
- **Regular expression**: Wrap the pattern in `/.../`. Example: `/^src\/.*\.ts$/`.

.pi/settings.json

```json
{
  "ppp": {
    "permission": {
      "write": {
        "**": "ask",
        "src/**": "allow",
        "*.env": "deny",
        "/^secrets\\/.*$/": "deny"
      }
    }
  }
}
```

## Bash matching

- The command is split into **segments** by `;`, `|`, `||`, `&&`, and newlines.
  Each segment is evaluated independently against the `bash` rules.
- A pattern matches the whole segment, command and arguments included:
  `"git push *"` matches `git push origin main`.
- `deny` on any segment blocks the entire call. `ask` is tracked across
  segments; if any segment asks and none is denied, the call asks. Otherwise
  the call is allowed.

~/.pi/agent/settings.json

```json
{
  "ppp": {
    "permission": {
      "bash": {
        "**": "ask",
        "git status *": "allow",
        "git diff *": "allow",
        "npm *": "allow",
        "rm -rf *": "deny"
      }
    }
  }
}
```

## Global vs project settings

Rules are merged per key: for the same pattern, the **project value wins**;
patterns that appear in only one source are kept. Project-only patterns are
evaluated after global patterns, so they take precedence under last-match-wins.

Untrusted project settings are ignored entirely, a project cannot widen
permissions set globally unless you trust it.

## Access modes

On top of per-rule permissions, Pi++ ships a session-level switch between two modes:

| Mode    | Behavior                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| `full`  | (Default) All tools are available, subject to your permission rules.                      |
| `ask`   | Read-only, it can answer questions and read files, but cannot mutate anything.            |

Switch modes in either of two ways:

- The `--access-mode` flag at startup:

  ```sh
  pi --access-mode ask
  ```

- The `/access-mode` slash command in the TUI, which opens a selector.
