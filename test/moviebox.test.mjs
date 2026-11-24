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

// Series live behind MovieBox's H5 API; the mobile API returns no episode
// files. Mock the whole chain: ARM -> TMDB -> search -> H5 play.
function seriesFetch({ tmdbId, name, year, subjects, heights, seen, only }) {
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: Object.assign({ "content-type": "application/json" }, headers)
    });

  return async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("arm.haglund.dev")) return json({ themoviedb: Number(tmdbId) });
    if (target.includes("/3/tv/" + tmdbId)) return json({ name, first_air_date: year + "-01-01" });
    if (target.includes("visitor-login")) return json({ code: 0, data: { token: "mobile-token" } });
    if (target.includes("search/v2")) return json({ code: 0, data: { results: [{ subjects }] } });
    if (target.includes("get-latest-app-pkgs")) {
      return json({}, { "x-user": JSON.stringify({ token: "h5-token" }) });
    }
    if (target.includes("web/post/list/subject")) {
      return json({ data: { items: [{ subject: { detailPath: "show-abc" } }] } });
    }
    if (target.includes("subject/play")) {
      const subjectId = (/subjectId=(\w+)/.exec(target) || [])[1];
      const se = Number((/se=(\d+)/.exec(target) || [])[1]);
      const ep = Number((/ep=(\d+)/.exec(target) || [])[1]);
      const list = only && (only.se !== se || only.ep !== ep) ? [] : heights;
      return json({
        code: 0,
        data: {
          streams: list.map((height) => ({
            format: "MP4",
            url: "https://bcdnxw.hakunaymatata.com/resource/" + subjectId + "-" + height + ".mp4",
            resolutions: String(height),
            size: "1000000000"
          }))
        }
      });
    }
    return json({});
  };
}

test("plays an anime series episode through the H5 API with Japanese audio", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = seriesFetch({
    tmdbId: 46260,
    name: "Naruto",
    year: "2002",
    subjects: [
      { subjectId: "111", title: "Naruto", subjectType: 2, hasResource: true },
      { subjectId: "222", title: "Naruto [Hindi] S1-S2", subjectType: 2, hasResource: true }
    ],
    heights: [720],
    seen
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("kitsu:11:100", "tv", 1, 100);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, "720p");
    assert.equal(streams[0].language, "Japanese");
    assert.equal(streams[0].headers.Referer, "https://filmboom.top/");

    const plays = seen.filter((u) => u.includes("subject/play"));
    assert.equal(plays.length, 1, "only the original release is played");
    assert.ok(plays[0].includes("subjectId=111"));
    assert.ok(plays[0].includes("se=1") && plays[0].includes("ep=100"));
  } finally {
    globalThis.fetch = original;
  }
});

test("plays the season the app passed when MovieBox splits merged TMDB seasons", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = seriesFetch({
    tmdbId: 95479,
    name: "JUJUTSU KAISEN",
    year: "2020",
    subjects: [{ subjectId: "777", title: "Jujutsu Kaisen S1-S3", subjectType: 2, hasResource: true }],
    heights: [1080],
    seen,
    only: { se: 2, ep: 1 }
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("kitsu:40748:25", "tv", 2, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].language, "Japanese");
    assert.ok(seen.some((u) => u.includes("subject/play") && u.includes("se=2") && u.includes("ep=1")));
  } finally {
    globalThis.fetch = original;
  }
});

