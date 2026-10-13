# browser-trail

A live pane that shows, call by call, what Claude does in a browser while it tests a web app. It only observes: it never drives the browser, and it never changes or blocks a tool call.

```
▣ BROWSER TRAIL                                  LIVE SESSION
PLAYWRIGHT · SESSION CE23 · ALL TOOLS

 ACTIONS        FAILURES       AVG LATENCY    ELAPSED
 05             01             779ms          1m06s
──────────────────────────────────────────────────────────────
EXECUTION TIMELINE
●  01 Bash · echo hello                             2.2s  DONE
│     Bash
●  02 Bash · ls plugins                            495ms  DONE
│     Bash
●  03 Bash · cat /nonexistent-file               474ms  FAILED
│     Bash
●  04 Read · file_path="~/work/claude-mods/READM…  89ms  DONE
│     Read
●  05 Say hi                                       651ms  DONE
      $ echo hi
╭────────────────────────────────────────────────────────────╮
│ ⚠ ACTION FAILED  #03 Bash · cat /nonexistent-file          │
│ Bash returned an error:                                    │
│   Exit code 1 cat: /nonexistent-file: No such file or      │
│   directory                                                │
│ A failed tool call does not show that the app failed.      │
│ No later check of the page observed.                       │
╰────────────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────────────
j: next  k: prev  o: inspect  f: failures  h: help    q: close
```

