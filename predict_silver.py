#!/usr/bin/env python3
"""
predict_silver.py

Generates a heuristic, rules-based directional estimate for silver's
intraday move during London market hours (08:00-16:30 UK), using:
  - 20-EMA (H1)
  - Rolling VWAP (intraday)
  - ATR(14) for volatility scaling
  - RSI(14) + simple divergence check
  - DXY 24h change (inverse correlation)
  - Gold/Silver ratio extremity

IMPORTANT: This is a heuristic scoring model, not a statistically
validated forecasting system. No combination of these indicators has
a proven, repeatable edge at predicting intraday percentage moves.
Treat the output as a structured opinion, not a guarantee. Do not use
this as the sole basis for a trading decision.

Data source: Twelve Data API (https://twelvedata.com), free tier.
Requires env var TWELVEDATA_API_KEY.

Output line format:
  <UK date/time>: Silver will likely (GAP-UP|GAP-DOWN|NOT GAP) initially
  and then (RISE|FALL) by (XX.XX%)

The line is appended to silver.txt and the file is committed/pushed
to the configured GitHub repo (see the accompanying GitHub Actions
workflow, which supplies GITHUB_TOKEN and repo checkout).
"""

import os
import sys
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

TD_API_KEY = os.environ.get("TWELVEDATA_API_KEY")
TD_BASE = "https://api.twelvedata.com"

UK_TZ = ZoneInfo("Europe/London")

SILVER_SYMBOL = "XAG/USD"
GOLD_SYMBOL = "XAU/USD"
DXY_SYMBOL = "DXY"  # Twelve Data index symbol for US Dollar Index

REPO_FILE = "silver.txt"


def td_get(endpoint: str, params: dict) -> dict:
    params = {**params, "apikey": TD_API_KEY}
    resp = requests.get(f"{TD_BASE}/{endpoint}", params=params, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and data.get("status") == "error":
        raise RuntimeError(f"Twelve Data error on {endpoint}: {data}")
    return data


def fetch_series(symbol: str, interval: str = "1h", outputsize: int = 60):
    """Returns list of dicts oldest->newest with open/high/low/close/volume floats."""
    data = td_get("time_series", {
        "symbol": symbol,
        "interval": interval,
        "outputsize": outputsize,
        "timezone": "UTC",
    })
    values = data.get("values", [])
    if not values:
        raise RuntimeError(f"No time series data for {symbol}")
    values = list(reversed(values))  # API returns newest first
    out = []
    for v in values:
        out.append({
            "datetime": v["datetime"],
            "open": float(v["open"]),
            "high": float(v["high"]),
            "low": float(v["low"]),
            "close": float(v["close"]),
            "volume": float(v.get("volume") or 0),
        })
    return out


def ema(values, period):
    k = 2 / (period + 1)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1 - k)
    return e


def atr(bars, period=14):
    trs = []
    for i in range(1, len(bars)):
        h, l, prev_c = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
        trs.append(tr)
    recent = trs[-period:] if len(trs) >= period else trs
    return sum(recent) / len(recent) if recent else 0.0


def rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def rolling_vwap(bars):
    """Volume-weighted average price over the fetched window."""
    num = sum(((b["high"] + b["low"] + b["close"]) / 3) * b["volume"] for b in bars)
    den = sum(b["volume"] for b in bars)
    if den == 0:
        return sum(b["close"] for b in bars) / len(bars)
    return num / den


def rsi_series(closes, period=14):
    out = []
    for i in range(period + 1, len(closes) + 1):
        out.append(rsi(closes[:i], period))
    return out


def check_bullish_divergence(bars):
    """Very simple check: price makes a lower low over the last N bars
    while RSI makes a higher low. Returns True/False."""
    closes = [b["close"] for b in bars]
    if len(closes) < 30:
        return False
    window = closes[-20:]
    r = rsi_series(closes, 14)[-20:]
    if len(r) < 20:
        return False
    price_low_idx = window.index(min(window))
    rsi_low_idx = r.index(min(r))
    # crude divergence signal: price's lowest point is later than RSI's
    # lowest point, and price is lower than its own earlier low while
    # RSI at that later point is not correspondingly lower
    if price_low_idx > rsi_low_idx and window[price_low_idx] <= min(window[:price_low_idx] or [window[price_low_idx]]):
        return True
    return False


