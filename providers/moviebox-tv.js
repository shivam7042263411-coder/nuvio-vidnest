/**
 * MovieBox series provider for Nuvio.
 *
 * Companion to providers/moviebox.js (the MovieBox mobile-API provider, movies
 * only). That API returns aggregator pages instead of streams for episodes, so
 * series go through MovieBox's H5 API here (h5-api.aoneroom.com), the same
 * endpoints the web player calls: app token -> title search -> subject detail
 * -> play?se=&ep=.
 *
 * Source policy: MP4 only, 1080p when MovieBox has it, otherwise the highest
 * quality it offers. Hindi dubs are separate releases ("Title [Hindi]"); the
 * best release per language is returned, so English and Hindi come back
 * together. Other dubs are dropped.
 *
 * Headers matter: the media CDN rejects a browser User-Agent (428) and wants
 * "okhttp/4.12.0", so every stream carries that UA for the player.
 */

var MOVIEBOX_API = "https://h5-api.aoneroom.com";
var MOVIEBOX_WEB = "https://h5.aoneroom.com";
var TMDB_API = "https://api.themoviedb.org/3";
var TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

var WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";

var PREFERRED_QUALITY = "1080";
var SEARCH_TIMEOUT_MS = 8000;
var PLAY_TIMEOUT_MS = 10000;
var TOTAL_BUDGET_MS = 15000;
var MAX_LANGUAGES = 2;

var API_HEADERS = {
  "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
  "Accept-Language": "en-US,en;q=0.5",
  "Accept": "application/json",
  "Referer": MOVIEBOX_API,
  "Host": "h5-api.aoneroom.com",
  "User-Agent": WEB_UA
};

// The JSON API expects the web player origin; the media CDN expects its own
// referer, filmboom.top. Same host as VidLink's CDN, same allowlist.
var PLAYER_ORIGIN = "https://fmoviesunblocked.net";
var MEDIA_HEADERS = {
  "User-Agent": MEDIA_UA,
  "Referer": "https://filmboom.top/",
  "Origin": "https://filmboom.top"
};

