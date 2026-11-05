# worktree-deck

A live dashboard of every git worktree in the repo and the Claude Code sessions running in each one. It's for running several Claude sessions side by side in separate worktrees and seeing at a glance which one is working, which one is waiting for you, and which one needs approval.

## Install

```
/plugin install worktree-deck --marketplace iampramod43/claude-mods
```

Install it at user scope so it loads in **every** session. Each session that runs it reports its own lifecycle, which is what makes approvals, subagents and exact turn ends visible on the deck.

## How it knows what Claude is doing

Two sources feed one monitor:

1. **Hooks (live).** Every session running the mod records its own events: prompt submitted, turn start and end, each tool call's start and result, a permission ask (`tool.check` → `ask`), subagent spawn and finish, and session end. These go to a small snapshot at `~/.claude/worktree-deck/live/<sessionId>.json`, written at most twice a second, with a heartbeat every 5 s. The hooks only observe: each one passes the event on unchanged, and nothing waits on the disk.
2. **Transcripts (incremental).** Each session's JSONL transcript is tailed from the byte offset it last reached. Half-written lines wait for the rest of the line. A truncated or replaced file is re-read from the end. This gives Claude's text, prompts and tool results, and covers sessions that don't run the mod.

A session belongs to the **deepest worktree containing its working directory**, read from the transcript records' `cwd` or the live feed, never from the branch name. Sessions started in a subfolder are found. A worktree can have several sessions.

On Linux and macOS, Claude processes are counted per worktree (`/proc` or `lsof`). For a transcript-only session, this tells "still running" apart from "ended, transcript remains".

## States

| State | Meaning | Source |
| --- | --- | --- |
| Starting | Session just started | hooks; a fresh transcript |
| Working | A turn is running: the model is generating or a tool runs | hooks; transcript recency |
| Waiting for input | A turn ended; Claude waits for your prompt | hooks; transcript `turn_duration` |
| Needs approval | A tool call waits for your permission | hooks only (exact) |
| Error | The last turn ended in an API error or refusal | hooks; transcript error records |
| Disconnected | A live feed stopped with no session end (crash, killed terminal) | hooks |
| Idle | The session exists but nothing has happened for 15 min | both |
| Completed | The session ended; its transcript remains | session end; or no process left |
| No session | No Claude session is associated with the worktree | — |
| Paused | Reserved; nothing exposes it today | — |

A worktree shows its most urgent session's state. Transcript-only sessions can't report approvals: a tool call with no result after 30 s is flagged *"no result yet — may need approval"* instead.

## The pane

**Dashboard**
- A header with the connection health: how many sessions are fed live, how many by transcript only, and whether the monitor is reconnecting.
- A summary bar: worktrees, working, input, approval, done, errors.
- Controls: `l` compact/expanded, `f` filter (all / active / attention), `s` sort (status / recent / name), `x` changed files, `r` refresh, and a search box.
- One card per worktree:
  - name, branch and state
  - task title and last prompt
  - what's happening now: the current tool with its elapsed time, the approval request, or your turn with Claude's last reply
  - a timestamped activity stream
  - git state
  - a footer with session duration, last activity, tool count and running subagents
- Wide panes (≥130 columns) lay the cards out in two columns.

**Inspector** (`1`–`9` on the dashboard, or `/worktree-deck inspect <name>`):
- session id, path, model, start and last activity, feed type, tool and error counts
- a session switcher when a worktree has several sessions
- **Activity:** a conversation view of prompts, Claude's replies, tool rows with status and duration, approvals, subagent events and errors
- **Tools:** expandable rows with file, start and end times, duration, and the first line of any error
- **Agents:** subagents with status, type, tool count and last tool; expand one to see its tool calls

`b` goes back, and `a` / `t` / `g` switch tabs.

A status line entry sums it up (`🌳 3 worktrees · 1 working · 1 approval`). A toast fires when another worktree's Claude finishes, asks for approval or hits an error.

## Commands

| Command | Does |
| --- | --- |
| `/worktree-deck` | Open the deck (it also opens by itself when the repo has more than one worktree) |
| `/worktree-deck refresh` | Refresh now |
| `/worktree-deck files` | Show or hide changed files on the cards |
| `/worktree-deck compact` / `expanded` | Card layout |
| `/worktree-deck filter all\|active\|attention` | Filter cards |
| `/worktree-deck sort status\|recent\|name` | Sort cards |
| `/worktree-deck inspect <name>` | Open a worktree's session inspector |
| `/worktree-deck back` | Back to the dashboard |
| `/worktree-deck help` | List commands and keys |

**Setting:** `historySize` (`/config` → worktree-deck) is how many events each session keeps (default 150, from 20 to 1000).

## Privacy and limits

- Events store one-line, length-capped summaries: the tool name and its target (file, command description, pattern), and the first line of an error. Full tool inputs and outputs are never stored. Live snapshots stay under your Claude config folder. Snapshots older than a day are deleted.
- The mod runs only read-only `git`, `tail`, `pgrep`/`readlink`/`lsof` and `find` (to prune its own old snapshots).
- Claude's text arrives once the transcript records it, per message, not per token.
- Sessions running without the mod have no approval or subagent detail.
- Sessions update every 1.5 s. Git status and processes update every 5 s.
