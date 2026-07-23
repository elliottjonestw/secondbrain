import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  // Class, not media: Settings → General can override the OS, so the `dark`
  // variant has to key off something the app controls. `lib/theme.ts` puts the
  // class on <html> (and resolves "system" through matchMedia itself).
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [typography],
};
