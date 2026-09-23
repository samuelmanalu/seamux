# Seamux

**See every agent session at once — and which one is waiting on you.**

*Sea* as in the open water you can see clear across, and as in **see**;
*mux* as in multiplexer. One view over many sessions.

Switching Terminal tabs to find which agent is waiting on a permission prompt is
the actual cost of running several projects at once. Seamux removes it: a sidebar of
live sessions, each with a status dot, plus a macOS notification and a dock badge
when one goes from *working* to *waiting on you*.

## Agents

Seamux is not tied to one CLI. An **agent profile** declares the command, how
standing instructions and an opening prompt are passed, and which global-rules
file the General tab edits. Pick one per project.

| Profile | Command | Instructions | Opening prompt | Global rules | Verified |
|---|---|---|---|---|---|
| Claude Code | `claude` | `--append-system-prompt` | positional arg | `~/.claude/CLAUDE.md` | yes — probed against v2.1.278 |
| Gemini CLI | `gemini` | none (uses `GEMINI.md`) | `-i` | `~/.gemini/GEMINI.md` | flags yes, output partly |
| Shell | `$SHELL` | — | — | — | yes |
| Codex CLI | `codex` | none | positional arg | `~/.codex/AGENTS.md` | **no — not installed here** |
| Custom | yours | optional flag | optional flag/positional | optional | no |

Gemini is the reason `prompt.mode` exists: its *positional* argument runs
one-shot, so an interactive opening prompt has to go through `-i` instead. An
agent that cannot carry part of your context says so in the session warnings
rather than dropping it silently.

Detection is generic by default — y/n prompts, numbered and bulleted menus,
`(Use Enter to select)`, braille spinners, quiet-means-idle — with agent-specific
rules layered on where they have been observed.

## Run

```
npm install     # downloads Electron, compiles node-pty
npm start
```

## Use

- **⌘T** — new session (pick a project directory; runs `claude` there)
- **⌘1**–**⌘9** — jump to a session
- **⌘D** — detector debug pane (see below)
- Click a **project** in the sidebar to start another session in it
- Click the red banner to jump straight to whatever needs you

Open straight into projects at launch, skipping the picker:

```
SEAMUX_OPEN=~/code/my-service npm start
SEAMUX_OPEN=~/proj-a:~/proj-b npm start        # colon separated
npx electron . -- ~/proj-a ~/proj-b          # or as arguments
```

Projects you open are remembered in `~/Library/Application Support/Seamux/seamux.json`.

## Context

Two kinds, both reached from the **Context** screen (**⌘E**, or **+** in the sidebar).

### General context — the rules every session gets

The **General** tab edits your global `CLAUDE.md` (`~/.claude/CLAUDE.md`), which
Claude Code reads at the start of every session.

This is a file you already depend on, so saving is deliberate:

- **Save changes** opens a confirmation showing a real line diff — what is added,
  what is removed, and a count — before anything is written.
- The previous version is backed up first, under `~/.claude/seamux-backups/`,
  reachable from **Earlier versions…**.
- If the file changed outside Seamux since you opened it, the save is **refused**
  rather than clobbering that edit.
- Sessions already running keep the rules they started with; the confirmation
  says so.

### Per-session context — values and instructions

Click **+** next to **Context** in the sidebar (or **⌘E**) and a guided flow
walks through it one question at a time:

1. **Paste it** — `NAME=value` lines, straight from a `.env` file, a password
   manager or a message. It tells you what it found as you type.
2. **Check what was found** — names listed, values masked.
3. **Name it** — “Stage database”, “AWS production”.
4. **Tick the projects** — the project you're currently in is pre-selected.

Nothing is written until the last step, so backing out leaves nothing behind.

The Context screen then manages everything: every set, every value, where each
one came from, reveal / edit / delete per value, and which projects use it.

Under the hood a context set is a named set of ordered **sources**:

