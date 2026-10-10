# Panelwarp

**An unofficial fork of the open-source [Warp](https://github.com/warpdotdev/warp) terminal,
running in a VS Code panel tab next to Terminal.** Not affiliated with or endorsed by Warp; all
credit for the terminal itself goes to the Warp team, who open-sourced their client.

Panelwarp builds Warp's client for the web and drives a real shell on your machine through a small
local PTY server, so you get Warp's terminal without leaving VS Code:

- **Blocks**: every command and its output is a block you can select, copy and search.
- **Warp's input editor**: multi-line editing, completions, syntax highlighting, history search.
- **Tabs and splits**, restored across VS Code windows and restarts.
- **Shells keep running across window reloads**, like VS Code's own terminal.
- **AI command search (`#`) and Next Command** with your own OpenRouter key (bring your own key,
  stored in VS Code's secret storage; zero-data-retention routing on by default).
- **Warp's settings, themes and appearance**, saved with VS Code.

Warp's account, cloud and Agent Mode features are hidden: no Warp account or sign-in is needed.

## Use

Open the **Panelwarp** tab in the bottom panel (View → Open View… → Panelwarp). Warp's own
actions that collide with VS Code shortcuts are in the Command Palette under "Panelwarp: …". To
use AI features, run **Panelwarp: Set OpenRouter API Key**.

Platforms: macOS (Apple silicon and Intel) and Linux (x64, arm64; also in Remote SSH, WSL and
container windows). Windows is planned.

## Source and license

Panelwarp is licensed under the GNU AGPL v3, like Warp's client. The extension's source and the
patches it applies to Warp are at <https://github.com/felkru/panelwarp>; `NOTICE.md` explains how
to reproduce the bundled build.
