# Claude Mods

Mods for [Claude Code](https://claude.com/claude-code): panes, status lines and hooks.

**Dashboard:** https://iampramod43.github.io/claude-mods/ lists every mod with a copy-ready install command.

## Install a mod

Type this at the Claude Code prompt in your terminal:

```
/plugin install burn-meter --marketplace iampramod43/claude-mods
```

Answer `y` to add the marketplace (first time only), then press Enter for the user scope. The mod is active right away and in every session after.

To update later:

```
claude plugin update burn-meter
```

then `/reload-plugins` in an open session.

## Mods

| Mod | What it does |
| --- | --- |
| [burn-meter](plugins/burn-meter) | Live pane showing session spend, $/h burn rate with a 1-hour sparkline, an optional budget with alerts (`/burn-meter budget 10`), tokens and estimated cost per model, context fill and rate-limit reset countdowns. |

Per-model costs in burn-meter are estimates from list prices; the session total is Claude Code's own figure.

## Adding a mod

1. Put it in `plugins/<mod-name>/` with `.claude-plugin/plugin.json` and its `hooks/`.
2. Add an entry to `.claude-plugin/marketplace.json` (`name`, `source: "./plugins/<mod-name>"`, `description`, `version`, `category`, `keywords`). The dashboard reads this file, so the new card appears on the next Pages deploy.
3. Check it:

   ```
   claude plugin validate .
   claude plugin validate plugins/<mod-name>
   claude plugin test plugins/<mod-name>
   ```

4. Bump `version` in both `plugin.json` and the marketplace entry whenever you change a mod, so `claude plugin update` picks it up.

To try a mod from a working copy without installing: `claude --plugin-dir plugins/<mod-name>`.
