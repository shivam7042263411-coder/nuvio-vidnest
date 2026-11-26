import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Nuvio decides which scrapers to run from the manifest's supportedTypes. It
// never maps its own "anime" media type onto "tv" (only "series"/"show"/"other"
// become "tv"), so a scraper that omits "anime" is filtered out before it runs
// and anime shows nothing while movies work.
function normalizePluginType(value) {
  switch (String(value).toLowerCase()) {
    case "series":
    case "show":
    case "other":
      return "tv";
    default:
      return String(value).toLowerCase();
  }
}

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("every scraper is selected for anime content", () => {
  assert.ok(manifest.scrapers.length > 0);
  for (const scraper of manifest.scrapers) {
    const supported = (scraper.supportedTypes || []).map(normalizePluginType);
    assert.ok(
      supported.includes("anime"),
      `${scraper.id} must declare the "anime" media type or Nuvio never runs it for anime`
    );
  }
});

test("scrapers still cover movies and shows", () => {
  for (const scraper of manifest.scrapers) {
    const supported = (scraper.supportedTypes || []).map(normalizePluginType);
    assert.ok(supported.includes("movie"), `${scraper.id} must support movies`);
    assert.ok(supported.includes("tv"), `${scraper.id} must support shows`);
  }
});
