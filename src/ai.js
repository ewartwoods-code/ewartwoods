// OpenRouter klients. Atslega un modelis nak no Railway videi mainigajiem:
//   OPENROUTER_API_KEY  - obligats
//   OPENROUTER_MODEL    - noklusejums, ja izsaukuma nav pateikts citads
//   OPENROUTER_BASE_URL - parasti https://openrouter.ai/api/v1
const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
const TIMEOUT = Number(process.env.OPENROUTER_TIMEOUT_MS || 60000);
const REFERER = process.env.OPENROUTER_REFERER || 'https://ewartwoods-production.up.railway.app';
const TITLE = process.env.OPENROUTER_TITLE || 'EWART WOODS dati';

const enabled = () => Boolean(KEY);

function headers() {
  return {
    Authorization: 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    // OpenRouter tos izmanto statistikai savas lapas rangos; nav obligati.
    'HTTP-Referer': REFERER,
    'X-Title': TITLE,
  };
}

// Iekseja palidzfunkcija: viens pieprasijums ar taimautu un cilveciskam kludam.
async function call(path, init) {
  if (!enabled()) throw new Error('nav OPENROUTER_API_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  let r;
  try {
    r = await fetch(BASE + path, { ...init, headers: headers(), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    throw new Error(e.name === 'AbortError' ? 'OpenRouter taimauts (' + TIMEOUT + 'ms)' : 'OpenRouter nesasniedzams: ' + e.message);
  }
  clearTimeout(t);
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    // atstajam null, zemak atdodam jelo tekstu
  }
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || text.slice(0, 300) || String(r.status);
    throw new Error('OpenRouter ' + r.status + ': ' + msg);
  }
  return data;
}

// Galvenais izsaukums. Atdod {teksts, modelis, lietojums}.
// messages var but virkne (tad tas ir user zinojums) vai gatavs masivs.
async function chat(messages, opts = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
  const body = {
    model: opts.model || MODEL,
    messages: opts.system ? [{ role: 'system', content: opts.system }, ...msgs] : msgs,
  };
  if (opts.maxTokens != null) body.max_tokens = Number(opts.maxTokens);
  if (opts.temperature != null) body.temperature = Number(opts.temperature);
  if (opts.json) body.response_format = { type: 'json_object' };

  const data = await call('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const choice = (data && data.choices && data.choices[0]) || {};
  return {
    teksts: (choice.message && choice.message.content) || '',
    modelis: (data && data.model) || body.model,
    lietojums: (data && data.usage) || null,
  };
}

// Ta pati chat, bet gaida JSON atpakal un to izparse.
async function chatJson(messages, opts = {}) {
  const out = await chat(messages, { ...opts, json: true });
  try {
    return { ...out, dati: JSON.parse(out.teksts) };
  } catch (e) {
    throw new Error('OpenRouter atdeva nederīgu JSON: ' + out.teksts.slice(0, 200));
  }
}

// Parbauda, vai atslega ir deriga un cik kredita pari. Nemaksa nekas.
async function status() {
  if (!enabled()) return { ok: false, kluda: 'nav OPENROUTER_API_KEY' };
  try {
    const d = await call('/key', { method: 'GET' });
    const k = (d && d.data) || {};
    return {
      ok: true,
      modelis: MODEL,
      limits: k.limit == null ? 'bez limita' : k.limit,
      izlietots: k.usage == null ? null : k.usage,
      bezmaksas_konts: Boolean(k.is_free_tier),
    };
  } catch (e) {
    return { ok: false, modelis: MODEL, kluda: e.message };
  }
}

module.exports = { chat, chatJson, status, enabled, MODEL };
