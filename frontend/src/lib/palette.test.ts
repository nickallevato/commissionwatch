import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The palette must have exactly one definition.
 *
 * ## The bug this exists to prevent
 *
 * `tailwind.config.ts` used to define the whole palette a second time, as
 * flat hex literals (`const accent = "#B03A2E"`), duplicating the `--cw-*`
 * custom properties in `src/index.css`. The two agreed only because someone
 * typed the same values twice by hand. That is the same defect class this
 * project has already paid for twice: the frontend's `vote_value` union
 * drifting from the backend's `pg_enum`, and the console's record count
 * drifting from `SUCCESS_KEYS` (see `src/pages/ingestion-counts.test.ts`).
 * Both got a guard test reading the other file so drift fails loudly instead
 * of shipping quietly. This is that guard for the palette.
 *
 * Now every colour token in `tailwind.config.ts` resolves through a
 * `var(--cw-*)` read at render time (`rgb(var(--cw-x) / <alpha-value>)`), so
 * `index.css` is the single source. The one deliberate exception is the
 * accent ramp's 200/300/400/600/700/800/900 steps, which have no `--cw-*`
 * counterpart because nothing outside Tailwind reads them — see the comment
 * at the top of `tailwind.config.ts`. Everything else must be var-backed.
 */

const CONFIG_PATH = join(__dirname, "..", "..", "tailwind.config.ts");

/** Hex literals allowed to stay bare in the colors block: the accent ramp
 *  steps that have no `--cw-*` variable, and nothing else. If this list
 *  needs to grow, the palette has forked again — add a variable instead. */
const ALLOWED_LITERAL_HEXES = new Set([
  "#EFC5BE", // accent-200
  "#E0A096", // accent-300
  "#C96A5B", // accent-400
  "#932F25", // accent-600
  "#76251D", // accent-700
  "#591C16", // accent-800
  "#3D130F", // accent-900
]);

