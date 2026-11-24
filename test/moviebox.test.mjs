import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("vendored MovieBox provider exposes getStreams", () => {
  const provider = require("../providers/moviebox.js");
  assert.equal(typeof provider.getStreams, "function");
});

test("returns nothing when the MovieBox API yields no title", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  try {
    const { getStreams } = require("../providers/moviebox.js");
    assert.deepEqual(await getStreams(550, "movie"), []);
  } finally {
    globalThis.fetch = original;
  }
});

// Nuvio's anime catalogues pass "kitsu:47083:1" style ids, not TMDB ids.
test("resolves an anime id to TMDB before scraping MovieBox", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("arm.haglund.dev")) {
      return new Response(JSON.stringify({ themoviedb: 220542, "themoviedb-season": 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { getStreams } = require("../providers/moviebox.js");
    assert.deepEqual(await getStreams("kitsu:47083:1", "movie"), []);
    assert.ok(
      seen.some((u) => u.includes("arm.haglund.dev") && u.includes("source=kitsu") && u.includes("id=47083")),
      "ARM should be called with the kitsu id"
    );
    assert.ok(seen.some((u) => u.includes("/movie/220542")), "TMDB should be queried with the resolved id");
  } finally {
    globalThis.fetch = original;
  }
});