// Anime films are listed on the web player even when the mobile API has only
// an empty shell for them.
test("falls back to the H5 player for an anime film with no mobile file", async () => {
  const original = globalThis.fetch;
  const seen = [];
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: Object.assign({ "content-type": "application/json" }, headers)
    });
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("arm.haglund.dev")) return json({ themoviedb: 635302 });
    if (target.includes("/3/movie/635302")) {
      return json({ title: "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train", release_date: "2020-10-16" });
    }
    if (target.includes("visitor-login")) return json({ code: 0, data: { token: "mobile-token" } });
    if (target.includes("search/v2")) {
      return json({
        code: 0,
        data: {
          results: [
            {
              subjects: [
                {
                  subjectId: "888",
                  title: "Demon Slayer the Movie: Mugen Train",
                  subjectType: 1,
                  hasResource: true,
                  releaseDate: "2021-04-23"
                }
              ]
            }
          ]
        }
      });
    }
    if (target.includes("subject-api/get")) {
      return json({ code: 0, data: { resourceDetectors: [{ resolutionList: [], downloadUrl: "", resourceLink: "https://ailok.pe/info/x" }] } });
    }
    if (target.includes("get-latest-app-pkgs")) {
      return json({}, { "x-user": JSON.stringify({ token: "h5-token" }) });
    }
    if (target.includes("web/post/list/subject")) {
      return json({ data: { items: [{ subject: { detailPath: "mugen-train" } }] } });
    }
    if (target.includes("subject/play")) {
      return json({
        code: 0,
        data: {
          streams: [
            { format: "MP4", url: "https://bcdnxw.hakunaymatata.com/resource/jp-1080.mp4", resolutions: "1080", size: "2391937826" },
            { format: "MP4", url: "https://bcdnxw.hakunaymatata.com/tran-audio/hi-480.mp4", resolutions: "480", size: "464894769" }
          ]
        }
      });
    }
    return json({});
  };

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("mal:40456", "movie");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, "1080p");
    assert.equal(streams[0].language, "Japanese");
    assert.ok(!streams[0].url.includes("tran-audio"));
    assert.equal(streams[0].headers.Referer, "https://filmboom.top/");
    assert.ok(seen.some((u) => u.includes("subject/play") && u.includes("se=0") && u.includes("ep=0")));
  } finally {
    globalThis.fetch = original;
  }
});

test("returns nothing for anime when only a dubbed release exists", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = seriesFetch({
    tmdbId: 46260,
    name: "Naruto",
    year: "2002",
    subjects: [{ subjectId: "222", title: "Naruto [Hindi] S1-S2", subjectType: 2, hasResource: true }],
    heights: [1080],
    seen: []
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    assert.deepEqual(await getStreams("kitsu:11:1", "tv", 1, 1), []);
  } finally {
    globalThis.fetch = original;
  }
});

test("non-anime series keeps the original and Hindi at 1080p", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = seriesFetch({
    tmdbId: 1396,
    name: "Breaking Bad",
    year: "2008",
    subjects: [
      { subjectId: "333", title: "Breaking Bad S2", subjectType: 2, hasResource: true },
      { subjectId: "444", title: "Breaking Bad [Hindi] S2", subjectType: 2, hasResource: true }
    ],
    heights: [1080, 720],
    seen: []
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams(1396, "tv", 2, 1);
    assert.equal(streams.length, 2);
    assert.deepEqual(
      streams.map((s) => s.quality),
      ["1080p", "1080p"]
    );
    assert.deepEqual(
      streams.map((s) => s.language).sort(),
      ["Hindi", "Original"]
    );
  } finally {
    globalThis.fetch = original;
  }
});

// Regression: releases that carry one direct URL instead of a resolution list
// used to throw while attaching the cookie and silently drop the stream.
test("keeps a movie release that only carries a direct download URL", async () => {
  const original = globalThis.fetch;
  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/3/movie/155")) return json({ title: "The Dark Knight", release_date: "2008-07-18" });
    if (target.includes("visitor-login")) return json({ code: 0, data: { token: "mobile-token" } });
    if (target.includes("search/v2")) {
      return json({
        code: 0,
        data: { results: [{ subjects: [{ subjectId: "555", title: "The Dark Knight", subjectType: 1, hasResource: true }] }] }
      });
    }
    if (target.includes("subject-api/get")) {
      return json({
        code: 0,
        data: {
          title: "The Dark Knight",
          resourceDetectors: [
            {
              type: 0,
              totalSize: "2000000000",
              resourceLink: "https://example.com/page",
              downloadUrl: "https://bcdn.hakunaymatata.com/resource/dark.mp4",
              resolutionList: [],
              signCookie: ""
            }
          ]
        }
      });
    }
    return json({});
  };

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams(155, "movie");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "https://bcdn.hakunaymatata.com/resource/dark.mp4");
    assert.equal(streams[0].headers.Cookie, "mobile-token");
  } finally {
    globalThis.fetch = original;
  }
});
