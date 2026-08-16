import type { Config } from "tailwindcss";

/**
 * CommissionWatch design tokens — editorial / newspaper-of-record.
 *
 * Light is the default theme; dark follows `prefers-color-scheme`, driven
 * entirely by the `--cw-*` custom properties in src/index.css. THOSE are the
 * single source of truth for colour — every token below resolves through a
 * `var(--cw-*)` read at render time, via the `rgb(var(...) / <alpha-value>)`
 * form, which also keeps Tailwind's opacity modifiers (`bg-accent/20`)
 * working. Nothing here is a duplicate literal; a value typed twice is
 * exactly the defect class this file used to be (see
 * `frontend/src/lib/palette.test.ts`).
 *
 * The accent ramp's 200/300/400/600/700/800/900 steps are the one
 * exception: they have no `--cw-*` counterpart (nothing else in the app
 * reads them outside Tailwind), so they stay literal. 50 and 100 are wired
 * to variables because they're used as near-white washes (a highlighted
 * quote span, an alert row background) that would glow on a dark ground
 * unless they have a dark counterpart too.
 */

/** `rgb(var(--cw-x) / <alpha-value>)` — lets Tailwind's opacity modifiers
 *  (`bg-accent/20`) work against a CSS custom property, which requires the
 *  variable to hold bare RGB channels rather than a hex string. */
const cw = (name: string) => `rgb(var(--cw-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // No `darkMode` key. Dark here is driven purely by `prefers-color-scheme`
  // via the CSS custom properties in index.css — no `dark:` variants, no
  // `class` strategy, no toggle, nothing stored. This previously carried
  // `darkMode: "class"` while nothing in the app ever added that class, so
  // every `dark:` variant it enabled was dead config advertising a theme
  // that did not exist; that dead config was removed, and this file does
  // not need `dark:` variants back because component classes never change
  // between themes — only the variables they resolve to do.
  theme: {
    extend: {
      colors: {
        /** Page background. `paper-sunk` is the only sanctioned alternate band. */
        paper: {
          DEFAULT: cw("paper"),
          sunk: cw("paper-sunk"),
        },
        /** Body text. `ink-soft` for de-emphasised prose that is still primary. */
        ink: {
          DEFAULT: cw("ink"),
          soft: cw("ink-soft"),
        },
        /**
         * The single red accent: kickers, rules, emphasis. Use sparingly.
         * `accent` === `accent-500`. The ramp exists so legacy `accent-300/400`
         * references resolve on-palette instead of to nothing.
         */
        accent: {
          DEFAULT: cw("accent"),
          50: cw("accent-50"),
          100: cw("accent-100"),
          200: "#EFC5BE",
          300: "#E0A096",
          400: "#C96A5B",
          500: cw("accent"),
          600: "#932F25",
          700: "#76251D",
          800: "#591C16",
          900: "#3D130F",
        },
        /** Hairlines and borders. Also the default `border` colour. */
        rule: cw("rule"),
        /** Secondary text, micro-labels, captions. */
        muted: cw("muted"),
        /** Anomaly severity. sev1/sev5 are aliases so a 1-5 lookup never gaps. */
        sev5: cw("sev5"),
        sev4: cw("sev4"),
        sev3: cw("sev3"),
        sev2: cw("sev2"),
        sev1: cw("sev1"),
        /** Vote outcomes. */
        pass: cw("pass"),
        fail: cw("fail"),
      },
      fontFamily: {
        display: [
          "Iowan Old Style",
          "Georgia",
          "Times New Roman",
          "Times",
          "serif",
        ],
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      letterSpacing: {
        /** Headlines: slightly negative. */
        headline: "-0.02em",
        /** Small uppercase labels. */
        label: "0.15em",
      },
      lineHeight: {
        /** Tight display leading. */
        headline: "1.12",
      },
      borderColor: {
        /** A bare `border` is a hairline, not a box. */
        DEFAULT: cw("rule"),
      },
      animation: {
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "translateY(-50%) scale(1)" },
          "50%": { opacity: "0.5", transform: "translateY(-50%) scale(1.4)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
