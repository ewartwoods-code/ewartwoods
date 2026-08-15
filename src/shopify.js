const { hash } = require('./store');

const STORE = (process.env.SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_TOKEN || '';
const VERSIONS = [process.env.SHOPIFY_API_VERSION, '2026-07', '2026-04', '2026-01', '2025-10'].filter(Boolean);

let version = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enabled = () => Boolean(STORE && TOKEN);
const numId = (gid) => String(gid || '').split('/').pop();

async function call(query, variables, ver) {
const res = await fetch('https://' + STORE + '/admin/api/' + ver + '/graphql.json', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
body: JSON.stringify({ query, variables })
});
const text = await res.text();
if (!res.ok) throw new Error('Shopify ' + res.status + ': ' + text.slice(0, 300));
const j = JSON.parse(text);
if (j.errors) throw new Error('Shopify GraphQL: ' + JSON.stringify(j.errors).slice(0, 300));
return j.data;
}

// Pirmaja reize atrodam API versiju, kas strada, un turamies pie tas.
async function gql(query, variables = {}) {
if (version) return call(query, variables, version);
let last;
for (const v of VERSIONS) {
try {
const d = await call(query, variables, v);
version = v;
return d;
} catch (e) {
last = e;
}
}
throw last || new Error('Shopify: neviena API versija nedereja');
}

const PRODUCTS = 'query($cursor: String) { products(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } edges { node { id title handle status productType vendor tags descriptionHtml createdAt updatedAt seo { title description } featuredMedia { preview { image { url } } } media(first: 20) { edges { node { id } } } priceRangeV2 { minVariantPrice { amount currencyCode } } variants(first: 100) { edges { node { id sku price inventoryQuantity } } } } } } }';

function shape(n) {
const price = n.priceRangeV2 && n.priceRangeV2.minVariantPrice;
const variants = ((n.variants && n.variants.edges) || []).map((e) => e.node);
const mediaIds = ((n.media && n.media.edges) || []).map((e) => numId(e.node.id)).join(',');
return {
ext_id: numId(n.id),
url: 'https://' + STORE + '/products/' + n.handle,
title: n.title || '',
sku: variants.map((v) => v.sku).filter(Boolean).join(','),
st8: (n.status || '').toLowerCase(),
price: price ? Number(price.amount) : null,
ccy: price ? price.currencyCode : null,
tags: (n.tags || []).join(', '),
img: hash(mediaIds),
desc_h: hash(n.descriptionHtml),
seo_h: hash(((n.seo && n.seo.title) || '') + '|' + ((n.seo && n.seo.description) || '')),
extra: {
handle: n.handle,
productType: n.productType,
vendor: n.vendor,
variants: variants.length,
inventory: variants.reduce((s, v) => s + Number(v.inventoryQuantity || 0), 0),
seoTitle: (n.seo && n.seo.title) || null,
image: n.featuredMedia && n.featuredMedia.preview && n.featuredMedia.preview.image ? n.featuredMedia.preview.image.url : null
},
lastmod: n.updatedAt ? Math.floor(Date.parse(n.updatedAt) / 1000) : 0,
created: n.createdAt ? Math.floor(Date.parse(n.createdAt) / 1000) : 0
};
}

async function products() {
const out = [];
let cursor = null;
for (;;) {
const d = await gql(PRODUCTS, { cursor });
const p = d.products;
for (const e of p.edges) out.push(shape(e.node));
if (!p.pageInfo.hasNextPage) break;
cursor = p.pageInfo.endCursor;
await sleep(300);
}
return out;
}

const ORDERS = 'query($q: String!, $cursor: String) { orders(first: 100, after: $cursor, query: $q) { pageInfo { hasNextPage endCursor } edges { node { id createdAt lineItems(first: 100) { edges { node { quantity product { id } discountedTotalSet { shopMoney { amount currencyCode } } } } } } } } }';

// Dienas pasutijumi pa produktiem.
async function dayOrders(dateIso) {
const q = "created_at:>='" + dateIso + "T00:00:00' AND created_at:<='" + dateIso + "T23:59:59'";
const agg = new Map();
let cursor = null;
let orders = 0;
for (;;) {
const d = await gql(ORDERS, { q, cursor });
const o = d.orders;
for (const e of o.edges) {
orders++;
for (const li of e.node.lineItems.edges) {
const n = li.node;
if (!n.product || !n.product.id) continue;
const id = numId(n.product.id);
const money = n.discountedTotalSet && n.discountedTotalSet.shopMoney;
const cur = agg.get(id) || { ext_id: id, ord: 0, rev: 0, ccy: money ? money.currencyCode : null };
cur.ord += Number(n.quantity || 0);
cur.rev += money ? Number(money.amount) : 0;
agg.set(id, cur);
}
}
if (!o.pageInfo.hasNextPage) break;
cursor = o.pageInfo.endCursor;
await sleep(300);
}
const list = [...agg.values()].map((v) => ({ ...v, rev: Number(v.rev.toFixed(2)) }));
return { orders, list };
}

module.exports = { enabled, products, dayOrders };
