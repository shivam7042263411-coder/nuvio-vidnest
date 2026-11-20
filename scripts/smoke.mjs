/**
 * Live smoke check against vidnest.fun.
 * Usage: node scripts/smoke.mjs [tmdbId] [movie|tv] [season] [episode]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/vidnest.js");

const [tmdbId = "550", mediaType = "movie", season, episode] = process.argv.slice(2);

if (typeof fetch !== "function" || !globalThis.crypto?.subtle) {
  console.error("Node 18+ with global fetch and WebCrypto is required.");
  process.exit(1);
}

const results = await getStreams(tmdbId, mediaType, season, episode);

if (results.length === 0) {
  console.error(`No sources returned for ${mediaType} ${tmdbId}. VidNest may be rate-limiting; retry in a minute.`);
  process.exit(2);
}

console.log(`${results.length} source(s) for ${mediaType} ${tmdbId}${mediaType === "tv" ? ` S${season}E${episode}` : ""}:`);
for (const result of results) {
  console.log(`- [${result.type}] ${result.quality} ${result.language} | ${result.name}`);
  console.log(`  ${result.url}`);
  if (Object.keys(result.headers).length > 0) console.log(`  headers: ${Object.keys(result.headers).join(", ")}`);
}