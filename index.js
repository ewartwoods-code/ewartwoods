const crypto = require('crypto');
const db = require('./src/db');
const web = require('./src/web');
const sync = require('./src/sync');
const analyze = require('./src/analyze');

const PORT = process.env.PORT || 3000;
const RUN_HOUR = Number(process.env.RUN_HOUR || 6); // pec Europe/Riga
const TZ = process.env.TZ_NAME || 'Europe/Riga';

function localHour() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
}

// Servisa tokens tikai /ingest galapunktam. Pats sevi izveido un ieraksta zurnala,
// lai datus varetu iestumt no arpuses, neatdodot ADMIN_TOKEN.
async function ensureIngestToken() {
  let t = await db.cfgGet('ingest_token');
  if (!t) {
    t = crypto.randomBytes(24).toString('base64url');
    await db.cfgSet('ingest_token', t);
  }
  console.log('ingest_token:', t);
  return t;
}

// Ik pa 10 minutem paskatas, vai vakardienas dati jau ir savakti.
// Atzime ir pati pedeja veiksmigi savakta diena, tapec neveiksme pati atkartojas.
async function tick() {
  try {
    const target = sync.dayStr(new Date(), -1);
    if ((await db.cfgGet('pedeja_diena')) === target) return;
    if (localHour() < RUN_HOUR) return;
    console.log('dienas vaksana sakas', target);
    const out = await sync.runDaily(target);
    const a = await analyze.runAnalysis(sync.dayStr());
    console.log(out.summary, '| analize:', JSON.stringify(a));
  } catch (e) {
    console.error('dienas vaksana neizdevas:', e.message);
  }
}

async function main() {
  await db.init();
  await ensureIngestToken();
  web.start(PORT);
  try {
    const a = await analyze.runAnalysis(sync.dayStr());
    console.log('analize pie starta:', JSON.stringify(a));
  } catch (e) {
    console.error('analize neizdevas:', e.message);
  }
  await tick();
  setInterval(tick, 10 * 60 * 1000);
}

main().catch((e) => {
  console.error('starts neizdevas:', e);
  process.exit(1);
});
