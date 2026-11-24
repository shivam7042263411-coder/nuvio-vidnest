import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCipheriv } from "node:crypto";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/megaplay.js");

// MegaPlay encrypts its sources payload with a fixed AES-256-CBC key/iv.
function encSources(value) {
  const key = Buffer.alloc(32);
  key.write("i?LMTAx0Q6,:}50U");
  const iv = Buffer.alloc(16);
  iv.write("W0;27ToaUpl_P%'c");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const out = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return out.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function html(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2094419,RESOLUTION=1920x1080,CODECS=\"avc1.640032\"\nindex-f1-v1-a1.m3u8\n";

function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: options.headers || {} });
    const route = routes.find((entry) => target.includes(entry.match));
    if (!route) throw new Error("unexpected request: " + target);
    return typeof route.response === "function" ? route.response(target) : route.response;
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
  };
}

const page = (id) => html(`<!doctype html><div id="megaplay-player" data-id="${id}" data-realid="1"></div>`);
const sources = (file, tracks = []) => json({ tracks, enc: encSources({ file }) });

test("exposes getStreams", () => {
  assert.equal(typeof getStreams, "function");
});

test("keys a kitsu episode through ARM and returns the HLS stream", async () => {
  const mock = mockFetch([
    { match: "arm.haglund.dev", response: () => json({ myanimelist: 21, themoviedb: 37854 }) },
    { match: "/stream/mal/21/1000/sub", response: () => page(38373) },
    { match: "/stream/getSources", response: () => sources("https://cdn.example/anime/hash/master.m3u8", [{ file: "https://cdn.subs/eng-2.vtt", label: "English", kind: "captions" }, { file: "https://cdn.subs/por-3.vtt", label: "Portuguese", kind: "captions" }]) },
    { match: "master.m3u8", response: () => new Response(master, { status: 200 }) }
  ]);

  try {
    const streams = await getStreams("kitsu:12:1000", "tv", 1, 1000);
    assert.equal(streams.length, 1);
    const [stream] = streams;
    assert.equal(stream.url, "https://cdn.example/anime/hash/master.m3u8");
    assert.equal(stream.quality, "1080p");
    assert.equal(stream.type, "hls");
    assert.equal(stream.provider, "MegaPlay");
    assert.equal(stream.language, "Japanese");
    assert.equal(stream.headers.Referer, "https://megaplay.buzz/");
    assert.deepEqual(stream.subtitles.map((s) => s.language), ["en"]);
    assert.equal(stream.subtitles[0].headers.Referer, "https://megaplay.buzz/");
    const armCall = mock.calls.find((call) => call.url.includes("arm.haglund.dev"));
    assert.ok(armCall && armCall.url.includes("source=kitsu") && armCall.url.includes("id=12"));
  } finally {
    mock.restore();
  }
});

test("trusts the episode number in the video id over a fake season", async () => {
  const mock = mockFetch([
    { match: "arm.haglund.dev", response: () => json({ myanimelist: 20 }) },
    { match: "/stream/mal/20/45/sub", response: () => page(104333) },
    { match: "/stream/getSources", response: () => sources("https://cdn.example/anime/x/master.m3u8") },
    { match: "master.m3u8", response: () => new Response(master, { status: 200 }) }
  ]);

  try {
    const streams = await getStreams("kitsu:11:45", "tv", 2, 5);
    assert.equal(streams.length, 1);
    assert.ok(mock.calls.some((call) => call.url.includes("/stream/mal/20/45/sub")));
  } finally {
    mock.restore();
  }
});

test("uses a MyAnimeList id directly, without ARM", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/21/12/sub", response: () => page(4000) },
    { match: "/stream/getSources", response: () => sources("https://cdn.example/anime/y/master.m3u8") },
    { match: "master.m3u8", response: () => new Response(master, { status: 200 }) }
  ]);

  try {
    const streams = await getStreams("mal:21:12", "tv", 1, 12);
    assert.equal(streams.length, 1);
    assert.ok(!mock.calls.some((call) => call.url.includes("arm.haglund.dev")));
  } finally {
    mock.restore();
  }
});

