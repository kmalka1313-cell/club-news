#!/usr/bin/env node
// Collect the latest news about your favorite clubs across sports (Google News RSS, no API keys).
const fs = require("fs");
const path = require("path");

const CLUBS_FILE = path.join(__dirname, "clubs.json");
const SEEN_FILE = path.join(__dirname, "seen.json");
const DIGEST_DIR = path.join(__dirname, "digests");

const HELP = `Usage:
  node club-news.js                  new items since last run
  node club-news.js --all            ignore history, show everything
  node club-news.js --days 3         look back 3 days (default 2)
  node club-news.js --limit 5        max items per club (default 8)
  node club-news.js --add "Arsenal" --sport Football
  node club-news.js --list`;

const loadJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const saveJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

function parseArgs(argv) {
  const a = { days: 2, limit: 8, all: false, sport: "Other" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--all") a.all = true;
    else if (k === "--list") a.list = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--days") a.days = Number(argv[++i]);
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--add") a.add = argv[++i];
    else if (k === "--sport") a.sport = argv[++i];
  }
  return a;
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

// Google News edition (interface/results language and region) per UI language
const EDITIONS = {
  en: "hl=en-US&gl=US&ceid=US:en", es: "hl=es&gl=ES&ceid=ES:es", fr: "hl=fr&gl=FR&ceid=FR:fr",
  de: "hl=de&gl=DE&ceid=DE:de", hi: "hl=hi&gl=IN&ceid=IN:hi", he: "hl=he&gl=IL&ceid=IL:he",
};

async function fetchItems(club, days, lang = "en") {
  const q = encodeURIComponent(`${club.query} when:${days}d`);
  const url = `https://news.google.com/rss/search?q=${q}&${EDITIONS[lang] || EDITIONS.en}`;
  const res = await fetch(url, { headers: { "User-Agent": "club-news/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, x]) => ({
      title: tag(x, "title"),
      link: tag(x, "link"),
      source: tag(x, "source"),
      published: new Date(tag(x, "pubDate") || Date.now()),
    }))
    .sort((a, b) => b.published - a.published);
}

async function buildDigest(clubs, { days, limit, all }) {
  const seen = new Set(loadJson(SEEN_FILE, []));
  const lines = [`# Club news digest - ${new Date().toLocaleString()}`, ""];
  let found = 0;
  for (const club of clubs) {
    let items;
    try {
      items = await fetchItems(club, days);
    } catch (e) {
      lines.push(`## ${club.name} (${club.sport})`, `_Fetch failed: ${e.message}_`, "");
      continue;
    }
    const fresh = items.filter((i) => all || !seen.has(i.link)).slice(0, limit);
    fresh.forEach((i) => seen.add(i.link));
    if (!fresh.length) continue;
    found += fresh.length;
    lines.push(`## ${club.name} (${club.sport})`, "");
    for (const i of fresh) {
      const date = i.published.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
      lines.push(`- [${i.title}](${i.link})${i.source ? " - " + i.source : ""} (${date})`);
    }
    lines.push("");
  }
  if (!found) lines.push("_Nothing new._");
  saveJson(SEEN_FILE, [...seen].sort());
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const clubs = loadJson(CLUBS_FILE, []);
  if (args.add) {
    clubs.push({ name: args.add, sport: args.sport, query: args.add });
    saveJson(CLUBS_FILE, clubs);
    return console.log(`Added ${args.add} (${args.sport})`);
  }
  if (args.list) return clubs.forEach((c) => console.log(`${c.name} (${c.sport})`));

  const digest = await buildDigest(clubs, args);
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  const out = path.join(DIGEST_DIR, `${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(out, digest);
  console.log(digest + `\n\nSaved to ${out}`);
}

module.exports = { fetchItems, loadJson, saveJson, CLUBS_FILE };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
