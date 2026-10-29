# Amy — Kiosco de voz Kraemer & Kraemer (demo)

Asistente conversacional con **voz** para el showroom de Kraemer & Kraemer.
Habla español e inglés, escucha por micrófono, responde con TTS y se despide
solo. Basado en el kiosco original (`showroom-kiosk`) del robot CSJBOT.

**Demo:** https://ricardochen.github.io/amy-demo/

## Arquitectura

| Pieza | Dónde | Qué hace |
|---|---|---|
| Frontend | GitHub Pages (`docs/`) | UI del kiosco, `SpeechRecognition` (STT) y `<audio>` (TTS) |
| Backend | Supabase Edge Function `amy-api` (Deno) | `/query` (retrieval + DeepSeek), `/tts` (ElevenLabs), `/health` |
| Knowledge base | `supabase/functions/amy-api/kb_data.json` | 1.357 Q&A del bufete |

### Por qué BM25 y no embeddings

El backend original usaba `sentence-transformers` + `chromadb`. Eso arrastra
`torch` (>700 MB), imposible en un runtime serverless. Se reemplazó por **BM25**
sobre el mismo knowledge base: determinista, carga en ~20 ms y sin dependencias.

La KB está **100 % en inglés** pero el kiosco atiende en ES y EN. Sin ayuda, una
pregunta como *"¿cuánto cuesta una consulta?"* no recuperaba nada. Se añadió un
glosario ES→EN (`glossary_es_en.json`, 153 términos legales) que se expande en
ambos sentidos: al indexar y al consultar.

## Regenerar el knowledge base

```bash
# desde el Excel original (knowledge_base.xls)
python3 scripts/build_kb.py ruta/al/knowledge_base.xls
```

## Desplegar el backend

```bash
supabase functions deploy amy-api --project-ref <ref> --no-verify-jwt
supabase secrets set --project-ref <ref> \
  DEEPSEEK_API_KEY=... ELEVENLABS_API_KEY=... RATE_LIMIT_PER_HOUR=40
```

`--no-verify-jwt` es necesario: el kiosco es público y no tiene sesión.

## Límites

- Rate limit: 40 consultas/IP/hora (in-memory por instancia tibia).
- Respuestas reales requieren `DEEPSEEK_API_KEY`; sin ella devuelve un aviso de demo.
