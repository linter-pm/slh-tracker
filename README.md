# SLH × Hilton Honors Tracker

A live tracker of every Small Luxury Hotel currently bookable with Hilton Honors points, ranked by aspirational tier + points value.

## Stack

Plain static site — `index.html` + `hotels.json`. No build step. No framework. Deploys to Vercel in one command.

## Files

- `index.html` — the app (HTML/CSS/JS, all inline)
- `hotels.json` — the data (snapshot from hilton.com)
- `vercel.json` — caching headers
- `.gitignore` — standard exclusions

## How the data stays fresh

The source of truth is [hilton.com/participating-hotels](https://www.hilton.com/en/brands/small-luxury-hotels-slh/participating-hotels/) — it's a static HTML page that lists every participating property by country. SLH properties join/leave the partnership monthly without announcements.

A scheduled task runs on the 1st of each month that:
1. Re-scrapes Hilton's participating-hotels page
2. Diffs against the current `hotels.json`
3. Updates `hotels.json` with adds/removals (and re-tags "Recently added" badges)
4. Notifies Terry to push the change (or, future improvement: GitHub Action to auto-commit)

## Local dev

Just open `index.html` in a browser, or run any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

```bash
cd "/Users/terry/Library/CloudStorage/GoogleDrive-terrylin921@gmail.com/My Drive/AI/Travel/slh-tracker"
vercel --prod
```

After first deploy, enable "Auto-deploy on push to main" in the Vercel project settings — then future updates are just `git push`.

## Updating manually

If you spot a new SLH listing on Hilton that the monthly scrape missed, edit `hotels.json` directly:

```json
{
  "name": "Hotel Name",
  "country": "Country",
  "city": "City (optional)",
  "tags": ["new"],
  "url": "https://www.hilton.com/en/hotels/...",
  "points": 75000
}
```

Tag options: `tpg` · `sweet` · `nobu` · `new` · `iconic`

Then `git push` (or just `vercel --prod` for a one-off deploy).
