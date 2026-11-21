/**
 * VidLink provider for Nuvio.
 *
 * Uses VidLink's own JSON API. The TMDB id is first encrypted by enc-dec.app
 * (the same helper the 7movies front end uses), then the API returns direct
 * progressive MP4 qualities plus subtitle tracks.
 *
 * Source policy: MP4 only, no HLS. 1080p is returned when VidLink has it,
 * otherwise the highest quality it offers, so a title never comes back empty
 * just because it tops out at 720p.
 *
 * Headers matter: VidLink's media CDN (bcdn.hakunaymatata.com) answers 428
 * Forbidden to a browser User-Agent and 206 to "okhttp/4.12.0", so every
 * stream carries that UA for the player to forward.
 */

var VIDLINK_API = "https://vidlink.pro/api/b";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";

var WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";

var PREFERRED_QUALITY = 1080;
var REQUEST_TIMEOUT_MS = 6000;
var TOTAL_BUDGET_MS = 12000;

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

async function request(url, headers, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  try {
    var response = await fetch(url, { headers: headers, signal: controller.signal });
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, headers, timeoutMs) {
  return JSON.parse(await request(url, headers, timeoutMs));
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

// One entry per declared quality. 1080p wins; without it the highest wins.
function selectStreams(stream, subtitles) {
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

  var top = entries.reduce(function (best, entry) {
    return entry.height > best.height ? entry : best;
  });
  var chosen = top.height >= PREFERRED_QUALITY
    ? entries.filter(function (entry) {
        return entry.height >= PREFERRED_QUALITY;
      })
    : [top];

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
    var id = String(tmdbId == null ? "" : tmdbId).trim();
    if (!/^\d+$/.test(id)) return [];

    var kind = mediaType === "tv" ? "tv" : "movie";
    if (kind === "tv" && (!isPositiveInt(season) || !isPositiveInt(episode))) return [];

    var deadline = Date.now() + TOTAL_BUDGET_MS;

    var encoded = await requestJson(
      ENC_API + "?text=" + encodeURIComponent(id),
      { "User-Agent": WEB_UA, Accept: "application/json" },
      Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())
    );
    if (!encoded || !encoded.result) {
      log(kind + " " + id + " -> no encrypted id");
      return [];
    }

    var url = kind === "tv"
      ? VIDLINK_API + "/tv/" + encodeURIComponent(encoded.result) + "/" + season + "/" + episode
      : VIDLINK_API + "/movie/" + encodeURIComponent(encoded.result);

    var payload = await requestJson(
      url,
      API_HEADERS,
      Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
    );
    var stream = payload && payload.stream;
    if (!stream) {
      log(kind + " " + id + " -> no stream");
      return [];
    }

    var streams = selectStreams(stream, subtitlesOf(stream));
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