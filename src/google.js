const crypto = require('crypto');

// Viens servisa konts visam: Search Console, GA4, Merchant Center, Google Ads (caur GA4).
const RAW = process.env.GOOGLE_SA_JSON || '';
const GSC_SITE = process.env.GSC_SITE || '';
const GA4_PROPERTY = process.env.GA4_PROPERTY_ID || '';
const MC_ACCOUNTS = (process.env.MERCHANT_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);

const S_GSC = 'https://www.googleapis.com/auth/webmasters.readonly';
const S_GA4 = 'https://www.googleapis.com/auth/analytics.readonly';
const S_MC = 'https://www.googleapis.com/auth/content';

function creds() {
  if (!RAW) return null;
  const txt = RAW.trim().startsWith('{') ? RAW : Buffer.from(RAW, 'base64').toString('utf8');
  return JSON.parse(txt);
}

const enabledGsc = () => Boolean(RAW && GSC_SITE);
const enabledGa4 = () => Boolean(RAW && GA4_PROPERTY);
const enabledMc = () => Boolean(RAW && MC_ACCOUNTS.length);
const enabled = () => enabledGsc() || enabledGa4() || enabledMc();

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const num = (v) => Number(v || 0);

const cache = new Map();

async function token(scope) {
  const hit = cache.get(scope);
  if (hit && Date.now() < hit.exp - 60000) return hit.tok;
  const c = creds();
  if (!c) throw new Error('Nav GOOGLE_SA_JSON');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: c.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(head + '.' + claim);
  const sig = signer.sign(c.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig })
  });
  const body = await res.text();
  if (!res.ok) throw new Error('Google tokens (' + res.status + '): ' + body.slice(0, 300));
  const j = JSON.parse(body);
  cache.set(scope, { tok: j.access_token, exp: Date.now() + num(j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function post(url, scope, payload) {
  const t = await token(scope);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  if (!res.ok) throw new Error(res.status + ': ' + body.slice(0, 300));
  return JSON.parse(body || '{}');
}

// Search Console: viena diena, sadalijums pa lapam.
async function gsc(dateIso) {
  if (!enabledGsc()) return [];
  const url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(GSC_SITE) + '/searchAnalytics/query';
  const j = await post(url, S_GSC, { startDate: dateIso, endDate: dateIso, dimensions: ['page'], rowLimit: 25000, type: 'web' });
  return (j.rows || []).map((r) => ({ page: r.keys[0], clicks: Math.round(num(r.clicks)), impressions: Math.round(num(r.impressions)), position: r.position || null }));
}

const GA4_URL = () => 'https://analyticsdata.googleapis.com/v1beta/properties/' + GA4_PROPERTY + ':runReport';

// GA4: viena diena, sesijas pa lapam.
async function ga4(dateIso) {
  if (!enabledGa4()) return [];
  const j = await post(GA4_URL(), S_GA4, {
    dateRanges: [{ startDate: dateIso, endDate: dateIso }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
    limit: 25000
  });
  return (j.rows || []).map((r) => ({ path: r.dimensionValues[0].value, sessions: num(r.metricValues[0].value), views: num(r.metricValues[1].value) }));
}

// Google Ads caur GA4 sasaisti: izmaksas, kliksi, raditijumi pa kampanam.
async function ga4Ads(dateIso) {
  if (!enabledGa4()) return [];
  const j = await post(GA4_URL(), S_GA4, {
    dateRanges: [{ startDate: dateIso, endDate: dateIso }],
    dimensions: [{ name: 'sessionCampaignName' }],
    metrics: [{ name: 'advertiserAdCost' }, { name: 'advertiserAdClicks' }, { name: 'advertiserAdImpressions' }, { name: 'sessions' }],
    limit: 5000
  });
  return (j.rows || [])
  .map((r) => ({
    campaign: r.dimensionValues[0].value,
    cost: num(r.metricValues[0].value),
    clicks: Math.round(num(r.metricValues[1].value)),
    impr: Math.round(num(r.metricValues[2].value)),
    sessions: Math.round(num(r.metricValues[3].value))
  }))
  .filter((r) => r.cost > 0 || r.clicks > 0 || r.impr > 0);
}

// Merchant Center: preces limena kliksi un raditijumi pa katru sub-kontu.
const MC_VER = ['v1beta', 'v1'];

async function mcOne(acc, dateIso) {
  const q = "SELECT offer_id, clicks, impressions, conversions, conversion_value_micros FROM product_performance_view WHERE date BETWEEN '" + dateIso + "' AND '" + dateIso + "'";
  let last = null;
  for (const v of MC_VER) {
    try {
      const j = await post('https://merchantapi.googleapis.com/reports/' + v + '/accounts/' + acc + '/reports:search', S_MC, { query: q, pageSize: 1000 });
      return (j.results || []).map((r) => {
        const p = r.productPerformanceView || {};
        return {
          ext_id: String(p.offerId || ''),
          clicks: Math.round(num(p.clicks)),
          impr: Math.round(num(p.impressions)),
          ord: Math.round(num(p.conversions)),
          rev: Number((num(p.conversionValueMicros) / 1e6).toFixed(2)),
          konts: String(acc)
        };
      }).filter((r) => r.ext_id);
    } catch (e) { last = e; }
  }
  throw last || new Error('Merchant API nav pieejams');
}

async function mc(dateIso) {
  if (!enabledMc()) return [];
  const out = [];
  for (const acc of MC_ACCOUNTS) out.push(...(await mcOne(acc, dateIso)));
  return out;
}

// No pilnas adreses vai celja izvelk Shopify produkta handle.
function handleOf(s) {
  const m = String(s || '').match(/\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

module.exports = { enabled, enabledGsc, enabledGa4, enabledMc, token, gsc, ga4, ga4Ads, mc, handleOf };
