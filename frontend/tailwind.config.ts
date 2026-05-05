import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: {
          400: "#fbbf24",
          500: "#f59e0b",
          600: "#d97706",
        },
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
