# Handoff: claude-mods

Context for picking this repo up in a new Claude Code session. Start the session from this folder (`cd ~/work/claude-mods && claude`) and point Claude at this file.

Last updated: 2026-10-14.

## What this is

A personal Claude Code **mod marketplace**. Mods are Claude Code plugins built on the function-hooks API (panes, status lines, toasts, slash commands, hooks on tool calls).

- Repo: https://github.com/iampramod43/claude-mods (public, branch `main`)
- Dashboard: https://iampramod43.github.io/claude-mods/ (GitHub Pages, served from the root of `main`)
- Install a mod: `/plugin install <mod> --marketplace iampramod43/claude-mods`, typed at the Claude Code prompt in a terminal

### Decisions already made

- **Personal GitHub, not the company org.** The user chose this.
- **Public repo.** Private was considered and rejected. A private repo breaks the one-line install for anyone without repo access. Pages on a free personal account also needs a public repo. And mod code always ends up on each installer's machine anyway, so it can't be kept secret from users. If a future mod touches work systems (Jira, internal APIs), give it a **separate private marketplace** instead of making this one private.
- **One repo for every mod.** Each mod lives in `plugins/<name>/`, and the dashboard reads `.claude-plugin/marketplace.json`, so adding a mod needs no change to the dashboard page.

## Layout

```
.claude-plugin/marketplace.json   list of mods; the dashboard renders its cards from this file
plugins/<mod>/                    one folder per mod
  .claude-plugin/plugin.json      name, version, description, author, "types"
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              the hooks module
  hooks/*.ts                      pure logic, kept separate so it's testable
  hooks/*.test.ts(x)              claude plugin test
  types/index.d.ts                $.state contract (PluginState)
index.html                        dashboard: fetches marketplace.json and works out owner/repo from the Pages URL
.nojekyll                         required, otherwise Pages hides the .claude-plugin folder
README.md                         install/update steps, mods table, how to add a mod
```

Gitignored: `plugins/*/.claude-plugin/types/` and `plugins/*/tsconfig.json`. The engine writes both when it loads a mod.

## Mods shipped

### burn-meter 1.0.0

A pane, status entry and `/burn-meter` command that track session spend.

- **What it shows, top to bottom on one page (no tabs):**
  - Headline card: 🔥 flame (·/🔥/🔥🔥/🔥🔥🔥 at $0, <$5, <$20, ≥$20 per hour), total cost, $/h over the last 10 min next to the session average, and a 1-hour sparkline.
  - Budget card.
  - Tokens card.
  - By-model card: a stacked share bar, then per-model turns, ≈$ and %.
  - Limits card: context fill, plus rate-limit windows with reset countdowns.
- **Data sources:**
  - `session.measure`: cost, context %, rate limits. It fires after each main-thread turn.
  - `turn.complete`: per-turn `usage` with `model`, subagents included.
  - A `$.clock.every(30s)` tick keeps durations and countdowns current.
- **Per-model $ is an estimate.** The engine only reports the session total. `PRICES` in `hooks/burn.ts` holds list prices taken from the claude-api skill (cached 2026-10-06). Cache writes are assumed to cost 1.25× input, so they're under-counted if Claude Code uses the 1-hour cache. Model ids are matched longest-first, so `claude-opus-5-5` is never priced as `claude-opus-5`.
- **Budget:** `/burn-meter budget <usd>` or `budget off`. Toasts fire once each at 50%, 80% and 100%. The budget lives only in `$.state`, so it resets each session. Persisting it via `$.store` was offered to the user but not built.

### file-trail 1.0.0

A live repo tree pane and `/file-trail [clear]`.

- **Tracking:** a `tool.call` hook records Read, Edit, Write and NotebookEdit calls, plus paths parsed out of Bash commands (`bashCandidates` in `hooks/trail.ts`). The parsing skips the pattern argument of grep/sed/awk/rg/jq, skips git, echo, npm and similar commands, and skips globs. Bare words like `components` count only if `$.fs.stat` finds them.
- **The tree:** all top-level repo entries are always shown. Only the branches leading to touched paths open, and each opened folder ends with a "… N more" line. Marks are R (read), E (edited), W (written), S (searched, for folders) with counts. The three most recent touches are bold.
- **Live highlight:** a touched row stays highlighted for `LINGER_MS` (4 s) after the tool finishes. Without that, a read lasts ~50 ms and is invisible. A `$.clock.after` call redraws the pane when the highlight expires.
- **Safety:** the hook only observes. `.catch(($, e, next) => next(e))` means a failure inside file-trail never blocks or reruns a tool call.
- **Root:** the session's cwd. Paths outside it are only counted ("+N outside the repo").

### browser-trail 1.0.0

A live pane of browser tool calls and `/browser-trail [all|clear]`. Built 2026-10-13 from `browser-trail-implementation-spec.md`. The full findings, capability matrix and privacy notes are in `plugins/browser-trail/README.md`.

