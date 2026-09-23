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
// This always reports the most recently COMPLETED session's close — today's
// bar (if present) is always excluded, since while the market is open it's
// only a live, still-changing price, never a real close.
//
// Yahoo's chart data has occasionally been observed to return `close: null`
// for the most recent completed day (a backend data gap, not a holiday —
// seen even many hours after that session actually closed). To work around
// this, a short "5d" request is tried first; if the freshest completed day
// in that response is null, a wider "1mo" request is tried as well, and
// whichever attempt yields the more recent valid close wins. If a gap is
// still unresolved after both, it falls back to the most recent valid close
// available and logs a warning — this should be rare.
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

async function fetchDailyBars(range) {
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

  // Build date -> close, excluding today entirely (never a real close while
  // the market's open) and excluding null/undefined entries (data gaps).
  const todayStr = londonDateString(Date.now());
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const dateStr = londonDateString(timestamps[i] * 1000);
    const close = closes[i];
    if (dateStr === todayStr) continue;
    if (close === null || close === undefined) continue;
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

async function main() {
  console.log('Attempt 1: range=5d');
  const shortRangeBars = await fetchDailyBars('5d');
  console.log('5d bars (today + null closes excluded):', Object.fromEntries(shortRangeBars));
  let picked = pickTargetAndPrevious(shortRangeBars);

  // If we didn't get a usable pair from the short range (or want to double
  // check we're not missing a fresher value due to a data gap), also try a
  // wider range and prefer whichever gives the more recent target date.
  console.log('Attempt 2: range=1mo (checked for a fresher/more complete value)');
  let widerBars;
  try {
    widerBars = await fetchDailyBars('1mo');
    console.log('1mo bars, most recent 5 (today + null closes excluded):',
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
