# Session and subscription usage

- Click **Usage** in the Herdr status bar, then click **Enable** for each provider you want to track.
- Install Node.js 18 or later on the app’s `PATH`.
- The bar shows local subscriptions and the focused local session.
- The session bar shows total tokens, cost in USD, the percentage of input tokens served from cache and observed output tokens per second. A dash (`—`) marks an unavailable metric.
- Click a provider icon to open its quota panel. Switch between **Remaining** and **Used** to change the bar and panel together. The panel shows every quota window, its reset time and the most recent update.
- Click the session reading to view model, turns, token breakdown (input, output, cache), model and tool call counts, context use, and TTFT where available, alongside subscription quota windows.
- The bar samples new output about every 2.5 seconds. The rolling rate settles to `idle` when output pauses. Codex writes usage in batches, so readings can update after a response finishes. Subscription limits refresh separately.
- The cost label identifies its source. For supported Codex models the bar estimates the API equivalent using Standard short-context prices per million tokens. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
  - `gpt-6.2-astra`: input `$8`, cache read `$0.40`, output `$40`, 30m cache write `$10`
  - `gpt-6.2-sol`: input `$2`, cache read `$0.10`, output `$10`, 30m cache write `$2.50`
- Replace `/absolute/path/to/workspace-status` with the absolute path to `mods/workspace-status` in your Herdr app home (`<appHome>`, normally `~/.config/herdr-app` or `$HERDR_APP_HOME`).

## Codex

- Uses your signed-in `codex app-server` for subscription quotas.
- For focused session tracking, either start directly with `codex resume <UUID>` or set `SESSION_ID` and bind it inside its Herdr terminal.

```bash
node "/absolute/path/to/workspace-status/usage.cjs" bind codex "$SESSION_ID"
```

- Optional Codex `SessionStart` hook reads `session_id` from stdin.

```bash
node "/absolute/path/to/workspace-status/usage.cjs" bind codex
```

## Claude Code

- Reads the default account-matched local cache for quotas automatically.
- For live session and rate-limit updates, add `statusLine` to your Claude settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/workspace-status/claude-usage.cjs\" status-line"
  }
}
```

- To keep an existing status-line command, add `--passthrough` and pipe to it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/workspace-status/claude-usage.cjs\" status-line --passthrough | existing-command"
  }
}
```

## Agy

- Add `statusLine` to `~/.gemini/antigravity-cli/settings.json`. Keep the default status line with `stack_with_default`.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/workspace-status/agy-usage.cjs\"",
    "stack_with_default": true
  }
}
```

## Cursor

- Add `sessionStart` and `stop` hooks to `~/.cursor/hooks.json` (`version: 1`). Keep existing entries in both arrays.

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "command": "node \"/absolute/path/to/workspace-status/cursor-usage.cjs\"" }
    ],
    "stop": [
      { "command": "node \"/absolute/path/to/workspace-status/cursor-usage.cjs\"" }
    ]
  }
}
```

- **Billing**: With Cursor enabled, Herdr uses the local Cursor CLI login from its auth.json to refresh the dashboard quota every minute. It sends the session only to cursor.com and keeps it in memory.
  - **Fallback when the CLI login file has no token**: Save the JSON from signed-in `https://cursor.com/api/usage-summary` to `<appHome>/usage/cursor/billing.json` (no restart and no environment variable needed).
  - **Custom file**: Set `HERDR_CURSOR_USAGE_FILE=/absolute/path/to/usage-summary.json`.
  - **Session cookie**: In a trusted app environment, explicitly set `HERDR_CURSOR_USAGE_COOKIE="WorkosCursorSessionToken=..."`.
- Displays session `model` and `turns` in the popup when available.
