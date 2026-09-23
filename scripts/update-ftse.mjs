// Fetches the FTSE 100 (^FTSE) closing level and day change from Yahoo
// Finance's free, keyless chart endpoint, then writes a single line to
// ftse.txt in the format the PensionPuma site expects:
//
//   close,changePct,tradingDate
//
// e.g.  9283.99,0.65,2026-09-22          (up day)
//       9210.14,-0.72,2026-09-19         (down day)
//
// tradingDate is the ISO date (YYYY-MM-DD) of the session that close/changePct
// belong to, expressed as an Europe/London calendar date. The site uses it to
// decide whether to say "today", "yesterday", or a weekday name (e.g. after a
// weekend or a bank holiday with no new session in between).
//
// This always reports the most recently COMPLETED session's close.
//
// IMPORTANT: "today's" bar is only excluded while the market is still open
// (checked against meta.currentTradingPeriod.regular.end) — NOT unconditionally.
// An earlier version of this script always dropped whatever bar was dated
// "today", which is wrong: this script runs on a schedule that fires on the
// same calendar day it's reporting on (18:00 UTC, safely after the 16:30 UK
// close), so "today" IS the day whose close we actually want to report once
// the session has ended. Unconditionally excluding it meant the scheduled run
// could never report its own day's close and was always at least one day
// stale, even with no data gaps at all.
//
// Yahoo's chart data has also occasionally been observed to return
// `close: null` for a specific completed day (a backend data gap, not a
// holiday). To work around that separately, a short "5d" request is tried
// first; if the freshest completed day in that response is null, a wider
// "1mo" request is also tried, and whichever attempt yields the more recent
// valid close wins.
//
// Dates are assembled manually from Intl.DateTimeFormat's individual
// year/month/day parts (formatToParts), not from its combined string output,
// since combined-string formatting can behave inconsistently across
// JS engines/ICU versions.
//
// This runs server-side (in GitHub Actions), NOT in a browser — so none of
// the CORS or bot-blocking issues that ruled out client-side proxies apply
// here. Requires Node.js 18+ (built-in fetch). No npm packages needed.

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

const LONDON_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Returns an Europe/London calendar date as "YYYY-MM-DD", built from
// individually-extracted parts rather than trusting a locale's combined
// string output.
function londonDateString(msTimestamp) {
  const parts = LONDON_PARTS_FORMATTER.formatToParts(new Date(msTimestamp));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function fetchDailyBars(range, { excludeToday }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Yahoo Finance request failed (range=${range}): HTTP ${res.status}`);
  }
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length === 0) {
    console.error(`Raw response from Yahoo (range=${range}):`, JSON.stringify(data, null, 2));
    throw new Error(`Unexpected response shape from Yahoo Finance (range=${range}).`);
  }

  const todayStr = londonDateString(Date.now());
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const dateStr = londonDateString(timestamps[i] * 1000);
    const close = closes[i];
    if (excludeToday && dateStr === todayStr) continue; // still-forming live price, not a real close
    if (close === null || close === undefined) continue; // data gap
    byDate.set(dateStr, close);
  }
  return byDate;
}

function pickTargetAndPrevious(byDate) {
  const dates = Array.from(byDate.keys()).sort(); // ISO strings sort chronologically
  if (dates.length < 2) return null;
  const targetDate = dates[dates.length - 1];
  const prevDate = dates[dates.length - 2];
  return {
    targetDate,
    targetClose: byDate.get(targetDate),
    prevClose: byDate.get(prevDate),
  };
}

async function getMarketMeta() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?range=1d&interval=1d';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance meta request failed: HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) {
    console.error('Raw response from Yahoo (meta check):', JSON.stringify(data, null, 2));
    throw new Error('Unexpected response shape from Yahoo Finance (meta check).');
  }
  return meta;
}

async function main() {
  const meta = await getMarketMeta();
  const sessionEnd = meta.currentTradingPeriod?.regular?.end;
  const sessionHasEnded = typeof sessionEnd === 'number' ? Date.now() / 1000 >= sessionEnd : true;
  // Only treat "today" as off-limits while the market is still open — once
  // the session has ended, today's own close is exactly what we want.
  const excludeToday = !sessionHasEnded;
  console.log(`sessionHasEnded=${sessionHasEnded} (excludeToday=${excludeToday})`);

  console.log('Attempt 1: range=5d');
  const shortRangeBars = await fetchDailyBars('5d', { excludeToday });
  console.log('5d bars (null closes excluded):', Object.fromEntries(shortRangeBars));
  let picked = pickTargetAndPrevious(shortRangeBars);

  console.log('Attempt 2: range=1mo (checked for a fresher/more complete value)');
  let widerBars;
  try {
    widerBars = await fetchDailyBars('1mo', { excludeToday });
    console.log('1mo bars, most recent 5 (null closes excluded):',
      Object.fromEntries(Array.from(widerBars).slice(-5)));
  } catch (err) {
    console.warn('Wider-range (1mo) fetch failed, continuing with 5d result only:', err);
    widerBars = null;
  }

  if (widerBars) {
    const widerPicked = pickTargetAndPrevious(widerBars);
    if (widerPicked && (!picked || widerPicked.targetDate > picked.targetDate)) {
      picked = widerPicked;
    }
  }

  if (!picked) {
    throw new Error('Could not find two consecutive completed daily closes from either range attempt.');
  }

  const { targetDate, targetClose, prevClose } = picked;
  const changePct = ((targetClose - prevClose) / prevClose) * 100;
  const line = `${targetClose.toFixed(2)},${changePct.toFixed(2)},${targetDate}`;

  console.log(`Selected: ${line}`);

  const fs = await import('node:fs/promises');
  await fs.writeFile('ftse.txt', line + '\n', 'utf8');

  console.log(`Wrote ftse.txt: ${line}`);
}

main().catch((err) => {
  console.error('Failed to update ftse.txt:', err);
  process.exit(1);
});
