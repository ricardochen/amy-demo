// Amy — RAG backend como Supabase Edge Function (Deno).
//
// Réplica del backend original (`showroom-kiosk/web/backend/server.py`) sin
// sentence-transformers ni chromadb: `torch` no corre en Deno y pesa >700MB.
// Se usa BM25 sobre el mismo knowledge base (determinista, ~20ms de carga).
//
// Despliegue: supabase functions deploy amy-api --project-ref <ref> --no-verify-jwt
// Secrets:    DEEPSEEK_API_KEY, ELEVENLABS_API_KEY (opcionales: DEEPSEEK_MODEL,
//             TTS_VOICE_ES, TTS_VOICE_EN, RATE_LIMIT_PER_HOUR, ALLOWED_ORIGIN)
//
// Endpoints:
//   POST /amy-api/query     → retrieval BM25 + DeepSeek
//   POST /amy-api/tts       → ElevenLabs
//   POST /amy-api/feedback  → log de preguntas sin respuesta
//   GET  /amy-api/health    → health check

import KB_DATA from "./kb_data.json" with { type: "json" };
import GLOSSARY from "./glossary_es_en.json" with { type: "json" };

// ── Config ────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
const DEEPSEEK_MODEL = Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const ELEVENLABS_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const TTS_VOICE_ES = Deno.env.get("TTS_VOICE_ES") ?? "4O1sYUnmtThcBoSBrri7";
const TTS_VOICE_EN = Deno.env.get("TTS_VOICE_EN") ?? "ZSNL4hPqCnqoMPaI4jGX";
const ELEVENLABS_TTS_URL = (id: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${id}/stream`;

const TOP_K = 5;
const MAX_TOKENS = 512;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const RATE_LIMIT_PER_HOUR = Number(Deno.env.get("RATE_LIMIT_PER_HOUR") ?? "40");

const K1 = 1.5;
const B = 0.75;

// ── Tipos ─────────────────────────────────────────────────────
interface KbItem {
  q: string;
  a: string;
  s: string;
  k: string;
}

const KB = KB_DATA as KbItem[];
const GLOS = GLOSSARY as Record<string, string>;

// ── Tokenización ──────────────────────────────────────────────
function norm(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function tokenize(text: string): string[] {
  return norm(text).match(/[a-z0-9]+/g) ?? [];
}

// ── Índice BM25 (se construye una vez por instancia tibia) ────
let DOCS: string[][] = [];
let POSTINGS: Map<string, Array<[number, number]>> = new Map();
let DOC_LEN: number[] = [];
let AVGDL = 0;

function buildIndex() {
  if (DOCS.length) return;
  const glosEntries = Object.entries(GLOS);
  for (const item of KB) {
    const base = [item.q, item.s ?? "", item.k ?? "", (item.a ?? "").slice(0, 400)].join(" ");
    // Sinónimos ES de los términos EN presentes en el doc: permite que una
    // pregunta en español (KB está en inglés) encuentre el documento.
    const normBlob = norm(base);
    const esSyn: string[] = [];
    for (const [es, en] of glosEntries) {
      if (normBlob.includes(norm(en))) esSyn.push(es);
    }
    const blob = base + " " + esSyn.join(" ");
    const toks = tokenize(blob);
    DOCS.push(toks);
    DOC_LEN.push(toks.length);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, c] of tf) {
      if (!POSTINGS.has(t)) POSTINGS.set(t, []);
      POSTINGS.get(t)!.push([DOCS.length - 1, c]);
    }
  }
  const total = DOC_LEN.reduce((s, n) => s + n, 0);
  AVGDL = DOC_LEN.length ? total / DOC_LEN.length : 0;
  // AVGDL global lo calcula cada búsqueda (evita estado mutable global).
}

function expandEsToEn(query: string): string {
  const nq = norm(query);
  const extra: string[] = [];
  for (const [es, en] of Object.entries(GLOS)) {
    if (nq.includes(norm(es))) extra.push(en);
  }
  return extra.join(" ");
}

function bm25(query: string, k = TOP_K): Array<[number, number]> {
  buildIndex();
  const n = DOCS.length;
  if (!n) return [];
  const avgdl = DOC_LEN.reduce((s, x) => s + x, 0) / n;
  const qTokens = tokenize(query + " " + expandEsToEn(query));
  if (!qTokens.length) return [];
  const scores = new Map<number, number>();
  for (const term of qTokens) {
    const plist = POSTINGS.get(term);
    if (!plist) continue;
    const df = plist.length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [docId, tf] of plist) {
      const dl = DOC_LEN[docId] || 1;
      const denom = tf + K1 * (1 - B + (B * dl) / (avgdl || 1));
      scores.set(docId, (scores.get(docId) ?? 0) + (idf * (tf * (K1 + 1))) / denom);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

// ── System prompt (idéntico al original) ──────────────────────
const SYSTEM_PROMPT = `Eres Amy, un asistente virtual del showroom de Kraemer & Kraemer, un bufete de abogados en Panamá. Tu nombre es Amy, NO Atlas.

Tu personalidad es amable, profesional y entusiasta. Representas a una firma legal premium con 18 años de experiencia.

IMPORTANTE: No te presentes ni digas tu nombre a menos que te lo pregunten directamente. El saludo inicial ya ocurrió en la pantalla. Ve directo al grano.

Debes responder SOLO basado en el contexto proporcionado (preguntas y respuestas del knowledge base).
Si la respuesta no está en el contexto, di cortésmente que no tienes esa información y ofrece conectar con un asesor humano.

Reglas:
- Responde en el MISMO IDIOMA de la pregunta (español o inglés).
- Respuestas concisas (máximo 3 párrafos). Si el visitante quiere más detalle, puede preguntar de nuevo.
- Usa un tono conversacional, no corporativo robótico.
- Menciona el nombre de la firma cuando sea natural hacerlo.
- Si no sabes la respuesta exacta: "No tengo esa información en este momento, pero puedo conectarle con un asesor de Kraemer & Kraemer."

DESPEDIDA (MUY IMPORTANTE): Si el visitante se despide o señala que ya terminó ("adiós", "hasta luego", "nos vemos", "chao", "bye", "goodbye", "see you", "that's all", "eso es todo", "gracias, eso es todo", etc.), responde con UNA sola frase corta de despedida en el idioma correspondiente, de forma cálida y profesional, y termina SIEMPRE tu respuesta con el marcador exacto "<<BYE>>" (sin nada después). No hagas preguntas de seguimiento ni ofrezcas más ayuda cuando te despides.
Ejemplo ES: "¡Gracias por visitar Kraemer & Kraemer! Ha sido un gusto ayudarle. <<BYE>>"
Ejemplo EN: "Thank you for visiting Kraemer & Kraemer! It was a pleasure to help. <<BYE>>"

CONTACTO HUMANO: Cuando el visitante pida hablar con una persona, agente, asesor humano, abogado, o contactarse con alguien, responde EXACTAMENTE lo siguiente según el idioma:
- Si la pregunta está en español: "Puede pasar al kiosko de atención, allí se le conectará por videollamada con un asesor de Kraemer & Kraemer que podrá atenderlo personalmente."
- Si la pregunta está en inglés: "You can go to the service kiosk, where you will be connected by video call with a Kraemer & Kraemer advisor who can assist you personally."
Sin agregar nada más ni ofrecer alternativas.`;

interface Msg {
  role: string;
  content: string;
}

function buildPrompt(
  question: string,
  contexts: Array<{ question: string; answer: string }>,
  history: Msg[] = [],
  language = "en",
): Msg[] {
  const contextText = contexts.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n\n");
  const langName = language === "es" ? "ESPAÑOL" : "ENGLISH";
  const langInstr = `IMPORTANTE: Debes responder en ${langName}. La respuesta debe estar completamente en ${
    language === "es" ? "español" : "english"
  }, sin mezclar idiomas.`;
  const byeReminder =
    "RECORDATORIO CRÍTICO: Si el mensaje del visitante es una DESPEDIDA o indica que ya terminó " +
    "(adiós, hasta luego, nos vemos, chao, bye, goodbye, see you, that's all, eso es todo, etc.), " +
    "responde con UNA sola frase corta de despedida y agrega EXACTAMENTE el marcador <<BYE>> al final. " +
    "En cualquier otro caso NO incluyas <<BYE>>.";

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${langInstr}\n\nContexto relevante del knowledge base:\n\n${contextText}\n\n---`,
    },
  ];
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.content });
  }
  messages.push({ role: "user", content: `${byeReminder}\n\nPregunta del visitante: ${question}` });
  return messages;
}

