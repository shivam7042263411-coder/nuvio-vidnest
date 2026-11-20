/**
 * VidNest provider for Nuvio.
 *
 * Uses only VidNest's own API (new.vidnest.fun), the same endpoints the
 * vidnest.fun player calls. Responses are AES-GCM encrypted; the request must
 * carry a random base64url nonce (`_n`). Both are reproduced below.
 *
 * Source policy: when a title has any MP4/MKV source, only those are returned.
 * VidNest's TV endpoints currently expose HLS only, so HLS is returned for TV
 * (and for movies that have no MP4) instead of showing "no streams".
 *
 * Quality policy: only the 1080p sources are returned; if no source is 1080p,
 * only the highest quality tier that is available is returned.
 *
 * Language policy: only English and Hindi audio is returned. The native track
 * ("Original Audio") and unlabeled streams are kept too, because those are the
 * default/VidNest-original audio; streams labeled with any other language are
 * dropped.
 */

var VIDNEST_BASE = "https://new.vidnest.fun";
var VIDNEST_SECRET = "K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2";

var REQUEST_TIMEOUT_MS = 5000;
var TOTAL_BUDGET_MS = 38000;
var BATCH_SIZE = 3;
var BATCH_GAP_MS = 300;

// Returned quality: 1080p when VidNest has it, otherwise the best it offers.
var PREFERRED_QUALITY = 1080;

var REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://vidnest.fun",
  "Referer": "https://vidnest.fun/"
};

// MP4-capable servers first so a direct file usually takes one round.
// The remaining servers are HLS-only and act as the series fallback.
var PROVIDERS = [
  { id: "gama", label: "Gama", path: "/vidzee" },
  { id: "lamda", label: "Lamda", path: "/ophim" },
  { id: "prime", label: "Prime", path: "/rpmvid" },
  { id: "alfa", label: "Alfa", path: "/onehd" },
  { id: "catflix", label: "Catflix", path: "/yflix" },
  { id: "filxer", label: "Filxer", path: "/rogflix" },
  { id: "ophim", label: "Ophim", path: "/klikxxi" },
  { id: "sigma", label: "Sigma", path: "/hollymoviehd" },
  { id: "delta", label: "Delta", path: "/allmovies" },
  { id: "beta", label: "Beta", path: "/flixhq" },
  { id: "zeta", label: "Zeta", path: "/nextgencloudfabric" },
  { id: "hexa", label: "Hexa", path: "/vidlink" }
];

var VIDRIFT_HOSTS = [
  "https://vidrift-cf.money-1.workers.dev",
  "https://vidrift-cf.money-2.workers.dev",
  "https://vidrift-cf.money-3.workers.dev",
  "https://vidrift-cf.money-4.workers.dev",
  "https://vidrift-cf.money-5.workers.dev",
  "https://vidrift-cf.money-6.workers.dev",
  "https://vidrift-cf.money-7.workers.dev",
  "https://vidrift-cf.money-8.workers.dev"
];

function log() {
  try {
    console.log.apply(console, ["[VidNest]"].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {}
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error("timeout after " + ms + "ms"));
      }, ms);
    })
  ]);
}

function randomBase64Url() {
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  var binary = "";
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  var text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (text.length % 4 !== 0) text += "=";
  var binary = atob(text);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decryptPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.v !== 2 || !payload.d) return payload;

  var combined = base64UrlToBytes(payload.d);
  if (combined.length < 29) throw new Error("encrypted payload too short");

  var iv = combined.slice(0, 12);
  var data = combined.slice(12);
  var keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(payload.n) + "|" + VIDNEST_SECRET)
  );
  var key = await crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["decrypt"]);
  var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
  var text = new TextDecoder().decode(plain);

  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

async function requestJson(url) {
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var response = await withTimeout(fetch(url, { headers: REQUEST_HEADERS }), REQUEST_TIMEOUT_MS);
      if (response.status >= 500 && attempt === 0) {
        await sleep(400);
        continue;
      }
      if (!response.ok) return null;
      var payload = await response.json();
      if (!payload) return null;
      return await decryptPayload(payload);
    } catch (error) {
      if (attempt === 0) {
        await sleep(300);
        continue;
      }
      return null;
    }
  }
  return null;
}

function endpoint(provider, tmdbId, mediaType, season, episode) {
  var kind = mediaType === "tv" ? "tv" : "movie";
  var url = VIDNEST_BASE + provider.path + "/" + kind + "/" + encodeURIComponent(tmdbId);
  if (kind === "tv") {
    url += "/" + encodeURIComponent(String(season)) + "/" + encodeURIComponent(String(episode));
  }
  return url + "?_n=" + randomBase64Url();
}

function pushStream(list, stream) {
  if (stream && stream.url) list.push(stream);
}

function extractStreams(data) {
  var list = [];
  if (!data || typeof data !== "object") return list;

  if (Array.isArray(data.streams)) data.streams.forEach(function (s) { pushStream(list, s); });
  if (Array.isArray(data.sources)) data.sources.forEach(function (s) { pushStream(list, s); });
  if (data.url) pushStream(list, data);

  // Hexa returns an HLS playlist nested under data.stream.
  if (data.data && data.data.stream && data.data.stream.playlist) {
    pushStream(list, { url: data.data.stream.playlist, type: "hls", headers: data.headers });
  }
  return list;
}

