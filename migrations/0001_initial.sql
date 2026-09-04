PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_created_idx ON sessions(user_id, created_at DESC);

CREATE TABLE anniversaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    accent TEXT NOT NULL DEFAULT '#E85C4A',
    mode TEXT NOT NULL CHECK (mode IN ('countdown', 'elapsed')),
    event_date TEXT NOT NULL,
    event_time TEXT NOT NULL DEFAULT '00:00:00',
    calendar_type TEXT NOT NULL DEFAULT 'solar' CHECK (calendar_type IN ('solar', 'lunar')),
    lunar_year INTEGER,
    lunar_month INTEGER,
    lunar_day INTEGER,
    lunar_is_leap INTEGER NOT NULL DEFAULT 0,
    repeat_rule TEXT NOT NULL DEFAULT 'once' CHECK (repeat_rule IN ('once', 'yearly', 'monthly', 'daily')),
    reminder_enabled INTEGER NOT NULL DEFAULT 1,
    advance_days INTEGER NOT NULL DEFAULT 7,
    reminder_type TEXT NOT NULL DEFAULT 'daily' CHECK (reminder_type IN ('daily', 'times')),
    max_reminders INTEGER,
    reminders_sent INTEGER NOT NULL DEFAULT 0,
    reminder_time TEXT NOT NULL DEFAULT '09:00',
    webhook_url TEXT,
    web_push_enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    last_reminded_on TEXT,
    reminder_occurrence_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX anniversaries_user_date_idx ON anniversaries(user_id, event_date, event_time);
CREATE INDEX anniversaries_reminder_idx ON anniversaries(reminder_enabled, reminder_time);

CREATE TABLE push_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    anniversary_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'wecom',
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (anniversary_id) REFERENCES anniversaries(id) ON DELETE CASCADE
);

CREATE INDEX push_logs_anniversary_idx ON push_logs(anniversary_id, sent_at DESC);

CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    last_success_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
