---
name: coplay
description: Show coplay status, available games, and local high scores
disable-model-invocation: true
allowed-tools: Bash(sh:*)
---
!`sh "${CLAUDE_PLUGIN_ROOT}/bin/status.sh"`

The text above is the complete coplay status report. Show it to the user
verbatim as your entire reply. Do not call any tools and do not add commentary.
