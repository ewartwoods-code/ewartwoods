// Meta: Instagram Business + Facebook Page + Meta Ads.
// Vajag tikai META_TOKEN. Parejo (lapa, IG konts, reklamas konts) atrod pats.
const TOKEN = process.env.META_TOKEN || '';
const VERS = [process.env.META_API_VERSION, 'v25.0', 'v24.0', 'v23.0', 'v22.0', 'v21.0'].filter(Boolean);

const enabled = () => Boolean(TOKEN);
const num = (v) => Number(v || 0);

let ver = null;
let ids = null;

async function get(path, params = {}, token) {
  const errs = [];
  for (const v of ver ? [ver] : VERS) {
    const u = new URL('https://graph.facebook.com/' + v + path);
    for (const [k, val] of Object.entries(params)) if (val != null) u.searchParams.set(k, String(val));
    u.searchParams.set('access_token', token || TOKEN);
    const res = await fetch(u);
    const body = await res.text();
    if (res.ok) { ver = v; return JSON.parse(body || '{}'); }
    errs.push(v + ': ' + body.slice(0, 200));
    if (!/unsupported get request|Unsupported|does not exist/i.test(body)) break;
  }
  throw new Error('Meta ' + path + ' | ' + errs.join(' | ').slice(0, 400));
}

// Atrod lapu, tas tokenu, Instagram kontu un reklamas kontu.
async function discover() {
  if (ids) return ids;
  const out = { pageId: null, pageToken: null, igId: null, ad: null };
  const pages = await get('/me/accounts', { fields: 'id,name,access_token,instagram_business_account', limit: 50 });
  const withIg = (pages.data || []).find((p) => p.instagram_business_account) || (pages.data || [])[0];
  if (withIg) {
    out.pageId = withIg.id;
    out.pageToken = withIg.access_token || TOKEN;
    out.igId = withIg.instagram_business_account ? withIg.instagram_business_account.id : null;
  }
  try {
    const acc = await get('/me/adaccounts', { fields: 'id,name,account_status', limit: 50 });
    const live = (acc.data || []).find((a) => a.account_status === 1) || (acc.data || [])[0];
    if (live) out.ad = live.id;
  } catch (e) { }
  ids = out;
  return ids;
}

// Instagram konta dienas skaitli.
async function igAccount(dateIso) {
  const d = await discover();
  if (!d.igId) return null;
  const since = Math.floor(Date.parse(dateIso + 'T00:00:00Z') / 1000);
  const until = since + 86400;
  const sets = ['reach,profile_views,website_clicks,accounts_engaged', 'reach,profile_views,website_clicks', 'reach'];
  for (const metric of sets) {
    try {
      const j = await get('/' + d.igId + '/insights', { metric, period: 'day', since, until }, d.pageToken);
      const o = { ext_id: 'ig:account', src: 'meta' };
      for (const m of j.data || []) {
        const v = num((m.values || [])[0] && (m.values || [])[0].value);
        if (m.name === 'reach') o.pv_d = v;
        if (m.name === 'profile_views') o.pv_tot = v;
        if (m.name === 'website_clicks') o.clicks = v;
        if (m.name === 'accounts_engaged') o.fav = v;
      }
      return o;
    } catch (e) { }
  }
  return null;
}

// Instagram postu dienas skaitli. Nem postus, kas publiceti pedejas 90 dienas.
async function igMedia(dateIso) {
  const d = await discover();
  if (!d.igId) return [];
  const from = Date.parse(dateIso + 'T00:00:00Z') - 90 * 86400000;
  const list = await get('/' + d.igId + '/media', { fields: 'id,timestamp,permalink,caption,media_type,like_count,comments_count', limit: 100 }, d.pageToken);
  const rows = [];
  for (const m of (list.data || [])) {
    if (Date.parse(m.timestamp) < from) continue;
    let reach = null, saved = null, shares = null;
    try {
      const ins = await get('/' + m.id + '/insights', { metric: 'reach,saved,shares' }, d.pageToken);
      for (const x of ins.data || []) {
        const v = num((x.values || [])[0] && (x.values || [])[0].value);
        if (x.name === 'reach') reach = v;
        if (x.name === 'saved') saved = v;
        if (x.name === 'shares') shares = v;
      }
    } catch (e) { }
    rows.push({
      ext_id: 'ig:' + m.id,
      url: m.permalink || null,
      title: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 120),
      st8: m.media_type || null,
      created: Math.floor(Date.parse(m.timestamp) / 1000),
      pv_d: reach,
      fav: num(m.like_count) + num(saved) + num(shares),
      impr: reach
    });
  }
  return rows;
}

// Facebook lapas dienas sasniegums.
async function fbPage(dateIso) {
  const d = await discover();
  if (!d.pageId) return null;
  const since = Math.floor(Date.parse(dateIso + 'T00:00:00Z') / 1000);
  const until = since + 86400;
  try {
    const j = await get('/' + d.pageId + '/insights', { metric: 'page_impressions_unique,page_post_engagements', period: 'day', since, until }, d.pageToken);
    const o = { ext_id: 'fb:page', src: 'meta' };
    for (const m of j.data || []) {
      const v = num((m.values || [])[0] && (m.values || [])[0].value);
      if (m.name === 'page_impressions_unique') o.pv_d = v;
      if (m.name === 'page_post_engagements') o.fav = v;
    }
    return o;
  } catch (e) { return null; }
}

// Meta reklamas pa kampanam vienai dienai.
async function ads(dateIso) {
  const d = await discover();
  if (!d.ad) return [];
  const j = await get('/' + d.ad + '/insights', {
    level: 'campaign',
    time_range: JSON.stringify({ since: dateIso, until: dateIso }),
    fields: 'campaign_name,spend,impressions,clicks,actions,action_values',
    limit: 200
  });
  return (j.data || []).map((r) => {
    const act = (r.actions || []).find((a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase');
    const val = (r.action_values || []).find((a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase');
    return {
      ext_id: r.campaign_name || 'kampana',
      spend: num(r.spend),
      impr: Math.round(num(r.impressions)),
      clicks: Math.round(num(r.clicks)),
      pv_d: Math.round(num(r.clicks)),
      ord: act ? Math.round(num(act.value)) : null,
      rev: val ? Number(num(val.value).toFixed(2)) : null,
      src: 'metaads'
    };
  });
}

// Viena dienas vaksana. Sauc no sync.js, pats saglaba caur store.
async function run(dateIso, store) {
  const media = await igMedia(dateIso).catch(() => []);
  let items = 0, changes = 0;
  if (media.length) {
    const a = await store.saveItems('instagram', dateIso, media);
    items = a.items;
    changes = a.changes;
    await store.saveMetrics('instagram', dateIso, media.map((m) => ({ ext_id: m.ext_id, pv_d: m.pv_d, fav: m.fav, impr: m.impr, src: 'meta' })));
  }
  const konts = [];
  const ig = await igAccount(dateIso).catch(() => null);
  if (ig) konts.push(ig);
  const fb = await fbPage(dateIso).catch(() => null);
  if (fb) konts.push(fb);
  if (konts.length) await store.saveMetrics('meta', dateIso, konts);
  const cmp = await ads(dateIso).catch(() => []);
  if (cmp.length) await store.saveMetrics('metaads', dateIso, cmp);
  return { platform: 'meta', items, changes, orders: cmp.reduce((s, v) => s + (v.ord || 0), 0), revenue: Number(cmp.reduce((s, v) => s + (v.rev || 0), 0).toFixed(2)), konts: konts.length, kampanas: cmp.length };
}

module.exports = { enabled, discover, igAccount, igMedia, fbPage, ads, run };
