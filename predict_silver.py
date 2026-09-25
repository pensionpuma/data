#!/usr/bin/env python3
"""
predict_silver.py

Heuristic, rules-based directional estimate for silver's intraday move
during London market hours (08:00-16:30 UK). Uses:
  - 20-period EMA on DAILY closes (self-built history; see note below)
  - A pseudo-VWAP: rolling 5-day average of typical price (H+L+C)/3.
    No real trade volume is available on the free tier, so this is an
    unweighted proxy, not a true volume-weighted average price.
  - ATR(14) on DAILY true range, from self-built history
  - RSI(14) + a simple divergence check on daily closes
  - DXY 24h change (if the API exposes it on your plan) as an inverse
    correlation signal
  - Gold/Silver ratio extremity as a momentum amplifier

IMPORTANT CAVEATS:
  - This is a heuristic scoring model, not a statistically validated
    forecasting system. Treat the output as a structured, transparent
    opinion, not a guarantee, and never as the sole basis for a trading
    decision.
  - The original spec called for a 20-EMA on H1/H4 intraday bars. The
    free MetalCharts tier only exposes live spot (no intraday history),
    so this script self-builds a DAILY series instead, one row per
    scheduled run. EMA(20)/RSI(14)/ATR(14) are computed on those daily
    closes/highs/lows once enough history has accumulated. Until then
    (roughly the first 3-4 weeks of runs), the output is explicitly
    marked LOW-CONFIDENCE / PROVISIONAL.
  - Gap detection uses the API's own changePercent24h field directly,
    which is a genuine live 24h change rather than an approximation.

Data source: MetalCharts API (https://metalcharts.org/metals-api),
free tier, endpoint https://api.metalcharts.org/v1/prices.
Requires env var METALCHARTS_API_KEY.

Output line format:
  <UK date/time>: Silver will likely (GAP-UP|GAP-DOWN|NOT GAP) initially
  and then (RISE|FALL) by (XX.XX%)
"""

import csv
import os
import sys
import subprocess
from datetime import datetime, date
from zoneinfo import ZoneInfo

import requests

API_KEY = os.environ.get("METALCHARTS_API_KEY")
PRICES_URL = "https://api.metalcharts.org/v1/prices"

UK_TZ = ZoneInfo("Europe/London")

HISTORY_FILE = "silver_history.csv"
OUTPUT_FILE = "silver.txt"

HISTORY_FIELDS = [
    "date", "silver_price", "silver_high24h", "silver_low24h",
    "silver_change_pct_24h", "gold_price", "dxy_price", "dxy_change_pct_24h",
]

GAP_THRESHOLD_PCT = 0.15
DXY_THRESHOLD_PCT = 0.15
GS_RATIO_EXTREME = 80.0

MIN_ROWS_FOR_EMA = 20
MIN_ROWS_FOR_ATR_RSI = 14
MIN_ROWS_FOR_DIVERGENCE = 30


def fetch_prices() -> dict:
    if not API_KEY:
        raise RuntimeError("METALCHARTS_API_KEY not set")
    resp = requests.get(
        PRICES_URL,
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=20,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success"):
        raise RuntimeError(f"MetalCharts API returned an error: {payload}")
    return payload["data"]


def load_history():
    if not os.path.exists(HISTORY_FILE):
        return []
    rows = []
    with open(HISTORY_FILE, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append({
                "date": r["date"],
                "silver_price": float(r["silver_price"]),
                "silver_high24h": float(r["silver_high24h"]),
                "silver_low24h": float(r["silver_low24h"]),
                "silver_change_pct_24h": float(r["silver_change_pct_24h"]),
                "gold_price": float(r["gold_price"]),
                "dxy_price": float(r["dxy_price"]) if r["dxy_price"] else None,
                "dxy_change_pct_24h": float(r["dxy_change_pct_24h"]) if r["dxy_change_pct_24h"] else None,
            })
    return rows


def append_history_row(row: dict):
    file_exists = os.path.exists(HISTORY_FILE)
    with open(HISTORY_FILE, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=HISTORY_FIELDS)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)


def ema(values, period):
    period = min(period, len(values))
    k = 2 / (period + 1)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1 - k)
    return e


