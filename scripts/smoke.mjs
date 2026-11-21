/**
 * Live smoke check against VidLink or MovieBox.
 * Usage: PROVIDER=moviebox|moviebox-tv node scripts/smoke.mjs [tmdbId] [movie|tv] [season] [episode]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const provider = ["moviebox", "moviebox-tv"].includes(process.env.PROVIDER) ? process.env.PROVIDER : "vidlink";
const { getStreams } = require(`../providers/${provider}.js`);

const [tmdbId = "603", mediaType = "movie", season, episode] = process.argv.slice(2);

if (typeof fetch !== "function") {
  console.error("Node 18+ with global fetch is required.");
  process.exit(1);
}

const results = await getStreams(tmdbId, mediaType, season, episode);

if (results.length === 0) {
  console.error(`No MP4 sources returned for ${mediaType} ${tmdbId} (${provider}).`);
  process.exit(2);
}

console.log(`${results.length} source(s) for ${mediaType} ${tmdbId}${mediaType === "tv" ? ` S${season}E${episode}` : ""} (${provider}):`);
for (const result of results) {
  console.log(`- [${result.type || "mp4"}] ${result.quality} ${result.language || ""} ${result.size || ""} | ${result.name}`);
  console.log(`  ${result.url}`);
}

// A stream is only useful if the media CDN serves bytes to the headers we ship.
const [first] = results;
const probe = await fetch(first.url, {
  headers: { ...(first.headers || {}), Range: "bytes=0-1023" }
});
console.log(`media check: HTTP ${probe.status} ${probe.headers.get("content-type")}`);
process.exit(probe.ok ? 0 : 3);
