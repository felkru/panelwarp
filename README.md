# Warp Terminal for VS Code

**An unofficial fork of the open-source [Warp](https://github.com/warpdotdev/warp) terminal,
running in a VS Code panel tab next to Terminal.** Not affiliated with or endorsed by Warp; all
credit for the terminal itself goes to the Warp team, who open-sourced their client.

This extension builds Warp's client for the web and drives a real shell on your machine through a small
local PTY server, so you get Warp's terminal without leaving VS Code:

- **Blocks**: every command and its output is a block you can select, copy and search.
- **Warp's input editor**: multi-line editing, completions, syntax highlighting, history search.
- **Tabs and splits**, restored across VS Code windows and restarts.
- **Shells keep running across window reloads**, like VS Code's own terminal.
- **AI command search (`#`) and Next Command** with your own OpenRouter key (bring your own key,
  stored in VS Code's secret storage; zero-data-retention routing on by default).
- **Warp's settings, themes and appearance**, saved in a `settings.toml` like desktop Warp's
  (**Warp: Open Settings File**), and **keybindings** in a `keybindings.yaml` (**Warp: Open
  Keybindings File**). Both stay on this machine; VS Code Settings Sync only carries command history,
  if you turn on `host.history_sync`. A remote window (SSH, WSL, containers) keeps its own copy on
  the remote machine, which starts from your settings at the time.

Warp's account, cloud and Agent Mode features are hidden: no Warp account or sign-in is needed.

## Use

Open the **Warp** tab in the bottom panel (View → Open View… → Warp). Warp's own
actions that collide with VS Code shortcuts are in the Command Palette under "Warp: …". To
use AI features, run **Warp: Set OpenRouter API Key**.

Windows full of Claude Code conversations can be put away and brought back: the archive
button in the Warp panel's title bar (also in the status bar as **Save window**, and in the tab
row of an active Claude Code tab) saves the window's conversations and their layout to a list
and closes the window; the window button next to it (**N saved** in the status bar, or **Warp:
Reopen a Saved Window** in the Command Palette) reopens one with all its conversations.

Platform: macOS (Apple silicon and Intel).

## Source and license

Warp Terminal for VS Code is licensed under the GNU AGPL v3, like Warp's client. The extension's source and the
patches it applies to Warp are at <https://github.com/felkru/panelwarp>; `NOTICE.md` explains how
to reproduce the bundled build.