def score_signals(silver_bars, gold_last, dxy_bars):
    closes = [b["close"] for b in silver_bars]
    last_close = closes[-1]

    ema20 = ema(closes[-30:], 20)
    vwap = rolling_vwap(silver_bars[-24:])  # ~last 24h on H1 bars
    atr14 = atr(silver_bars, 14)
    atr_pct = (atr14 / last_close) * 100 if last_close else 0.0
    rsi14 = rsi(closes, 14)
    bull_div = check_bullish_divergence(silver_bars)

    dxy_closes = [b["close"] for b in dxy_bars]
    dxy_change_pct = ((dxy_closes[-1] - dxy_closes[0]) / dxy_closes[0]) * 100 if dxy_closes else 0.0

    gs_ratio = gold_last / last_close if last_close else None

    score = 0.0
    reasons = []

    # 1. EMA trend
    if last_close > ema20:
        score += 0.25
        reasons.append("price above 20-EMA (bullish trend)")
    else:
        score -= 0.25
        reasons.append("price below 20-EMA (bearish trend)")

    # 2. VWAP position
    if last_close > vwap:
        score += 0.15
        reasons.append("trading above VWAP")
    else:
        score -= 0.15
        reasons.append("trading below VWAP")

    # 3. RSI level + divergence
    if bull_div:
        score += 0.2
        reasons.append("bullish RSI divergence detected")
    elif rsi14 < 30:
        score += 0.1
        reasons.append("RSI oversold")
    elif rsi14 > 70:
        score -= 0.1
        reasons.append("RSI overbought")

    # 4. DXY inverse correlation
    if dxy_change_pct > 0.15:
        score -= 0.25
        reasons.append(f"DXY up {dxy_change_pct:.2f}% (headwind)")
    elif dxy_change_pct < -0.15:
        score += 0.25
        reasons.append(f"DXY down {dxy_change_pct:.2f}% (tailwind)")

    # 5. Gold/Silver ratio extremity amplifies whatever direction score already has
    amplify = 1.0
    if gs_ratio and gs_ratio > 80:
        amplify = 1.3
        reasons.append(f"gold/silver ratio stretched at {gs_ratio:.1f} (amplifying momentum)")

    score *= amplify
    score = max(-1.0, min(1.0, score))

    # Magnitude: scale ATR% by conviction score, dampened so output stays plausible
    magnitude_pct = abs(score) * atr_pct * 0.6
    magnitude_pct = max(0.05, min(magnitude_pct, atr_pct * 1.5))

    direction = "RISE" if score >= 0 else "FALL"

    return {
        "direction": direction,
        "magnitude_pct": magnitude_pct,
        "score": score,
        "atr_pct": atr_pct,
        "rsi": rsi14,
        "ema20": ema20,
        "vwap": vwap,
        "dxy_change_pct": dxy_change_pct,
        "gs_ratio": gs_ratio,
        "reasons": reasons,
    }


def detect_gap(silver_bars):
    """Compare latest available price to the bar ~24h (last London session
    close) prior. Threshold of 0.15% to call a gap."""
    closes = [b["close"] for b in silver_bars]
    if len(closes) < 25:
        return "NOT GAP"
    prior = closes[-25]
    latest = closes[-1]
    change_pct = ((latest - prior) / prior) * 100
    if change_pct > 0.15:
        return "GAP-UP"
    elif change_pct < -0.15:
        return "GAP-DOWN"
    return "NOT GAP"


def build_output_line():
    if not TD_API_KEY:
        raise RuntimeError("TWELVEDATA_API_KEY not set")

    silver_bars = fetch_series(SILVER_SYMBOL, interval="1h", outputsize=60)
    dxy_bars = fetch_series(DXY_SYMBOL, interval="1h", outputsize=30)
    gold_quote = td_get("price", {"symbol": GOLD_SYMBOL})
    gold_last = float(gold_quote["price"])

    result = score_signals(silver_bars, gold_last, dxy_bars)
    gap = detect_gap(silver_bars)

    now_uk = datetime.now(UK_TZ)
    timestamp = now_uk.strftime("%Y-%m-%d %H:%M")

    line = (
        f"{timestamp}: Silver will likely {gap} initially and then "
        f"{result['direction']} by {result['magnitude_pct']:.2f}%"
    )
    return line, result


def append_and_push(line: str):
    with open(REPO_FILE, "a") as f:
        f.write(line + "\n")

    subprocess.run(["git", "config", "user.name", "silver-predictor-bot"], check=True)
    subprocess.run(["git", "config", "user.email", "actions@users.noreply.github.com"], check=True)
    subprocess.run(["git", "add", REPO_FILE], check=True)

    diff = subprocess.run(["git", "diff", "--cached", "--quiet"])
    if diff.returncode == 0:
        print("No changes to commit.")
        return

    subprocess.run(["git", "commit", "-m", f"Add silver prediction: {line}"], check=True)
    subprocess.run(["git", "push"], check=True)


def main():
    try:
        line, result = build_output_line()
    except Exception as e:
        print(f"ERROR generating prediction: {e}", file=sys.stderr)
        sys.exit(1)

    print(line)
    print("Signal breakdown:", ", ".join(result["reasons"]))
    print(
        f"ATR%: {result['atr_pct']:.2f} | RSI14: {result['rsi']:.1f} | "
        f"EMA20: {result['ema20']:.3f} | VWAP: {result['vwap']:.3f} | "
        f"DXY 24h chg: {result['dxy_change_pct']:.2f}% | "
        f"Gold/Silver ratio: {result['gs_ratio']:.1f}" if result['gs_ratio'] else ""
    )

    append_and_push(line)


if __name__ == "__main__":
    main()
