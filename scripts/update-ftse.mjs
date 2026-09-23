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
// IMPORTANT: this always reports the most recently COMPLETED session's close
// — never an in-progress intraday price — regardless of what time of day this
// script happens to run. If it runs while the market is still open (a manual
// trigger, a delayed cron run, etc.), meta.regularMarketPrice would be a live,
// still-changing price for *today*, not a real close, so we explicitly check
// whether today's session has actually ended before trusting it; if it hasn't,
// we step back to the last genuinely finished close instead.
//
// Dates are assembled manually from Intl.DateTimeFormat's individual
// year/month/day parts (formatToParts), NOT from its combined string output
// (e.g. the 'en-CA' locale's YYYY-MM-DD rendering) — combined date-string
// output can behave inconsistently across JS engines/ICU versions, which was
// causing "is this bar today?" comparisons to misfire. Extracting the parts
// individually and joining them ourselves sidesteps that entirely.
//
// This runs server-side (in GitHub Actions), NOT in a browser — so none of
// the CORS or bot-blocking issues that ruled out client-side proxies apply
// here. Requires Node.js 18+ (built-in fetch). No npm packages needed.

const YAHOO_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?range=5d&interval=1d';

// A real browser User-Agent avoids Yahoo's basic bot filtering.
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

async function main() {
  const res = await fetch(YAHOO_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Yahoo Finance request failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;

  if (!meta || !Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length === 0) {
    console.error('Raw response from Yahoo:', JSON.stringify(data, null, 2));
    throw new Error('Unexpected response shape from Yahoo Finance — no usable timestamp/close series.');
  }

  // Diagnostic dump: every bar's index, timestamp, London date, and close —
  // so if the selection below ever looks wrong again, the log shows exactly
  // what data we had to choose from.
  console.log(
    'Daily bars received:',
    timestamps.map((ts, i) => ({
      index: i,
      date: londonDateString(ts * 1000),
      close: closes[i],
    }))
  );

  const nowMs = Date.now();
  const todayStr = londonDateString(nowMs);
  const lastIdx = closes.length - 1;
  const lastBarDateStr = londonDateString(timestamps[lastIdx] * 1000);
  const lastBarIsToday = lastBarDateStr === todayStr;

  const sessionEnd = meta.currentTradingPeriod?.regular?.end;
  const sessionHasEnded = typeof sessionEnd === 'number' ? nowMs / 1000 >= sessionEnd : true;
  const skipLastBar = lastBarIsToday && !sessionHasEnded;

  console.log(
    `today=${todayStr} lastBarDate=${lastBarDateStr} lastBarIsToday=${lastBarIsToday} ` +
      `sessionHasEnded=${sessionHasEnded} skipLastBar=${skipLastBar}`
  );

  let closeIdx = skipLastBar ? lastIdx - 1 : lastIdx;
  // Walk back past any trailing null/undefined entries (a data gap, or a
  // still-forming bar) to make sure we land on a genuine, finalized close.
  while (closeIdx >= 0 && (closes[closeIdx] === null || closes[closeIdx] === undefined)) {
    closeIdx -= 1;
  }
  const prevIdx = closeIdx - 1;

  if (closeIdx < 1 || closes[prevIdx] === null || closes[prevIdx] === undefined) {
    console.error('Raw response from Yahoo:', JSON.stringify(data, null, 2));
    throw new Error('Not enough completed daily closes in the response to compute a change.');
  }

  const close = closes[closeIdx];
  const previousClose = closes[prevIdx];
  const changePct = ((close - previousClose) / previousClose) * 100;
  const tradingDate = londonDateString(timestamps[closeIdx] * 1000);

  const line = `${close.toFixed(2)},${changePct.toFixed(2)},${tradingDate}`;

  const fs = await import('node:fs/promises');
  await fs.writeFile('ftse.txt', line + '\n', 'utf8');

  console.log(`Wrote ftse.txt: ${line}`);
}

main().catch((err) => {
  console.error('Failed to update ftse.txt:', err);
  process.exit(1);
});
