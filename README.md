# 📈 Stock Dashboard

A personal, self-hosted dashboard for daily stock news and portfolio tracking. Builds on an earlier email-digest project, turning those daily stock-news emails into a live web dashboard.

## Overview

- **Daily stock news** aggregated and displayed in one place
- **Portfolio view** of individual holdings (private — data files are never committed)
- **Admin authentication** — the dashboard is password-protected since it displays a private portfolio
- **Self-hosted** on a DigitalOcean droplet

## Architecture

```
┌─────────────────┐        git push        ┌──────────────┐
│  Local dev repo │ ─────────────────────▶ │    GitHub    │
│  (this repo)    │                        └──────────────┘
│                 │        deploy (scp/rsync)
│                 │ ─────────────────────▶ ┌──────────────────────┐
└─────────────────┘                        │ DigitalOcean droplet │
                                           │  serves dashboard    │
                                           └──────────────────────┘
```

The droplet hosts a full copy of this repo so the dashboard runs directly from it. Every change — small or big — is committed and pushed to GitHub, then deployed to the droplet.

## Private files (not in this repo)

These live only on the local machine and the droplet, and are excluded via `.gitignore`:

| File | Purpose |
|------|---------|
| `config.json` | Droplet connection details and admin credentials |
| `individual_holdings.json` | Portfolio positions (symbols, quantities, cost basis, P/L) |

To run your own instance, create a `config.json` with your own server details and admin password, and an `individual_holdings.json` with your positions.

## Authentication

Access requires logging in as admin. The admin password is defined in `config.json` (never committed). All portfolio data stays behind this login.

## Status

🚧 **Early setup** — repo scaffolding is in place; dashboard development is starting soon.

## Roadmap

- [ ] Dashboard page (`stocksDashboard.html`) served from the droplet
- [ ] Admin login / session handling
- [ ] Daily stock news feed
- [ ] Portfolio holdings view with P/L
- [ ] Automated deploy from local → droplet
