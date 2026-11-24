/**
 * VidLink provider for Nuvio.
 *
 * Uses VidLink's own JSON API. The TMDB id is first encrypted by enc-dec.app
 * (the same helper the 7movies front end uses), then the API returns direct
 * progressive MP4 qualities plus subtitle tracks. Ids from non-TMDB
 * catalogues (kitsu:/mal:/anilist:/anidb:/tvdb:/imdb) are resolved to TMDB
 * first, so anime catalogues work too.
 *
 * Source policy: MP4 only, no HLS, and 1080p or 4K only. A title whose best
 * quality is below 1080p returns nothing, except anime, where VidLink often
 * only carries 480p/720p and the best available quality is used instead.
 *
 * Headers matter: VidLink's media CDN (bcdn.hakunaymatata.com) answers 428
 * Forbidden to a browser User-Agent and 206 to "okhttp/4.12.0", so every
 * stream carries that UA for the player to forward.
 *
 * No request timeouts: Nuvio's plugin sandbox (QuickJS) has no setTimeout, so
 * an AbortController-based timeout throws ReferenceError and the whole scrape
 * returns nothing. That is how this provider used to fail on TV only.
 */

var VIDLINK_API = "https://vidlink.pro/api/b";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";

var WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";

var PREFERRED_QUALITY = 1080;

var API_HEADERS = {
  "User-Agent": WEB_UA,
  "Accept": "application/json",
  "Referer": "https://vidlink.pro/",
  "Origin": "https://vidlink.pro"
};

// The CDN answers 428 to a browser User-Agent, so the player must send this
// one. MovieBox's host additionally demands a referer; VidLink supplies its
// own per quality, so only the UA is unconditional here.
var STREAM_HEADERS = { "User-Agent": MEDIA_UA };

var SUBTITLE_LANGUAGES = {
  english: "en",
  hindi: "hi",
  spanish: "es",
  french: "fr",
  german: "de",
  arabic: "ar",
  portuguese: "pt",
  russian: "ru",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  tamil: "ta",
  telugu: "te"
};

