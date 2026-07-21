import { useTranslation } from "react-i18next";
import {
  Sun, Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
} from "lucide-react";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadWeather, weatherLocation, temperatureUnit } from "./dayData";
import type { TodayWidget, TodayWidgetProps } from "./types";
import { isForecastable, weatherCondition, aqiBand, type DayWeather } from "../../lib/weather";
import { fmtTime, fmtHour } from "../../lib/format";

function Weather({ day, revision }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const location = weatherLocation();
  const unit = temperatureUnit();
  // Mounting is the gate: a hidden card isn't rendered, so it never asks. That
  // matters here — this hits someone else's free service.
  const { data: weather, loading, error } = useAsync(
    () => (location && isForecastable(day)
      ? loadWeather(location, day, unit, revision)
      : Promise.resolve(null)),
    [day.getTime(), revision, unit, location?.latitude, location?.longitude],
  );

  // No location set: the card would be a standing advert for a setting.
  if (!location) return null;

  return (
    <CardShell
      title={tr("today.weather", { place: location.name })}
      loading={loading && weather === undefined}
      error={error}
      skeletonLines={2}
    >
      {!weather ? (
        <CardEmpty>
          {isForecastable(day) ? tr("today.weatherUnavailable") : tr("today.weatherOutOfRange")}
        </CardEmpty>
      ) : (
        <WeatherBody weather={weather} />
      )}
    </CardShell>
  );
}

export const weatherWidget: TodayWidget = {
  id: "weather",
  labelKey: "today.weatherCard",
  Component: Weather,
};

/** lucide components for the icon names `weatherCondition` returns. */
const WEATHER_ICONS = {
  "sun": Sun,
  "cloud-sun": CloudSun,
  "cloud": Cloud,
  "cloud-fog": CloudFog,
  "cloud-drizzle": CloudDrizzle,
  "cloud-rain": CloudRain,
  "cloud-snow": CloudSnow,
  "cloud-lightning": CloudLightning,
} as const;

function WeatherBody({ weather }: { weather: DayWeather }) {
  const { t: tr } = useTranslation();
  const condition = weatherCondition(weather.code);
  const Icon = WEATHER_ICONS[condition.icon];
  // Whole degrees: the service's tenth of a degree is noise at tile size.
  const deg = (v: number) => `${Math.round(v)}${weather.unit}`;
  const band = weather.air ? aqiBand(weather.air.usAqi) : null;

  return (
    <div className="space-y-3 py-1">
      <div className="flex items-center gap-3">
        <Icon size={32} className="shrink-0 text-blue-500" />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            {/* "Now" only exists on today; other days lead with the high. */}
            <span className="text-2xl font-semibold">{deg(weather.now ?? weather.high)}</span>
            <span className="truncate text-sm text-neutral-400">
              {tr(`weather.conditions.${condition.label}` as "weather.conditions.clear")}
            </span>
          </div>
          <div className="text-xs text-neutral-400">
            {tr("today.weatherRange", { high: deg(weather.high), low: deg(weather.low) })}
            {weather.precipitation !== null && weather.precipitation > 0 &&
              ` · ${tr("today.weatherPrecipitation", { percent: weather.precipitation })}`}
          </div>
        </div>
      </div>

      {/* The rest of the day. Scrolls rather than wrapping — a second row of
          hours reads as a second day. */}
      {weather.hours.length > 1 && (
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {weather.hours.map((h) => {
            const HourIcon = WEATHER_ICONS[weatherCondition(h.code).icon];
            return (
              <div key={h.time} className="flex w-11 shrink-0 flex-col items-center gap-0.5">
                <span className="text-[10px] text-neutral-400">{fmtHour(Number(h.time.slice(11, 13)))}</span>
                <HourIcon size={15} className="text-blue-500" />
                <span className="text-xs">{deg(h.temp)}</span>
                {/* Only worth the ink when there's a real chance of rain. */}
                <span className="text-[10px] text-blue-500">
                  {h.precipitation !== null && h.precipitation >= 10 ? `${h.precipitation}%` : "\u00a0"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-neutral-100 pt-2 text-xs dark:border-neutral-700">
        {weather.feelsLike !== null && (
          <Stat label={tr("today.feelsLike")} value={deg(weather.feelsLike)} />
        )}
        {weather.humidity !== null && (
          <Stat label={tr("today.humidity")} value={`${Math.round(weather.humidity)}%`} />
        )}
        {weather.wind !== null && (
          <Stat label={tr("today.wind")} value={`${Math.round(weather.wind)} ${weather.windUnit}`} />
        )}
        {weather.uvIndex !== null && (
          <Stat label={tr("today.uvIndex")} value={String(Math.round(weather.uvIndex))} />
        )}
        {weather.air && band && (
          <Stat
            label={tr("today.airQuality")}
            value={`${Math.round(weather.air.usAqi)} · ${tr(`weather.aqi.${band.label}` as "weather.aqi.good")}`}
            tone={band.tone}
          />
        )}
        {weather.sunrise && weather.sunset && (
          <Stat
            label={tr("today.daylight")}
            value={`${fmtTime(new Date(weather.sunrise))} – ${fmtTime(new Date(weather.sunset))}`}
          />
        )}
      </div>
    </div>
  );
}

/** One label/value pair in the weather card's stat row. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-neutral-400">{label}</span>
      <span className={tone ?? ""}>{value}</span>
    </span>
  );
}