function readColorsBlock(source: string): string {
  const start = source.indexOf("colors: {");
  expect(
    start,
    "could not find the `colors: {` block in tailwind.config.ts — the matcher " +
      "is broken or the block moved.",
  ).toBeGreaterThan(-1);

  // Walk braces from the opening `{` of the colors block to find its match.
  let depth = 0;
  let i = start + "colors: ".length;
  const blockStart = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(blockStart, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces while scanning the colors block");
}

describe("the palette has exactly one definition", () => {
  const source = readFileSync(CONFIG_PATH, "utf8");
  const colorsBlock = readColorsBlock(source);

  it("every non-ramp colour value resolves through a --cw- variable", () => {
    // Every quoted hex literal in the colors block must be one of the
    // documented ramp exceptions. Anything else is a value typed a second
    // time instead of read from index.css — the exact defect this guards.
    const hexLiterals = [...colorsBlock.matchAll(/#[0-9A-Fa-f]{6}/g)].map(
      (m) => m[0],
    );
    const undocumented = hexLiterals.filter(
      (hex) => !ALLOWED_LITERAL_HEXES.has(hex.toUpperCase()),
    );
    expect(
      undocumented,
      `found colour(s) in tailwind.config.ts written as a literal hex value ` +
        `instead of "rgb(var(--cw-x) / <alpha-value>)": ${undocumented.join(", ")}. ` +
        `A palette defined twice drifts — that is what happened to vote_value ` +
        `against pg_enum, and to the console's record count against SUCCESS_KEYS. ` +
        `Point it at the matching --cw-* variable in index.css instead, or if it's ` +
        `a genuinely var-less ramp step, add it to ALLOWED_LITERAL_HEXES here.`,
    ).toEqual([]);
  });

  it("resolves every base token through the expected --cw- variable", () => {
    // These are the tokens index.css also defines — the ones that were
    // literally duplicated before this guard existed. tailwind.config.ts
    // wires each through the `cw(name)` helper (`rgb(var(--cw-name) /
    // <alpha-value>)`), so check for `cw("name")` calls rather than a raw
    // `var(--cw-name)` string, which appears only in the helper's own
    // definition, not at each call site.
    const expectedVars = [
      "paper",
      "paper-sunk",
      "ink",
      "ink-soft",
      "accent",
      "accent-50",
      "accent-100",
      "rule",
      "muted",
      "sev5",
      "sev4",
      "sev3",
      "sev2",
      "sev1",
      "pass",
      "fail",
    ];
    const missing = expectedVars.filter(
      (name) => !colorsBlock.includes(`cw("${name}")`),
    );
    expect(
      missing,
      `tailwind.config.ts's colors block does not reference these --cw-* ` +
        `variables (checked as cw("name") calls): ${missing.join(", ")}. Either the ` +
        `token was pointed back at a literal value, or the variable was renamed in ` +
        `one file but not the other.`,
    ).toEqual([]);
  });
});

/**
 * The dark theme redefines `--cw-*` colour variables under
 * `@media (prefers-color-scheme: dark)`, driven purely by the reader's
 * system preference — no toggle, nothing stored. Two ways that pattern goes
 * wrong quietly:
 *
 * 1. A variable gets a dark value but never had a light one added (or the
 *    light one gets deleted later) — it's then undefined in the un-stamped
 *    default state, which is the classic unreadable-theme bug.
 * 2. Someone "fixes" a component's look in dark mode by adding a selector
 *    or a component rule inside the dark block instead of a variable — the
 *    whole point of this design is that components never change between
 *    themes, only the variables they read do.
 */

const INDEX_CSS_PATH = join(__dirname, "..", "index.css");

/** Pull `--cw-x: ...;` declarations out of a block of CSS text. */
function declaredVars(cssText: string): string[] {
  return [...cssText.matchAll(/(--cw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
}

/** Slice from `:root {` to its matching closing `}`. */
function extractRootBlock(cssText: string, fromIndex: number): string {
  const start = cssText.indexOf(":root", fromIndex);
  expect(start, "could not find a :root block").toBeGreaterThan(-1);
  const braceStart = cssText.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < cssText.length; i++) {
    if (cssText[i] === "{") depth++;
    else if (cssText[i] === "}") {
      depth--;
      if (depth === 0) return cssText.slice(braceStart, i + 1);
    }
  }
  throw new Error("unbalanced braces while scanning a :root block");
}

describe("the dark theme redefines colour variables only", () => {
  const css = readFileSync(INDEX_CSS_PATH, "utf8");

  const mediaIndex = css.indexOf("prefers-color-scheme: dark");
  it("has a prefers-color-scheme: dark block", () => {
    expect(mediaIndex).toBeGreaterThan(-1);
  });

  const bareRootBlock = extractRootBlock(css, 0);
  const darkRootBlock = extractRootBlock(css, mediaIndex);

  it("defines every dark-block colour variable on bare :root too", () => {
    const bareVars = new Set(declaredVars(bareRootBlock));
    const darkVars = declaredVars(darkRootBlock);
    const darkOnly = darkVars.filter((name) => !bareVars.has(name));
    expect(
      darkOnly,
      `these variables are redefined in the dark media query but have no light ` +
        `definition on bare :root, so they are undefined in the default (light or ` +
        `un-stamped) state: ${darkOnly.join(", ")}. Add a light value on :root.`,
    ).toEqual([]);
  });

  it("the dark media query's :root block contains only variable declarations", () => {
    // Strip comments, then strip `--cw-*: ...;` and `color-scheme: ...;`
    // declarations (the one non-variable property this block is allowed to
    // set, since it's a rendering hint tied 1:1 to the theme, not a
    // component style). Whatever remains should be nothing but braces and
    // whitespace — a selector or a component rule would leave a residue.
    const withoutComments = darkRootBlock.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutDeclarations = withoutComments
      .replace(/--cw-[a-z0-9-]+\s*:[^;]+;/g, "")
      .replace(/color-scheme\s*:[^;]+;/g, "");
    const residue = withoutDeclarations.replace(/[\s{}]/g, "");
    expect(
      residue,
      `the dark media query's :root block contains something other than colour ` +
        `variable declarations and color-scheme: "${residue}". The dark theme is ` +
        `supposed to be variables-only so components never change between themes — ` +
        `move this into a variable instead of a selector or component rule.`,
    ).toBe("");
  });
});
