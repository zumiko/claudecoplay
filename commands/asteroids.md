---
name: asteroids
description: Play Asteroids in a tmux pane while Claude works (auto-pauses when Claude needs you)
disable-model-invocation: true
allowed-tools: Bash(sh:*)
---
!`sh "${CLAUDE_PLUGIN_ROOT}/bin/launch.sh" asteroids`

The text above is the complete output of the coplay launcher for Asteroids.
Show it to the user verbatim as your entire reply. Do not call any tools, do not
summarise it, and do not add commentary.
