import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/vidly.js");

const KEY = "vY7#qL2!mZ9@wK4$";
const IV = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// Mirrors the scraper's cipher so tests can mint v1 payloads.
function keystream(iv) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    let n = (0x811c9dc5 ^ Math.imul(0x9e3779b9, i)) >>> 0;
    for (let k = 0; k < KEY.length; k++) n = Math.imul(n ^ KEY.charCodeAt(k), 0x1000193) >>> 0;
    for (let j = 0; j < iv.length; j++) n = Math.imul(n ^ iv[j], 0x1000193) >>> 0;
    out.push(n);
  }
  return out;
}

function seal(value) {
  const data = Uint8Array.from(Buffer.from(JSON.stringify(value), "utf8"));
  let [a, b, c, d] = keystream(IV);
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  let r = 0;

  for (let t = 0; t < data.length; t++) {
    if ((t & 3) === 0) {
      let e = (a + b) | 0;
      a = (b ^ (b >>> 9)) >>> 0;
      b = (c + (c << 3)) | 0;
      c = (((c << 21) | (c >>> 11)) + (e = (e + ((d = (d + 1) | 0)) | 0))) | 0;
      r = e >>> 0;
    }
    data[t] ^= (r >>> ((t & 3) * 8)) & 255;
  }

  const combined = Buffer.concat([Buffer.from(IV), Buffer.from(data)]);
  return "v1." + combined.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function page(body) {
  return `{"token":"tok-test","sealed":"${body}"}`;
}

function stream(quality, language, url) {
  const item = { quality, type: "hls", url };
  if (language) item.language = language;
  return item;
}

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: options.headers || {} });
    const route = routes.find((entry) => target.includes(entry.match));
    if (!route) throw new Error("unexpected request: " + target);
    if (route.error) throw route.error;
    const status = route.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => route.body
    };
  };
  return calls;
}

const edge1080 = { provider: { id: "singularity", label: "Edge" }, streams: [stream("1080p", "", "https://cdn/edge1080.m3u8")] };

test("keeps only 1080p English and Hindi streams from Prism", async () => {
  const prism = {
    provider: { id: "prism", label: "Prism" },
    streams: [
      stream("1080p", "English", "https://cdn/en1080.m3u8"),
      stream("1080p", "Hindi", "https://cdn/hi1080.m3u8"),
      stream("1080p", "Arabic", "https://cdn/ar1080.m3u8"),
      stream("720p", "Hindi", "https://cdn/hi720.m3u8"),
      stream("1080p", "French", "https://cdn/fr1080.m3u8")
    ]
  };

  mockFetch([
    { match: "/api/sources", body: seal(prism) },
    { match: "vidly.pro/movie/", body: page(seal(edge1080)) }
  ]);

  const streams = await getStreams(550, "movie");

  assert.equal(streams.length, 3);
  assert.deepEqual(streams.map((s) => s.language), ["English", "Hindi", "Original"]);
  assert.deepEqual(streams.map((s) => s.name), ["Vidly • Prism", "Vidly • Prism", "Vidly • Edge"]);
  assert.ok(streams.every((s) => s.quality === "1080p"));
  assert.ok(streams.every((s) => s.headers && s.headers.Referer === "https://vidly.pro/"));
  assert.deepEqual(streams.map((s) => s.url), ["https://cdn/en1080.m3u8", "https://cdn/hi1080.m3u8", "https://cdn/edge1080.m3u8"]);
});

test("falls back to the page's sealed 1080p source when Prism has none", async () => {
  const prism = {
    provider: { id: "prism", label: "Prism" },
    streams: [stream("720p", "Hindi", "https://cdn/hi720.m3u8"), stream("480p", "English", "https://cdn/en480.m3u8")]
  };

  mockFetch([
    { match: "/api/sources", body: seal(prism) },
    { match: "vidly.pro/movie/", body: page(seal(edge1080)) }
  ]);

  const streams = await getStreams(550, "movie");

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, "Vidly • Edge");
  assert.equal(streams[0].url, "https://cdn/edge1080.m3u8");
  assert.equal(streams[0].language, "Original");
});

test("falls back when the Prism request fails", async () => {
  mockFetch([
    { match: "/api/sources", status: 502, body: "bad gateway" },
    { match: "vidly.pro/movie/", body: page(seal(edge1080)) }
  ]);

  const streams = await getStreams(550, "movie");

  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, "https://cdn/edge1080.m3u8");
});

