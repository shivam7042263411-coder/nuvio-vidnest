/**
 * Vidly provider for Nuvio.
 *
 * Uses only vidly.pro: the embed page's RSC payload supplies a per-title token
 * and the server-sealed default source list; /api/sources returns the same
 * sealed payload for any other server (Prism is the one with multi-audio).
 *
 * Payloads are "v1.<base64url>": the first 12 bytes are the IV for a small
 * counter cipher keyed by the constant below, the rest is XORed JSON.
 *
 * Source policy: 1080p only. Prism is preferred because it carries separate
 * Hindi and English tracks; when Prism has no 1080p source, the page's own
 * sealed source is returned instead.
 *
 * Language policy: English, Hindi, Original and unlabeled audio only.
 */

var VIDLY_BASE = "https://vidly.pro";
var DECRYPT_KEY = "vY7#qL2!mZ9@wK4$";
var PRISM_ID = "prism";

var PREFERRED_QUALITY = 1080;
var PAGE_TIMEOUT_MS = 9000;
var PRISM_TIMEOUT_MS = 12000;
var TOTAL_BUDGET_MS = 15000;

var PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/x-component, text/html;q=0.9, */*;q=0.8",
  "RSC": "1"
};

// Vidly's RSC endpoint intermittently 502s under load; the plain page carries
// the same token and sealed fields, so it is the fallback.
var PLAIN_PAGE_HEADERS = {
  "User-Agent": PAGE_HEADERS["User-Agent"],
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

var API_HEADERS = {
  "User-Agent": PAGE_HEADERS["User-Agent"],
  "Accept": "*/*",
  "Origin": VIDLY_BASE,
  "Referer": VIDLY_BASE + "/"
};

// The stream CDNs (img.rousav.tech, dash-hls-bridge.*) reject requests that do
// not carry the vidly page as referer with 403, so the player must send these.
var STREAM_HEADERS = {
  "User-Agent": PAGE_HEADERS["User-Agent"],
  "Referer": VIDLY_BASE + "/"
};