async function queryDeepseek(messages: Msg[]): Promise<string> {
  if (!DEEPSEEK_API_KEY) {
    return "Esta es una respuesta de demostración. Configura DEEPSEEK_API_KEY para respuestas reales basadas en el knowledge base de Kraemer & Kraemer.";
  }
  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
    }),
  });
  if (!resp.ok) {
    throw new Error(`DeepSeek ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Rate limit (in-memory, por instancia tibia) ───────────────
const RATE = new Map<string, number[]>();

function rateOk(ip: string): boolean {
  const now = Date.now();
  const win = (RATE.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (win.length >= RATE_LIMIT_PER_HOUR) {
    RATE.set(ip, win);
    return false;
  }
  win.push(now);
  RATE.set(ip, win);
  return true;
}

// ── HTTP helpers ──────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// ── Handler ───────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  // El path llega como /amy-api/query → normalizamos
  let path = url.pathname.replace(/^\/amy-api/, "").replace(/\/+$/, "");
  if (!path) path = "/";

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();

  if (req.method === "GET" && path === "/health") {
    buildIndex();
    return json({ status: "ok", kb_size: KB.length, retrieval: "bm25", runtime: "deno" });
  }

  if (req.method === "POST" && path === "/query") {
    if (!rateOk(ip)) {
      return json(
        { detail: `Límite de ${RATE_LIMIT_PER_HOUR} consultas por hora alcanzado. Escríbenos directamente.` },
        429,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ detail: "JSON inválido" }, 400);
    }
    const question = String(body.question ?? "").trim().slice(0, 2000);
    const language = body.language === "en" ? "en" : "es";
    const history = Array.isArray(body.history) ? (body.history as Msg[]) : [];
    if (!question) return json({ detail: "question requerida" }, 400);

    try {
      const ranked = bm25(question);
      const contexts = ranked.map(([i]) => ({ question: KB[i].q, answer: KB[i].a }));
      const messages = buildPrompt(question, contexts, history, language);
      const answer = await queryDeepseek(messages);
      return json({
        answer,
        language,
        context_sources: contexts.map((c) => c.question),
      });
    } catch (e) {
      return json({ detail: `Error: ${(e as Error).message}` }, 502);
    }
  }

  if (req.method === "POST" && path === "/tts") {
    if (!ELEVENLABS_KEY) return json({ detail: "ElevenLabs API key not configured" }, 400);
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ detail: "JSON inválido" }, 400);
    }
    const text = String(body.text ?? "").trim().slice(0, 5000);
    const language = body.language === "en" ? "en" : "es";
    if (!text) return json({ detail: "text requerido" }, 400);

    const voiceId = language === "es" ? TTS_VOICE_ES : TTS_VOICE_EN;
    try {
      const resp = await fetch(ELEVENLABS_TTS_URL(voiceId), {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.3, similarity_boost: 0.5 },
        }),
      });
      if (!resp.ok) {
        return json({ detail: `TTS error ${resp.status}: ${(await resp.text()).slice(0, 200)}` }, 502);
      }
      const audio = await resp.arrayBuffer();
      return new Response(audio, {
        status: 200,
        headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    } catch (e) {
      return json({ detail: `TTS error: ${(e as Error).message}` }, 502);
    }
  }

  if (req.method === "POST" && path === "/feedback") {
    // Best-effort: los edge functions son stateless; solo se loguea.
    try {
      const body = await req.json();
      console.log("[amy-feedback]", JSON.stringify({ ...body, ip }));
    } catch {
      /* ignora */
    }
    return json({ ok: true });
  }

  return json({ error: "not found", path }, 404);
});