def atr(highs, lows, closes, period=14):
    trs = []
    for i in range(1, len(closes)):
        h, l, prev_c = highs[i], lows[i], closes[i - 1]
        trs.append(max(h - l, abs(h - prev_c), abs(l - prev_c)))
    if not trs:
        return 0.0
    recent = trs[-period:] if len(trs) >= period else trs
    return sum(recent) / len(recent)


def rsi(closes, period=14):
    if len(closes) < 2:
        return 50.0
    period = min(period, len(closes) - 1)
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


def rsi_series(closes, period=14):
    out = []
    for i in range(2, len(closes) + 1):
        out.append(rsi(closes[:i], period))
    return out


def check_bullish_divergence(closes):
    if len(closes) < MIN_ROWS_FOR_DIVERGENCE:
        return False
    window = closes[-20:]
    r = rsi_series(closes, 14)[-20:]
    if len(r) < 20:
        return False
    price_low_idx = window.index(min(window))
    rsi_low_idx = r.index(min(r))
    if price_low_idx > rsi_low_idx and window[price_low_idx] <= min(window[:price_low_idx] or [window[price_low_idx]]):
        return True
    return False


def pseudo_vwap(rows, window=5):
    recent = rows[-window:] if len(rows) >= window else rows
    typical = [(r["silver_high24h"] + r["silver_low24h"] + r["silver_price"]) / 3 for r in recent]
    return sum(typical) / len(typical)


def score_signals(rows_with_today, today_row):
    closes = [r["silver_price"] for r in rows_with_today]
    highs = [r["silver_high24h"] for r in rows_with_today]
    lows = [r["silver_low24h"] for r in rows_with_today]
    last_close = closes[-1]

    n = len(rows_with_today)
    provisional = n < MIN_ROWS_FOR_EMA

    ema_period = min(20, n)
    ema20 = ema(closes[-max(ema_period, 1):], ema_period)

    vwap = pseudo_vwap(rows_with_today, window=5)

    atr14 = atr(highs, lows, closes, period=14)
    atr_pct = (atr14 / last_close) * 100 if last_close else 0.0

    rsi14 = rsi(closes, period=14)
    bull_div = check_bullish_divergence(closes)

    gs_ratio = today_row["gold_price"] / last_close if last_close else None

    dxy_change_pct = today_row.get("dxy_change_pct_24h")

    score = 0.0
    reasons = []

    if last_close > ema20:
        score += 0.25
        reasons.append(f"price above {ema_period}-period EMA (bullish trend)")
    else:
        score -= 0.25
        reasons.append(f"price below {ema_period}-period EMA (bearish trend)")

    if last_close > vwap:
        score += 0.15
        reasons.append("trading above 5-day pseudo-VWAP")
    else:
        score -= 0.15
        reasons.append("trading below 5-day pseudo-VWAP")

    if bull_div:
        score += 0.2
        reasons.append("bullish RSI divergence detected")
    elif rsi14 < 30:
        score += 0.1
        reasons.append("RSI oversold")
    elif rsi14 > 70:
        score -= 0.1
        reasons.append("RSI overbought")

    if dxy_change_pct is not None:
        if dxy_change_pct > DXY_THRESHOLD_PCT:
            score -= 0.25
            reasons.append(f"DXY up {dxy_change_pct:.2f}% (headwind)")
        elif dxy_change_pct < -DXY_THRESHOLD_PCT:
            score += 0.25
            reasons.append(f"DXY down {dxy_change_pct:.2f}% (tailwind)")
    else:
        reasons.append("DXY data unavailable on this plan/run - term skipped")

    amplify = 1.0
    if gs_ratio and gs_ratio > GS_RATIO_EXTREME:
        amplify = 1.3
        reasons.append(f"gold/silver ratio stretched at {gs_ratio:.1f} (amplifying momentum)")

    score = max(-1.0, min(1.0, score * amplify))

    magnitude_pct = abs(score) * atr_pct * 0.6
    magnitude_pct = max(0.05, min(magnitude_pct, atr_pct * 1.5 if atr_pct else 1.0))

    direction = "RISE" if score >= 0 else "FALL"

    return {
        "direction": direction,
        "magnitude_pct": magnitude_pct,
        "score": score,
        "atr_pct": atr_pct,
        "rsi": rsi14,
        "ema_period_used": ema_period,
        "ema": ema20,
        "vwap": vwap,
        "dxy_change_pct": dxy_change_pct,
        "gs_ratio": gs_ratio,
        "provisional": provisional,
        "history_days": n,
        "reasons": reasons,
    }