function isMp4(stream) {
  var type = String(stream.type || "").toLowerCase();
  if (type === "mp4" || type === "mkv" || type === "m4v") return true;
  if (type === "hls" || type === "m3u8") return false;
  return /\.(mp4|mkv|m4v)(\?|#|$)/i.test(String(stream.url || ""));
}

function cleanHeaders(raw) {
  var headers = {};
  if (!raw || typeof raw !== "object") return headers;
  Object.keys(raw).forEach(function (key) {
    var name = String(key || "").trim();
    var value = String(raw[key] == null ? "" : raw[key]).trim();
    if (name && value) headers[name] = value;
  });
  return headers;
}

function qualityOf(stream) {
  var quality = String(stream.quality || "").trim();
  if (!quality || quality.toLowerCase() === "auto") return "Auto";
  return quality;
}

function languageTag(stream) {
  var language = String(stream.language || "").trim().toLowerCase();
  if (!language || language === "auto") return "original";
  if (language.indexOf("hindi") >= 0 || language === "hi" || language === "hin") return "hindi";
  if (language.indexOf("english") >= 0 || language === "en" || language === "eng") return "english";
  if (language.indexOf("original") >= 0) return "original";
  return "other";
}

function isAllowedLanguage(stream) {
  return languageTag(stream) !== "other";
}

function languageOf(stream) {
  var tag = languageTag(stream);
  if (tag === "hindi") return "Hindi";
  if (tag === "english") return "English";
  if (tag === "original") return "Original";
  return String(stream.language || "").trim();
}

function qualityRank(quality) {
  var match = /(\d{3,4})/.exec(String(quality || ""));
  return match ? parseInt(match[1], 10) : 0;
}

function normalizeStream(provider, stream) {
  var url = String(stream.url || "").trim();
  if (!url) return null;

  // Alfa sometimes returns worker-relative paths.
  if (url.charAt(0) === "/") {
    url = VIDRIFT_HOSTS[Math.floor(Math.random() * VIDRIFT_HOSTS.length)] + url;
  }

  var mp4 = isMp4(stream);
  var quality = qualityOf(stream);
  var language = languageOf(stream);
  var title = "VidNest " + provider.label + " • " + quality + " • " + language + " • " + (mp4 ? "MP4" : "HLS");

  return {
    name: "VidNest • " + provider.label,
    title: title,
    url: url,
    quality: quality,
    language: language,
    type: mp4 ? "mp4" : "hls",
    provider: "VidNest",
    headers: cleanHeaders(stream.headers)
  };
}

async function fetchProvider(provider, tmdbId, mediaType, season, episode) {
  var data = await requestJson(endpoint(provider, tmdbId, mediaType, season, episode));
  if (!data) return [];

  var results = [];
  extractStreams(data).forEach(function (stream) {
    var normalized = normalizeStream(provider, stream);
    if (normalized) results.push(normalized);
  });
  return results;
}

function dedupe(streams) {
  var seen = {};
  var out = [];
  streams.forEach(function (stream) {
    if (seen[stream.url]) return;
    seen[stream.url] = true;
    out.push(stream);
  });
  return out;
}

function selectTopQuality(streams) {
  if (streams.length < 2) return streams;

  var preferred = streams.filter(function (stream) {
    return qualityRank(stream.quality) === PREFERRED_QUALITY;
  });
  if (preferred.length > 0) return preferred;

  var best = 0;
  streams.forEach(function (stream) {
    var rank = qualityRank(stream.quality);
    if (rank > best) best = rank;
  });
  return streams.filter(function (stream) {
    return qualityRank(stream.quality) === best;
  });
}

function finalize(streams) {
  var allowed = streams.filter(isAllowedLanguage);
  var mp4 = allowed.filter(function (stream) { return stream.type === "mp4"; });
  var pool = mp4.length > 0 ? mp4 : allowed.filter(function (stream) { return stream.type === "hls"; });
  return selectTopQuality(dedupe(pool)).sort(function (a, b) {
    return qualityRank(b.quality) - qualityRank(a.quality);
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
    var collected = [];

    for (var i = 0; i < PROVIDERS.length; i += BATCH_SIZE) {
      var batch = PROVIDERS.slice(i, i + BATCH_SIZE);
      var batchResults = await Promise.all(batch.map(function (provider) {
        return fetchProvider(provider, id, kind, season, episode).catch(function () { return []; });
      }));
      batchResults.forEach(function (results) {
        collected = collected.concat(results);
      });

      var hasMp4 = collected.some(function (stream) {
        return stream.type === "mp4" && isAllowedLanguage(stream);
      });
      if (hasMp4) return finalize(collected);
      if (Date.now() > deadline) break;
      if (i + BATCH_SIZE < PROVIDERS.length) await sleep(BATCH_GAP_MS);
    }

    var final = finalize(collected);
    log(kind + " " + id + (kind === "tv" ? " s" + season + "e" + episode : "") + " -> " + final.length + " source(s)");
    return final;
  } catch (error) {
    log("failed:", error && error.message ? error.message : error);
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}