Captured from a real Claude Code session in tmux (the 62-column dock) with `/browser-trail all` on. Colors, the filled cards and the callout background are not shown. Rows 01–04 were recorded before generic calls got their own titles; row 05 shows the current form (the call's description as the title, the command as the detail). Claude in Chrome rows read like `02 Navigate / localhost:8765/login.html` and `04 Sets the password field / ref_7 · value redacted`.

## Use

- `/browser-trail` opens the pane with the keyboard, asking for a 120-column dock (a width you dragged the dock to wins). It also opens by itself on the first browser tool call of a session.
- `/browser-trail all` toggles the generic fallback, which records every tool call and not just browser ones.
- `/browser-trail clear` hides the current list. Nothing is deleted.

### Keys (while the pane has focus)

| Key | Does |
| --- | --- |
| `j` / `k` | select the next / previous call |
| Tab, Enter | focus a timeline row; Enter inspects it |
| `o` | inspect the selected (or newest) call; `o` again goes back |
| `f` | failed calls only |
| `c` | clear the visible timeline (nothing is deleted); shown from 72 columns, `/browser-trail clear` always works |
| `h` | help and legend (`?` cannot be bound: pane hotkeys are one letter or digit) |
| `q` | close the pane; the browser session is untouched |
| ↑ / ↓ | scroll the pane (the engine's own keys) |

### Layout

One column, top to bottom, sized from the pane's real `bodyColumns` and `scroll.bodyRows` and redrawn from the same state on every resize:

- **Header:** `▣ BROWSER TRAIL` with a status pill: LIVE SESSION (a call ran in the last minute), IDLE, ENDED, or NO BROWSER TOOLS. Under it: the connected integrations (CHROME EXTENSION, PLAYWRIGHT, CHROME DEVTOOLS), the session, and the current page when one is exposed (`≈` when correlated). The tool list is re-read every 30 s and on `/browser-trail`, so `/chrome` turned on mid-session shows up.
- **Cards:** actions, failures (red when any), average latency of completed calls that have both timestamps, and elapsed time since the session started. A missing figure shows `—`; nothing is estimated. Cards are filled, with darker fills on a dark theme and lighter ones on a light theme (read from the `theme` setting).
- **Execution timeline:** one dot per call joined by a line. Line one has the number, a title and on the right the duration and DONE / RUNNING / FAILED / TIMEOUT / NO RESULT. Line two has the detail: the target, the URL, `value redacted`, a batch's result and steps. The window follows the selection and counts what is out of view (`↑ 3 earlier`).
- **Failure callout:** for the selected failed call, or the newest one. Shows the tool's own error text, that a failed tool call does not show the app failed, and the next later call that looked at the page, or that none was observed. A `playwright test` run is labelled as the test runner's report.
- **Inspect screen (`o`):** tool, action and confidence, start, duration, status and its source, integration, target, the page and how it is known, a reminder that DONE is not proof of page state, the redacted input, the output or error (word-wrapped and bounded), evidence, and batch steps (DONE / FAILED / NOT RUN).
- **Short terminals (19 rows or fewer):** the header, a one-line telemetry strip, and one line per call.

The timeline only shows calls that happened. A step that never ran ("verify dashboard") is never drawn as BLOCKED. Batch steps after a failure show NOT RUN because the batch's own report says so.

## Findings (2026-10-13)

- **Stack.** The mod follows the repo's existing pattern: a Claude Code function-hooks plugin in TSX, pure logic in `.ts` files, and `claude plugin test`. It shares no code with burn-meter or file-trail; it reuses their layout, the `atom` state approach, and the observe-only `tool.call` + `.catch` pattern.
- **Browser integrations.** At first none was connected, so the adapters were built from documented tool names. **Claude in Chrome has since been validated live** (below). Playwright MCP and Chrome DevTools MCP have not: Playwright's run stopped at launch because Chrome was not installed.
- **Event source.** Claude Code's `tool.call` hook (the function-hooks form of PreToolUse/PostToolUse). It carries the tool name, the full input, a stable `tool_use_id`, and on return the result (`text`, `result`, `isError`, or `deny`). Each MCP browser tool call is **one** call: the hook does not see the browser steps inside it.
- **Connected browser servers** come from `$.tool.list()`, read at session start, every 30 s and on `/browser-trail`, and from any browser call that runs.

### Live validation: Claude in Chrome (2026-10-13)

Tested with the extension in Windows Chrome and Claude Code in WSL2, on a local login page. What the real payloads showed:

- Tools are `mcp__claude-in-chrome__*`, including `browser_batch`. Because that name also starts with `browser_`, the server name is now checked before the Playwright prefix.
- `computer` and `form_input` carry an `action_summary` the model writes for display. It is now the row label (redacted, and typed values still masked).
- `form_input` echoes the value it set (`Set email value to "…"`), including inside a `browser_batch` report. Redaction masks every `value to "…"` echo, and typing actions keep no output preview.
- A batch of fill, fill, click, wait returned OK while the page stayed on the login page (read back with `get_page_text`). This is why the pane never treats OK as proof of page state.
- Every result ends with a "Tab Context" block (`tabId N: "title" ("url")`, plus `Executed on tabId` or `selectedTabId`). The page and title are taken from that block as observed facts. It is the tab state when the call returned, so a click that starts a navigation can still report the old page.
- The extension redacts password values in its own output and in tab URLs. Other form fields (e.g. email) still appear in URLs; `email`/`phone` keys are now redacted too.
- `browser_batch` lists its steps in its input, and on failure reports `actions[i] (…) failed … (N completed, M remaining)`. The pane shows the batch as one row (`· 2 ok, step 3 failed`), with the steps in its details.

## Architecture

```
tool.call hook ──classify()──▶ start()  ─▶ $.state trail (≤200 events) ─▶ ui.render Pane
      │          adapters.ts                trail.ts                          register.tsx
      └─ await next(e) ─▶ finish(): status, duration, page fact, evidence, redacted previews
```

- `adapters.ts` maps a tool call to an action. It uses one table per integration, keyed by tool name: Playwright MCP's `browser_*` tools (any server name), Chrome DevTools MCP on a server named `*devtools*`/`*chrome*`, and Claude in Chrome on a server named `claude-in-chrome`. Bash lines that run `agent-browser …` or `playwright test` are marked *inferred*. A browser-looking server with an unknown tool becomes one `OTHER` row under its own name. No sub-steps are ever made up.
- `trail.ts` pairs start and result by `tool_use_id`, ignores duplicates, and keeps a result that arrives before its start. It times each call with the engine clock and keeps at most 200 events per session.
- `redact.ts` runs before anything is stored or drawn.
- **Sessions.** The trail is keyed to `$.session.id()`. A call under a new id (after `/clear`) starts a fresh trail. A reload marks calls still running as `UNKNOWN (session-restart)`, and `session.end` marks them `UNKNOWN (session-end)` and sets `ENDED`. Nothing is written to disk: the trail lives in the session's `$.state` only.
- **Safety.** The `tool.call` hook carries `.catch(($, e, next) => next(e))`. The engine's `.catch` is replay-safe, so a failure in this mod lets the tool run (or keeps its result) and never runs it twice. A test checks this.

## Capability matrix

| Fact | Status | Where it comes from |
| --- | --- | --- |
| Tool name, arguments, `tool_use_id` | **observed** | `tool.call` input |
| Call start, end, duration | **observed** | engine clock around `next(e)`. The duration includes any permission prompt. |
| OK / ERROR / denied | **observed** | `isError` / `deny` on the result. OK means the *call* returned, not that the UI changed. |
| TIMEOUT | **inferred** | from the error text (`timeout`, `timed out`, `deadline exceeded`) |
| UNKNOWN | **observed absence** | no result arrived (reload, session end, hook failure) |
| Action type and summary for an MCP browser tool | **observed** | tool name + arguments, through the adapter tables |
| Action for a Bash browser CLI | **inferred** (`?`) | the command line. One command may do more. |
| Target | **observed** as given | Playwright `element`/`ref`, DevTools `uid`, Chrome `ref`/coordinate. This is the model's own description, not the DOM. |
| Page URL and title in a tool's output | **observed** | Playwright `Page URL:`/`Page Title:` lines, the DevTools page list's `[selected]` row |
| Page after a successful navigate | **correlated** (`≈`) | the URL that was asked for. The page may have redirected. |
| Page a later action ran on | **correlated** | the last known page, by order only |
| Screenshot or snapshot returned | **observed** as evidence | image blocks counted, snapshot noted with its line count. The content is never stored. |
| Sub-steps inside one MCP call, DOM changes, network, unrelated tabs | **unavailable** | not exposed through hooks. Shown as one grouped call. |
| "The app reached state X" | **unavailable** unless a later call reports it | the mod never claims it |

## Privacy

- Typed values (`text`, `value`, `fields`, `elements`, …) are **always** masked as `‹N chars›`, whatever the field, because a target description can't be trusted to say "password".
- Keys that look sensitive (password, token, secret, auth, cookie, session, api key, code, …) are masked in the input summary, in URL query strings and fragments, and in JSON text.
- Bearer/Basic tokens, JWTs, common API key prefixes (`sk-`, `ghp_`, `xox*`, `AKIA…`) and Cookie/Authorization headers are removed from all text.
- URL credentials (`user:pass@`) are stripped.
- Output previews are cut to 300 characters, and page snapshot content is dropped before storing. Nothing persists beyond the session, and nothing is sent anywhere.
- Limitation: redaction is pattern-based. A secret with an innocent-looking name in free text can get through, so treat the pane like your terminal scrollback.

## Validating against a real integration

The adapter fixtures in `hooks/adapters.test.ts` are **synthetic**, shaped from the documented tool names. To validate one:

1. Connect a browser MCP, e.g. `claude mcp add playwright -- npx @playwright/mcp@latest`.
2. Start `claude --plugin-dir plugins/browser-trail` and ask Claude to open and click through a local page.
3. Check that the header names the server, that each call gets a classified row, and that the `↳` URL matches the browser. Then open details (`o`) to check the target, page and evidence.
4. If a tool name or output format differs, adjust the table in `adapters.ts` and add the sanitized payload as a fixture.

## Tests

`claude plugin test plugins/browser-trail`: 68 tests covering correlation, durations, failures, timeouts, denies, duplicates and out-of-order results, session cut-offs and bounds, unknown tools, malformed payloads, redaction, large outputs, the pane on terminal and desktop with empty and missing fields, layout at dock, wide and short sizes and across resizes, selection, inspect, failures-only, the failure callout, help and clear, and the hook passing the tool's own result and error through untouched.
