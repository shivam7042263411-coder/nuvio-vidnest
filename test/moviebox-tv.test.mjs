import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getStreams } = require("../providers/moviebox-tv.js");

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function tokenResponse() {
  return new Response("{}", {
    status: 200,
    headers: { "x-user": '{"token":"TOK"}' }
  });
}

function searchResponse(items) {
  return json({ code: 0, message: "ok", data: { items } });
}

function playResponse(streams) {
  return json({ code: 0, message: "ok", data: { streams } });
}

function detailResponse(detailPath) {
  return json({ code: 0, message: "ok", data: { items: [{ subject: { detailPath } }] } });
}

function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: options.headers || {}, body: options.body });
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

const meta = { match: "/movie/550", response: () => json({ title: "Fight Club", release_date: "1999-10-15" }) };
const pkgs = { match: "get-latest-app-pkgs", response: tokenResponse };

test("returns the 1080p MP4 from the Hindi dub with player headers", async () => {
  const mock = mockFetch([
    meta,
    pkgs,
    { match: "subject/search", response: () => searchResponse([{ subjectId: "1", title: "Fight Club [Hindi]", releaseDate: "1999-10-15" }]) },
    { match: "list/subject", response: () => detailResponse("fight-club-hindi") },
    {
      match: "subject/play",
      response: () =>
        playResponse([
          { resolutions: "480", url: "https://cdn/480.mp4", size: "800" },
          { resolutions: "1080", url: "https://cdn/1080.mp4", size: "2794807282" }
        ])
    }
  ]);

  try {
    const streams = await getStreams(550, "movie");

    assert.equal(streams.length, 1);
    const [stream] = streams;
    assert.equal(stream.url, "https://cdn/1080.mp4");
    assert.equal(stream.quality, "1080p");
    assert.equal(stream.language, "Hindi");
    assert.equal(stream.type, "mp4");
    assert.equal(stream.provider, "MovieBox");
    assert.equal(stream.size, "2.60 GB");
    assert.equal(stream.headers["User-Agent"], "okhttp/4.12.0");
    assert.equal(stream.headers.Referer, "https://filmboom.top/");
  } finally {
    mock.restore();
  }
});

test("returns English and Hindi as separate MP4 sources", async () => {
  const mock = mockFetch([
    meta,
    pkgs,
    {
      match: "subject/search",
      response: () =>
        searchResponse([
          { subjectId: "HI", title: "Fight Club [Hindi]", releaseDate: "1999-10-15" },
          { subjectId: "EN", title: "Fight Club", releaseDate: "1999-10-15" }
        ])
    },
    { match: "list/subject?id=EN", response: () => detailResponse("fc-en") },
    { match: "list/subject?id=HI", response: () => detailResponse("fc-hi") },
    {
      match: "subject/play?subjectId=EN",
      response: () => playResponse([{ resolutions: "1080", url: "https://cdn/en-1080.mp4" }])
    },
    {
      match: "subject/play?subjectId=HI",
      response: () => playResponse([{ resolutions: "1080", url: "https://cdn/hi-1080.mp4" }])
    }
  ]);

  try {
    const streams = await getStreams(550, "movie");
    assert.deepEqual(
      streams.map((s) => [s.language, s.url]),
      [
        ["Hindi", "https://cdn/hi-1080.mp4"],
        ["Original", "https://cdn/en-1080.mp4"]
      ]
    );
  } finally {
    mock.restore();
  }
});

test("treats an untagged title as the original audio", async () => {
  const mock = mockFetch([
    meta,
    pkgs,
    { match: "subject/search", response: () => searchResponse([{ subjectId: "2", title: "Fight Club", releaseDate: "1999-10-15" }]) },
    { match: "list/subject", response: () => detailResponse("fight-club") },
    { match: "subject/play", response: () => playResponse([{ resolutions: "1080", url: "https://cdn/en.mp4" }]) }
  ]);

  try {
    const [stream] = await getStreams(550, "movie");
    assert.equal(stream.language, "Original");
  } finally {
    mock.restore();
  }
});

test("drops dubs outside the English/Hindi policy", async () => {
  const mock = mockFetch([
    meta,
    pkgs,
    { match: "subject/search", response: () => searchResponse([{ subjectId: "3", title: "Fight Club [Tamil]", releaseDate: "1999-10-15" }]) },
    { match: "list/subject", response: () => detailResponse("fc-tamil") },
    { match: "subject/play", response: () => playResponse([{ resolutions: "1080", url: "https://cdn/ta.mp4" }]) }
  ]);

  try {
    assert.deepEqual(await getStreams(550, "movie"), []);
  } finally {
    mock.restore();
  }
});

test("falls back to the highest quality when there is no 1080p", async () => {
  const mock = mockFetch([
    meta,
    pkgs,
    { match: "subject/search", response: () => searchResponse([{ subjectId: "4", title: "Fight Club [Hindi]", releaseDate: "1999-10-15" }]) },
    { match: "list/subject", response: () => detailResponse("fc") },
    {
      match: "subject/play",
      response: () =>
        playResponse([
          { resolutions: "360", url: "https://cdn/360.mp4" },
          { resolutions: "720", url: "https://cdn/720.mp4" }
        ])
    }
  ]);

  try {
    const [stream] = await getStreams(550, "movie");
    assert.equal(stream.quality, "720p");
  } finally {
    mock.restore();
  }
});

test("skips a remake listed under the same title in another year", async () => {
  const mock = mockFetch([
    meta,
    pkgs,
    { match: "subject/search", response: () => searchResponse([{ subjectId: "5", title: "Fight Club [Hindi]", releaseDate: "2023-12-15" }]) }
  ]);

  try {
    assert.deepEqual(await getStreams(550, "movie"), []);
    assert.ok(!mock.calls.some((call) => call.url.includes("subject/play")));
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