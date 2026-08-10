"""Stocks Dashboard — daily stock news + private portfolio.

Flask app served behind nginx on the droplet. Auth is a single admin
password from config.json (never committed). Market data comes from the
Yahoo Finance chart API and news from public RSS feeds, both cached
in-memory so a dashboard refresh never hammers upstream sources.
"""

import concurrent.futures
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

import feedparser
import requests
from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("CONFIG_PATH", BASE_DIR / "config.json"))
HOLDINGS_PATH = Path(os.environ.get("HOLDINGS_PATH", BASE_DIR / "individual_holdings.json"))
SECRET_KEY_PATH = BASE_DIR / ".secret_key"

QUOTES_TTL = 55       # ~1 min — dashboard polls every 60s and gets fresh prices
NEWS_TTL = 600        # 10 min — RSS feeds rarely update faster
LOGIN_MAX_FAILS = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60
SESSION_LIFETIME_SECONDS = 12 * 3600

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) StocksDashboard/1.0"}

MARKET_FEEDS = [
    ("CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
]


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def get_secret_key():
    """Persistent random secret so sessions survive restarts."""
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_text().strip()
    key = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(key)
    try:
        os.chmod(SECRET_KEY_PATH, 0o600)
    except OSError:
        pass
    return key


app = Flask(__name__)
app.config.update(
    SECRET_KEY=get_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=SESSION_LIFETIME_SECONDS,
)

CONFIG = load_config()
ADMIN_PASSWORD = CONFIG["admin-pwd"]

# ---------------------------------------------------------------------------
# Cache + login throttling
# ---------------------------------------------------------------------------

_cache = {}
_cache_lock = threading.Lock()
_login_fails = {}  # ip -> {"count": int, "lock_until": epoch}


def cached(key, ttl, fetch):
    """Return cached value if fresh; refetch otherwise, serving stale on error."""
    now = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry["expires"] > now:
            return entry["value"]
    try:
        value = fetch()
    except Exception:
        if entry:  # stale is better than nothing
            return entry["value"]
        raise
    with _cache_lock:
        _cache[key] = {"value": value, "expires": now + ttl}
    return value


def client_ip():
    return request.headers.get("X-Real-IP") or request.remote_addr or "?"


def login_locked(ip):
    rec = _login_fails.get(ip)
    return bool(rec and rec.get("lock_until", 0) > time.time())


def record_login_failure(ip):
    rec = _login_fails.setdefault(ip, {"count": 0, "lock_until": 0})
    rec["count"] += 1
    if rec["count"] >= LOGIN_MAX_FAILS:
        rec["lock_until"] = time.time() + LOGIN_LOCKOUT_SECONDS
        rec["count"] = 0


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

DEV_AUTOLOGIN = os.environ.get("DASH_DEV_AUTOLOGIN") == "1"  # local dev only


def login_required(view):
    def wrapped(*args, **kwargs):
        if DEV_AUTOLOGIN:
            session["authed"] = True
        if not session.get("authed"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    wrapped.__name__ = view.__name__
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        ip = client_ip()
        if login_locked(ip):
            error = "Too many attempts. Try again in a few minutes."
        elif hmac.compare_digest(request.form.get("password", ""), ADMIN_PASSWORD):
            session.permanent = True
            session["authed"] = True
            _login_fails.pop(ip, None)
            target = request.args.get("next") or url_for("dashboard")
            if not target.startswith("/"):  # avoid open redirect
                target = url_for("dashboard")
            return redirect(target)
        else:
            record_login_failure(ip)
            error = "Wrong password."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

def load_holdings():
    with open(HOLDINGS_PATH, encoding="utf-8") as f:
        return json.load(f)


def num(value):
    """Coerce holdings-file values to float; delisted rows use empty strings."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_quote(symbol):
    """Live price, previous close and 3 months of daily closes from Yahoo."""
    from urllib.parse import quote

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol, safe='')}"
    resp = requests.get(
        url,
        params={"range": "3mo", "interval": "1d"},
        headers=HTTP_HEADERS,
        timeout=8,
    )
    resp.raise_for_status()
    result = resp.json()["chart"]["result"][0]
    meta = result["meta"]
    timestamps = result.get("timestamp") or []
    closes_raw = result["indicators"]["quote"][0].get("close") or []
    series = [(t, c) for t, c in zip(timestamps, closes_raw) if c is not None]
    closes = [c for _, c in series]
    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
    market_time = meta.get("regularMarketTime")
    prev_close = meta.get("previousClose")
    if prev_close is None and len(closes) >= 2:
        # If the last daily row is today's session, yesterday is one back.
        same_day = (
            market_time is not None
            and series
            and series[-1][0] // 86400 == market_time // 86400
        )
        prev_close = closes[-2] if same_day else closes[-1]
    return {
        "symbol": symbol,
        "price": price,
        "prev_close": prev_close,
        "series": series,
        "market_time": market_time,
    }


# Static sector map for the portfolio — insight Robinhood doesn't surface.
SECTORS = {
    "ADBE": "Technology", "SHOP": "Technology", "APPN": "Technology",
    "AAPL": "Technology", "PANW": "Technology", "APLD": "Technology",
    "TRMB": "Technology", "WDC": "Technology", "STX": "Technology",
    "SNDK": "Technology", "IONQ": "Quantum", "QBTS": "Quantum",
    "NVDA": "Semiconductors", "AMD": "Semiconductors", "INTC": "Semiconductors",
    "TSM": "Semiconductors", "MRVL": "Semiconductors", "ARM": "Semiconductors",
    "SOXL": "Semiconductors", "TSLA": "Consumer", "AMZN": "Consumer",
    "CVNA": "Consumer", "RIVN": "Consumer", "PSMT": "Consumer", "OZON": "Consumer",
    "ROKU": "Media", "NFLX": "Media", "PYPL": "Financials", "LMND": "Financials",
    "NDAQ": "Financials", "HIMS": "Healthcare", "RTX": "Industrials",
    "HYLN": "Industrials", "GEVO": "Industrials", "ARE": "Real Estate",
    "SPY": "Index ETFs", "DIA": "Index ETFs", "QQQ": "Index ETFs",
    "SPCX": "Index ETFs", "GLD": "Commodities", "GLDM": "Commodities",
    "USO": "Commodities",
}

TRADING_DAYS = {"1w": 5, "1m": 21, "3m": 63}


def window_returns(closes):
    """% return over ~1 week / 1 month / 3 months of trading days."""
    out = {}
    for key, days in TRADING_DAYS.items():
        idx = len(closes) - 1 - days
        if idx < 0 and key == "3m" and len(closes) >= 45:
            idx = 0  # a 3mo range often yields exactly ~63 rows; use the first
        if idx >= 0 and closes[idx]:
            out[key] = (closes[-1] / closes[idx] - 1) * 100
        else:
            out[key] = None
    return out


def annualized_vol(closes):
    """Annualized daily-return volatility, in percent."""
    if len(closes) < 15:
        return None
    rets = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)) if closes[i - 1]]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return (var ** 0.5) * (252 ** 0.5) * 100


BENCHMARKS = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "DIA": "Dow Jones"}


def build_history(holdings_positions, quotes):
    """Reconstruct daily portfolio value over ~3 months from per-symbol closes,
    assuming current share counts. Also returns index-ETF closes as benchmarks."""
    by_day = {}
    day_sets = []
    for pos in holdings_positions:
        q = quotes.get(pos["symbol"])
        qty = num(pos.get("quantity")) or 0.0
        if not q or not q.get("series") or qty <= 0:
            continue
        series = {t // 86400: c for t, c in q["series"]}
        by_day[pos["symbol"]] = (qty, series)
        day_sets.append(set(series))
    if not by_day:
        return None
    days = sorted(set().union(*day_sets))[-64:]
    last_close = {}
    values = []
    bench_series = {
        sym: {t // 86400: c for t, c in (quotes.get(sym) or {}).get("series", [])}
        for sym in BENCHMARKS
    }
    bench_vals = {sym: [] for sym in BENCHMARKS}
    bench_last = {}
    for day in days:
        total = 0.0
        for sym, (qty, series) in by_day.items():
            if day in series:
                last_close[sym] = series[day]
            if sym in last_close:
                total += qty * last_close[sym]
        values.append(round(total, 2))
        for sym in BENCHMARKS:
            bench_last[sym] = bench_series[sym].get(day, bench_last.get(sym))
            bench_vals[sym].append(bench_last[sym])
    return {
        "days": days,
        "value": values,
        "benchmarks": [
            {"symbol": sym, "label": label, "values": bench_vals[sym]}
            for sym, label in BENCHMARKS.items()
            if any(v is not None for v in bench_vals[sym])
        ],
    }


def fetch_all_quotes(symbols):
    quotes = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_quote, s): s for s in symbols}
        for fut in concurrent.futures.as_completed(futures):
            sym = futures[fut]
            try:
                quotes[sym] = fut.result()
            except Exception:
                quotes[sym] = None  # position falls back to stored last_price
    return quotes


def build_portfolio():
    holdings = load_holdings()
    symbols = [p["symbol"] for p in holdings["positions"]]
    # Always fetch benchmark ETFs too, even if not (or no longer) held.
    fetch_syms = list(dict.fromkeys(symbols + list(BENCHMARKS)))
    quotes = cached("quotes", QUOTES_TTL, lambda: fetch_all_quotes(fetch_syms))

    positions = []
    totals = {"market_value": 0.0, "cost_basis": 0.0, "day_change": 0.0}
    latest_market_time = None
    for pos in holdings["positions"]:
        sym = pos["symbol"]
        q = quotes.get(sym) or {}
        qty = num(pos.get("quantity")) or 0.0
        avg_buy = num(pos.get("avg_buy_price"))
        live = num(q.get("price"))
        if live is None:
            live = num(pos.get("last_price"))  # stored fallback
        prev_close = num(q.get("prev_close"))
        cost_basis = num(pos.get("cost_basis"))
        if cost_basis is None and avg_buy is not None:
            cost_basis = avg_buy * qty

        market_value = live * qty if live is not None else None
        unrealized = (
            market_value - cost_basis
            if market_value is not None and cost_basis is not None
            else None
        )
        priceable = live is not None and prev_close is not None
        day_change = (live - prev_close) * qty if priceable else 0.0
        day_change_pct = ((live / prev_close) - 1) * 100 if priceable else None
        if q.get("market_time"):
            latest_market_time = max(latest_market_time or 0, q["market_time"])
        closes = [c for _, c in q.get("series") or []]
        positions.append({
            "symbol": sym,
            "quantity": qty,
            "avg_buy_price": avg_buy,
            "price": live,
            "live": q.get("price") is not None,
            "day_change": day_change,
            "day_change_pct": day_change_pct,
            "market_value": market_value,
            "cost_basis": cost_basis,
            "unrealized_pl": unrealized,
            "unrealized_pl_pct": (
                unrealized / cost_basis * 100
                if unrealized is not None and cost_basis
                else None
            ),
            "spark": closes[-10:],
            "returns": window_returns(closes),
            "vol": annualized_vol(closes),
            "sector": SECTORS.get(sym, "Other"),
        })
        if market_value is not None and cost_basis is not None:
            totals["market_value"] += market_value
            totals["cost_basis"] += cost_basis
            totals["day_change"] += day_change

    totals["unrealized_pl"] = totals["market_value"] - totals["cost_basis"]
    totals["unrealized_pl_pct"] = (
        totals["unrealized_pl"] / totals["cost_basis"] * 100 if totals["cost_basis"] else None
    )
    prev_total = totals["market_value"] - totals["day_change"]
    totals["day_change_pct"] = (
        totals["day_change"] / prev_total * 100 if prev_total else None
    )
    positions.sort(key=lambda p: p["market_value"] or 0.0, reverse=True)

    sectors = {}
    for p in positions:
        if p["market_value"]:
            sectors[p["sector"]] = sectors.get(p["sector"], 0.0) + p["market_value"]
    sector_list = sorted(
        ({"sector": k, "value": round(v, 2)} for k, v in sectors.items()),
        key=lambda s: s["value"],
        reverse=True,
    )

    return {
        "account": holdings.get("account"),
        "as_of": holdings.get("as_of"),
        "market_time": latest_market_time,
        "positions": positions,
        "totals": totals,
        "sectors": sector_list,
        "history": build_history(holdings["positions"], quotes),
    }


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------

def parse_feed(source, url, limit, ticker=None):
    parsed = feedparser.parse(url, request_headers=HTTP_HEADERS)
    items = []
    for entry in parsed.entries[:limit]:
        published = entry.get("published_parsed") or entry.get("updated_parsed")
        items.append({
            "title": entry.get("title", "").strip(),
            "link": entry.get("link"),
            "source": source,
            "ticker": ticker,
            "published": int(time.mktime(published)) if published else None,
        })
    return items


def fetch_news(symbols):
    tasks = [("market", src, url, 8, None) for src, url in MARKET_FEEDS]
    tasks += [
        (
            "portfolio",
            "Yahoo Finance",
            f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US",
            4,
            sym,
        )
        for sym in symbols
    ]
    results = {"market": [], "portfolio": []}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(parse_feed, src, url, limit, ticker): bucket
            for bucket, src, url, limit, ticker in tasks
        }
        for fut in concurrent.futures.as_completed(futures):
            bucket = futures[fut]
            try:
                results[bucket].extend(fut.result())
            except Exception:
                pass  # one dead feed shouldn't sink the rest

    for bucket in results:
        seen = set()
        deduped = []
        for item in sorted(results[bucket], key=lambda x: x["published"] or 0, reverse=True):
            key = item["title"].lower()
            if item["title"] and key not in seen:
                seen.add(key)
                deduped.append(item)
        results[bucket] = deduped[:40]
    return results


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return redirect(url_for("dashboard"))


@app.route("/stocksDashboard.html")
@login_required
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/dashboard")
@login_required
def api_dashboard():
    portfolio = build_portfolio()
    symbols = [p["symbol"] for p in portfolio["positions"]]
    news = cached("news", NEWS_TTL, lambda: fetch_news(symbols))
    return jsonify({
        "generated_at": int(time.time()),
        "portfolio": portfolio,
        "news": news,
    })


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8600, debug=True)
