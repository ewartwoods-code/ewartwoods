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

// Ik pa 10 minutem paskatas, vai sodien jau ir vakts. Ja nav un stunda ir klat - vac.
// Atzimi liek tikai pec veiksmigas vaksanas, lai neveiksme meginatu velreiz.
async function tick() {
  try {
    const today = sync.dayStr();
    if ((await db.cfgGet('pedeja_palaisana')) === today) return;
    if (localHour() < RUN_HOUR) return;
    console.log('dienas vaksana sakas', today);
    const out = await sync.runDaily();
    const a = await analyze.runAnalysis(today);
    await db.cfgSet('pedeja_palaisana', today);
    console.log(out.summary, '| analize:', JSON.stringify(a));
  } catch (e) {
    console.error('dienas vaksana neizdevas:', e.message);
  }
}

async function main() {
  await db.init();
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
