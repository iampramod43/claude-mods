# worktree-deck

A live pane showing every git worktree in the repo and what the Claude session in each one is doing. It's for running several Claude sessions side by side in separate worktrees.

## What each card shows

- **Branch and folder.** Tags mark this session's worktree, the main worktree, locked worktrees, and any rebase, merge, cherry-pick, revert or bisect in progress.
- **Claude activity.** This comes from the newest transcript under `~/.claude/projects/<encoded worktree path>/`:
  - the session title
  - its state: `● working`, `◐ stalled` (the last tool call has waited 30 s or more, often a permission prompt), `◆ your turn` or `○ idle` (no writes for 15 min)
  - the tool currently running, your last prompt, and Claude's last reply when it's your turn
- **Git state.**
  - commits ahead and behind the main worktree's branch, plus ahead/behind the remote
  - counts of conflicts (✖), staged (●), modified (✚) and untracked (?) files
  - lines added and removed vs `HEAD`
  - the last commit and its age

A status line entry sums it up (`🌳 3 worktrees · 1 working · 1 your turn`). A toast fires when Claude in another worktree finishes or appears to be waiting for approval.

## Commands

| Command | Does |
| --- | --- |
| `/worktree-deck` | Open the pane (it also opens by itself when the repo has more than one worktree) |
| `/worktree-deck refresh` | Refresh now (it refreshes every 5 s anyway) |
| `/worktree-deck files` | Show or hide the changed files under each card |

## Limits

- It only finds sessions started at a worktree's root folder. A session started in a subfolder is stored under a different project folder and isn't matched.
- "Stalled" is a timing guess. A long-running build and a pending approval look the same.
- It reads only the last 400 KB of each transcript. The title and last prompt can be missing until the session writes them again.
- The mod only observes. It runs read-only `git` commands and `tail`, and changes nothing.
