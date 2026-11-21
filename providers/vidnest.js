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

var REQUEST_TIMEOUT_MS = 3000;
var TOTAL_BUDGET_MS = 15000;
var BATCH_SIZE = 6;
var BATCH_GAP_MS = 100;

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

// --- Pure-JS SHA-256 + AES-256-CTR ---
// VidNest responses are AES-GCM. We decrypt them in JavaScript instead of
// crypto.subtle: Nuvio's iOS GCM bridge never sets the GCM IV, so it throws,
// and the unguarded native bridge aborts the whole app. CTR is the
// confidentiality half of GCM; the GCM tag only authenticates, so dropping it
// still yields the correct plaintext.

var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function sha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var len = bytes.length;
  var total = (((len + 9 + 63) >> 6) << 6);
  var msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  var bitHi = Math.floor(len / 0x20000000);
  var bitLo = (len << 3) >>> 0;
  msg[total - 8] = (bitHi >>> 24) & 0xff;
  msg[total - 7] = (bitHi >>> 16) & 0xff;
  msg[total - 6] = (bitHi >>> 8) & 0xff;
  msg[total - 5] = bitHi & 0xff;
  msg[total - 4] = (bitLo >>> 24) & 0xff;
  msg[total - 3] = (bitLo >>> 16) & 0xff;
  msg[total - 2] = (bitLo >>> 8) & 0xff;
  msg[total - 1] = bitLo & 0xff;

  var w = new Array(64);
  for (var off = 0; off < total; off += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3]) >>> 0;
    }
    for (t = 16; t < 64; t++) {
      var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (t = 0; t < 64; t++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  var out = new Uint8Array(32);
  for (var i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

var AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];

function xtime(b) {
  return ((b << 1) ^ ((b >> 7) * 0x1b)) & 0xff;
}

function aesExpandKey256(key) {
  var Nk = 8, Nr = 14, total = 4 * (Nr + 1);
  var w = new Uint8Array(total * 4);
  w.set(key);
  var rcon = 1;
  for (var i = Nk; i < total; i++) {
    var o = i * 4, p = (i - 1) * 4;
    var t0 = w[p], t1 = w[p + 1], t2 = w[p + 2], t3 = w[p + 3];
    if (i % Nk === 0) {
      var tmp = t0;
      t0 = AES_SBOX[t1] ^ rcon;
      t1 = AES_SBOX[t2];
      t2 = AES_SBOX[t3];
      t3 = AES_SBOX[tmp];
      rcon = xtime(rcon);
    } else if (i % Nk === 4) {
      t0 = AES_SBOX[t0]; t1 = AES_SBOX[t1]; t2 = AES_SBOX[t2]; t3 = AES_SBOX[t3];
    }
    var q = (i - Nk) * 4;
    w[o] = w[q] ^ t0;
    w[o + 1] = w[q + 1] ^ t1;
    w[o + 2] = w[q + 2] ^ t2;
    w[o + 3] = w[q + 3] ^ t3;
  }
  return w;
}

function aesEncryptBlock(rk, block) {
  var s = new Uint8Array(16);
  s.set(block);
  for (var i = 0; i < 16; i++) s[i] ^= rk[i];

  for (var round = 1; round <= 14; round++) {
    for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];

    var t = s.slice();
    s[1] = t[5]; s[5] = t[9]; s[9] = t[13]; s[13] = t[1];
    s[2] = t[10]; s[6] = t[14]; s[10] = t[2]; s[14] = t[6];
    s[3] = t[15]; s[7] = t[3]; s[11] = t[7]; s[15] = t[11];

    if (round !== 14) {
      for (var c = 0; c < 4; c++) {
        var j = c * 4;
        var a0 = s[j], a1 = s[j + 1], a2 = s[j + 2], a3 = s[j + 3];
        s[j] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        s[j + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        s[j + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        s[j + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
      }
    }

    var o = round * 16;
    for (i = 0; i < 16; i++) s[i] ^= rk[o + i];
  }
  return s;
}

function aesCtrDecrypt(key, iv, ciphertext) {
  var rk = aesExpandKey256(key);
  var counter = new Uint8Array(16);
  counter.set(iv.subarray(0, 12));
  counter[15] = 1;
  var out = new Uint8Array(ciphertext.length);
  for (var off = 0; off < ciphertext.length; off += 16) {
    for (var i = 15; i >= 12; i--) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
    var stream = aesEncryptBlock(rk, counter);
    var n = Math.min(16, ciphertext.length - off);
    for (var k = 0; k < n; k++) out[off + k] = ciphertext[off + k] ^ stream[k];
  }
  return out;
}

function utf8Encode(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
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

async function decryptPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.v !== 2 || !payload.d) return payload;

  var combined = base64UrlToBytes(payload.d);
  if (combined.length < 28) throw new Error("encrypted payload too short");

  var iv = combined.subarray(0, 12);
  var ciphertext = combined.subarray(12, combined.length - 16);
  var key = sha256(utf8Encode(String(payload.n) + "|" + VIDNEST_SECRET));
  var text = utf8Decode(aesCtrDecrypt(key, iv, ciphertext));

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

// True once the collected set holds the source we would keep anyway: a movie MP4
// ("auto" means top tier) or a 1080p tier, the cap of VidNest's HLS-only TV path.
function hasTarget(streams, kind) {
  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i];
    if (!isAllowedLanguage(stream)) continue;
    var rank = qualityRank(stream.quality);
    if (kind === "movie") {
      if (stream.type === "mp4" && (rank === 0 || rank >= PREFERRED_QUALITY)) return true;
    } else if (rank >= PREFERRED_QUALITY) {
      return true;
    }
  }
  return false;
}

// Resolves as soon as one provider yields a target, so the slow or erroring
// providers sharing its batch are abandoned instead of waited on.
function raceBatch(batch, tmdbId, kind, season, episode) {
  return new Promise(function (resolve) {
    var collected = [];
    var settled = 0;
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      resolve(collected);
    }

    batch.forEach(function (provider) {
      fetchProvider(provider, tmdbId, kind, season, episode)
        .then(function (results) {
          collected = collected.concat(results);
          if (hasTarget(collected, kind)) finish();
        })
        .catch(function () {})
        .then(function () {
          settled += 1;
          if (settled === batch.length) finish();
        });
    });
  });
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
      collected = collected.concat(await raceBatch(batch, id, kind, season, episode));
      if (hasTarget(collected, kind)) break;
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