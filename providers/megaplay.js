/**
 * MegaPlay provider for Nuvio — anime only.
 *
 * MegaPlay (megaplay.buzz) publishes every anime episode as HLS addressed by
 * MyAnimeList id and the show's absolute episode number, so a long anime that
 * a catalogue splits into fake seasons still lands on the right file. The
 * player shell /stream/mal/{malId}/{ep}/{sub} carries the internal file id;
 * /stream/getSources answers with an AES-CBC encrypted payload that Nuvio's
 * sandbox decrypts in-process through crypto.subtle.
 *
 * The media CDN answers 403 without a megaplay.buzz referer — the playlist and
 * every segment — so each stream ships that referer for the player to forward.
 *
 * No request timeouts: the sandbox (QuickJS) has no setTimeout, so an
 * AbortController-based timeout throws and the scrape returns nothing.
 */

var MEGAPLAY_ORIGIN = "https://megaplay.buzz";

var ARM_API = "https://arm.haglund.dev/api/v2/ids";
// MegaPlay is keyed by MyAnimeList id; every other anime id is mapped through
// ARM first. TMDB-only ids are not anime here and resolve to nothing.
var ARM_SOURCES = { kitsu: "kitsu", mal: "myanimelist", myanimelist: "myanimelist", anilist: "anilist", anidb: "anidb" };

// MegaPlay's fixed source-encryption key/iv, zero-padded to the AES sizes.
var SOURCE_ENC_KEY = "i?LMTAx0Q6,:}50U";
var SOURCE_ENC_IV = "W0;27ToaUpl_P%'c";

var WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

var API_HEADERS = {
  "User-Agent": WEB_UA,
  "Accept": "application/json",
  "Referer": MEGAPLAY_ORIGIN + "/"
};

// Carries the referer the CDN demands on the playlist and on every segment.
var STREAM_HEADERS = {
  "User-Agent": WEB_UA,
  "Referer": MEGAPLAY_ORIGIN + "/"
};

function log() {
  try {
    console.log.apply(console, ["[MegaPlay]"].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {}
}

async function request(url, headers) {
  var response = await fetch(url, { headers: headers });
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return await response.text();
}

async function requestJson(url, headers) {
  return JSON.parse(await request(url, headers));
}

function isPositiveInt(value) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  var number = Number(value);
  return isFinite(number) && number >= 0 && Math.floor(number) === number;
}

// The episode number a catalogue puts in the video id ("kitsu:11:45" = episode
// 45). It is authoritative: some anime catalogues number continuously while
// the app shows fake seasons, and MegaPlay numbers episodes absolutely too.
function episodeFromVideoId(rawId) {
  var match = /^[a-z-]+:\d+:(\d+)$/i.exec(String(rawId == null ? "" : rawId).trim());
  return match ? Number(match[1]) : 0;
}

// "kitsu:11:45" / "mal:20" / "anilist:110277:1" -> a MyAnimeList id, or "" when
// the id is not an anime catalogue id.
async function resolveMalId(rawId) {
  var match = /^([a-z-]+):(\d+)(?::\d+)?$/i.exec(String(rawId == null ? "" : rawId).trim());
  if (!match) return "";
  var source = match[1].toLowerCase();
  var value = match[2];
  if (!ARM_SOURCES[source]) return "";
  if (source === "mal" || source === "myanimelist") return value;
  try {
    var mapped = await requestJson(
      ARM_API + "?source=" + ARM_SOURCES[source] + "&id=" + encodeURIComponent(value),
      { Accept: "application/json" }
    );
    return mapped && isPositiveInt(mapped.myanimelist) ? String(mapped.myanimelist) : "";
  } catch (e) {
    return "";
  }
}

function padBytes(text, length) {
  var out = new Uint8Array(length);
  var bytes = new TextEncoder().encode(String(text));
  out.set(bytes.subarray(0, Math.min(length, bytes.length)));
  return out;
}

function base64UrlToBytes(value) {
  var text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  var remainder = text.length % 4;
  if (remainder) text += "====".slice(remainder);
  var binary = atob(text);
  var out = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function decryptSources(encrypted) {
  var key = await crypto.subtle.importKey("raw", padBytes(SOURCE_ENC_KEY, 32), { name: "AES-CBC" }, false, ["decrypt"]);
  var plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: padBytes(SOURCE_ENC_IV, 16) }, key, base64UrlToBytes(encrypted));
  return JSON.parse(new TextDecoder().decode(plain));
}

