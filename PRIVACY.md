# Privacy statement: Mod Manager (powermods-mod-manager)

Mod Manager is a Claude Code mod that lists your installed plugins and runs the `claude plugin` commands you choose. It is published by Michael Dobekidis ([github.com/netgfx](https://github.com/netgfx)).

## What it collects

Nothing is collected by the publisher. The mod has no server, no analytics and no telemetry, and collects no personal data.

On your computer it keeps only your per-mod auto-update choices (`auto-update:<plugin id>`, on or off) and a marker that the one-time copy of those choices from the plugin's old name ran.

## Where it is stored

In Claude Code's plugin store for this mod (`$.store`, under `~/.claude/plugins/store/`), which every Claude Code session on this computer can read. The list of installed plugins and update status it shows is kept in memory for the session only.

## What leaves your computer

The mod makes no network requests itself. The commands it runs at your request do:

- The `claude` CLI reaches the git host of each marketplace you use, such as `github.com`, `gitlab.com`, or a self-hosted GitLab or other git URL you paste, to add and refresh marketplaces and to install and update plugins. Those requests are made by Claude Code under your own git credentials, as when you run `claude plugin` yourself.
- `git ls-remote` reaches a plugin's git source to read its latest commit, during an update check, for plugins whose marketplace pins no version.

Nothing is sent to the publisher or to any other service.

## Retention

Auto-update choices stay until you change them with `t` in the pane. Everything else lasts only for the session.

## How to delete it

Turn auto-update off for a mod with `t`, or uninstall the plugin with `claude plugin uninstall powermods-mod-manager@claude-mod-manager`. To clear its store as well, delete the file whose name starts with `powermods-mod-manager_` in `~/.claude/plugins/store/` (and `mod-manager_` for versions before 0.3.0).

## Sharing and sale

The publisher receives none of this data, and nothing is sold or shared with anyone.

## Children

The mod is a developer tool and is not directed at anyone under 18.

## Contact

Questions or requests: [github.com/netgfx/claude-mod-manager/issues](https://github.com/netgfx/claude-mod-manager/issues).
