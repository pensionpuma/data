// Fetches the FTSE 100 (^FTSE) closing level and day change from Yahoo
// Finance's free, keyless chart endpoint, then writes a single line to
// ftse.txt in the format the PensionPuma site expects:
//
//   close,changePct
//
// e.g.  9283.99,0.65          (up day)
//       9210.14,-0.72         (down day)
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
    typeof meta.previousClose !== 'number'
  ) {
    throw new Error(
      'Unexpected response shape from Yahoo Finance — no usable meta.regularMarketPrice/previousClose.'
    );
  }

  const close = meta.regularMarketPrice;
  const changePct =
    ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100;

  const line = `${close.toFixed(2)},${changePct.toFixed(2)}`;

  const fs = await import('node:fs/promises');
  await fs.writeFile('ftse.txt', line + '\n', 'utf8');

  console.log(`Wrote ftse.txt: ${line}`);
}

main().catch((err) => {
  console.error('Failed to update ftse.txt:', err);
  process.exit(1);
});