| Source | Behaviour |
|---|---|
| pasted `.env` text | parsed once into stored variables |
| `.env` file, **live** | re-read on every session launch |
| `.env` file, **snapshot** | values frozen when you added it |
| command output | run on every launch, stdout parsed as `KEY=value` |
| key-by-key | added or edited directly in the table |

### Context belongs to the session

A session owns its context. A project only supplies the **default** that gets
ticked when a session starts there, so two sessions in the same project can hold
different context — stage in one pane, prod in the next.

The session header shows what is applied; click it to change it.

**Changing context on a running session.** A process's environment is fixed at
`exec()`, so new values cannot become real environment variables in a session
that is already running. Measured against a real Claude Code session:

| | |
|---|---|
| Do Bash tool calls inherit the spawn environment? | **yes** |
| Does `BASH_ENV` make the Bash tool read a live file? | **no** |

So Seamux does two things when a session's context changes:

1. **Rewrites that session's context file** (`$SEAMUX_CONTEXT_FILE`, `0600` in a
   `0700` directory, removed when the session closes).
2. **Injects a one-line notice into the session** naming the variables and how
   to load them:
   `set -a; . "$SEAMUX_CONTEXT_FILE"; set +a`

Only variable **names** are injected; the values stay in the file and never
enter the conversation. Those values are plaintext on disk for as long as the
session lives — a deliberate trade for delivering changes without a restart.
Orphaned files from a crash or force-quit are swept on the next startup. The notice waits until the session is at its prompt, so
it never lands in a permission dialog or mid-turn.

A first version of the context file was removed as useless — nothing read it.
What was missing was not the file but anyone telling Claude it existed.

**Restart** is still offered, and is what you want when something needs the
values as real environment variables. It is never automatic: restarting ends the
conversation in that pane.

**Context changes reach running sessions.** Binding a set to a project, editing
a value, adding a source or deleting a set all re-resolve every running session
and flag any that now differ. Without this a session silently keeps its
spawn-time environment — which is exactly how a session ended up not knowing
about credentials added to its project after it started. A session you pointed
at specific context by hand is left alone; others follow their project.

Bind a context set to a project and every session started there gets it by default. Within
a set, later sources win; across sets, later bindings win; the result is layered
*over* the inherited shell environment, so a set can deliberately override
something from your shell.

### How values are held

- Encrypted at rest with Electron `safeStorage` (macOS Keychain) in
  `seamux-secrets.json`, mode `0600`. The manager shows a badge saying whether
  encryption is actually active — if the Keychain is unavailable it says so
  rather than silently writing plaintext.
- Raw values never cross to the renderer. The UI gets masked values; a real
  value is fetched only when you click **reveal**, and dropped when you collapse it.
- Deleting a context set unbinds it from every project.
- The UI uses in-app dialogs, never `window.prompt`, so a value being edited can
  be masked.

**What this does not protect against:** anything in a session's environment is
readable by Claude and by every command it runs, and is inherited by child
processes. That is the point of the feature, but it means a prod credential
bound to a project is available to anything that session does. Bind narrowly.

## How status detection works

Each session is a `node-pty` process running `claude`, mirrored into a **headless
xterm emulator** in the main process. Every 400ms we read that emulator's rendered
viewport — the exact text you would see in the pane — and run ordered rules against
it (`src/main/status-detector.js`).

Reading the *rendered screen* rather than the raw PTY stream matters. The raw stream
is append-only history, so a spinner line from 40 seconds ago keeps matching forever.
The screen always reflects now.

| State | Meaning | Dot |
|---|---|---|
| `needs_input` | Blocked on you: permission prompt, workspace trust, y/n | red, haloed |
| `running` | Working: thinking or running a tool | amber, pulsing |
| `idle` | Prompt is up, quiet — your move | green |
| `exited` | Process ended | grey |

The rules are written against **real captured Claude Code output**, not guesses.
Two things only a live capture revealed:

- There is no `esc to interrupt` string in current output. The working line is
  `✽ Calculating… (6s · ↓ 92 tokens)`.
- The finished line uses the *same* glyph: `✻ Churned for 20s · done 11:11 AM`.
  The ellipsis after the gerund is the only reliable discriminator, and that is
  what the pattern keys on.
