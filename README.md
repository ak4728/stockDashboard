# 📈 Stock Dashboard

A personal, self-hosted dashboard for daily stock news and portfolio tracking. Builds on an earlier email-digest project, turning those daily stock-news emails into a live web dashboard.

**Live at** `http://<droplet-ip>/stocksDashboard.html` (admin login required).

## Features

- **Portfolio overview** — KPI tiles for total value, day P/L, unrealized P/L and the day's top mover
- **Live quotes** — prices, day change and 5-day sparklines per holding (Yahoo Finance chart API, cached 5 min; delisted positions fall back to stored prices and are marked stale)
- **Charts** — allocation by market value (top holdings + "Other") and a diverging biggest-movers chart, rendered as dependency-free inline SVG with hover tooltips; light & dark theme
- **Holdings table** — full position detail: quantity, cost, price, day change, value, P/L
- **News** — headlines for your holdings (per-ticker feeds) plus general market news from CNBC, MarketWatch and Yahoo Finance (cached 15 min)
- **Admin authentication** — password login with rate-limited attempts (lockout after repeated failures), HttpOnly session cookies
- **Lightweight** — Flask + gunicorn (single worker) behind nginx; runs comfortably on a 512MB droplet

## Stack

Python 3 / Flask · gunicorn · nginx · vanilla JS + inline SVG (no frontend dependencies)

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

The droplet holds a git clone of this repo at `/var/www/stocksDashboard`. nginx routes requests addressed to the bare IP to the dashboard, while existing sites on the same droplet keep their own server blocks untouched. Every change — small or big — is committed and pushed to GitHub, then pulled on the droplet.

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
| `config.json` | Server connection details and the admin password |
| `individual_holdings.json` | Portfolio positions (symbols, quantities, cost basis) |
| `.secret_key` | Auto-generated Flask session key |

To run your own instance, create a `config.json` with an `admin-pwd` key and an `individual_holdings.json` following the schema `{ "positions": [{ "symbol", "quantity", "avg_buy_price", "cost_basis", ... }] }`.

## Local development

```bash
pip install -r requirements.txt
python app.py            # http://127.0.0.1:8600
```

## Roadmap

- [x] Dashboard page served from the droplet
- [x] Admin login / session handling
- [x] Daily stock news feed
- [x] Portfolio holdings view with live P/L
- [x] Deploy script (local → GitHub → droplet)
- [ ] Domain + HTTPS
- [ ] Historical portfolio value tracking
- [ ] News relevance filtering / summaries
