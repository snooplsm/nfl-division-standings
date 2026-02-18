# Copilot / AI Agent Instructions — NFC East

Purpose
- Small static site that renders NFC East team cards from `nfceast.yml` and exports PNGs (no backend).

Big picture
- Source of truth: `nfceast.yml`. Pages fetch it via `fetch('nfceast.yml')` and build DOM rows.
- Pages: `index.html` (fewest points allowed), `points-for.html` (most points scored), `taxes.html` (multi-stat dashboard + export).
- UI pattern: compute a numeric value per team, sort an array of teams, then build `.team-row` elements with `team.logo`, `team.color`, and a `.points` value. Rows use `z-index` = `teams.length - index` to stack.

Key files & data model
- `nfceast.yml` — top-level keys:
  - `opponent_logos` map for logos used in versus mode
  - `nfc_east`: array of team objects: { team, rank, wins, losses, win_pct, points_for, points_against, logo, color, income_tax, games: [ { week, opponent, location, result, score, overtime? } ] }
- `games[].score` format: string "teamScore-opponentScore" (e.g. "24-20"). Several scripts parse with `split('-').map(Number)` so keep that format consistent.

Project-specific patterns & conventions
- No build step—files served statically and include libraries via CDN (js-yaml, dom-to-image). Keep changes compatible with plain static hosting.
- Image export expects CORS-friendly remote images. Pages set `img.crossOrigin = 'anonymous'` for export — when adding new logos, prefer hosting with CORS headers or add them to `opponent_logos`.
- Sorting direction is controlled by `statConfig` in `taxes.html` (`sortAscending: true|false`). Add a stat by adding an entry in `statConfig` and ensuring `renderTeams` can format it.
- Derived metrics are computed client-side (examples):
  - Fewest points allowed: sum opponent score for each game (see `index.html`) — stored as `calculated_points_allowed`.
  - Wins vs .500+ teams: `calculateWinsVsWinning()` in `taxes.html` (uses an internal mapping of team names to abbreviations).
  - Versus view: `getAllOpponents()` + `renderVersus(opponent)` compute point differentials and sort.

How to run & debug locally
- Do NOT open files over `file://` — `fetch('nfceast.yml')` fails locally under `file://`. Start a simple static server in repo root:
  - Python 3: `python -m http.server 8000`
  - Node: `npx http-server` or `npx serve`
  Then open `http://localhost:8000/index.html`.
- Use browser devtools Console to inspect fetch/parsing errors and thrown exceptions.
- To verify export: use `taxes.html` → select stat/versus → click `Export PNG`. If PNG export fails, check console for CORS "tainted canvas" errors.

Small code patterns to copy (examples)
- New stat page: copy `index.html` or `points-for.html`, change title/subtitle, compute new metric from `nfceast.yml`, sort, then render rows using the same DOM structure (`.team-row`, `.team-logo`, `.points`).
- Add a stat to main dashboard (`taxes.html`):
  1. Add entry to `statConfig` with { title, subtitle, suffix, sortAscending }
  2. Add derived field calculation (if needed) and ensure `renderTeams` formats it (special-case `win_pct`).

Tests & CI
- No tests or workflows currently. Any agent changes should include a simple manual verification checklist and preferably add a small GitHub Action if introducing build/test steps.

Safety & quality notes
- Prefer minimal, explicit changes (this is a small, visible UI). Keep changes unobtrusive and test in Chrome/Firefox. When adding external assets (logos), prefer CORS-enabled hosts.

If anything is unclear or you want examples copied into a new page/feature, indicate which change you want and I will implement and test it locally on a dev server.