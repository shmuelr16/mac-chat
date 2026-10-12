# mac-chat

A fullscreen terminal AI chat for macOS that uses free OpenRouter models. The AI can run shell commands and read, create and edit files, and the user approves each risky action. The UI is in Hebrew and renders right-to-left.

## Files

- `mac-chat.mjs`: the whole app, in one file. `ai` and `mac-chat` are symlinks to it.
- `set-key.sh`: shows a native macOS dialog (osascript), checks the key against OpenRouter, and stores it in the Keychain.
- `install.sh`: checks for macOS and Node 18+, then links the commands into `/usr/local/bin`.
- `README.md`: the user-facing docs, in Hebrew with a short English part. Update it whenever a feature, command or key changes.
- `assets/`: screenshots used by the README.

## Hard rules

- macOS only. Node 18+. **No dependencies** and no `package.json`. Use only Node built-ins, and keep the app in a single file.
- Never write the API key to a file, a log or a commit. The key lives in the Keychain under service `mac-chat`, account `openrouter`. Before every push, check that it is not in the repo:
  `git grep -lF "$(security find-generic-password -s mac-chat -a openrouter -w)"` (no output means clean).
- Every assistant tool call must have a matching `tool` message, or the API rejects the history. `apiMessages()` builds the history, and `loadChat()` repairs chats that were saved mid-turn.

## How `mac-chat.mjs` is organized

The sections appear in this order:

1. **Key & config**: `readKey`, `askForKey`, and `~/.config/mac-chat/config.json` (the chosen model).
2. **Colors**: truecolor with a 256-color fallback, plus the gradient helpers.
3. **Text measurement & bidi**: `textWidth` measures by grapheme (Hebrew niqqud is 0 cells, emoji are 2). `isRtl` picks the direction by word majority. `he()` wraps RTL text in an isolate.
4. **Lines**: everything renders to `{ s, w }`, a styled string plus its visible width. Never measure a string that contains ANSI codes. Markdown is handled by `renderMarkdown`, `paragraph` and `wrapTokens`.
5. **State**: one `state` object.
6. **Drawing**: `render()` repaints all rows of the screen every frame inside a synchronized-output block. `messageLines` draws chat messages, `toolLines` draws tool cards, and `pickerRows` draws the generic picker.
7. **Chat**: `complete()` makes one streamed model call. `runTurn()` loops model call, then tools, until the model replies with text. `handleTool()` asks for approval when needed.
8. **Computer access**: `TOOLS` holds the function schemas, `runShell` runs zsh (`cd` persists through a `$PWD` trailer), and `executeTool` runs the tools.
9. **Picker, history, input editing, lifecycle**: lifecycle covers the alternate screen, SGR mouse reporting and bracketed paste.

## Things that are easy to break

- **Bidi in Terminal.app.** Terminal.app lays out every row with an LTR base direction and full UBA support. RTL spans must be wrapped in RLI…PDI (`⁧…⁩`) through `he()` or `rtlRow()`. Do not use RLE/PDF: neutral characters between two embeddings get reordered. Isolates are zero-width and do not shift columns.
- **Input pipeline.** stdin data first has SGR mouse reports removed (`MOUSE_EVENT`, which feeds the wheel scrolling). The rest goes into a `PassThrough`, where `readline.emitKeypressEvents` turns it into keypresses. Do not attach readline to stdin directly, or mouse reports become typed text.
- **Approval keys** must also accept the Hebrew keyboard layout: ט=y, מ=n, ש=a.
- **Scrolling** is measured in lines up from the bottom. While the user is scrolled up, `chatRows` raises the offset as new lines stream in, so the view stays still.

## Adding a tool

1. Add an `fn(...)` schema to `TOOLS` and a `case` to `executeTool`.
2. Add its short verb in `toolLines`, plus a preview if approval needs one.
3. Add it to `NEEDS_APPROVAL` if it changes anything on disk or runs code.
4. Add a row to the tools table in the README.

## Testing

- `node --check mac-chat.mjs` after every edit.
- **End to end (headless):** run the app in a pseudo-terminal with Python's `pty.fork()`. Set the size with `TIOCSWINSZ`, and split the output on `\x1b[?2026l` to get whole frames. To read a frame, turn `\x1b[<row>;1H` into newlines and strip the other escape codes. Answer approvals by writing `y` once a frame shows `לאשר את הפעולה`. Mouse wheel events are `\x1b[<64;x;yM` (up) and `\x1b[<65;x;yM` (down).
- **Visual check:** run `osascript -e 'tell application "Terminal" to do script "…"'`, get the window id, and capture it with `screencapture -x -o -l<id>`.
- These tests call the real API with the key from the Keychain. Afterwards, delete the chats they saved from `~/.config/mac-chat/chats`.

## Style

Match the existing code: 2-space indent, single quotes, small functions, and comments only where the reason is not obvious. UI strings are short Hebrew, passed through `he()`. Commit messages are in English and explain why.

## Website

The landing and install page lives in the private repo `shmuelr16/mac-chat-site` (local clone: `~/code/mac-chat-site`) and is deployed on Vercel at https://mac-chat-site.vercel.app. Its facts come from this `README.md`. When a feature, command, requirement or install step changes here, update the site too.

## Working with the user

- The user writes in Hebrew. Answer in Hebrew.
- The user also edits files directly on GitHub. Pull before every push.
- The shell command `mac` (in `~/.zshrc`) opens Claude Code in this repo. `mac -c` continues the last session.
- Screenshots in `assets/` must never show the local username or a path. Crop the window title bar and tab bar out.
- Auto mode blocks history rewrites and force pushes. Ask the user to add a rule in `/permissions`, or to run the command themselves with `!`. Remove the rule when done.

## History

### 2026-10-12

- The title bar of `assets/splash.png` showed the local username and install path. The user asked to remove it, including from git history.
- Cropped the title bar, tab bar and window border out of the image (now 1076×682).
- Rewrote `main` with `git filter-branch --index-filter`, so every commit has only the cropped image. The user ran `git push --force-with-lease`. All commit SHAs changed; the new head is `ebee591`.
- Still open: the old first commit `69235c7` is still reachable on GitHub by its SHA. Removing it needs a request to GitHub Support (https://support.github.com/request). The local clone also keeps the old history in `refs/original` and the reflog.
