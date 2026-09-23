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

async function main() {
  const res = await fetch(YAHOO_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Yahoo Finance request failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;

  if (
    !meta ||
    typeof meta.regularMarketPrice !== 'number' ||
    typeof meta.regularMarketChangePercent !== 'number' ||
    typeof meta.regularMarketTime !== 'number'
  ) {
    // Log the raw response so the Actions log shows exactly what Yahoo sent
    // back — this is what we need to see to diagnose an unexpected shape.
    console.error('Raw response from Yahoo:', JSON.stringify(data, null, 2));
    throw new Error(
      'Unexpected response shape from Yahoo Finance — no usable meta.regularMarketPrice/regularMarketChangePercent/regularMarketTime.'
    );
  }

  const close = meta.regularMarketPrice;
  const changePct = meta.regularMarketChangePercent;

  // regularMarketTime is a Unix timestamp (seconds) for the most recent
  // session's close. Convert it to an Europe/London calendar date (handles
  // the GMT/BST switch automatically) so the site can compare it against
  // "today" in the same timezone the market actually trades in.
  const tradingDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(meta.regularMarketTime * 1000));

  const line = `${close.toFixed(2)},${changePct.toFixed(2)},${tradingDate}`;

  const fs = await import('node:fs/promises');
  await fs.writeFile('ftse.txt', line + '\n', 'utf8');

  console.log(`Wrote ftse.txt: ${line}`);
}

main().catch((err) => {
  console.error('Failed to update ftse.txt:', err);
  process.exit(1);
});