test("defaults an anime film to episode 1 when the id carries no number", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/40456/1/sub", response: () => page(32163) },
    { match: "/stream/getSources", response: () => sources("https://cdn.example/anime/z/master.m3u8") },
    { match: "master.m3u8", response: () => new Response(master, { status: 200 }) }
  ]);

  try {
    const streams = await getStreams("mal:40456", "movie");
    assert.equal(streams.length, 1);
    assert.ok(mock.calls.some((call) => call.url.includes("/stream/mal/40456/1/sub")));
  } finally {
    mock.restore();
  }
});

test("returns nothing for a non-anime TMDB id without a request", async () => {
  const mock = mockFetch([]);
  try {
    assert.deepEqual(await getStreams(550, "movie"), []);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("returns nothing when MegaPlay has no file for the episode", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/21/9999/sub", response: () => html("<title>Error - MegaPlay</title>") }
  ]);

  try {
    assert.deepEqual(await getStreams("mal:21:9999", "tv", 1, 9999), []);
    assert.ok(!mock.calls.some((call) => call.url.includes("getSources")));
  } finally {
    mock.restore();
  }
});

test("returns nothing when the payload carries no encrypted sources", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/21/1/sub", response: () => page(1) },
    { match: "/stream/getSources", response: () => json({ tracks: [] }) }
  ]);

  try {
    assert.deepEqual(await getStreams("mal:21:1", "tv", 1, 1), []);
  } finally {
    mock.restore();
  }
});

test("fails over to the alternate server when the primary host is down", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/21/1000/sub", response: () => page(38373) },
    {
      match: "/stream/getSources",
      response: (target) =>
        target.includes("s=tcdn")
          ? sources("https://megap.shiora.top/hash/master.m3u8")
          : sources("https://fetch.nexabloom.top/anime/hash/master.m3u8")
    },
    { match: "fetch.nexabloom.top", response: () => new Response("", { status: 404 }) },
    { match: "megap.shiora.top", response: () => new Response(master, { status: 200 }) }
  ]);

  try {
    const streams = await getStreams("mal:21:1000", "tv", 1, 1000);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "https://megap.shiora.top/hash/master.m3u8");
    assert.equal(streams[0].quality, "1080p");
  } finally {
    mock.restore();
  }
});

test("fails over to the check_domain fallback host when both hosts are down", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/21/1000/sub", response: () => page(38373) },
    {
      match: "/stream/getSources",
      response: (target) =>
        target.includes("s=tcdn")
          ? json({ tracks: [] })
          : sources("https://fetch.nexabloom.top/anime/hash/master.m3u8")
    },
    { match: "check_domain.json", response: () => json({ fallback: "xdw5v.qeltrix.top" }) },
    { match: "fetch.nexabloom.top", response: () => new Response("", { status: 404 }) },
    { match: "xdw5v.qeltrix.top", response: () => new Response(master, { status: 200 }) }
  ]);

  try {
    const streams = await getStreams("mal:21:1000", "tv", 1, 1000);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "https://xdw5v.qeltrix.top/anime/hash/master.m3u8");
    assert.equal(streams[0].quality, "1080p");
  } finally {
    mock.restore();
  }
});

// Regression: Nuvio's QuickJS sandbox has no setTimeout, so a provider that
// calls it returns nothing there (TV) while working on other devices.
test("works in the Nuvio sandbox, which has no setTimeout", async () => {
  const mock = mockFetch([
    { match: "/stream/mal/21/1/sub", response: () => page(1) },
    { match: "/stream/getSources", response: () => sources("https://cdn.example/anime/q/master.m3u8") },
    { match: "master.m3u8", response: () => new Response(master, { status: 200 }) }
  ]);
  const savedSetTimeout = globalThis.setTimeout;
  delete globalThis.setTimeout;

  try {
    const streams = await getStreams("mal:21:1", "tv", 1, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "https://cdn.example/anime/q/master.m3u8");
  } finally {
    globalThis.setTimeout = savedSetTimeout;
    mock.restore();
  }
});