- The workspace-trust dialog uses a bare `❯ ` cursor with no numbering — but so
  does the idle input box and the echo of your own prompt. Matching `❯ ` alone
  would mark every idle session as needing you, so the modal is identified by
  its affordance line (`Enter to confirm · Esc to cancel`) instead.

Blocking states are checked first: a false `needs_input` costs you a glance, a false
`running` costs you a session sitting stuck while you don't notice.

### Tuning it

All patterns live in the `RULES` array in `src/main/status-detector.js`, matched in
order, first match wins. Nothing else needs to change when you adjust them.

Press **⌘D** to open the debug pane, which shows the exact screen text the detector
is reading and which rule fired. That is by far the fastest way to fix a
misdetection: reproduce it, read the screen text, add or loosen a rule.

The patterns are heuristics against Claude Code's current TUI. They will need
adjustment when its output changes — that is the one part of this app expected to
drift.

## Tests

```
npm test               # everything below, in order
npm run test:dotenv    # .env parser edge cases
npm run test:env       # environment resolution + precedence
npm run test:detector  # rules vs. real captured screens
npm run test:pty       # pty + headless mirror
npm run test:e2e       # drives the real window: layout, focus, keystrokes
npm run test:env-e2e   # credentials reach a real session; encrypted at rest
npm run test:wizard    # clicks through the guided flow by button label
npm run test:session-context  # live file updates, restart semantics, per-session isolation
```

Every Electron test runs against a throwaway `SEAMUX_USER_DATA` directory. Without
that, test runs write projects and context sets into the real config — which
happened, and made one assertion match a stale set from a previous run.

`test/fixtures/*.txt` are real screens captured from a live Claude Code session.
To test a state the rules get wrong, capture it and add it there — that is the
regression guard, and it is what caught the two bugs above.

There is also a live test that drives the real `claude` binary through the real
window and asserts the badge tracks an actual turn:

```
SEAMUX_LIVE_DIR=/some/project SEAMUX_E2E=$PWD/test/live-claude.js npx electron .
```

## Layout

```
src/main/
  main.js             window, IPC, notifications, dock badge, menu
  env-manager.js      environment sets, sources, resolution order
  secrets.js          safeStorage-encrypted store
  dotenv.js           .env parsing / masking
  pty-manager.js      spawns sessions, drives the headless mirror, polls status
  status-detector.js  the rules  <- tune here
  store.js            remembered projects
  preload.js          the renderer's entire API surface
src/renderer/
  index.html  styles.css  renderer.js  env-ui.js (Context screen + wizard)
test/
  detector.test.js  fixtures/   rules vs. real captured screens
  e2e.js                        drives the real window
  live-claude.js                drives real claude through the real window
  pty.smoke.js                  pty + headless mirror
```

The renderer gets no Node: `contextIsolation` on, `nodeIntegration` off, and a CSP
that allows only local scripts. Everything crosses through `preload.js`.

## Traps worth knowing about

`renderer.js` and `env-ui.js` are classic scripts sharing **one global lexical
scope**, so a top-level `const` in one collides with the same name in the other
and kills that whole file with a SyntaxError — silently, in the renderer console.
That happened once (`el`). `env-ui.js` is wrapped in an IIFE for this reason, and
the e2e suite now asserts every renderer module initialised and that the console
is free of errors.



`[hidden] { display: none !important }` in `styles.css` is load-bearing. The UA
rule for `[hidden]` has specificity (0,1,0), so any ID selector that sets
`display` silently outbids it and `el.hidden = true` does nothing. That is how
the welcome overlay (`#empty { display: flex }`) stayed painted over the terminal,
covering it and eating every click while the session underneath worked perfectly.
Keep that rule.

## Known limits

- Sessions die with the app. If you want them to survive a crash or quit, the move
  is to back each one with a tmux session — a contained change in `pty-manager.js`.
- Unsigned local build. Distribution needs an Apple Developer cert and notarization.
