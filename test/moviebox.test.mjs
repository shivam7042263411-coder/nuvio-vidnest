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

// TMDB spells it "Dan Da Dan"; MovieBox spells it "Dandadan". Spacing must not
// hide a whole series from the catalogue.
test("matches a MovieBox title that only differs by spacing", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = seriesFetch({
    tmdbId: 240411,
    name: "Dan Da Dan",
    year: "2024",
    subjects: [{ subjectId: "999", title: "Dandadan S1-S2", subjectType: 2, hasResource: true }],
    heights: [1080],
    seen
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("mal:57334", "tv", 1, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, "1080p");
    assert.equal(streams[0].language, "Japanese");
    assert.ok(seen.some((u) => u.includes("subject/play") && u.includes("subjectId=999")));
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

// Reached by a bare TMDB id, a film is still listed under a reworded title on
// MovieBox; the year-guarded word fallback must run for it too.
test("finds a film by a bare TMDB id when MovieBox rewords its title", async () => {
  const original = globalThis.fetch;
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: Object.assign({ "content-type": "application/json" }, headers)
    });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/3/movie/1311031")) {
      return json({ title: "Demon Slayer: Kimetsu no Yaiba Infinity Castle", release_date: "2025-09-12" });
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
                  subjectId: "999",
                  title: "Demon Slayer: Kimetsu no Yaiba- The Movie - Infinity Castle",
                  subjectType: 1,
                  hasResource: true,
                  releaseDate: "2025-09-12"
                }
              ]
            }
          ]
        }
      });
    }
    if (target.includes("subject-api/get")) {
      return json({ code: 0, data: { resourceDetectors: [] } });
    }
    if (target.includes("get-latest-app-pkgs")) {
      return json({}, { "x-user": JSON.stringify({ token: "h5-token" }) });
    }
    if (target.includes("web/post/list/subject")) {
      return json({ data: { items: [{ subject: { detailPath: "infinity-castle" } }] } });
    }
    if (target.includes("subject/play")) {
      return json({
        code: 0,
        data: {
          streams: [
            { format: "MP4", url: "https://bcdn.hakunaymatata.com/resource/ic-1080.mp4", resolutions: "1080", size: "1340000000" }
          ]
        }
      });
    }
    return json({});
  };

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("1311031", "movie");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, "1080p");
    assert.equal(streams[0].headers.Referer, "https://filmboom.top/");
  } finally {
    globalThis.fetch = original;
  }
});

// MovieBox lists the anime "ERASED" (genre Anime) and the live-action remake
// "Erased" (genre Drama) under one title. An anime id must pick the anime.
test("an anime id never resolves to a same-titled live-action release", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = seriesFetch({
    tmdbId: 65249,
    name: "Erased",
    year: "2016",
    subjects: [
      { subjectId: "LA", title: "Erased", subjectType: 2, hasResource: true, genre: "Drama, Fantasy, Mystery" },
      { subjectId: "AN", title: "ERASED", subjectType: 2, hasResource: true, genre: "Anime" }
    ],
    heights: [1080],
    seen
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("kitsu:11110", "tv", 1, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].language, "Japanese");
    const plays = seen.filter((u) => u.includes("subject/play"));
    assert.ok(plays.length > 0 && plays.every((u) => u.includes("subjectId=AN")), "only the anime release is played");
  } finally {
    globalThis.fetch = original;
  }
});

// Regression: Nuvio's QuickJS sandbox on Android TV has no setTimeout, so a
// provider that calls it returns nothing there while working elsewhere.
test("works in the Nuvio sandbox, which has no setTimeout", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = seriesFetch({
    tmdbId: 46260,
    name: "Naruto",
    year: "2002",
    subjects: [{ subjectId: "111", title: "Naruto", subjectType: 2, hasResource: true }],
    heights: [1080],
    seen
  });
  const savedTimeout = globalThis.setTimeout;
  delete globalThis.setTimeout;

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("kitsu:11:1", "tv", 1, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].language, "Japanese");
  } finally {
    globalThis.setTimeout = savedTimeout;
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

// Nuvio tags anime with its own "anime" media type (it is never normalized to
// "tv"), so the provider must run the series path for it.
test("plays an anime episode when Nuvio tags the content anime", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = seriesFetch({
    tmdbId: 46260,
    name: "Naruto",
    year: "2002",
    subjects: [{ subjectId: "111", title: "Naruto", subjectType: 2, hasResource: true }],
    heights: [1080],
    seen
  });

  try {
    const { getStreams } = require("../providers/moviebox.js");
    const streams = await getStreams("kitsu:11:100", "anime", 1, 100);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].language, "Japanese");
    assert.ok(seen.some((u) => u.includes("subject/play") && u.includes("subjectId=111")));
  } finally {
    globalThis.fetch = original;
  }
});

// An anime film carries no episode number, so the "anime" media type must fall
// back to the movie path instead of hunting for an episode.
test("an anime film tagged anime uses the movie path", async () => {
  const original = globalThis.fetch;
  const seen = [];
  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("arm.haglund.dev")) return json({ themoviedb: 635302 });
    if (target.includes("/3/movie/635302")) {
      return json({ title: "Demon Slayer the Movie: Mugen Train", release_date: "2020-10-16" });
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
      return json({
        code: 0,
        data: {
          resourceDetectors: [
            {
              resolutionList: [
                { resolution: 1080, resourceLink: "https://bcdn.hakunaymatata.com/resource/jp-1080.mp4", size: "2000000000" }
              ],
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
    const streams = await getStreams("mal:40456", "anime");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, "1080p");
    assert.ok(streams[0].name.includes("Japanese"), "an anime film keeps the Japanese audio");
    assert.ok(seen.some((u) => u.includes("/3/movie/635302")), "the film must resolve as a movie");
    assert.ok(!seen.some((u) => u.includes("subject/play")), "the series path must not run");
  } finally {
    globalThis.fetch = original;
  }
});
