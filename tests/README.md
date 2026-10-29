# E2E smoke tests

These run against the **deployed** demo (GitHub Pages + the `amy-api` edge
function), never against localhost. Requires `playwright`.

```bash
node tests/smoke_pages.mjs   # load, assets, /health, /query, /tts, clean console
node tests/smoke_chat.mjs    # real UI flow: LET'S TALK → question → answer on screen
```

Both exit with code != 0 if anything fails.

## Note on the asset check

The background images live in an inline `<style>` block with **relative** URLs,
so `document.styleSheets` does not expose them. The test reads the raw HTML and
resolves each URL against the page origin, and it **fails when it finds zero
images** — an empty result is a blind test, not a pass.
