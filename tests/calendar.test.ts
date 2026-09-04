import assert from "node:assert/strict";
import test from "node:test";
import { lunarToSolar, lunarYearOptions, nextOccurrence, relativeDays } from "../src/calendar.ts";
import { validateAnniversary } from "../src/data.ts";
import type { AnniversaryRow, LocalDateTime } from "../src/types.ts";

function item(overrides: Partial<AnniversaryRow> = {}): AnniversaryRow {
  return {
    id: 1, user_id: 1, title: "测试", accent: "#E85C4A", mode: "countdown",
    event_date: "2024-01-31", event_time: "09:30:00", calendar_type: "solar",
    lunar_year: null, lunar_month: null, lunar_day: null, lunar_is_leap: 0,
    repeat_rule: "once", reminder_enabled: 1, advance_days: 7, reminder_type: "daily",
    max_reminders: null, reminders_sent: 0, reminder_time: "09:00", webhook_url: null,
    web_push_enabled: 1, note: "", last_reminded_on: null, reminder_occurrence_date: null,
    created_at: "2024-01-01 00:00:00", updated_at: "2024-01-01 00:00:00", ...overrides,
  };
}

const reference = (value: Partial<LocalDateTime>): LocalDateTime => ({
  year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, ...value,
});

test("converts lunar new year to its solar date", () => {
  assert.deepEqual(lunarToSolar(2024, 1, 1, false), reference({ month: 2, day: 10 }));
});

test("reports the leap lunar month", () => {
  const options = lunarYearOptions(2023) as { leap_month: number; months: unknown[] };
  assert.equal(options.leap_month, 2);
  assert.equal(options.months.length, 13);
});

test("clamps monthly solar recurrence to the end of month", () => {
  const result = nextOccurrence(item({ repeat_rule: "monthly" }), reference({ month: 2, day: 1 }));
  assert.deepEqual(result, reference({ month: 2, day: 29, hour: 9, minute: 30 }));
});

test("moves yearly recurrence into the next year", () => {
  const result = nextOccurrence(item({ event_date: "2024-02-29", repeat_rule: "yearly" }), reference({ year: 2025, month: 3, day: 1 }));
  assert.deepEqual(result, reference({ year: 2026, month: 2, day: 28, hour: 9, minute: 30 }));
});

test("calculates countdown and elapsed day counts", () => {
  assert.equal(relativeDays(item({ event_date: "2024-02-10" }), reference({ month: 2, day: 1 })), 9);
  assert.equal(relativeDays(item({ mode: "elapsed", event_date: "2024-01-01" }), reference({ month: 2, day: 1 })), 31);
});

test("validates and normalizes API payloads", () => {
  const result = validateAnniversary({
    title: "  相识纪念日  ", mode: "countdown", event_date: "2026-09-04", event_time: "08:30",
    calendar_type: "solar", repeat_rule: "yearly", reminder_enabled: true, advance_days: "7",
    reminder_type: "times", max_reminders: "3", reminder_time: "09:00", web_push_enabled: true,
  });
  assert.equal(result.title, "相识纪念日");
  assert.equal(result.event_time, "08:30:00");
  assert.equal(result.max_reminders, 3);
});
