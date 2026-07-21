// Weather for the Today page, from Open-Meteo.
//
// Chosen because it needs no account, no API key and no registration — the app
// stays something you can build and run without signing up to anything, which
// is the same reason there's no backend. Free for non-commercial use under
// CC-BY-4.0; the attribution lives in Settings and the README.
//
// Like connected calendars, forecasts are NEVER written to SQLite. They're
// fetched live and cached in localStorage for a few minutes — a forecast is
// stale within the hour, so persisting it would only mean showing yesterday's
// weather with confidence. Failures are soft: no network means no tile, never
// an error banner over the rest of the day.
//
// Requests go through tauri-plugin-http's fetch (runs in Rust) — the webview's
// own fetch is blocked by CORS from tauri://, and both hosts are scoped in
// capabilities/default.json.

import { fetch } from "@tauri-apps/plugin-http";
import type { TemperatureUnit, WeatherLocation } from "./settings";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

/**
 * How far either side of today Open-Meteo will serve. It reports the exact
 * window in its error text (~92 days back, ~15 forward) and these stay just
 * inside it, so an out-of-range day hides the tile instead of spending a
 * request to be told no.
 */
const MAX_PAST_DAYS = 90;
const MAX_FUTURE_DAYS = 14;

/** Long enough that stepping around the week is free, short enough to stay true. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_KEY = "secondbrain.weather";
const CACHE_MAX = 20;

/** One day's forecast, already unit-converted by the service. */
export interface DayWeather {
  /** WMO code — pass to `weatherIconKey` / `weatherLabelKey`. */
  code: number;
  high: number;
  low: number;
  /** Chance of precipitation, 0–100, or null if the service didn't say. */
  precipitation: number | null;
  /** Temperature right now. Only meaningful for today, so null on other days. */
  now: number | null;
  /** "°C" / "°F", as reported by the service rather than assumed. */
  unit: string;
  sunrise: string | null;
  sunset: string | null;
}

/** A geocoding hit, for the Settings place picker. */
export interface PlaceResult extends WeatherLocation {
  /** Distinguishes the several "Springfield"s a search returns. */
  admin: string | null;
}

/** yyyy-MM-dd in *local* time. `toISOString` would shift the day westward. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from today to `day`, both taken at local midnight. */
function dayOffset(day: Date): number {
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((at(day) - at(new Date())) / 86400000);
}

/** Is there a forecast to be had for this day at all? */
export function isForecastable(day: Date): boolean {
  const offset = dayOffset(day);
  return offset >= -MAX_PAST_DAYS && offset <= MAX_FUTURE_DAYS;
}

// --- Cache -------------------------------------------------------------------
// Keyed by place + day + unit. Entries carry their own timestamp, so a stale one
// is simply a miss rather than something to sweep.

interface CacheEntry { at: number; data: DayWeather }

function cacheKey(loc: WeatherLocation, day: Date, unit: TemperatureUnit): string {
  // Coordinates rounded to ~1km: re-picking the same city from the geocoder can
  // return a slightly different centroid, which shouldn't cost a fresh request.
  return `${loc.latitude.toFixed(2)},${loc.longitude.toFixed(2)}|${isoDay(day)}|${unit}`;
}

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeCache(key: string, data: DayWeather): void {
  try {
    const cache = readCache();
    delete cache[key]; // re-insert at the end so the oldest untouched entry ages out
    cache[key] = { at: Date.now(), data };
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete cache[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation, never a failure */
  }
}

// --- Fetching ----------------------------------------------------------------

/** First element of an Open-Meteo daily array, as a number or null. */
function firstNumber(arr: unknown): number | null {
  const v = Array.isArray(arr) ? arr[0] : null;
  return typeof v === "number" ? v : null;
}

function firstString(arr: unknown): string | null {
  const v = Array.isArray(arr) ? arr[0] : null;
  return typeof v === "string" ? v : null;
}

/**
 * The forecast for one day at one place, or null if there isn't one to be had
 * (day outside the served window, or the service is unreachable).
 *
 * Never throws: the tile is an enhancement on a page that works without it.
 */
export async function getDayWeather(
  loc: WeatherLocation,
  day: Date,
  unit: TemperatureUnit,
  signal?: AbortSignal,
): Promise<DayWeather | null> {
  if (!isForecastable(day)) return null;

  const key = cacheKey(loc, day, unit);
  const hit = readCache()[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const date = isoDay(day);
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    current: "temperature_2m,weather_code",
    // The service buckets days in the *location's* timezone, which is what makes
    // "the high on Friday" mean the same thing there as it does on the tile.
    timezone: "auto",
    temperature_unit: unit,
    start_date: date,
    end_date: date,
  });

  try {
    const res = await fetch(`${FORECAST_URL}?${params}`, { method: "GET", signal });
    if (!res.ok) return null;
    const data = await res.json();
    // Open-Meteo reports refusals as 200 + `{ error: true, reason }`.
    if (data?.error) return null;

    const code = firstNumber(data?.daily?.weather_code);
    const high = firstNumber(data?.daily?.temperature_2m_max);
    const low = firstNumber(data?.daily?.temperature_2m_min);
    // A day with no code or no temperatures has nothing to show; treat it as a
    // miss rather than rendering a tile full of blanks.
    if (code === null || high === null || low === null) return null;

    const out: DayWeather = {
      code,
      high,
      low,
      precipitation: firstNumber(data?.daily?.precipitation_probability_max),
      // "Now" only means something on today's tile.
      now: dayOffset(day) === 0 && typeof data?.current?.temperature_2m === "number"
        ? data.current.temperature_2m
        : null,
      unit: typeof data?.daily_units?.temperature_2m_max === "string"
        ? data.daily_units.temperature_2m_max
        : "°",
      sunrise: firstString(data?.daily?.sunrise),
      sunset: firstString(data?.daily?.sunset),
    };
    writeCache(key, out);
    return out;
  } catch {
    return null; // offline, aborted, or the service is having a day
  }
}

