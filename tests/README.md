# Smokes E2E

Corren contra la demo **desplegada** (GitHub Pages + edge `amy-api`), no contra local.
Requiere `playwright` disponible.

```bash
node tests/smoke_pages.mjs   # carga, assets, /health, /query ES, /tts, consola limpia
node tests/smoke_chat.mjs    # flujo real: LET'S TALK → pregunta → respuesta en pantalla
```

Ambos salen con código != 0 si algo falla.
