# Amy — Voice Kiosk for Kraemer & Kraemer (demo)

Voice-enabled conversational assistant for the Kraemer & Kraemer showroom.
Speaks and listens in **English**, answers with natural TTS, and ends the
conversation on its own. Built on the original robot kiosk (`showroom-kiosk`)
for the CSJBOT hardware.

**Live demo:** https://ricardochen.github.io/amy-demo/

## Architecture

| Piece | Where | What it does |
|---|---|---|
| Frontend | GitHub Pages (`docs/`) | Kiosk UI, `SpeechRecognition` (STT), `<audio>` (TTS) |
| Backend | Supabase Edge Function `amy-api` (Deno) | `/query` (retrieval + DeepSeek), `/tts` (ElevenLabs), `/health` |
| Knowledge base | `supabase/functions/amy-api/kb_data.json` | 1,357 Q&A pairs for the firm |

### Why BM25 instead of embeddings

The original backend used `sentence-transformers` + `chromadb`. That pulls in
`torch` (>700 MB), which cannot fit in a serverless runtime. It was replaced by
**BM25** over the same knowledge base: deterministic, loads in ~20 ms, and has
zero heavy dependencies.

The knowledge base is English-only. A Spanish→English glossary
(`glossary_es_en.json`, 153 legal terms) is expanded in both directions — at
index time and at query time — so vocabulary variance does not cause empty
results. This matters because the source KB uses different wording than a
visitor would ("payment methods" vs "how can I pay").

**Trade-off to be aware of:** BM25 is lexical, not semantic. A visitor who asks
"my wife and I want to separate" without using the word "divorce" will retrieve
worse than an embedding model would. Acceptable for a demo; move to pgvector if
Kramer runs this in production.

## Regenerate the knowledge base

```bash
# from the original Excel file (knowledge_base.xls)
python3 scripts/build_kb.py path/to/knowledge_base.xls
```

## Deploy the backend

```bash
supabase functions deploy amy-api --project-ref <ref> --no-verify-jwt
supabase secrets set --project-ref <ref> \
  DEEPSEEK_API_KEY=*** ELEVENLABS_API_KEY=*** RATE_LIMIT_PER_HOUR=40
```

`--no-verify-jwt` is required: the kiosk is public and has no session.

## Tests

Both smoke tests run against the **deployed** demo, not against localhost:

```bash
node tests/smoke_pages.mjs   # load, assets, /health, /query, /tts, clean console
node tests/smoke_chat.mjs    # real UI flow: LET'S TALK → question → answer on screen
```

They exit non-zero on failure.

## Limits

- Rate limit: 40 queries per IP per hour, tracked **in memory per warm
  instance**. This is not a global limit — move it to a table or KV store if the
  demo gets shared widely.
- Real answers require `DEEPSEEK_API_KEY`; without it the API returns a demo
  notice instead of an answer.