/**
 * Places matching a typed query, for the Settings picker. Throws on failure —
 * unlike the tile, a search box that silently returns nothing is a bug the user
 * can't tell apart from "no such place".
 */
export async function searchPlaces(
  query: string,
  language: string,
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  const name = query.trim();
  if (!name) return [];
  const params = new URLSearchParams({
    name,
    count: "8",
    // Returns localized place names where the service has them.
    language,
    format: "json",
  });
  const res = await fetch(`${GEOCODING_URL}?${params}`, { method: "GET", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r: any) => typeof r?.latitude === "number" && typeof r?.longitude === "number")
    .map((r: any) => ({
      name: typeof r.name === "string" ? r.name : "",
      country: typeof r.country === "string" ? r.country : "",
      // admin1 is the state/province — the only thing separating the
      // Springfields from each other.
      admin: typeof r.admin1 === "string" ? r.admin1 : null,
      latitude: r.latitude,
      longitude: r.longitude,
    }));
}

// --- WMO weather codes -------------------------------------------------------
// The service reports conditions as WMO 4677 codes. Grouped here into the
// handful of distinctions worth drawing on a dashboard tile: "light drizzle"
// and "moderate drizzle" get one icon and one label between them.

/** Icon name from `lucide-react`, resolved to a component by the tile. */
export type WeatherIcon =
  | "sun" | "cloud-sun" | "cloud" | "cloud-fog" | "cloud-drizzle"
  | "cloud-rain" | "cloud-snow" | "cloud-lightning";

interface WeatherCondition {
  icon: WeatherIcon;
  /** Suffix of a `weather.conditions.*` translation key. */
  label: string;
}

/** Ranges are inclusive on both ends; first match wins. */
const CONDITIONS: { from: number; to: number; condition: WeatherCondition }[] = [
  { from: 0, to: 0, condition: { icon: "sun", label: "clear" } },
  { from: 1, to: 1, condition: { icon: "sun", label: "mainlyClear" } },
  { from: 2, to: 2, condition: { icon: "cloud-sun", label: "partlyCloudy" } },
  { from: 3, to: 3, condition: { icon: "cloud", label: "overcast" } },
  { from: 45, to: 48, condition: { icon: "cloud-fog", label: "fog" } },
  { from: 51, to: 55, condition: { icon: "cloud-drizzle", label: "drizzle" } },
  { from: 56, to: 57, condition: { icon: "cloud-drizzle", label: "freezingDrizzle" } },
  { from: 61, to: 65, condition: { icon: "cloud-rain", label: "rain" } },
  { from: 66, to: 67, condition: { icon: "cloud-rain", label: "freezingRain" } },
  { from: 71, to: 75, condition: { icon: "cloud-snow", label: "snow" } },
  { from: 77, to: 77, condition: { icon: "cloud-snow", label: "snowGrains" } },
  { from: 80, to: 82, condition: { icon: "cloud-rain", label: "rainShowers" } },
  { from: 85, to: 86, condition: { icon: "cloud-snow", label: "snowShowers" } },
  { from: 95, to: 95, condition: { icon: "cloud-lightning", label: "thunderstorm" } },
  { from: 96, to: 99, condition: { icon: "cloud-lightning", label: "thunderstormHail" } },
];

const UNKNOWN_CONDITION: WeatherCondition = { icon: "cloud", label: "unknown" };

/** Icon + label key for a WMO code. Unrecognised codes degrade to a plain cloud. */
export function weatherCondition(code: number): WeatherCondition {
  return CONDITIONS.find((c) => code >= c.from && code <= c.to)?.condition ?? UNKNOWN_CONDITION;
}

/**
 * English condition text for the AI day summary. Deliberately not `t()` — like
 * every other string in `ai.ts`, what the model reads stays English regardless
 * of the UI language.
 */
const ENGLISH_CONDITIONS: Record<string, string> = {
  clear: "clear sky",
  mainlyClear: "mainly clear",
  partlyCloudy: "partly cloudy",
  overcast: "overcast",
  fog: "fog",
  drizzle: "drizzle",
  freezingDrizzle: "freezing drizzle",
  rain: "rain",
  freezingRain: "freezing rain",
  snow: "snow",
  snowGrains: "snow grains",
  rainShowers: "rain showers",
  snowShowers: "snow showers",
  thunderstorm: "thunderstorm",
  thunderstormHail: "thunderstorm with hail",
  unknown: "unsettled",
};

export function englishCondition(code: number): string {
  return ENGLISH_CONDITIONS[weatherCondition(code).label] ?? ENGLISH_CONDITIONS.unknown;
}
