import { Lunar, LunarYear, Solar } from "lunar-typescript";
import type { AnniversaryRow, LocalDateTime } from "./types";
import { ApiError, addDays, daysBetween, localDate, localTime, parseDateTime, toNaiveEpoch } from "./utils";

export const LUNAR_MIN_YEAR = 1900;
export const LUNAR_MAX_YEAR = 2099;
const LUNAR_MONTH_NAMES = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];

function assertLunarYear(year: number): void {
  if (!Number.isInteger(year) || year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) {
    throw new ApiError(400, `农历年份应在 ${LUNAR_MIN_YEAR}-${LUNAR_MAX_YEAR} 之间`);
  }
}

export function lunarToSolar(year: number, month: number, day: number, isLeap: boolean): LocalDateTime {
  assertLunarYear(year);
  try {
    const lunarMonth = isLeap ? -month : month;
    const lunar = Lunar.fromYmd(year, lunarMonth, day);
    if (lunar.getYear() !== year || lunar.getMonth() !== lunarMonth || lunar.getDay() !== day) throw new Error();
    const solar = lunar.getSolar();
    return { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay(), hour: 0, minute: 0, second: 0 };
  } catch {
    throw new ApiError(400, "请选择有效的农历日期");
  }
}

export function lunarYearOptions(year: number, solarDate?: string): Record<string, unknown> {
  assertLunarYear(year);
  const lunarYear = LunarYear.fromYear(year);
  const months = lunarYear.getMonthsInYear().map((month) => {
    const value = month.getMonth();
    const isLeap = value < 0;
    const number = Math.abs(value);
    return {
      month: number,
      is_leap: isLeap,
      label: `${isLeap ? "闰" : ""}${LUNAR_MONTH_NAMES[number - 1]}`,
      days: month.getDayCount(),
      solar_start: localDate(lunarToSolar(year, number, 1, isLeap)),
    };
  });
  const result: Record<string, unknown> = {
    min_year: LUNAR_MIN_YEAR, max_year: LUNAR_MAX_YEAR, year,
    leap_month: lunarYear.getLeapMonth(), months,
  };
  if (solarDate) {
    const solarValue = parseDateTime(solarDate);
    const lunar = Solar.fromYmd(solarValue.year, solarValue.month, solarValue.day).getLunar();
    result.selected = {
      year: lunar.getYear(), month: Math.abs(lunar.getMonth()), day: lunar.getDay(), is_leap: lunar.getMonth() < 0,
    };
  }
  return result;
}

function daysInSolarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function solarMonthOccurrence(year: number, month: number, day: number, time: LocalDateTime): LocalDateTime {
  return { ...time, year, month, day: Math.min(day, daysInSolarMonth(year, month)) };
}

function lunarMonthOccurrences(year: number, day: number, time: LocalDateTime): LocalDateTime[] {
  if (year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) return [];
  return LunarYear.fromYear(year).getMonthsInYear().map((month) => {
    const monthValue = month.getMonth();
    const first = lunarToSolar(year, Math.abs(monthValue), 1, monthValue < 0);
    return { ...addDays(first, Math.min(day, month.getDayCount()) - 1), hour: time.hour, minute: time.minute, second: time.second };
  });
}

export function nextOccurrence(item: AnniversaryRow, reference?: LocalDateTime): LocalDateTime {
  const base = parseDateTime(item.event_date, item.event_time || "00:00:00");
  const repeatRule = item.repeat_rule || "once";
  if (item.mode !== "countdown" || repeatRule === "once" || !reference) return base;
  if (toNaiveEpoch(reference) <= toNaiveEpoch(base)) return base;

  if (repeatRule === "daily") {
    const candidate = { ...reference, hour: base.hour, minute: base.minute, second: base.second };
    return toNaiveEpoch(candidate) >= toNaiveEpoch(reference) ? candidate : addDays(candidate, 1);
  }
  if (repeatRule === "monthly") {
    if (item.calendar_type === "lunar" && item.lunar_day) {
      const currentLunar = Solar.fromYmd(reference.year, reference.month, reference.day).getLunar();
      for (let year = currentLunar.getYear(); year <= LUNAR_MAX_YEAR; year += 1) {
        for (const candidate of lunarMonthOccurrences(year, item.lunar_day, base)) {
          if (toNaiveEpoch(candidate) >= toNaiveEpoch(reference)) return candidate;
        }
      }
      return base;
    }
    let year = reference.year;
    let month = reference.month;
    let candidate = solarMonthOccurrence(year, month, base.day, base);
    if (toNaiveEpoch(candidate) < toNaiveEpoch(reference)) {
      month += 1;
      if (month === 13) { month = 1; year += 1; }
      candidate = solarMonthOccurrence(year, month, base.day, base);
    }
    return candidate;
  }
  if (item.calendar_type === "lunar" && item.lunar_month && item.lunar_day) {
    const currentLunar = Solar.fromYmd(reference.year, reference.month, reference.day).getLunar();
    for (let year = currentLunar.getYear(); year <= LUNAR_MAX_YEAR; year += 1) {
      const signedMonth = item.lunar_is_leap ? -item.lunar_month : item.lunar_month;
      const month = LunarYear.fromYear(year).getMonth(signedMonth);
      if (!month) continue;
      const solar = lunarToSolar(year, item.lunar_month, Math.min(item.lunar_day, month.getDayCount()), Boolean(item.lunar_is_leap));
      const candidate = { ...solar, hour: base.hour, minute: base.minute, second: base.second };
      if (toNaiveEpoch(candidate) >= toNaiveEpoch(reference)) return candidate;
    }
    return base;
  }
  let candidate = solarMonthOccurrence(reference.year, base.month, base.day, base);
  if (toNaiveEpoch(candidate) < toNaiveEpoch(reference)) candidate = solarMonthOccurrence(reference.year + 1, base.month, base.day, base);
  return candidate;
}

export function relativeDays(item: AnniversaryRow, today: LocalDateTime): number {
  const event = parseDateTime(item.event_date, item.event_time);
  if (item.mode === "countdown") {
    const midnight = { ...today, hour: 0, minute: 0, second: 0 };
    return daysBetween(midnight, nextOccurrence(item, midnight));
  }
  return daysBetween(event, today);
}

export function serializeAnniversary(item: AnniversaryRow, reference: LocalDateTime): Record<string, unknown> {
  const occurrence = nextOccurrence(item, reference);
  const { user_id: _userId, ...publicItem } = item;
  return {
    ...publicItem,
    reminder_enabled: Boolean(item.reminder_enabled), web_push_enabled: Boolean(item.web_push_enabled),
    lunar_is_leap: Boolean(item.lunar_is_leap), next_occurrence_date: localDate(occurrence),
    next_occurrence_time: localTime(occurrence),
  };
}
