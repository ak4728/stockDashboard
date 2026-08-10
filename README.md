# 📈 Stock Dashboard

A personal, self-hosted portfolio-intelligence dashboard: live prices, daily stock news with context on *why* holdings are moving, and analytics a brokerage app doesn't surface. Runs on a DigitalOcean droplet behind admin login.

**Live at** `http://<droplet-ip>/stocksDashboard.html`.

## Features

### Live data
- **~60-second price refresh** — quotes from Yahoo Finance's chart API (`regularMarketPrice`), fetched in parallel and cached 55s server-side; the page polls every 60s with a live countdown pill
- **News every 10 minutes** — per-ticker feeds for every holding plus CNBC, MarketWatch and Yahoo Finance market headlines, deduped and timestamped
- Delisted/unquotable positions fall back to stored prices, are marked stale, and stay out of totals

### Insights beyond the brokerage app
- **"Why it's moving"** — today's biggest movers, each annotated with its latest headlines
- **You vs the indices** — 3-month indexed performance chart with toggleable SPY / QQQ / DIA benchmarks and a 1M/3M range switch (selections persist)
- **Sector exposure**, **allocation** (top holdings + "Other"), **top-5 concentration**, **winners/losers breadth**, **day performance vs S&P in points**
- Per-position **1W / 1M / 3M returns** and **annualized volatility**, plus 10-day sparklines

### Interactive
- Holdings table sorts by any column (click headers), filters by symbol, and keeps your sort/filter through auto-refreshes
- Hover tooltips and crosshair on every chart; no charting library — dependency-free inline SVG

### Private & lightweight
- **Admin authentication** — rate-limited password login (lockout after repeated failures), HttpOnly session cookies
- Flask + gunicorn (single worker) behind nginx; runs comfortably alongside other sites on a 512MB droplet
- Committed dark theme — green-tinted charcoal, lime accent, Space Grotesk display type

## Stack

Python 3 / Flask · gunicorn · nginx · vanilla JS + inline SVG

## Architecture

```
┌─────────────────┐        git push        ┌──────────────┐
│  Local dev repo │ ─────────────────────▶ │    GitHub    │
└─────────────────┘                        └──────┬───────┘
                                                  │ git pull (deploy.sh)
                                           ┌──────▼───────────────────────┐
                                           │ DigitalOcean droplet         │
                                           │  nginx :80 (IP server block) │
                                           │   └▶ gunicorn 127.0.0.1:8600 │
                                           │       └▶ Flask app           │
                                           └──────────────────────────────┘
```

The droplet holds a git clone of this repo at `/var/www/stocksDashboard`. nginx routes requests addressed to the bare IP to the dashboard; other sites on the droplet keep their own server blocks untouched. Every change — small or big — is committed and pushed to GitHub, then pulled on the droplet.

## Deploying

```bash
./deploy.sh
```

Pushes to GitHub, pulls on the droplet, syncs the private files, reinstalls requirements if changed, restarts the service and health-checks it.

Server pieces (installed once):

| File | Installs to |
|------|-------------|
| `deploy/stocksdashboard.service` | `/etc/systemd/system/` — gunicorn unit (started via the venv's `python -m gunicorn`; SELinux blocks systemd from exec'ing scripts under `/var/www`) |
| `deploy/stocksdashboard.conf` | `/etc/nginx/conf.d/` — server block matching the droplet IP |

## Private files (never committed)

Excluded via `.gitignore`; they live only on the local machine and the droplet:

| File | Purpose |
|------|---------|
| `config.json` | Server connection details and the admin password (`admin-pwd`) |
| `individual_holdings.json` | Portfolio positions (symbols, quantities, cost basis) |
| `.secret_key` | Auto-generated Flask session key |

To run your own instance, create a `config.json` with an `admin-pwd` key and an `individual_holdings.json` following the schema `{ "positions": [{ "symbol", "quantity", "avg_buy_price", "cost_basis", ... }] }`.

## Local development

```bash
pip install -r requirements.txt
python app.py                      # http://127.0.0.1:8600
DASH_DEV_AUTOLOGIN=1 python app.py # skip login locally (never set in production)
```

## Data honesty notes

- Yahoo quotes are real-time for most US listings but can be delayed up to 15 minutes for some symbols
- The performance history assumes current share counts held throughout the window
- Per-ticker RSS feeds are occasionally noisy (a fund's feed may return stories about a similarly-named company)

## Roadmap

- [x] Live dashboard with admin login, served from the droplet
- [x] ~60s dynamic prices, news with per-mover context
- [x] Benchmark comparison, sector/concentration/returns/volatility insights
- [x] Sortable, filterable holdings table; interactive charts
- [ ] Domain + HTTPS (password currently travels over plain HTTP)
- [ ] Persist daily portfolio snapshots for exact long-term history
- [ ] News relevance filtering / AI summaries
