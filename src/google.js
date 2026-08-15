onst crypto = require('crypto');

// Viens servisa konts abiem: Search Console un GA4.
const RAW = process.env.GOOGLE_SA_JSON || '';
const GSC_SITE = process.env.GSC_SITE || '';
const GA4_PROPERTY = process.env.GA4_PROPERTY_ID || '';

function creds() {
if (!RAW) return null;
const txt = RAW.trim().startsWith('{') ? RAW : Buffer.from(RAW, 'base64').toString('utf8');
return JSON.parse(txt);
}

const enabledGsc = () => Boolean(RAW && GSC_SITE);
const enabledGa4 = () => Boolean(RAW && GA4_PROPERTY);
const enabled = () => enabledGsc() || enabledGa4();

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

let cache = { token: null, expires: 0, scope: null };

async function accessToken(scope) {
if (cache.token && cache.scope === scope && Date.now() < cache.expires - 60000) return cache.token;
const c = creds();
if (!c) throw new Error('Nav GOOGLE_SA_JSON');

const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: 'RS256', typ: 'JWT' });
const claim = b64({ iss: c.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
const signer = crypto.createSign('RSA-SHA256');
signer.update(header + '.' + claim);
const sig = signer.sign(c.private_key, 'base64url');

const res = await fetch('https://oauth2.googleapis.com/token', {
method: 'POST',
headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig })
});
const body = await res.text();
if (!res.ok) throw new Error('Google tokens (' + res.status + '): ' + body.slice(0, 300));
const j = JSON.parse(body);
cache = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000, scope };
return cache.token;
}

// Search Console: viena diena, sadalijums pa lapam.
async function gsc(dateIso) {
if (!enabledGsc()) return [];
const token = await accessToken('https://www.googleapis.com/auth/webmasters.readonly');
const url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(GSC_SITE) + '/searchAnalytics/query';
const res = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
body: JSON.stringify({ startDate: dateIso, endDate: dateIso, dimensions: ['page'], rowLimit: 25000, type: 'web' })
});
const body = await res.text();
if (!res.ok) throw new Error('GSC ' + res.status + ': ' + body.slice(0, 300));
return (JSON.parse(body).rows || []).map((r) => ({ page: r.keys[0], clicks: Math.round(r.clicks || 0), impressions: Math.round(r.impressions || 0), position: r.position || null }));
}

// GA4: viena diena, sesijas un skatijumi pa lapam.
async function ga4(dateIso) {
if (!enabledGa4()) return [];
const token = await accessToken('https://www.googleapis.com/auth/analytics.readonly');
const url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + GA4_PROPERTY + ':runReport';
const res = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
body: JSON.stringify({ dateRanges: [{ startDate: dateIso, endDate: dateIso }], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }], limit: 25000 })
});
const body = await res.text();
if (!res.ok) throw new Error('GA4 ' + res.status + ': ' + body.slice(0, 300));
return (JSON.parse(body).rows || []).map((r) => ({ path: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value || 0), views: Number(r.metricValues[1].value || 0) }));
}

// No pilnas adreses vai celja izvelk Shopify produkta handle.
function handleOf(s) {
const m = String(s || '').match(/\/products\/([^/?#]+)/);
return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

module.exports = { enabled, enabledGsc, enabledGa4, gsc, ga4, handleOf };
