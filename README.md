# Pi++

> The missing pieces of **Pi**, in one extension.

**Pi++** is an *all-in-one extension* that adds features like *Permissions*, *MCP Support*, *Subagents* etc. in a single extension install.

## Features

- **Tool permissions**: `allow`, `deny`, or `ask` when the agent reads,
  writes, or runs Bash commands on configured paths. [docs/permissions](./docs/permissions.md).
- **Access modes**: switch a session between `full` (default) and `ask`
  (read-only) with the `--access-mode` flag or the `/access-mode` command. 
  - In `ask` mode the agent can answer questions but cannot edit files or make changes.
- **Bash command descriptions**: every Bash command the agent runs has a concise description of what it does, so you always know what is running.

## Install

Install the published package globally (recommended):

```sh
pi install npm:pi-plus-plus@latest
```

Or declare it in your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["npm:pi-plus-plus@latest"]
}
```

To run from source instead:

```sh
pi -e ./src/index.ts
```

## Roadmap

**Main**

- [x] Tool permissions (`allow` / `deny` / `ask`)
- [x] Access modes (`full` / `ask`)
- [ ] MCP server support
- [ ] Subagents

**Quality of life**

- [x] Bash command descriptions
- [ ] MCP call descriptions
- [ ] More theme options
- [ ] Better Statusline