function log() {
  try {
    console.log.apply(console, ["[Vidly]"].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {}
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error("timeout after " + ms + "ms"));
    }, ms);
    promise.then(
      function (value) {
        clearTimeout(timer);
        resolve(value);
      },
      function (error) {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function randomToken() {
  var bytes = new Uint8Array(12);
  for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
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

function utf8Decode(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length;) {
    var b = bytes[i++];
    var cp;
    if (b < 0x80) {
      cp = b;
    } else if (b < 0xe0) {
      cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else if (b < 0xf0) {
      cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    } else {
      cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

function keyStream(iv) {
  var out = [];
  for (var i = 0; i < 4; i++) {
    var n = (0x811c9dc5 ^ Math.imul(0x9e3779b9, i)) >>> 0;
    for (var k = 0; k < DECRYPT_KEY.length; k++) n = Math.imul(n ^ DECRYPT_KEY.charCodeAt(k), 0x1000193) >>> 0;
    for (var j = 0; j < iv.length; j++) n = Math.imul(n ^ iv[j], 0x1000193) >>> 0;
    out.push(n);
  }
  return out;
}

function decryptPayload(payload) {
  if (!payload || String(payload).indexOf("v1.") !== 0) return null;

  var combined = base64UrlToBytes(String(payload).slice(3));
  if (combined.length < 13) return null;

  var data = combined.slice(12);
  var key = keyStream(combined.subarray(0, 12));
  var a = key[0], b = key[1], c = key[2], d = key[3];
  var r = 0;

  for (var t = 0; t < data.length; t++) {
    if ((t & 3) === 0) {
      var e = (a + b) | 0;
      a = (b ^ (b >>> 9)) >>> 0;
      b = (c + (c << 3)) | 0;
      c = (((c << 21) | (c >>> 11)) + (e = (e + ((d = (d + 1) | 0)) | 0))) | 0;
      r = e >>> 0;
    }
    data[t] ^= (r >>> ((t & 3) * 8)) & 255;
  }

  try {
    return JSON.parse(utf8Decode(data));
  } catch (e) {
    return null;
  }
}

function pickField(html, field) {
  var escaped = new RegExp('\\\\"' + field + '\\\\":\\\\"([^\\\\"]+)\\\\"');
  var match = escaped.exec(html);
  if (match) return match[1];

  var plain = new RegExp('"' + field + '":"([^"]+)"');
  match = plain.exec(html);
  return match ? match[1] : null;
}

function pathFor(tmdbId, kind, season, episode) {
  if (kind === "tv") {
    return "/tv/" + encodeURIComponent(tmdbId) + "/" + encodeURIComponent(String(season)) + "/" + encodeURIComponent(String(episode));
  }
  return "/movie/" + encodeURIComponent(tmdbId);
}

async function requestText(url, headers, ms) {
  try {
    var response = await withTimeout(fetch(url, { headers: headers }), ms);
    if (!response || !response.ok) return null;
    return await response.text();
  } catch (e) {
    return null;
  }
}

async function fetchPage(tmdbId, kind, season, episode, deadline) {
  var path = pathFor(tmdbId, kind, season, episode);
  var variants = [PAGE_HEADERS, PLAIN_PAGE_HEADERS];

  for (var i = 0; i < variants.length; i++) {
    var remaining = deadline - Date.now();
    if (remaining < 500) return null;

    var url = VIDLY_BASE + path + "?_rsc=" + randomToken();
    var text = await requestText(url, variants[i], Math.min(PAGE_TIMEOUT_MS, remaining));
    if (!text) continue;

    var token = pickField(text, "token");
    var sealed = pickField(text, "sealed");
    if (token || sealed) return { token: token, sealed: sealed };
  }
  return null;
}

async function fetchPrism(token, tmdbId, kind, season, episode, ms) {
  var url = VIDLY_BASE + "/api/sources?kind=" + (kind === "tv" ? "tv" : "movie") +
    "&provider=" + PRISM_ID +
    "&t=" + encodeURIComponent(token) +
    "&tmdb=" + encodeURIComponent(tmdbId) +
    (kind === "tv" ? "&s=" + encodeURIComponent(String(season)) + "&e=" + encodeURIComponent(String(episode)) : "") +
    "&hevc=0";

  var text = await requestText(url, API_HEADERS, ms);
  if (!text) return null;

  var data = decryptPayload(text.trim());
  if (!data || !Array.isArray(data.streams)) return null;
  return data;
}

function qualityOf(stream) {
  var quality = String(stream.quality || "").trim();
  return quality || "Auto";
}

function qualityRank(quality) {
  var match = /(\d{3,4})/.exec(String(quality || ""));
  return match ? parseInt(match[1], 10) : 0;
}

function languageTag(stream) {
  var language = String(stream.language || "").trim().toLowerCase();
  if (!language || language === "auto") return "original";
  if (language.indexOf("hindi") >= 0 || language === "hi" || language === "hin") return "hindi";
  if (language.indexOf("english") >= 0 || language === "en" || language === "eng") return "english";
  if (language.indexOf("original") >= 0) return "original";
  return "other";
}

function languageOf(stream) {
  var tag = languageTag(stream);
  if (tag === "hindi") return "Hindi";
  if (tag === "english") return "English";
  if (tag === "original") return "Original";
  return String(stream.language || "").trim();
}

function normalize(serverLabel, stream) {
  var url = String(stream.url || "").trim();
  if (!url) return null;

  var quality = qualityOf(stream);
  var language = languageOf(stream);

  return {
    name: "Vidly • " + serverLabel,
    title: "Vidly " + serverLabel + " • " + quality + " • " + language + " • HLS",
    url: url,
    quality: quality,
    language: language,
    type: "hls",
    provider: "Vidly",
    headers: STREAM_HEADERS
  };
}

// 1080p, allowed audio, one entry per URL.
function selectStreams(payload, serverLabel) {
  var out = [];
  var seen = {};
  if (!payload || !Array.isArray(payload.streams)) return out;

  payload.streams.forEach(function (stream) {
    if (languageTag(stream) === "other") return;
    if (qualityRank(qualityOf(stream)) !== PREFERRED_QUALITY) return;

    var normalized = normalize(serverLabel, stream);
    if (!normalized || seen[normalized.url]) return;
    seen[normalized.url] = true;
    out.push(normalized);
  });
  return out;
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
    var page = await fetchPage(id, kind, season, episode, deadline);
    if (!page) {
      log(kind + " " + id + " -> no token");
      return [];
    }

    var sealed = page.sealed ? decryptPayload(page.sealed) : null;
    var sealedLabel = sealed && sealed.provider && sealed.provider.label ? sealed.provider.label : "Edge";
    var fallback = selectStreams(sealed, sealedLabel);
    if (sealed && sealed.provider && sealed.provider.id === PRISM_ID) {
      return fallback;
    }

    var prismStreams = [];
    var remaining = deadline - Date.now();
    if (page.token && remaining > 500) {
      var prism = await fetchPrism(page.token, id, kind, season, episode, Math.min(PRISM_TIMEOUT_MS, remaining));
      prismStreams = selectStreams(prism, "Prism");
    }

    var seen = {};
    var final = [];
    prismStreams.concat(fallback).forEach(function (stream) {
      if (seen[stream.url]) return;
      seen[stream.url] = true;
      final.push(stream);
    });

    log(kind + " " + id + " -> " + final.length + " source(s)");
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