def detect_gap(today_row) -> str:
    chg = today_row["silver_change_pct_24h"]
    if chg > GAP_THRESHOLD_PCT:
        return "GAP-UP"
    elif chg < -GAP_THRESHOLD_PCT:
        return "GAP-DOWN"
    return "NOT GAP"


def build_output_line():
    data = fetch_prices()

    if "XAG" not in data or "XAU" not in data:
        raise RuntimeError(f"Expected XAG/XAU in API response, got keys: {list(data.keys())}")

    xag = data["XAG"]
    xau = data["XAU"]
    dxy = data.get("DXY")  # may not exist on the free tier/plan

    today_row = {
        "date": date.today().isoformat(),
        "silver_price": xag["price"],
        "silver_high24h": xag["high24h"],
        "silver_low24h": xag["low24h"],
        "silver_change_pct_24h": xag["changePercent24h"],
        "gold_price": xau["price"],
        "dxy_price": dxy["price"] if dxy else "",
        "dxy_change_pct_24h": dxy["changePercent24h"] if dxy else "",
    }

    history = load_history()

    # Avoid double-appending if the workflow is run more than once same day
    if history and history[-1]["date"] == today_row["date"]:
        rows_with_today = history
    else:
        append_history_row(today_row)
        rows_with_today = history + [{
            **today_row,
            "dxy_price": today_row["dxy_price"] or None,
            "dxy_change_pct_24h": today_row["dxy_change_pct_24h"] or None,
        }]

    result = score_signals(rows_with_today, today_row)
    gap = detect_gap(today_row)

    now_uk = datetime.now(UK_TZ)
    timestamp = now_uk.strftime("%Y-%m-%d %H:%M")

    line = (
        f"{timestamp}: Silver will likely {gap} initially and then "
        f"{result['direction']} by {result['magnitude_pct']:.2f}%"
    )
    if result["provisional"]:
        line += f"  [PROVISIONAL - only {result['history_days']} day(s) of history]"

    return line, result


def append_output_and_push(line: str):
    with open(OUTPUT_FILE, "a") as f:
        f.write(line + "\n")

    subprocess.run(["git", "config", "user.name", "silver-predictor-bot"], check=True)
    subprocess.run(["git", "config", "user.email", "actions@users.noreply.github.com"], check=True)
    subprocess.run(["git", "add", OUTPUT_FILE, HISTORY_FILE], check=True)

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
        f"ATR%: {result['atr_pct']:.2f} | RSI: {result['rsi']:.1f} | "
        f"EMA({result['ema_period_used']}): {result['ema']:.3f} | "
        f"pseudo-VWAP(5d): {result['vwap']:.3f} | "
        f"Gold/Silver ratio: {result['gs_ratio']:.1f} | "
        f"History depth: {result['history_days']} day(s)"
    )

    append_output_and_push(line)


if __name__ == "__main__":
    main()
