import type { Config } from "tailwindcss";

/**
 * CommissionWatch design tokens — editorial / newspaper-of-record.
 *
 * Light is the default and primary theme. There is no dark theme.
 * Hex values here are mirrored as `--cw-*` custom properties in src/index.css
 * for use in inline styles and SVG, where Tailwind classes cannot reach.
 */

const paper = "#FFFDF8";
const ink = "#16161A";
const rule = "#E8E3D8";
const muted = "#6E6A62";
const accent = "#B03A2E";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // No `darkMode` key. This carried `darkMode: "class"` while nothing in the
  // app ever added that class, so every `dark:` variant it enabled was dead
  // config advertising a theme that did not exist. A committed light identity
  // is more credible than a half-built one; if a dark theme is ever wanted,
  // the `--cw-*` custom properties in index.css make it a token swap.
  theme: {
    extend: {
      colors: {
        /** Page background. `paper-sunk` is the only sanctioned alternate band. */
        paper: {
          DEFAULT: paper,
          sunk: "#F6F3EA",
        },
        /** Body text. `ink-soft` for de-emphasised prose that is still primary. */
        ink: {
          DEFAULT: ink,
          soft: "#3A3A40",
        },
        /**
         * The single red accent: kickers, rules, emphasis. Use sparingly.
         * `accent` === `accent-500`. The ramp exists so legacy `accent-300/400`
         * references resolve on-palette instead of to nothing.
         */
        accent: {
          DEFAULT: accent,
          50: "#FCF3F1",
          100: "#F8E3DF",
          200: "#EFC5BE",
          300: "#E0A096",
          400: "#C96A5B",
          500: accent,
          600: "#932F25",
          700: "#76251D",
          800: "#591C16",
          900: "#3D130F",
        },
        /** Hairlines and borders. Also the default `border` colour. */
        rule,
        /** Secondary text, micro-labels, captions. */
        muted,
        /** Anomaly severity. sev1/sev5 are aliases so a 1-5 lookup never gaps. */
        sev5: accent,
        sev4: accent,
        sev3: "#C2860C",
        sev2: "#8A857C",
        sev1: "#8A857C",
        /** Vote outcomes. */
        pass: "#1E6B45",
        fail: accent,
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
        DEFAULT: rule,
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
