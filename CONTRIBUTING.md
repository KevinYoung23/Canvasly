<p align="right"><strong>English</strong> · <a href="./CONTRIBUTING.zh-CN.md">简体中文</a></p>

# Contributing to Canvasly

Thank you for helping make human–AI interface work more direct, inspectable, and useful.

## Before you start

- Search existing issues and pull requests.
- Keep changes focused on one behavior or product outcome.
- For interaction or visual changes, include before/after screenshots or a short recording.
- Never commit API keys, tokens, generated credentials, or local `.env` files.

## Local setup

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`.

## Quality bar

Run the checks relevant to your change:

```bash
npm run lint
node --check tools/copilot-bridge.mjs
```

Linux or environments with GNU `timeout`:

```bash
npm test
```

macOS equivalent:

```bash
bash scripts/sites-env.sh -- ./node_modules/.bin/vinext build
bash scripts/validate-artifact.sh
node --test tests/rendered-html.test.mjs
```

For UI work, verify desktop, tablet, and mobile widths. Confirm that selection overlays, free movement, drawing, local zoom, Cowork, Chat, Steer, and Queue still behave coherently where relevant.

## Pull requests

A good pull request explains:

1. The user problem.
2. The behavioral change.
3. Risks or trade-offs.
4. How it was validated.
5. Screenshots or media for visible changes.