- **Source:** the same observe-only `tool.call` hook as file-trail. Adapters (`hooks/adapters.ts`) classify Playwright MCP `browser_*`, Chrome DevTools MCP, Claude in Chrome, and Bash `agent-browser`/`playwright test` (inferred).
- **Validated live with Claude in Chrome** (extension in Windows Chrome, Claude Code in WSL2). Captured payloads are in the tests. Playwright MCP and Chrome DevTools MCP are still unvalidated.
- **UI:** a single-column design the user supplied as a mock-up: header and pill, filled cards, a dot-and-line timeline with a title and detail per call, a failure callout, and an inspect screen. `hooks/pane.tsx` draws; `hooks/view.ts` holds the pure layout, telemetry, label and failure logic. Short mode comes from `scroll.bodyRows`. The dock is about 62 columns here (`pluginPanes.dockColumns: 63` in `~/.claude.json` wins over the pane's 120-column request), and the design is built for that width. Checked in a real terminal by running `claude --plugin-dir plugins/browser-trail` in tmux and capturing the screen (`tmux capture-pane -p`). Remember to send `C-m` to submit a typed prompt.
- Redaction (`hooks/redact.ts`) masks every typed value and every sensitive key, URL parameter and token before anything is stored. The trail is session-only, at most 200 events.

### model-pilot 0.1.0

A dashboard pane and `/model-pilot [plan|approve|cancel|retry|models|mode|pin|budget|motion]` that route a task to a model or a team of subagents. Built 2026-10-13 from `model-pilot-implementation-spec.md`. The findings, architecture and limits are in `plugins/model-pilot/README.md`.

- **Spawns** use `$.agent.spawn` with a registered read-only worker type; results come back on `turn.complete` by `agentId`. Shared context goes through the mod's own `mcp__model-pilot__*` artifact tools.
- **Verified live** with three Haiku workers (two parallel plus one integration agent). In **auto** permission mode the classifier refuses mod-started spawns, so orchestration needs the default mode.
- Released as 0.1.0 (a vertical slice), not 1.0.0.

## Developing a mod from this repo

1. **Write the mod.** Load the `plugin-authoring` skill. It holds the API, examples and the full types file, about 14k lines; grep it for the event or noun you need.
2. **Run it while you work** with `claude --plugin-dir plugins/<mod>`. The folder is watched and saving a file reloads it.
   - If the same mod is also installed from the marketplace, uninstall that copy first so two copies of the same mod aren't loaded at once.
   - Alternatively, the skill's session mods folder (`~/.claude/dev-mods/<session>/`) hot-reloads at the end of each turn once the user enables it. The two current mods were built that way and then copied in here.
3. **Check it:**
   ```
   claude plugin validate .                    # marketplace file
   claude plugin validate plugins/<mod>        # manifest + module
   claude plugin test plugins/<mod>            # *.test.ts(x)
   npx -y -p typescript@5.6.3 tsc -p plugins/<mod>   # after the engine has laid the types
   ```
   Before the engine has loaded the mod, type-check with a scratch `tsconfig.json` instead, using the options from the header of the skill's `types/claude-code.d.ts` and with `include` naming that file plus the mod's `hooks` and `types` folders.
4. **Write tests** in positive/negative/edge style. Keep logic in pure functions and test those. Add one `$.ui.mount` test per pane.

### Gotchas found the hard way

- **Never name a variable `h`.** JSX compiles to the global `h`. Shadowing it makes every render fail with "h is not a function", and the engine draws its own pane instead. A `$.ui.mount` test catches it, and `claude plugin test --debug` shows the reason.
- **UI tests need the clock mocked.** Call `mock.clock(on)` in any UI test whose render calls `$.clock.now()`. Otherwise mount fails with "no implementation for ui.render".
- **Tests can't write the mod's `$.state` directly.** The test `$` has no `state`. Test against empty state, or drive the state through events.
- **Buttons with `hotkey` get an engine-drawn `1:` prefix.** Don't repeat the key in the label.
- **Some built-in tools are missing.** There are no `Glob` or `Grep` tools in this build; Claude searches through Bash. Check `.claude-plugin/types/claude-code-tools/index.d.ts` for the real tool list and each tool's input shape.
- **Mark observe-only `tool.call` hooks with `.catch(($, e, next) => next(e))`.** Otherwise validate warns about a "gating hook without .catch".
- **`session.start` fires again on every reload.** Merge the stored state with `{ ...empty(), ...stored }` so fields added in a new version get their defaults.
- **Pane redraws only happen on state changes.** Use a `tick` atom bumped by `$.clock.every` or `$.clock.after` for anything time-based.

## Releasing

1. Add or update `plugins/<mod>/` and its entry in `.claude-plugin/marketplace.json`: `name`, `source: "./plugins/<mod>"`, `description`, `version`, `category`, `keywords`.
2. On every change, bump `version` in **both** `plugin.json` and the marketplace entry. Installs run the copy made at install time and only update when the version changes, via `claude plugin update <mod>` followed by `/reload-plugins`.
3. Add a row to the README's mods table.
4. Run validate and the tests, commit (Conventional Commits, e.g. `feat(<mod>): ...`), and push.
   - Plain `git push` fails on this machine because git isn't wired to the `gh` login. Either run `gh auth setup-git` once, or push with `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push`.
   - Pages redeploys about 40 s after a push. Verify with `curl -s https://iampramod43.github.io/claude-mods/.claude-plugin/marketplace.json`.
5. Always confirm with the user before pushing.

## Ideas not built yet

Ideas offered to the user but not chosen yet:

- **Ticket band:** a band above the prompt showing the Jira key from the branch name, the branch, commits behind `dev`, and the count of changed files.
- **Git guard:** a `tool.call` hook on Bash that blocks `git commit`/`push` when the branch is behind its base, or when pushing to master/main/dev.
- **Test watch toast:** a toast plus status entry when a test, typecheck or lint command fails, with a pass/fail tally for the session.
- **Session timeline pane:** one row per turn, with the prompt snippet, duration, tools, files edited and cost.

Follow-ups for the existing mods:

- burn-meter: persist the budget across sessions.
- burn-meter: a more compact layout for short terminals.
- file-trail: possibly track `Agent` subagent activity separately.
- The dashboard has never been checked visually in a browser; worth a look.
