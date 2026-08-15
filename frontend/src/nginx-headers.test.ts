import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `nginx.conf`, read as text, for the one property no other check can hold.
 *
 * **`add_header` does not merge across levels.** A single `add_header` inside a
 * `location` discards every header inherited from the `server` block. This file
 * has been bitten by it before, which is why the security header set is now
 * written out three times — at server level, in `/version.json`, and in
 * `location /` where `Vary: User-Agent` had to be declared for the prerender
 * split.
 *
 * Three copies of a constant is the price nginx charges for that behaviour. The
 * danger is not the duplication; it is the drift. Tightening the CSP in one
 * place and not the others leaves the site with a header that is strict on the
 * pages nobody attacks and stale on the ones they do, and nothing anywhere
 * would say so — `nginx -t` is happy, every page returns 200, and the weaker
 * policy is invisible unless somebody curls that exact path and reads the
 * headers.
 *
 * So the assertion is not "the CSP is correct". It is "there is one CSP", which
 * is checkable, and which is the property the repetition actually threatens.
 *
 * This is a text scan, not a container run. Behaviour is verified by curling a
 * running nginx — see the record of that in `docs/STATUS.md`. What a container
 * run cannot cheaply prove is that the *third* copy, on a path nobody thought
 * to curl, still says the same thing.
 */

const CONF = readFileSync(join(__dirname, "..", "nginx.conf"), "utf8");

/** Every `add_header <name> "<value>"`, in file order. */
function headerValues(name: string): string[] {
  const pattern = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"`, "g");
  return [...CONF.matchAll(pattern)].map((match) => match[1]);
}

const REPEATED = [
  "Content-Security-Policy",
  "Referrer-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Permissions-Policy",
] as const;

describe("the nginx security headers do not drift between their copies", () => {
  for (const name of REPEATED) {
    it(`states one value for ${name}, however many times it is written`, () => {
      const values = headerValues(name);
      // Two would mean a block lost its set; more than three means a fourth
      // location was added and this list was not read.
      expect(values.length, `${name} should be declared three times`).toBe(3);
      expect(new Set(values).size, `${name} has diverging values: ${values.join(" | ")}`).toBe(
        1,
      );
    });
  }

  /**
   * The reason the third copy exists. If `Vary` is ever removed, a proxy may
   * hand a crawler's unstyled document to the next human asking for that URL —
   * the one failure mode that turns a defensible rendering decision into a
   * visible breakage.
   */
  it("varies on User-Agent wherever the response body depends on it", () => {
    expect(CONF).toMatch(/add_header\s+Vary\s+"User-Agent"/);
    expect(CONF).toMatch(/try_files\s+\$prerender_prefix\$uri\/index\.html/);
  });

  /**
   * The prerendered tree must not be addressable from outside: the cursor file
   * is not public, and a second URL for every record is the duplicate-content
   * problem the feature exists to solve.
   */
  it("keeps the prerendered tree internal, ahead of the static-extension regex", () => {
    expect(CONF).toMatch(/location\s+\^~\s+\/_prerender\/\s*\{\s*internal;/);
  });

  /**
   * A browser's first `try_files` candidate must probe a prefix the image
   * cannot contain. An empty default would probe the real document root
   * instead, which is how a browser gets served a prerendered file by accident.
   */
  it("defaults the prerender prefix to a path that cannot exist", () => {
    const fallback = /map\s+\$http_user_agent\s+\$prerender_prefix\s*\{\s*default\s+"([^"]*)"/.exec(
      CONF,
    );
    expect(fallback, "the prerender map needs an explicit default").not.toBeNull();
    expect(fallback?.[1]).toBe("/_prerender-off");
  });
});