function log() {
  try {
    console.log.apply(console, ["[MovieBox]"].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {}
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Both APIs drop connections when busy; retries absorb that.
async function request(url, options, timeoutMs) {
  var lastError;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(200);
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    try {
      var response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
      return { response: response, text: await response.text() };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function requestJson(url, options, timeoutMs) {
  var result = await request(url, options, timeoutMs);
  return { response: result.response, json: JSON.parse(result.text) };
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s*\[[^\]]*\]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleYear(value) {
  var match = String(value || "").match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "";
}

async function fetchMeta(id, kind) {
  var url = TMDB_API + "/" + kind + "/" + encodeURIComponent(id) + "?api_key=" + TMDB_KEY + "&language=en-US";
  var result = await requestJson(url, { headers: { Accept: "application/json" } }, SEARCH_TIMEOUT_MS);
  var data = result.json || {};
  var date = data.release_date || data.first_air_date || "";
  return { title: data.title || data.name || "", year: String(date).slice(0, 4) };
}

async function fetchToken() {
  var result = await request(
    MOVIEBOX_API + "/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox",
    { headers: { "User-Agent": WEB_UA } },
    SEARCH_TIMEOUT_MS
  );
  try {
    return JSON.parse(result.response.headers.get("x-user") || "{}").token || "";
  } catch (e) {
    return "";
  }
}

async function searchSubjects(title, kind, token) {
  var headers = Object.assign({}, API_HEADERS, {
    "Content-Type": "application/json",
    Authorization: "Bearer " + token
  });
  var result = await requestJson(
    MOVIEBOX_API + "/wefeed-h5api-bff/subject/search",
    {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        keyword: title,
        page: 1,
        perPage: 24,
        subjectType: kind === "tv" ? 2 : 1
      })
    },
    SEARCH_TIMEOUT_MS
  );
  var data = (result.json && result.json.data) || {};
  return Array.isArray(data.items) ? data.items : [];
}

// Best release first: exact title + matching year, then title matches, then the
// rest. MovieBox lists remakes and regional dubs under near-identical names.
function rankCandidates(items, meta) {
  var want = cleanTitle(meta.title).toLowerCase();
  var scored = [];
  items.forEach(function (item, index) {
    var lower = cleanTitle(item.title).toLowerCase();
    var score = 0;
    if (lower === want) score += 4;
    else if (lower.indexOf(want) === 0) score += 2;
    else if (want.indexOf(lower) === 0) score += 1;
    if (meta.year && titleYear(item.releaseDate) === meta.year) score += 4;
    if (score === 0 && meta.year && titleYear(item.releaseDate) !== meta.year) return;
    scored.push({ item: item, score: score, index: index });
  });
  scored.sort(function (a, b) {
    return b.score - a.score || a.index - b.index;
  });
  return scored.map(function (entry) {
    return entry.item;
  });
}

async function fetchDetailPath(subjectId) {
  var result = await requestJson(
    MOVIEBOX_WEB + "/wefeed-h5-bff/web/post/list/subject?id=" + encodeURIComponent(subjectId),
    { headers: { "User-Agent": WEB_UA } },
    SEARCH_TIMEOUT_MS
  );
  var items = ((result.json && result.json.data) || {}).items || [];
  var subject = items.length && items[0].subject ? items[0].subject : null;
  return subject && subject.detailPath ? subject.detailPath : "";
}

async function fetchPlay(subjectId, detailPath, kind, season, episode, token) {
  var params =
    "subjectId=" + encodeURIComponent(subjectId) +
    (kind === "tv" ? "&se=" + encodeURIComponent(season) + "&ep=" + encodeURIComponent(episode) : "") +
    (detailPath ? "&detailPath=" + encodeURIComponent(detailPath) : "");

  var headers = Object.assign({}, API_HEADERS, {
    Authorization: "Bearer " + token,
    Referer: PLAYER_ORIGIN + "/spa/videoPlayPage/movies/" + detailPath + "?id=" + subjectId + "&type=/movie/detail",
    Origin: PLAYER_ORIGIN
  });

  var result = await requestJson(
    MOVIEBOX_API + "/wefeed-h5api-bff/subject/play?" + params,
    { headers: headers },
    PLAY_TIMEOUT_MS
  );
  var data = (result.json && result.json.data) || {};
  return Array.isArray(data.streams) ? data.streams : [];
}

function languageOf(item) {
  var tag = (String(item.title || "").match(/\[([^\]]+)\]/) || [])[1];
  if (!tag) return "Original";
  if (/hindi/i.test(tag)) return "Hindi";
  if (/english|^eng$/i.test(tag)) return "English";
  return ""; // other dubs are outside the English/Hindi policy
}

function formatSize(bytes) {
  var value = Number(bytes);
  if (!isFinite(value) || value <= 0) return null;
  return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

// MP4 only, 1080p when available, otherwise the highest resolution on offer.
function selectStreams(item, streams) {
  var language = languageOf(item);
  if (!language) return [];

  var candidates = streams
    .filter(function (stream) {
      return stream && stream.url && !stream.vipLocked;
    })
    .map(function (stream) {
      return {
        height: parseInt(stream.resolutions || stream.resolution, 10) || 0,
        url: String(stream.url),
        size: formatSize(stream.size)
      };
    })
    .filter(function (stream) {
      return stream.height > 0;
    });
  if (!candidates.length) return [];

  var top = candidates.reduce(function (best, entry) {
    return entry.height > best.height ? entry : best;
  });
  var chosen = top.height >= Number(PREFERRED_QUALITY)
    ? candidates.filter(function (entry) {
        return entry.height >= Number(PREFERRED_QUALITY);
      })
    : [top];

  var seen = {};
  var out = [];
  chosen.forEach(function (entry) {
    if (seen[entry.url]) return;
    seen[entry.url] = true;
    out.push({
      name: "MovieBox • " + language,
      title: "MovieBox • " + entry.height + "p • " + language + " • MP4",
      url: entry.url,
      quality: entry.height + "p",
      size: entry.size,
      language: language,
      type: "mp4",
      provider: "MovieBox",
      headers: MEDIA_HEADERS
    });
  });
  return out;
}

// MovieBox files each dub as its own release ("Title [Hindi]"), so keep only
// the best release per language. That is what returns English and Hindi side
// by side instead of whichever dub the search happens to rank first.
function bestPerLanguage(candidates) {
  var seen = {};
  var out = [];
  candidates.forEach(function (item) {
    var language = languageOf(item);
    if (!language || seen[language]) return;
    seen[language] = true;
    out.push(item);
  });
  return out;
}

async function sourcesFor(item, kind, season, episode, token, deadline) {
  if (Date.now() > deadline) return [];
  var subjectId = item.subjectId || item.id;
  if (!subjectId) return [];

  var detailPath = await fetchDetailPath(subjectId);
  var streams = await fetchPlay(subjectId, detailPath, kind, season, episode, token);
  return selectStreams(item, streams);
}

function isPositiveInt(value) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  var number = Number(value);
  return isFinite(number) && number >= 0 && Math.floor(number) === number;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var id = String(tmdbId == null ? "" : tmdbId).trim();
    if (!/^\d+$/.test(id)) return [];

    var kind = mediaType === "tv" ? "tv" : "movie";
    if (kind === "tv" && (!isPositiveInt(season) || !isPositiveInt(episode))) return [];

    var deadline = Date.now() + TOTAL_BUDGET_MS;
    var meta;
    var token;
    try {
      var results = await Promise.all([fetchMeta(id, kind), fetchToken()]);
      meta = results[0];
      token = results[1];
    } catch (e) {
      log(kind + " " + id + " -> metadata failed: " + e.message);
      return [];
    }
    if (!meta.title) return [];

    var items = await searchSubjects(meta.title, kind, token);
    var candidates = bestPerLanguage(rankCandidates(items, meta)).slice(0, MAX_LANGUAGES);

    var final = [];
    var seen = {};
    for (var i = 0; i < candidates.length; i++) {
      var found = await sourcesFor(candidates[i], kind, season, episode, token, deadline);
      found.forEach(function (stream) {
        if (seen[stream.url]) return;
        seen[stream.url] = true;
        final.push(stream);
      });
    }

    log(kind + " " + id + " -> " + final.length + " source(s)");
    return final;
  } catch (e) {
    log("getStreams failed: " + (e && e.message));
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}