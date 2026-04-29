# IntegrationsBot — Claude Code Guidelines

## Branch Workflow

Always work on a feature branch, never directly on `main`:

```bash
git checkout -b feature/<short-name>   # start work
# ... commits ...
gh pr create                            # open PR when done
```

Use `superpowers:finishing-a-development-branch` at the end of each implementation session — it verifies tests and creates the PR.

## Testing

Run the full test suite with:
```bash
node test.js
```

All tests must pass (0 failures) before any PR is created.

## Code Style

- Node.js ESM (`import`/`export`), no CommonJS
- No comments unless the WHY is non-obvious
- No error handling for scenarios that can't happen
- Keep Block Kit payloads well under Slack's 50-block limit

## Key Files

- `src/slack/blocks.js` — all Block Kit builders
- `src/index.js` — Bolt app, all action/event handlers
- `src/handlers/mention.js` — mention handler (channel responses)
- `src/handlers/dm.js` — DM handler
- `test.js` — full test suite (no test framework, plain `assert`)
