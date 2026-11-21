/**
 * Live smoke check against vidly.pro.
 * Usage: node scripts/smoke.mjs [tmdbId] [movie|tv] [season] [episode]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/vidly.js");

const [tmdbId = "550", mediaType = "movie", season, episode] = process.argv.slice(2);

if (typeof fetch !== "function") {
  console.error("Node 18+ with global fetch is required.");
  process.exit(1);
}

const results = await getStreams(tmdbId, mediaType, season, episode);

if (results.length === 0) {
  console.error(`No 1080p sources returned for ${mediaType} ${tmdbId}. Vidly may be rate-limiting; retry in a minute.`);
  process.exit(2);
}

console.log(`${results.length} source(s) for ${mediaType} ${tmdbId}${mediaType === "tv" ? ` S${season}E${episode}` : ""}:`);
for (const result of results) {
  console.log(`- [${result.type}] ${result.quality} ${result.language} | ${result.name}`);
  console.log(`  ${result.url}`);
}