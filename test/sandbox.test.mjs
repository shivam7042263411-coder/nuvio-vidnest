import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

// Nuvio runs providers in a QuickJS sandbox on Android TV that has no
// setTimeout/setInterval/AbortController and no Node built-ins. A provider that
// reaches for them works on phones but silently returns nothing on TV, which is
// exactly the platform this repo targets. Guard it statically for every
// provider, since the per-provider runtime tests can miss a rare code path.
test("no provider depends on timers or AbortController the TV sandbox lacks", () => {
  const providers = ["vidlink", "moviebox", "megaplay"];
  for (const id of providers) {
    const source = readFileSync(require.resolve(`../providers/${id}.js`), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/\bsetTimeout\s*\(/.test(code), `${id} must not call setTimeout`);
    assert.ok(!/\bsetInterval\s*\(/.test(code), `${id} must not call setInterval`);
    assert.ok(!/\bAbortController\b/.test(code), `${id} must not use AbortController`);
  }
});
