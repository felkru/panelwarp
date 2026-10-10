# Notices

This extension embeds a web build of Warp's open-source client
(<https://github.com/warpdotdev/warp>), Copyright (C) 2020-2026 Denver Technologies, Inc.,
licensed under the GNU Affero General Public License v3.0 (see `LICENSE`; parts of Warp are
MIT-licensed, see Warp's `LICENSE-MIT`).

The extension's changes to Warp are in `warp-patches/`: apply them in order to the upstream commit
named in `warp-patches/UPSTREAM_COMMIT` and build with `--features remote_tty` for
`wasm32-unknown-unknown` to reproduce `bundle/`.

The fallback fonts in `media/fallback-fonts/` (Noto Sans families, Noto Color Emoji, Hack Nerd
Font) are licensed under the SIL Open Font License 1.1 (`media/fallback-fonts/OFL.txt`) and, for
Hack Nerd Font, the MIT license.

This extension is not affiliated with or endorsed by Warp.
