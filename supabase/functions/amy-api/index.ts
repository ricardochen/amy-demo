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
const MAX_TOKENS = 120;
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
const SYSTEM_PROMPT = `You are Amy, a virtual assistant for the Kraemer & Kraemer showroom, a law firm in Panama. Your name is Amy, NOT Atlas.

You are always English-first. This deployment is an English-only demo: answer in English even if the visitor writes in another language. Only if the visitor writes in Spanish, add one short sentence noting a Spanish-speaking advisor is available.

Your personality is warm, professional and enthusiastic. You represent a premium legal firm with 18 years of experience.

IMPORTANT: Do not introduce yourself or state your name unless asked directly. The opening greeting already happened on screen. Get to the point.

You must answer ONLY based on the context provided (question and answer pairs from the knowledge base).
If the answer is not in the context, politely say you do not have that information and offer to connect the visitor with a human advisor.

Rules (STYLE — these override everything else):
- ALWAYS respond in English.
- BE SHORT. Aim for 1-2 sentences, 30 words max. This is a voice kiosk: a long answer means the visitor stands there listening instead of talking. Never exceed 45 words.
- Give ONE key fact, then ask ONE short question to narrow it down. Never dump the whole knowledge base entry.
- Ask a follow-up question in almost every reply (e.g. "Are you thinking of starting a company, or buying property?", "Is this for you or for a business?"). One question only — never a list of options.
- No preamble, no restating the question, no "Great question!", no "Happy to help with that". Start with the substance.
- Do NOT volunteer extra details (fees, timelines, document names, legal citations) unless asked. They come out one question at a time, as the visitor drills in.
- Use a conversational tone, not robotic corporate speak. Plain spoken English.
- Never mention that you are reading from a knowledge base, documents, forms, context or sources.
- Do NOT mention Spanish-speaking advisors unless the visitor writes in Spanish.
- If you do not know the exact answer: "I don't have that detail on hand, but I can connect you with a Kraemer & Kraemer advisor."

FAREWELL (VERY IMPORTANT): If the visitor says goodbye or signals they are done ("bye", "goodbye", "see you", "that's all", "thanks, that's it", "adiós", "hasta luego", etc.), respond with ONE short, warm, professional farewell sentence and ALWAYS end your answer with the exact marker "<<BYE>>" (nothing after it). Do not ask follow-up questions or offer further help when saying goodbye.
Example: "Thank you for visiting Kraemer & Kraemer! It was a pleasure to help. <<BYE>>"

HUMAN CONTACT: When the visitor asks to speak with a person, agent, human advisor or lawyer, respond EXACTLY:
"You can go to the service kiosk, where you will be connected by video call with a Kraemer & Kraemer advisor who can assist you personally."
Add nothing else and do not offer alternatives.`;

interface Msg {
  role: string;
  content: string;
}

function buildPrompt(
  question: string,
  contexts: Array<{ question: string; answer: string }>,
  history: Msg[] = [],
  _language = "en",
): Msg[] {
  // English-only deployment: the language argument is accepted for backward
  // compatibility but the response is always forced to English.
  const contextText = contexts.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n\n");
  const langInstr =
    "IMPORTANT: Respond in ENGLISH. The entire answer must be in English, regardless of the language the visitor used.";
  const byeReminder =
    "CRITICAL REMINDER: If the visitor's message is a FAREWELL or signals they are done " +
    "(bye, goodbye, see you, that's all, thanks that's it, etc.), respond with ONE short farewell " +
    "sentence and append EXACTLY the marker <<BYE>> at the end. Otherwise do NOT include <<BYE>>.";

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${langInstr}\n\nRelevant knowledge base context:\n\n${contextText}\n\n---`,
    },
  ];
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.content });
  }
  messages.push({ role: "user", content: `${byeReminder}\n\nVisitor question: ${question}` });
  return messages;
}

async function queryDeepseek(messages: Msg[]): Promise<string> {
  if (!DEEPSEEK_API_KEY) {
    return "This is a demo response. Set DEEPSEEK_API_KEY for real answers based on the Kraemer & Kraemer knowledge base.";
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
        { detail: `Rate limit reached: ${RATE_LIMIT_PER_HOUR} queries per hour. Please contact us directly.` },
        429,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ detail: "Invalid JSON" }, 400);
    }
    const question = String(body.question ?? "").trim().slice(0, 2000);
    const language = "en";
    const history = Array.isArray(body.history) ? (body.history as Msg[]) : [];
    if (!question) return json({ detail: "question is required" }, 400);

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
      return json({ detail: "Invalid JSON" }, 400);
    }
    const text = String(body.text ?? "").trim().slice(0, 5000);
    const language = "en";
    if (!text) return json({ detail: "text is required" }, 400);

    const voiceId = TTS_VOICE_EN;
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
