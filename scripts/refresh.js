#!/usr/bin/env node
/**
 * Monthly refresh script — scrapes hilton.com/participating-hotels and merges
 * the changes into hotels.json while preserving curation (tpg/sweet/nobu/iconic
 * tags, cities, points values, URLs).
 *
 * Runs via GitHub Actions on the 1st of each month. Also runnable locally:
 *   npm install
 *   node scripts/refresh.js
 *
 * The Hilton page is JS-rendered and gates plain HTTP requests with an anti-bot
 * page, so we use Playwright (headless Chromium) to render it properly.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.hilton.com/en/brands/small-luxury-hotels-slh/participating-hotels/';
const DATA_PATH = path.join(__dirname, '..', 'hotels.json');

// Page header text → JSON key (in case Hilton's display differs from our canonical naming)
const COUNTRY_NORMALIZE = {
  'Mainland China': 'China',
  'Hong Kong, China': 'Hong Kong',
  'Taiwan, China': 'Taiwan',
  'Saint Vincent & Grenadines': 'Saint Vincent and Grenadines',
  'Türkiye': 'Turkiye'
};

const normalizeCountry = (name) => {
  const t = name.trim().replace(/^\*+|\*+$/g, '').trim();
  return COUNTRY_NORMALIZE[t] || t;
};

async function scrape() {
  console.log('▸ Launching browser…');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await ctx.newPage();

  console.log(`▸ Navigating to ${SOURCE_URL}`);
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for at least one country heading to appear
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('h2'))
      .some(h => /Andorra|Anguilla|Antigua/i.test(h.textContent));
  }, { timeout: 30000 });

  console.log('▸ Extracting hotel list from DOM…');
  const data = await page.evaluate(() => {
    const result = {};
    const h2s = Array.from(document.querySelectorAll('h2'));
    h2s.forEach((h2) => {
      const countryRaw = h2.textContent.trim();
      // Filter out non-country h2s (page sections, footer headers, etc.)
      if (!countryRaw || countryRaw.length > 60) return;
      if (/^(How|Phone|Help|Global|Hilton|Footer|Back|Discover|Why|What|FAQ)/i.test(countryRaw)) return;

      const hotels = [];
      let node = h2.nextElementSibling;
      while (node && node.tagName !== 'H2') {
        // Look for anchor tags first — they give us both name AND deep-link URL
        const anchors = node.querySelectorAll
          ? Array.from(node.querySelectorAll('a[href*="/hotels/"]'))
          : [];
        if (anchors.length > 0) {
          anchors.forEach((a) => {
            const name = a.textContent.trim();
            const href = a.getAttribute('href');
            if (name && name.length > 1 && name.length < 120) {
              hotels.push({ name, url: new URL(href, location.origin).href });
            }
          });
        } else {
          // Fall back to plain text extraction
          const text = node.textContent.trim();
          if (text && text.length < 200) {
            text.split('\n').forEach((line) => {
              const name = line.trim();
              if (name && name.length > 1 && name.length < 120) {
                hotels.push({ name, url: null });
              }
            });
          }
        }
        node = node.nextElementSibling;
      }

      if (hotels.length > 0 && hotels.length < 100) {
        result[countryRaw] = hotels;
      }
    });
    return result;
  });

  await browser.close();
  const totalHotels = Object.values(data).flat().length;
  console.log(`▸ Scraped ${Object.keys(data).length} countries, ${totalHotels} hotels`);

  if (totalHotels < 200) {
    throw new Error(`Suspiciously low hotel count (${totalHotels}) — refusing to overwrite. Page may have changed structure.`);
  }
  return data;
}

function mergeWithExisting(scrapedByCountry) {
  // Normalize country keys
  const normalized = {};
  for (const [k, v] of Object.entries(scrapedByCountry)) {
    normalized[normalizeCountry(k)] = v;
  }

  const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const existingByKey = {};
  existing.hotels.forEach((h) => {
    existingByKey[`${h.country}::${h.name}`] = h;
  });

  const today = new Date().toISOString().split('T')[0];
  const ninetyDaysAgoStr = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

  const newHotels = [];
  const added = [];
  const removed = [];
  let urlsBackfilled = 0;

  for (const [country, hotelObjs] of Object.entries(normalized)) {
    for (const { name, url } of hotelObjs) {
      const key = `${country}::${name}`;
      if (existingByKey[key]) {
        // Preserve all existing curation
        const h = { ...existingByKey[key] };
        // Backfill URL if we don't have one yet
        if (!h.url && url) {
          h.url = url;
          urlsBackfilled++;
        }
        // Clean up stale "new" tags (>90 days old, or no added_date which means pre-existing)
        if (h.tags && h.tags.includes('new')) {
          const addedDate = h.added_date || '2025-06-01';
          if (addedDate < ninetyDaysAgoStr) {
            h.tags = h.tags.filter((t) => t !== 'new');
            if (h.tags.length === 0) delete h.tags;
            delete h.added_date;
          }
        }
        newHotels.push(h);
        delete existingByKey[key];
      } else {
        const entry = {
          name,
          country,
          tags: ['new'],
          added_date: today
        };
        if (url) entry.url = url;
        newHotels.push(entry);
        added.push(`${name} (${country})`);
      }
    }
  }
  if (urlsBackfilled > 0) {
    console.log(`▸ Backfilled ${urlsBackfilled} hotel URLs (for deep-linking to points calendar)`);
  }

  // Anything left in existingByKey was removed from Hilton's list
  for (const key of Object.keys(existingByKey)) {
    removed.push(`${existingByKey[key].name} (${existingByKey[key].country})`);
  }

  // Add country_meta entries for any newly-appearing countries
  const country_meta = { ...existing.country_meta };
  const unknownCountries = [];
  for (const country of Object.keys(normalized)) {
    if (!country_meta[country]) {
      unknownCountries.push(country);
      country_meta[country] = { r: 'Unknown', f: '🏳️' };
    }
  }

  const updated = {
    ...existing,
    snapshot_date: today,
    total: newHotels.length,
    countries: Object.keys(country_meta).length,
    country_meta,
    hotels: newHotels
  };

  return { updated, added, removed, unknownCountries };
}

async function main() {
  const scraped = await scrape();
  const { updated, added, removed, unknownCountries } = mergeWithExisting(scraped);

  const prevTotal = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).total;
  console.log('\n══════ Refresh summary ══════');
  console.log(`Total: ${updated.total} (was ${prevTotal})`);
  console.log(`Countries: ${updated.countries}`);

  if (added.length) {
    console.log(`\nAdded (${added.length}):`);
    added.forEach((a) => console.log(`  + ${a}`));
  } else {
    console.log('\nAdded: none');
  }

  if (removed.length) {
    console.log(`\nRemoved (${removed.length}):`);
    removed.forEach((r) => console.log(`  - ${r}`));
  } else {
    console.log('Removed: none');
  }

  if (unknownCountries.length) {
    console.log(`\n⚠️  New countries with unknown region/flag — add to country_meta manually:`);
    unknownCountries.forEach((c) => console.log(`     ${c}`));
  }

  if (added.length === 0 && removed.length === 0) {
    console.log('\nNo changes — hotels.json not modified.');
    return;
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(updated, null, 2) + '\n');
  console.log('\n✅ hotels.json updated.');
}

main().catch((err) => {
  console.error('\n❌ Refresh failed:', err);
  process.exit(1);
});
