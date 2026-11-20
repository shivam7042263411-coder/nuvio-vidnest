import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/vidnest.js");

const SECRET = "K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2";
const realFetch = globalThis.fetch;

async function encrypt(payload) {
  const nonceBytes = webcrypto.getRandomValues(new Uint8Array(16));
  const nonce = Buffer.from(nonceBytes).toString("base64url");
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${nonce}|${SECRET}`)
  );
  const key = await webcrypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(payload))
    )
  );
  const combined = Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]);
  return { v: 2, n: nonce, d: combined.toString("base64url") };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers });
    return handler(String(url));
  };
  return calls;
}

test("movie: builds the VidNest movie URL, decrypts, and returns MP4 only", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  const calls = stubFetch(async (url) => {
    if (url.includes("/vidzee/movie/550")) {
      return response(await encrypt({
        streams: [{
          url: "https://s3.streamflixserver.site/movies/1999/fightclub.mkv",
          type: "mp4",
          quality: "auto",
          language: "English",
          headers: { Referer: "https://s3.streamflixserver.site/" },
        }],
      }));
    }
    return response({ streams: [{ url: `https://cdn.example/${url.length}.m3u8`, type: "hls" }] });
  });

  const results = await getStreams("550", "movie");

  assert.equal(calls.length, 3, "must stop after the MP4 batch");
  assert.ok(calls.every((call) => /\/movie\/550\?_n=[A-Za-z0-9_-]{22}$/.test(call.url)));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, "mp4");
  assert.match(results[0].url, /fightclub\.mkv$/);
  assert.equal(results[0].headers.Referer, "https://s3.streamflixserver.site/");
  assert.equal(results[0].quality, "Auto");
  assert.equal(results[0].language, "English");
  assert.match(results[0].name, /Gama/);
});

test("tv: builds season/episode URLs and falls back to HLS when no MP4 exists", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  const calls = stubFetch(async (url) => {
    const provider = url.split("/")[3];
    if (provider === "vidzee") return response({ error: "upstream" }, 502);
    const hls = { streams: [{ url: `https://cdn.example/${provider}.m3u8`, type: "hls", quality: "1080p" }] };
    return response(provider === "ophim" ? hls : await encrypt(hls));
  });

  const results = await getStreams("1396", "tv", 1, 2);

  assert.ok(calls.length > 3, "should query the whole provider list");
  assert.ok(calls.every((call) => /\/tv\/1396\/1\/2\?_n=[A-Za-z0-9_-]{22}$/.test(call.url)));
  assert.ok(results.length >= 10);
  assert.ok(results.every((result) => result.type === "hls"));
  assert.ok(results.some((result) => /Catflix/.test(result.name)));
  assert.ok(results.some((result) => /Sigma/.test(result.name)));
});

test("rejects invalid ids and incomplete TV coordinates without any request", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({}); };

  assert.deepEqual(await getStreams("tt0137523", "movie"), []);
  assert.deepEqual(await getStreams("", "movie"), []);
  assert.deepEqual(await getStreams("1396", "tv", null, 1), []);
  assert.deepEqual(await getStreams("1396", "tv", 1, null), []);
  assert.equal(calls, 0);
});

test("returns an empty list when every provider fails", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  globalThis.fetch = async () => response({ error: "bad gateway" }, 502);

  assert.deepEqual(await getStreams("550", "movie"), []);
});

test("movie: keeps only the 1080p tier when a server offers it", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  stubFetch(async (url) => {
    const quality = url.includes("/ophim/") ? "1080p" : "720p";
    return response(await encrypt({
      streams: [{ url: `https://cdn.example/${url.includes("/ophim/") ? "1080" : "720"}.mkv`, type: "mp4", quality }],
    }));
  });

  const results = await getStreams("550", "movie");

  assert.equal(results.length, 1);
  assert.equal(results[0].quality, "1080p");
  assert.match(results[0].url, /1080\.mkv$/);
});

test("tv: keeps only the 1080p tier when a 1080p server exists", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  stubFetch(async (url) => {
    const quality = url.split("/")[3] === "vidzee" ? "1080p" : "720p";
    return response(await encrypt({
      streams: [{ url: `https://cdn.example/${url.split("/")[3]}.m3u8`, type: "hls", quality }],
    }));
  });

  const results = await getStreams("1396", "tv", 1, 2);

  assert.ok(results.length >= 1);
  assert.ok(results.every((result) => result.quality === "1080p"));
});

test("tv: falls back to the highest tier when 1080p is absent", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  stubFetch(async (url) => {
    const host = url.split("/")[3];
    const quality = host === "vidzee" || host === "ophim" ? "720p" : "480p";
    return response(await encrypt({
      streams: [{ url: `https://cdn.example/${host}.m3u8`, type: "hls", quality }],
    }));
  });

  const results = await getStreams("1396", "tv", 1, 2);

  assert.ok(results.length >= 1);
  assert.ok(results.every((result) => result.quality === "720p"));
});