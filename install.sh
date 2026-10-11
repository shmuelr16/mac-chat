#!/bin/bash
# Installs mac-chat: links the `ai` and `mac-chat` commands into /usr/local/bin.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="/usr/local/bin"

if [ "$(uname)" != "Darwin" ]; then
  echo "mac-chat עובד רק על macOS."
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "צריך Node.js 18 ומעלה: https://nodejs.org (או: brew install node)"
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "צריך Node.js 18 ומעלה (מותקן: $(node -v))."
  exit 1
fi

chmod +x "$DIR/mac-chat.mjs" "$DIR/set-key.sh"
SUDO=""
[ -w "$BIN" ] || SUDO="sudo"
$SUDO mkdir -p "$BIN"
$SUDO ln -sf "$DIR/mac-chat.mjs" "$BIN/mac-chat"
$SUDO ln -sf "$DIR/mac-chat.mjs" "$BIN/ai"
echo "✓ הותקן. פתח טאב חדש בטרמינל והקלד: ai"

# An `ai` alias or function in the shell config would hide the new command.
kind=$(zsh -ic 'whence -w ai' 2>/dev/null | awk '{print $2}')
if [ -n "$kind" ] && [ "$kind" != "command" ]; then
  echo "⚠️  ב-~/.zshrc כבר מוגדר ai בתור $kind, והוא יסתיר את הפקודה. אפשר להריץ mac-chat במקום, או לשנות את השם שם."
fi