test("returns nothing when no 1080p source exists", async () => {
  const prism = { provider: { id: "prism", label: "Prism" }, streams: [stream("720p", "Hindi", "https://cdn/hi720.m3u8")] };

  mockFetch([
    { match: "/api/sources", body: seal(prism) },
    { match: "vidly.pro/movie/", body: page(seal({ provider: { id: "singularity" }, streams: [stream("720p", "", "https://cdn/edge720.m3u8")] })) }
  ]);

  assert.deepEqual(await getStreams(550, "movie"), []);
});

test("decrypts a real vidly sealed payload", async () => {
  const realSealed =
    "v1.dHxPT5slypyUtlPcKYdLubfFRpQY2211ACOKXxCILWycp1dhmGrsFq21P6Mfpr4aX3jjUHq2xpt32payvoMwFRu3Zs_lS1qLP-5audWw97wdfZHy-E1DD7itKFRF-WQC6wUExnOBLTG1B120YbYj3M9azYUuNrmC3yDR3HkotQFUSH90B-rK9Xg9zzNMhX4265obEx7Wm39RSzz6maDgAi9VeVz0V0BqNlFt7-jGgO9rj3FXqNXJa1ruL1ExC46_5dajlIpb21oZ0J7U9EDDQc-wGwe1FWRNTswLjZ2r_-fJrCqWDAtAzKOWTHKEnm12FNi728f7WKMR3_XXocagrsydbaxNyILVUSiPeg3TX_uuVZDt4X-9A7WZGjVpu6y7yQFbnVi8Sn5dokqKYPrlhZCVw2jJzJu9CF8W2v7--4_-IawtmF-ej3qDI66MJjezUajuR5TuafS-U8IEIu-V7-RiqnLWDLcFMU_kwTAu6-9Tb_AGvWKwWIyiVirYe8WOlYtt9bxVAijGrOR-tKHLJoJXgYwOpuCXkPRTeyClzROaWXlkHh09XOU1tNdW-V7Ez6beL4Jjoyqis8BDRf7HGq3w8jHfJiOvmYYgK6cnVfhmKji8pFNeHLX3xVjaPFQMfE-_e_VGe-9sD7Wzm_N-1RV51dgGaWL0OChllU1yimo5LPqDrd7zIZ6CjyAVYhwjxkrTJtS3gCqrqjmEQ9FfCNFFe4szoZhEQkXBM8dhBa1bLUoW2Z8RNEoj9g318icL3fGRv0iN";

  mockFetch([
    { match: "/api/sources", body: seal({ provider: { id: "prism" }, streams: [] }) },
    { match: "vidly.pro/movie/", body: `{\\"token\\":\\"tok-test\\",\\"sealed\\":\\"${realSealed}\\"}` }
  ]);

  const streams = await getStreams(550, "movie");

  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, "https://img.rousav.tech/media/84ba08366bab854da1bf/index.m3u8");
  assert.equal(streams[0].quality, "1080p");
});

test("builds the TV path and passes season and episode to the API", async () => {
  const prism = { provider: { id: "prism", label: "Prism" }, streams: [stream("1080p", "Original", "https://cdn/tv1080.m3u8")] };

  const calls = mockFetch([
    { match: "/api/sources", body: seal(prism) },
    { match: "vidly.pro/tv/", body: page(seal({ provider: { id: "evion" }, streams: [] })) }
  ]);

  const streams = await getStreams(1396, "tv", 2, 3);

  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, "https://cdn/tv1080.m3u8");
  assert.ok(calls[0].url.includes("/tv/1396/2/3"));
  assert.ok(calls[1].url.includes("kind=tv"));
  assert.ok(calls[1].url.includes("provider=prism"));
  assert.ok(calls[1].url.includes("tmdb=1396"));
  assert.ok(calls[1].url.includes("s=2"));
  assert.ok(calls[1].url.includes("e=3"));
});

test("ignores invalid ids without making a request", async () => {
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    throw new Error("should not be called");
  };

  assert.deepEqual(await getStreams("abc", "movie"), []);
  assert.deepEqual(await getStreams(550, "tv"), []);
  assert.equal(requested, false);
});