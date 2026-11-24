import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/vidlink.js");

function quality(url, size = "1073741824") {
  return { type: "mp4", url, size, codecName: "hevc" };
}

function payload(qualities, captions = []) {
  return { sourceId: "test", stream: { id: "primary", type: "file", qualities, captions } };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: options.headers || {} });
    const route = routes.find((entry) => target.includes(entry.match));
    if (!route) throw new Error("unexpected request: " + target);
    return typeof route.response === "function" ? route.response() : route.response;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

const enc = { match: "enc-vidlink", response: () => json({ status: 200, result: "HASH123" }) };

test("returns the 1080p MP4 with player headers and subtitles", async () => {
  const mock = mockFetch([
    enc,
    {
      match: "/movie/HASH123",
      response: () =>
        json(
          payload(
            { 360: quality("https://cdn/360.mp4"), 720: quality("https://cdn/720.mp4"), 1080: quality("https://cdn/1080.mp4") },
            [
              { url: "https://cdn/en.srt", language: "English" },
              { url: "https://cdn/hi.srt", language: "Hindi" }
            ]
          )
        )
    }
  ]);

  try {
    const streams = await getStreams(550, "movie");

    assert.equal(streams.length, 1);
    const [stream] = streams;
    assert.equal(stream.url, "https://cdn/1080.mp4");
    assert.equal(stream.quality, "1080p");
    assert.equal(stream.type, "mp4");
    assert.equal(stream.provider, "VidLink");
    assert.equal(stream.size, "1.00 GB");
    assert.equal(stream.headers["User-Agent"], "okhttp/4.12.0");
    assert.deepEqual(stream.subtitles.map((s) => s.language), ["en", "hi"]);
    assert.equal(stream.subtitles[0].headers["User-Agent"], "okhttp/4.12.0");
  } finally {
    mock.restore();
  }
});

test("forwards the referer VidLink supplies for the CDN", async () => {
  const mock = mockFetch([
    enc,
    {
      match: "/movie/HASH123",
      response: () =>
        json(
          payload({
            1080: {
              ...quality("https://cdn/1080.mp4"),
              headers: { referer: "https://player.example/", origin: "https://player.example" }
            }
          })
        )
    }
  ]);

  try {
    const [stream] = await getStreams(550, "movie");
    assert.equal(stream.headers.Referer, "https://player.example/");
    assert.equal(stream.headers.Origin, "https://player.example");
    assert.equal(stream.headers["User-Agent"], "okhttp/4.12.0");
  } finally {
    mock.restore();
  }
});

test("sends no referer when VidLink supplies none", async () => {
  const mock = mockFetch([
    enc,
    { match: "/movie/HASH123", response: () => json(payload({ 1080: quality("https://cdn/1080.mp4") })) }
  ]);

  try {
    const [stream] = await getStreams(550, "movie");
    assert.deepEqual(stream.headers, { "User-Agent": "okhttp/4.12.0" });
  } finally {
    mock.restore();
  }
});

test("returns nothing when there is no 1080p or 4K", async () => {
  const mock = mockFetch([
    enc,
    {
      match: "/movie/HASH123",
      response: () =>
        json(payload({ 360: quality("https://cdn/360.mp4"), 720: quality("https://cdn/720.mp4") }))
    }
  ]);

  try {
    assert.deepEqual(await getStreams(550, "movie"), []);
  } finally {
    mock.restore();
  }
});

test("keeps 4K and 1080p while dropping lower qualities", async () => {
  const mock = mockFetch([
    enc,
    {
      match: "/movie/HASH123",
      response: () =>
        json(
          payload({
            720: quality("https://cdn/720.mp4"),
            1080: quality("https://cdn/1080.mp4"),
            2160: quality("https://cdn/4k.mp4")
          })
        )
    }
  ]);

  try {
    const streams = await getStreams(550, "movie");
    assert.deepEqual(streams.map((s) => s.quality).sort(), ["1080p", "4K"]);
    assert.deepEqual(streams.map((s) => s.url).sort(), ["https://cdn/1080.mp4", "https://cdn/4k.mp4"]);
  } finally {
    mock.restore();
  }
});

test("builds the TV path with season and episode", async () => {
  const mock = mockFetch([
    enc,
    { match: "/tv/HASH123/2/5", response: () => json(payload({ 1080: quality("https://cdn/ep.mp4") })) }
  ]);

  try {
    const streams = await getStreams(1396, "tv", 2, 5);
    assert.equal(streams.length, 1);
    assert.ok(mock.calls.some((call) => call.url.includes("/tv/HASH123/2/5")));
  } finally {
    mock.restore();
  }
});

test("skips quality entries without a URL", async () => {
  const mock = mockFetch([
    enc,
    {
      match: "/movie/HASH123",
      response: () =>
        json(payload({ 1080: quality("https://cdn/1080.mp4"), 720: { type: "mp4", url: "", size: "1" } }))
    }
  ]);

  try {
    const streams = await getStreams(550, "movie");
    assert.deepEqual(streams.map((s) => s.url), ["https://cdn/1080.mp4"]);
  } finally {
    mock.restore();
  }
});

test("returns nothing for an invalid id without making a request", async () => {
  const mock = mockFetch([]);
  try {
    assert.deepEqual(await getStreams("abc", "movie"), []);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("returns nothing when VidLink answers with an error", async () => {
  const mock = mockFetch([
    enc,
    { match: "/movie/HASH123", response: () => new Response("nope", { status: 404 }) }
  ]);

  try {
    assert.deepEqual(await getStreams(550, "movie"), []);
  } finally {
    mock.restore();
  }
});

// Regression: Nuvio's QuickJS plugin sandbox has no setTimeout, so a provider
// that calls it returns nothing there (TV) while working on other devices.
test("works in the Nuvio sandbox, which has no setTimeout", async () => {
  const mock = mockFetch([
    enc,
    { match: "/movie/HASH123", response: () => json(payload({ 1080: quality("https://cdn/1080.mp4") })) }
  ]);
  const savedSetTimeout = globalThis.setTimeout;
  delete globalThis.setTimeout;

  try {
    const streams = await getStreams(550, "movie");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "https://cdn/1080.mp4");
  } finally {
    globalThis.setTimeout = savedSetTimeout;
    mock.restore();
  }
});

test("drops duplicate subtitles and unknown language names", async () => {
  const mock = mockFetch([
    enc,
    {
      match: "/movie/HASH123",
      response: () =>
        json(
          payload({ 1080: quality("https://cdn/1080.mp4") }, [
            { url: "https://cdn/a.srt", language: "English" },
            { url: "https://cdn/a.srt", language: "English" },
            { url: "https://cdn/b.srt", language: "Klingon" }
          ])
        )
    }
  ]);

  try {
    const [stream] = await getStreams(550, "movie");
    assert.deepEqual(stream.subtitles.map((s) => [s.url, s.language]), [
      ["https://cdn/a.srt", "en"],
      ["https://cdn/b.srt", "und"]
    ]);
  } finally {
    mock.restore();
  }
});