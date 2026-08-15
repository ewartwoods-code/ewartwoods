const db = require('./src/db');
const web = require('./src/web');
const sync = require('./src/sync');

const PORT = process.env.PORT || 3000;
const RUN_HOUR = Number(process.env.RUN_HOUR || 6); // pec Europe/Riga
const TZ = process.env.TZ_NAME || 'Europe/Riga';

function localHour() {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })
      .format(new Date())
  );
}

// Ik pa 10 minutem paskatas, vai sodien jau ir vakts. Ja nav un stunda ir klat - vac.
async function tick() {
  try {
    const today = sync.dayStr();
    const marker = await db.cfgGet('pedeja_palaisana');
    if (marker === today) return;
    if (localHour() < RUN_HOUR) return;
    await db.cfgSet('pedeja_palaisana', today);
    console.log('dienas vaksana sakas', today);
    const out = await sync.runDaily();
    console.log(out.summary);
  } catch (e) {
    console.error('dienas vaksana neizdevas:', e.message);
  }
}

async function main() {
  await db.init();
  web.start(PORT);
  await tick();
  setInterval(tick, 10 * 60 * 1000);
}

main().catch((e) => {
  console.error('starts neizdevas:', e);
  process.exit(1);
});
