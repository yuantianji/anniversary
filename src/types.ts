export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_TIMEZONE: string;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

export interface User {
  id: number;
  username: string;
}

export interface AnniversaryRow {
  id: number;
  user_id: number;
  title: string;
  accent: string;
  mode: "countdown" | "elapsed";
  event_date: string;
  event_time: string;
  calendar_type: "solar" | "lunar";
  lunar_year: number | null;
  lunar_month: number | null;
  lunar_day: number | null;
  lunar_is_leap: number | boolean;
  repeat_rule: "once" | "yearly" | "monthly" | "daily";
  reminder_enabled: number | boolean;
  advance_days: number;
  reminder_type: "daily" | "times";
  max_reminders: number | null;
  reminders_sent: number;
  reminder_time: string;
  webhook_url: string | null;
  web_push_enabled: number | boolean;
  note: string;
  last_reminded_on: string | null;
  reminder_occurrence_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
