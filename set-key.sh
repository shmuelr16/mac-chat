#!/bin/bash
# Asks for the OpenRouter API key in a native macOS dialog, checks it, and saves it to the Keychain.

SERVICE="mac-chat"
ACCOUNT="openrouter"
KEYS_URL="https://openrouter.ai/keys"
GET_KEY="קבלת מפתח…"

ask() { # message -> "button<newline>text"
  osascript - "$1" "$GET_KEY" "ביטול" "שמירה" <<'APPLESCRIPT'
on run argv
  activate
  set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "mac-chat" buttons {item 2 of argv, item 3 of argv, item 4 of argv} default button 3 cancel button 2 with icon note
  return (button returned of r) & linefeed & (text returned of r)
end run
APPLESCRIPT
}

msg="הדבק כאן את מפתח ה-API של OpenRouter.
אין לך מפתח? לחץ על \"$GET_KEY\" — זה בחינם."

while true; do
  reply=$(ask "$msg") || { echo "בוטל."; exit 1; }
  button=${reply%%$'\n'*}
  key=$(printf '%s' "${reply#*$'\n'}" | tr -d '[:space:]')

  if [ "$button" = "$GET_KEY" ]; then
    open "$KEYS_URL"
    continue
  fi
  if [ -z "$key" ]; then
    msg="לא הוזן מפתח. הדבק את המפתח ונסה שוב."
    continue
  fi

  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K - https://openrouter.ai/api/v1/key \
    <<< "header = \"Authorization: Bearer $key\"")
  if [ "$code" = "401" ] || [ "$code" = "403" ]; then
    msg="המפתח לא תקין. בדוק שהעתקת אותו במלואו ונסה שוב."
    continue
  fi

  security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -l "mac-chat (OpenRouter)" -w "$key" \
    || { echo "השמירה ב-Keychain נכשלה."; exit 1; }
  osascript -e 'display notification "המפתח נשמר. הקלד ai בטרמינל כדי להתחיל." with title "mac-chat ✓"' >/dev/null 2>&1
  echo "✓ המפתח נשמר ב-Keychain."
  exit 0
done