function log() {
  try {
    console.log.apply(console, ["[VidLink]"].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {}
}

// The sandbox has no setTimeout/AbortController, so there is no request
// timeout here; the host enforces its own 60s plugin deadline.
async function request(url, headers) {
  var response = await fetch(url, { headers: headers });
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return await response.text();
}

async function requestJson(url, headers) {
  return JSON.parse(await request(url, headers));
}

// Nuvio passes whatever id the catalogue uses. TMDB ids arrive as digits and
// imdb ids as "tt...", but anime catalogues (AIOMetadata) use episode ids like
// "kitsu:47083:12" or "mal:52991:3", which no TMDB lookup accepts as-is.
// Resolve those to a TMDB id so the provider works with any catalogue and
// numbering the user picks.
var ARM_API = "https://arm.haglund.dev/api/v2/ids";
var ARM_SOURCES = { kitsu: "kitsu", mal: "myanimelist", myanimelist: "myanimelist", anilist: "anilist", anidb: "anidb" };
var TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

async function tmdbJson(path) {
  var hosts = ["https://api.themoviedb.org", "https://api.tmdb.org"];
  var query = path + (path.indexOf("?") < 0 ? "?api_key=" : "&api_key=") + TMDB_KEY;
  for (var i = 0; i < hosts.length; i++) {
    try {
      return await requestJson(hosts[i] + query, { Accept: "application/json" });
    } catch (e) {}
  }
  return null;
}

async function tmdbFind(externalSource, value) {
  var body = await tmdbJson("/3/find/" + encodeURIComponent(value) + "?external_source=" + externalSource);
  var results = (body && body.tv_results) || (body && body.movie_results) || [];
  return results.length && isPositiveInt(results[0].id) ? String(results[0].id) : "";
}

// shortcut: a single mapping service (ARM) resolves anime ids. If it is down,
// an anime id resolves to nothing and the title returns no sources, exactly as
// it did before; add a second source only if that proves flaky.
async function resolveId(rawId) {
  var raw = String(rawId == null ? "" : rawId).trim();
  var id = raw.replace(/^(tmdb|movie|series)[:/]/i, "");
  if (/^\d+$/.test(id)) return { id: id, anime: false };

  var match = /^([a-z-]+):(.+)$/i.exec(id);
  var source = match ? match[1].toLowerCase() : "";
  var value = (match ? match[2] : id).split(":")[0].split("/")[0];

  if (ARM_SOURCES[source]) {
    try {
      var mapped = await requestJson(
        ARM_API + "?source=" + ARM_SOURCES[source] + "&id=" + encodeURIComponent(value),
        { Accept: "application/json" }
      );
      var tmdb = mapped && mapped.themoviedb != null ? String(mapped.themoviedb).split(",")[0].trim() : "";
      if (isPositiveInt(tmdb)) return { id: tmdb, anime: true };
    } catch (e) {}
    return { id: "", anime: true };
  }
  if (source === "tvdb" && isPositiveInt(value)) return { id: await tmdbFind("tvdb_id", value), anime: false };

  var imdb = /(tt\d{5,})/i.exec(id);
  return { id: imdb ? await tmdbFind("imdb_id", imdb[1]) : "", anime: false };
}

// Long-running anime catalogues number episodes absolutely inside one season
// ("kitsu:11:100" = Naruto episode 100), but TMDB — and so VidLink — split
// those into seasons. When an episode is outside its TMDB season, read the
// number as absolute and map it onto TMDB's season layout. Returns null when
// the number already fits the requested season.
async function mapAnimeEpisode(tmdbId, season, episode) {
  var show = await tmdbJson("/3/tv/" + encodeURIComponent(tmdbId));
  var seasons = ((show && show.seasons) || [])
    .filter(function (s) { return s && s.season_number >= 1 && s.episode_count > 0; })
    .sort(function (a, b) { return a.season_number - b.season_number; });

  var current = null;
  seasons.forEach(function (s) { if (s.season_number === season) current = s; });
  if (!current || episode <= current.episode_count) return null;

  var offset = 0;
  for (var i = 0; i < seasons.length; i++) {
    if (episode <= offset + seasons[i].episode_count) {
      return { season: seasons[i].season_number, episode: episode - offset };
    }
    offset += seasons[i].episode_count;
  }
  return null;
}

function qualityLabel(height) {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  return height + "p";
}

function formatSize(bytes) {
  var value = Number(bytes);
  if (!isFinite(value) || value <= 0) return null;
  return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function languageCode(name) {
  var key = String(name || "").trim().toLowerCase();
  if (SUBTITLE_LANGUAGES[key]) return SUBTITLE_LANGUAGES[key];
  if (/^[a-z]{2}$/.test(key)) return key;
  return "und";
}

function subtitlesOf(stream) {
  var captions = Array.isArray(stream.captions) ? stream.captions : [];
  var out = [];
  var seen = {};
  captions.forEach(function (caption) {
    if (!caption || !caption.url || seen[caption.url]) return;
    seen[caption.url] = true;
    var name = caption.language || caption.label || caption.name || "Subtitle";
    out.push({
      url: caption.url,
      language: languageCode(name),
      name: name,
      headers: STREAM_HEADERS
    });
  });
  return out;
}

// VidLink ships a per-quality referer for the CDN (filmboom.top); keep the
// native media UA and forward whatever else the API asks for.
function playbackHeaders(source) {
  var headers = Object.assign({}, STREAM_HEADERS);
  var extra = (source && source.headers) || {};
  Object.keys(extra).forEach(function (key) {
    var value = extra[key];
    if (!value) return;
    if (/^referer$/i.test(key)) headers.Referer = value;
    else if (/^origin$/i.test(key)) headers.Origin = value;
    else if (/^user-agent$/i.test(key)) headers["User-Agent"] = MEDIA_UA;
    else headers[key] = value;
  });
  return headers;
}

// One entry per declared quality, keeping only 1080p and 4K. For anime
// (allowBelowPreferred) fall back to the best available quality instead of
// returning nothing, because VidLink often only carries 480p/720p for it.
function selectStreams(stream, subtitles, allowBelowPreferred) {
  var qualities = stream && stream.qualities ? stream.qualities : null;
  if (!qualities) return [];

  var entries = [];
  Object.keys(qualities).forEach(function (key) {
    var entry = qualities[key];
    if (!entry || !entry.url) return;
    var height = parseInt(key, 10);
    entries.push({
      height: isNaN(height) ? 0 : height,
      label: isNaN(height) ? "Auto" : qualityLabel(height),
      url: String(entry.url),
      size: formatSize(entry.size),
      headers: playbackHeaders(entry)
    });
  });
  if (!entries.length) return [];

  // 1080p and 4K only; a title whose best is below 1080p returns nothing,
  // unless it is anime, where playing the best available beats nothing.
  var chosen = entries.filter(function (entry) {
    return entry.height >= PREFERRED_QUALITY;
  });
  if (!chosen.length && allowBelowPreferred) {
    chosen = [entries.reduce(function (best, entry) {
      return entry.height > best.height ? entry : best;
    })];
  }

  return chosen.map(function (entry) {
    return {
      name: "VidLink • " + entry.label,
      title: "VidLink • " + entry.label + " • MP4",
      url: entry.url,
      quality: entry.label,
      size: entry.size,
      language: "Original",
      type: "mp4",
      provider: "VidLink",
      headers: entry.headers,
      subtitles: subtitles
    };
  });
}

function isPositiveInt(value) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  var number = Number(value);
  return isFinite(number) && number >= 0 && Math.floor(number) === number;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var resolved = await resolveId(tmdbId);
    if (!resolved.id) {
      log("could not resolve a TMDB id from " + tmdbId);
      return [];
    }
    var id = resolved.id;

    var kind = mediaType === "tv" ? "tv" : "movie";
    if (kind === "tv" && (!isPositiveInt(season) || !isPositiveInt(episode))) return [];

    // Anime catalogues number long shows absolutely in season 1; map that onto
    // the TMDB season VidLink actually uses.
    if (resolved.anime && kind === "tv" && season === 1) {
      var mapped = await mapAnimeEpisode(id, season, episode);
      if (mapped) {
        log("absolute episode " + episode + " -> S" + mapped.season + "E" + mapped.episode);
        season = mapped.season;
        episode = mapped.episode;
      }
    }

    var encoded = await requestJson(
      ENC_API + "?text=" + encodeURIComponent(id),
      { "User-Agent": WEB_UA, Accept: "application/json" }
    );
    if (!encoded || !encoded.result) {
      log(kind + " " + id + " -> no encrypted id");
      return [];
    }

    var url = kind === "tv"
      ? VIDLINK_API + "/tv/" + encodeURIComponent(encoded.result) + "/" + season + "/" + episode
      : VIDLINK_API + "/movie/" + encodeURIComponent(encoded.result);

    var payload = await requestJson(url, API_HEADERS);
    var stream = payload && payload.stream;
    if (!stream) {
      log(kind + " " + id + " -> no stream");
      return [];
    }

    var streams = selectStreams(stream, subtitlesOf(stream), resolved.anime);
    log(kind + " " + id + " -> " + streams.length + " source(s)");
    return streams;
  } catch (e) {
    log("getStreams failed: " + (e && e.message));
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}