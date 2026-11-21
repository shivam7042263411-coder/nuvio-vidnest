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