// The master playlist is a single rendition. Returns its text, or "" when the
// host is unreachable — the signal to fail over to a mirror.
async function masterOf(url) {
  try {
    return await request(url, STREAM_HEADERS);
  } catch (e) {
    return "";
  }
}

function heightOf(master) {
  var match = /RESOLUTION=\d+x(\d+)/i.exec(master || "");
  return match ? Number(match[1]) : 0;
}

function swapHost(url, host) {
  return String(url).replace(/^https?:\/\/[^/]+/i, "https://" + host);
}

// The same file is mirrored on MegaPlay's alternate server (?s=tcdn) and on the
// host its check_domain.json declares. Collect those so a dead primary host can
// fail over instead of returning a URL the player cannot open.
async function mirrorFiles(fileId, primaryFile) {
  var mirrors = [];
  try {
    var alt = await requestJson(
      MEGAPLAY_ORIGIN + "/stream/getSources?id=" + fileId + "&s=tcdn",
      Object.assign({ "X-Requested-With": "XMLHttpRequest" }, API_HEADERS)
    );
    if (alt && alt.enc) {
      var altSources = await decryptSources(alt.enc);
      if (altSources && altSources.file && String(altSources.file) !== primaryFile) {
        mirrors.push(String(altSources.file));
      }
    }
  } catch (e) {}
  try {
    var domain = await requestJson(MEGAPLAY_ORIGIN + "/lib/check_domain.json", {
      Accept: "application/json",
      "User-Agent": WEB_UA,
      "Referer": MEGAPLAY_ORIGIN + "/"
    });
    if (domain && domain.fallback) {
      var swapped = swapHost(primaryFile, String(domain.fallback));
      if (mirrors.indexOf(swapped) === -1) mirrors.push(swapped);
    }
  } catch (e) {}
  return mirrors;
}

function qualityLabel(height) {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  return height ? height + "p" : "Auto";
}

// The bundle ships an English caption; other languages are left to the user's
// subtitle addon.
function englishSubtitles(tracks) {
  var out = [];
  (Array.isArray(tracks) ? tracks : []).forEach(function (track) {
    if (!track || track.kind !== "captions" || !track.file) return;
    if (!/^english/i.test(String(track.label || "").trim())) return;
    out.push({
      url: String(track.file),
      language: "en",
      name: track.label || "English",
      headers: STREAM_HEADERS
    });
  });
  return out;
}

async function getStreams(rawId, mediaType, season, episode) {
  try {
    var malId = await resolveMalId(rawId);
    if (!malId) {
      log("not an anime id: " + rawId);
      return [];
    }

    var episodeNumber = episodeFromVideoId(rawId);
    if (!episodeNumber && isPositiveInt(episode) && Number(episode) > 0) episodeNumber = Number(episode);
    if (!episodeNumber) episodeNumber = 1;

    var page = await request(MEGAPLAY_ORIGIN + "/stream/mal/" + malId + "/" + episodeNumber + "/sub", API_HEADERS);
    var fileId = /data-id="(\d+)"/.exec(page);
    if (!fileId) {
      log("mal:" + malId + " ep" + episodeNumber + " -> no file");
      return [];
    }

    var payload = await requestJson(
      MEGAPLAY_ORIGIN + "/stream/getSources?id=" + fileId[1],
      Object.assign({ "X-Requested-With": "XMLHttpRequest" }, API_HEADERS)
    );
    if (!payload || !payload.enc) {
      log("mal:" + malId + " ep" + episodeNumber + " -> no encrypted sources");
      return [];
    }

    var sources = await decryptSources(payload.enc);
    if (!sources || !sources.file) {
      log("mal:" + malId + " ep" + episodeNumber + " -> empty payload");
      return [];
    }

    var playable = String(sources.file);
    var master = await masterOf(playable);
    if (!master) {
      var mirrors = await mirrorFiles(fileId[1], playable);
      for (var m = 0; m < mirrors.length && !master; m++) {
        master = await masterOf(mirrors[m]);
        if (master) playable = mirrors[m];
      }
    }
    var label = qualityLabel(heightOf(master));
    log("mal:" + malId + " ep" + episodeNumber + " -> " + label);
    return [{
      name: "MegaPlay • " + label + " (Sub)",
      title: "MegaPlay • " + label + " • HLS",
      url: playable,
      quality: label,
      language: "Japanese",
      type: "hls",
      provider: "MegaPlay",
      headers: STREAM_HEADERS,
      subtitles: englishSubtitles(payload.tracks)
    }];
  } catch (e) {
    log("getStreams failed: " + (e && e.message));
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}
