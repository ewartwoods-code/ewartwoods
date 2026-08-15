const { cfgGet, cfgSet } = require('./db');

const API = 'https://api.etsy.com/v3';
const KEY = process.env.ETSY_KEYSTRING || '';
const SECRET = process.env.ETSY_SHARED_SECRET || '';

// Etsy Seller App prasa x-api-key forma keystring:shared_secret.
// Tokena atjaunosanai der tikai keystring (client_id).
const apiKey = () => (SECRET ? KEY + ':' + SECRET : KEY);

let access = { token: null, expires: 0, userId: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Refresh token dzivo datubaze un rotejas katra atjaunosana.
// ETSY_REFRESH_TOKEN vides mainigais ir tikai pirmais sejums.
async function currentRefreshToken() {
  const stored = await cfgGet('etsy_refresh_token');
  if (stored) return stored;
  const seed = process.env.ETSY_REFRESH_TOKEN;
  if (!seed) throw new Error('Nav refresh tokena: ieraksti ETSY_REFRESH_TOKEN Railway mainigajos');
  await cfgSet('etsy_refresh_token', seed);
  return seed;
}

async function getAccessToken() {
  if (access.token && Date.now() < access.expires - 60000) return access.token;
  if (!KEY) throw new Error('Nav ETSY_KEYSTRING');
  if (!SECRET) throw new Error('Nav ETSY_SHARED_SECRET: Etsy prasa to x-api-key headeri');

const refresh = await currentRefreshToken();
  const res = await fetch(`${API}/public/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: KEY, refresh_token: refresh })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Tokena atjaunosana neizdevas (${res.status}): ${body.slice(0, 300)}`);

const j = JSON.parse(body);
  access = {
    token: j.access_token,
    expires: Date.now() + (j.expires_in || 3600) * 1000,
    userId: String(j.access_token).split('.')[0]
  };
  if (j.refresh_token && j.refresh_token !== refresh) {
    await cfgSet('etsy_refresh_token', j.refresh_token);
    await cfgSet('etsy_token_updated', new Date().toISOString());
  }
  return access.token;
}

// GET ar atkartojumu uz 429 un 5xx. Etsy limits ir 10 QPS.
async function get(path, params = {}, tries = 0) {
  const token = await getAccessToken();
  const qs = new URLSearchParams(params).toString();
  const url = `${API}/application${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey(), Authorization: `Bearer ${token}` } });

if ((res.status === 429 || res.status >= 500) && tries < 4) {
  await sleep(2000 * (tries + 1));
  return get(path, params, tries + 1);
}
  const body = await res.text();
  if (!res.ok) throw new Error(`Etsy ${res.status} ${path}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function userId() {
  await getAccessToken();
  return access.userId;
}

async function shopId() {
  const cached = await cfgGet('etsy_shop_id');
  if (cached) return cached;
  const fromEnv = process.env.ETSY_SHOP_ID;
  if (fromEnv) {
    await cfgSet('etsy_shop_id', fromEnv);
    return String(fromEnv);
  }
  const uid = await userId();
  const r = await get(`/users/${uid}/shops`);
  const shop = r.shop_id ? r : (r.results && r.results[0]);
  if (!shop) throw new Error('Neatradu veikalu sim kontam');
  await cfgSet('etsy_shop_id', shop.shop_id);
  await cfgSet('etsy_shop_name', shop.shop_name || '');
  return String(shop.shop_id);
}

// Iet cauri visam lapam, kamer beidzas rezultati.
async function all(path, params = {}, limit = 100) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await get(path, { ...params, limit, offset });
    const rows = page.results || [];
    out.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
    if (offset > 20000) break;
    await sleep(150);
  }
  return out;
}

module.exports = { get, all, shopId, userId, getAccessToken, sleep };
