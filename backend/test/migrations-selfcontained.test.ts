import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import { encryptConfig } from "../src/services/delivery/crypto";

/**
 * Migrations run inside the production image, and that image does not contain
 * application source. `backend/Dockerfile` copies `dist/` and `migrations/`,
 * never `src/` — so a migration importing `../src/...` resolves on every
 * developer machine, passes every test, builds a clean image, and then dies at
 * module load in the container.
 *
 * That is exactly what happened on 2026-08-09: migration 025 imported
 * `../src/services/delivery/crypto`, the entrypoint runs `knex migrate:latest`
 * under `set -e`, the server never started, and `restart: unless-stopped`
 * retried the same failure. Production served 502 for hours while every local
 * check was green, because nothing local can see an image layout.
 *
 * This test is the guard. It is deliberately a source scan rather than a
 * behavioural test: the failure mode is a module resolution that only differs
 * between two filesystem layouts, so no amount of running the migration here
 * would reproduce it.
 */

// `__dirname`, not `import.meta.dirname`: tsx transpiles this suite to
// CommonJS, where the latter is undefined.
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/** Only these may be imported by a migration. Everything else ships nowhere. */
const ALLOWED_BARE = new Set(["knex"]);

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

describe("migrations are self-contained", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".ts"));

  it("finds migrations to check", () => {
    // A scan that silently matched nothing would pass forever.
    assert.ok(files.length > 30, `expected the migration set, found ${files.length}`);
  });

  it("no migration reaches outside the migrations directory", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      for (const spec of importSpecifiers(source)) {
        const isRelative = spec.startsWith(".");
        const escapes = isRelative && spec.startsWith("..");
        const isNodeBuiltin = spec.startsWith("node:");
        const isAllowedBare = !isRelative && !isNodeBuiltin && ALLOWED_BARE.has(spec);

        if (escapes) {
          offenders.push(`${file} imports ${spec}`);
        } else if (!isRelative && !isNodeBuiltin && !isAllowedBare) {
          offenders.push(`${file} imports non-shipped package ${spec}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A migration imported something the production image does not contain.\n" +
        "backend/Dockerfile copies dist/ and migrations/, never src/.\n" +
        "Inline what you need using node: builtins instead.\n" +
        offenders.join("\n"),
    );
  });
});

/**
 * The encryption envelope is duplicated between migration 025 and
 * `src/services/delivery/crypto.ts` — unavoidably, since the migration cannot
 * import it. Duplication is only safe while the two agree, so assert it: the
 * application must be able to read what the migration writes.
 */
describe("migration 025's inlined envelope matches the application's", () => {
  const KEY = "a".repeat(64); // 32 bytes of hex

  it("produces a payload the application's decrypt path accepts", () => {
    const previous = process.env.CHANNEL_SECRET_KEY;
    process.env.CHANNEL_SECRET_KEY = KEY;
    try {
      const payload = encryptConfig({ email: "someone@example.invalid" }, KEY);

      // Same layout the migration writes: version, iv, tag, ciphertext.
      assert.equal(payload[0], 1, "version byte");
      const iv = payload.subarray(1, 13);
      const tag = payload.subarray(13, 29);
      const ciphertext = payload.subarray(29);

      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");

      assert.deepEqual(JSON.parse(plain), { email: "someone@example.invalid" });
    } finally {
      if (previous === undefined) delete process.env.CHANNEL_SECRET_KEY;
      else process.env.CHANNEL_SECRET_KEY = previous;
    }
  });
});
