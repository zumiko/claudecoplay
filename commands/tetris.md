---
name: tetris
description: Play Tetris in a tmux pane while Claude works (auto-pauses when Claude needs you)
disable-model-invocation: true
allowed-tools: Bash(sh:*)
---
!`sh "${CLAUDE_PLUGIN_ROOT}/bin/launch.sh" tetris`

The text above is the complete output of the coplay launcher for Tetris.
Show it to the user verbatim as your entire reply. Do not call any tools, do not
summarise it, and do not add commentary.
