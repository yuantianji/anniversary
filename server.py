#!/usr/bin/env python3
"""Local anniversary reminder service with SQLite storage."""

from __future__ import annotations

import base64
import calendar
import json
import hashlib
import os
import secrets
import sqlite3
import threading
import unicodedata
import urllib.error
import urllib.request
from datetime import date, datetime, time as dt_time, timedelta
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from lunardate import LunarDate
from pywebpush import WebPushException, webpush


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATABASE_PATH = ROOT / "anniversaries.db"
VAPID_PRIVATE_PATH = ROOT / "vapid_private.pem"
DEFAULT_PORT = 5178
APP_HOST = os.environ.get("APP_HOST", "127.0.0.1")
APP_PORT = int(os.environ.get("APP_PORT", str(DEFAULT_PORT)))
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
VAPID_PUBLIC_KEY = ""
LUNAR_MIN_YEAR = 1900
LUNAR_MAX_YEAR = 2099
LUNAR_MONTH_NAMES = ("正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月")


def ensure_vapid_keys() -> str:
    if VAPID_PRIVATE_PATH.exists():
        private_key = serialization.load_pem_private_key(
            VAPID_PRIVATE_PATH.read_bytes(), password=None
        )
    else:
        private_key = ec.generate_private_key(ec.SECP256R1())
        VAPID_PRIVATE_PATH.write_bytes(
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode("ascii")


def db_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_database() -> None:
    with db_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                username_key TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO users (username, username_key) VALUES (?, ?)",
            ("默认用户", "默认用户"),
        )
        default_user_id = connection.execute(
            "SELECT id FROM users WHERE username_key = ?", ("默认用户",)
        ).fetchone()[0]
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS anniversaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                accent TEXT NOT NULL DEFAULT '#E85C4A',
                mode TEXT NOT NULL CHECK(mode IN ('countdown', 'elapsed')),
                event_date TEXT NOT NULL,
                event_time TEXT NOT NULL DEFAULT '00:00:00',
                calendar_type TEXT NOT NULL DEFAULT 'solar' CHECK(calendar_type IN ('solar', 'lunar')),
                lunar_year INTEGER,
                lunar_month INTEGER,
                lunar_day INTEGER,
                lunar_is_leap INTEGER NOT NULL DEFAULT 0,
                repeat_rule TEXT NOT NULL DEFAULT 'once' CHECK(repeat_rule IN ('once', 'yearly', 'monthly', 'daily')),
                reminder_enabled INTEGER NOT NULL DEFAULT 1,
                advance_days INTEGER NOT NULL DEFAULT 7,
                reminder_type TEXT NOT NULL DEFAULT 'daily' CHECK(reminder_type IN ('daily', 'times')),
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
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        anniversary_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(anniversaries)").fetchall()
        }
        if "user_id" not in anniversary_columns:
            connection.execute("ALTER TABLE anniversaries ADD COLUMN user_id INTEGER REFERENCES users(id)")
        if "web_push_enabled" not in anniversary_columns:
            connection.execute(
                "ALTER TABLE anniversaries ADD COLUMN web_push_enabled INTEGER NOT NULL DEFAULT 1"
            )
        if "event_time" not in anniversary_columns:
            connection.execute(
                "ALTER TABLE anniversaries ADD COLUMN event_time TEXT NOT NULL DEFAULT '00:00:00'"
            )
        if "calendar_type" not in anniversary_columns:
            connection.execute(
                "ALTER TABLE anniversaries ADD COLUMN calendar_type TEXT NOT NULL DEFAULT 'solar'"
            )
        if "lunar_year" not in anniversary_columns:
            connection.execute("ALTER TABLE anniversaries ADD COLUMN lunar_year INTEGER")
        if "lunar_month" not in anniversary_columns:
            connection.execute("ALTER TABLE anniversaries ADD COLUMN lunar_month INTEGER")
        if "lunar_day" not in anniversary_columns:
            connection.execute("ALTER TABLE anniversaries ADD COLUMN lunar_day INTEGER")
        if "lunar_is_leap" not in anniversary_columns:
            connection.execute(
                "ALTER TABLE anniversaries ADD COLUMN lunar_is_leap INTEGER NOT NULL DEFAULT 0"
            )
        if "repeat_rule" not in anniversary_columns:
            connection.execute(
                "ALTER TABLE anniversaries ADD COLUMN repeat_rule TEXT NOT NULL DEFAULT 'once'"
            )
        if "reminder_occurrence_date" not in anniversary_columns:
            connection.execute(
                "ALTER TABLE anniversaries ADD COLUMN reminder_occurrence_date TEXT"
            )
        connection.execute(
            """UPDATE anniversaries
            SET reminder_occurrence_date = event_date
            WHERE reminder_occurrence_date IS NULL AND reminders_sent > 0"""
        )
        connection.execute(
            "UPDATE anniversaries SET user_id = ? WHERE user_id IS NULL", (default_user_id,)
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS push_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                anniversary_id INTEGER NOT NULL,
                channel TEXT NOT NULL DEFAULT 'wecom',
                status TEXT NOT NULL,
                detail TEXT NOT NULL,
                sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(anniversary_id) REFERENCES anniversaries(id) ON DELETE CASCADE
            )
            """
        )
        push_log_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(push_logs)").fetchall()
        }
        if "user_id" not in push_log_columns:
            connection.execute("ALTER TABLE push_logs ADD COLUMN user_id INTEGER REFERENCES users(id)")
        if "channel" not in push_log_columns:
            connection.execute(
                "ALTER TABLE push_logs ADD COLUMN channel TEXT NOT NULL DEFAULT 'wecom'"
            )
        connection.execute(
            """
            UPDATE push_logs
            SET user_id = COALESCE(
                (SELECT user_id FROM anniversaries WHERE anniversaries.id = push_logs.anniversary_id),
                ?
            )
            WHERE user_id IS NULL
            """,
            (default_user_id,),
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
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
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        count = connection.execute("SELECT COUNT(*) FROM anniversaries").fetchone()[0]
        if count == 0:
            connection.executemany(
                """
                INSERT INTO anniversaries
                (user_id, title, accent, mode, event_date, reminder_enabled, advance_days, reminder_type,
                 max_reminders, reminder_time, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (default_user_id, "小满的生日", "#EF6E5B", "countdown", (date.today() + timedelta(days=12)).isoformat(), 1, 10, "daily", None, "09:00", "记得订一束向日葵"),
                    (default_user_id, "恋爱纪念日", "#DA7E9B", "countdown", (date.today() + timedelta(days=38)).isoformat(), 1, 14, "times", 3, "20:30", "提前预订晚餐"),
                    (default_user_id, "一起走过的日子", "#4D9C91", "elapsed", (date.today() - timedelta(days=818)).isoformat(), 1, 0, "daily", None, "08:30", "每一天都值得纪念"),
                ],
            )


def normalized_username(value: Any) -> tuple[str, str]:
    username = unicodedata.normalize("NFKC", str(value or "")).strip()
    if not username or len(username) > 32:
        raise ValueError("请输入 1-32 个字符的用户名")
    if any(character in "\r\n\t" or ord(character) < 32 for character in username):
        raise ValueError("用户名包含无效字符")
    return username, username.casefold()


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def login_user(payload: dict[str, Any]) -> dict[str, Any]:
    username, username_key = normalized_username(payload.get("username"))
    with db_connection() as connection:
        cursor = connection.execute(
            "INSERT OR IGNORE INTO users (username, username_key) VALUES (?, ?)",
            (username, username_key),
        )
        created = cursor.rowcount > 0
        row = connection.execute(
            "SELECT id, username FROM users WHERE username_key = ?", (username_key,)
        ).fetchone()
        user_id = row["id"]
        stored_username = row["username"]

        token = secrets.token_urlsafe(32)
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)",
            (token_digest(token), user_id),
        )
        connection.execute(
            """
            DELETE FROM sessions
            WHERE user_id = ? AND token_hash NOT IN (
                SELECT token_hash FROM sessions
                WHERE user_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT 20
            )
            """,
            (user_id, user_id),
        )
    return {
        "token": token,
        "user": {"id": user_id, "username": stored_username},
        "created": created,
    }


def user_for_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    with db_connection() as connection:
        row = connection.execute(
            """
            SELECT users.id, users.username
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
            """,
            (token_digest(token),),
        ).fetchone()
    return dict(row) if row else None


def revoke_token(token: str) -> None:
    if not token:
        return
    with db_connection() as connection:
        connection.execute(
            "DELETE FROM sessions WHERE token_hash = ?", (token_digest(token),)
        )


def as_dict(row: sqlite3.Row, include_owner: bool = False) -> dict[str, Any]:
    item = dict(row)
    if not include_owner:
        item.pop("user_id", None)
    item["reminder_enabled"] = bool(item["reminder_enabled"])
    item["web_push_enabled"] = bool(item["web_push_enabled"])
    item["lunar_is_leap"] = bool(item["lunar_is_leap"])
    item["max_reminders"] = item["max_reminders"] if item["max_reminders"] is not None else None
    occurrence = next_occurrence_datetime(item)
    item["next_occurrence_date"] = occurrence.date().isoformat()
    item["next_occurrence_time"] = occurrence.strftime("%H:%M:%S")
    return item


def get_anniversary(anniversary_id: int, user_id: int) -> dict[str, Any] | None:
    with db_connection() as connection:
        row = connection.execute(
            "SELECT * FROM anniversaries WHERE id = ? AND user_id = ?",
            (anniversary_id, user_id),
        ).fetchone()
    return as_dict(row) if row else None


def list_anniversaries(user_id: int | None = None) -> list[dict[str, Any]]:
    with db_connection() as connection:
        if user_id is None:
            rows = connection.execute(
                "SELECT * FROM anniversaries ORDER BY event_date ASC, event_time ASC, id DESC"
            ).fetchall()
        else:
            rows = connection.execute(
                """SELECT * FROM anniversaries
                WHERE user_id = ?
                ORDER BY event_date ASC, event_time ASC, id DESC""",
                (user_id,),
            ).fetchall()
    return [as_dict(row, include_owner=user_id is None) for row in rows]


def lunar_to_solar(year: int, month: int, day: int, is_leap: bool) -> date:
    if not LUNAR_MIN_YEAR <= year <= LUNAR_MAX_YEAR:
        raise ValueError(f"农历年份应在 {LUNAR_MIN_YEAR}-{LUNAR_MAX_YEAR} 之间")
    try:
        solar_date = LunarDate(year, month, day, is_leap).toSolarDate()
        converted = LunarDate.fromSolarDate(solar_date.year, solar_date.month, solar_date.day)
    except ValueError as error:
        raise ValueError("请选择有效的农历日期") from error
    if (
        converted.year != year
        or converted.month != month
        or converted.day != day
        or bool(converted.isLeapMonth) != is_leap
    ):
        raise ValueError("所选农历日期或闰月无效")
    return solar_date


def lunar_month_days(year: int, month: int, is_leap: bool) -> int:
    try:
        lunar_to_solar(year, month, 30, is_leap)
        return 30
    except ValueError:
        lunar_to_solar(year, month, 29, is_leap)
        return 29


def lunar_year_options(year: int, selected: LunarDate | None = None) -> dict[str, Any]:
    if not LUNAR_MIN_YEAR <= year <= LUNAR_MAX_YEAR:
        raise ValueError(f"农历年份应在 {LUNAR_MIN_YEAR}-{LUNAR_MAX_YEAR} 之间")
    leap_month = LunarDate.leapMonthForYear(year)
    months = []
    for month in range(1, 13):
        month_variants = (False, True) if leap_month == month else (False,)
        for is_leap in month_variants:
            first_day = lunar_to_solar(year, month, 1, is_leap)
            months.append(
                {
                    "month": month,
                    "is_leap": is_leap,
                    "label": f"{'闰' if is_leap else ''}{LUNAR_MONTH_NAMES[month - 1]}",
                    "days": lunar_month_days(year, month, is_leap),
                    "solar_start": first_day.isoformat(),
                }
            )
    result: dict[str, Any] = {
        "min_year": LUNAR_MIN_YEAR,
        "max_year": LUNAR_MAX_YEAR,
        "year": year,
        "leap_month": leap_month,
        "months": months,
    }
    if selected is not None:
        result["selected"] = {
            "year": selected.year,
            "month": selected.month,
            "day": selected.day,
            "is_leap": bool(selected.isLeapMonth),
        }
    return result


def event_datetime(item: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(
        f"{item['event_date']}T{item.get('event_time') or '00:00:00'}"
    )


def solar_month_occurrence(year: int, month: int, day: int, event_time: dt_time) -> datetime:
    clamped_day = min(day, calendar.monthrange(year, month)[1])
    return datetime.combine(date(year, month, clamped_day), event_time)


def next_solar_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def lunar_month_occurrences(
    year: int, day: int, event_time: dt_time
) -> list[datetime]:
    occurrences = []
    for month in lunar_year_options(year)["months"]:
        occurrence_day = min(day, month["days"])
        solar_start = date.fromisoformat(month["solar_start"])
        solar_date = solar_start + timedelta(days=occurrence_day - 1)
        occurrences.append(datetime.combine(solar_date, event_time))
    return occurrences


def next_occurrence_datetime(
    item: dict[str, Any], reference: datetime | None = None
) -> datetime:
    base = event_datetime(item)
    repeat_rule = item.get("repeat_rule") or "once"
    if item.get("mode") != "countdown" or repeat_rule == "once":
        return base

    reference = reference or datetime.now()
    if reference <= base:
        return base
    event_time = base.time()

    if repeat_rule == "daily":
        candidate = datetime.combine(reference.date(), event_time)
        return candidate if candidate >= reference else candidate + timedelta(days=1)

    if repeat_rule == "monthly":
        if item.get("calendar_type") == "lunar":
            current_lunar = LunarDate.fromSolarDate(
                reference.year, reference.month, reference.day
            )
            for lunar_year in range(current_lunar.year, LUNAR_MAX_YEAR + 1):
                for candidate in lunar_month_occurrences(
                    lunar_year, int(item["lunar_day"]), event_time
                ):
                    if candidate >= reference:
                        return candidate
            return base

        year, month = reference.year, reference.month
        candidate = solar_month_occurrence(year, month, base.day, event_time)
        if candidate < reference:
            year, month = next_solar_month(year, month)
            candidate = solar_month_occurrence(year, month, base.day, event_time)
        return candidate

    if item.get("calendar_type") == "lunar":
        current_lunar = LunarDate.fromSolarDate(
            reference.year, reference.month, reference.day
        )
        lunar_month = int(item["lunar_month"])
        lunar_day = int(item["lunar_day"])
        is_leap = bool(item["lunar_is_leap"])
        for lunar_year in range(current_lunar.year, LUNAR_MAX_YEAR + 1):
            if is_leap and LunarDate.leapMonthForYear(lunar_year) != lunar_month:
                continue
            try:
                days = lunar_month_days(lunar_year, lunar_month, is_leap)
                solar_date = lunar_to_solar(
                    lunar_year, lunar_month, min(lunar_day, days), is_leap
                )
            except ValueError:
                continue
            candidate = datetime.combine(solar_date, event_time)
            if candidate >= reference:
                return candidate
        return base

    candidate = solar_month_occurrence(
        reference.year, base.month, base.day, event_time
    )
    if candidate < reference:
        candidate = solar_month_occurrence(
            reference.year + 1, base.month, base.day, event_time
        )
    return candidate


def validate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    title = str(payload.get("title", "")).strip()
    if not title or len(title) > 50:
        raise ValueError("请填写 1-50 个字符的纪念日名称")

    mode = payload.get("mode")
    if mode not in ("countdown", "elapsed"):
        raise ValueError("纪念方式无效")

    repeat_rule = str(payload.get("repeat_rule", "once")).strip().lower()
    if repeat_rule not in ("once", "yearly", "monthly", "daily"):
        raise ValueError("重复周期无效")
    if mode != "countdown":
        repeat_rule = "once"

    calendar_type = str(payload.get("calendar_type", "solar")).strip().lower()
    if calendar_type not in ("solar", "lunar"):
        raise ValueError("日期类型无效")

    lunar_year = None
    lunar_month = None
    lunar_day = None
    lunar_is_leap = False
    if calendar_type == "lunar":
        try:
            lunar_year = int(payload.get("lunar_year"))
            lunar_month = int(payload.get("lunar_month"))
            lunar_day = int(payload.get("lunar_day"))
        except (TypeError, ValueError) as error:
            raise ValueError("请选择完整的农历日期") from error
        lunar_is_leap = payload.get("lunar_is_leap") in (True, 1, "1")
        event_date = lunar_to_solar(
            lunar_year, lunar_month, lunar_day, lunar_is_leap
        ).isoformat()
    else:
        try:
            event_date = date.fromisoformat(str(payload.get("event_date", ""))).isoformat()
        except ValueError as error:
            raise ValueError("请选择正确的日期") from error

    event_time = str(payload.get("event_time", "00:00:00")).strip()
    if event_time.count(":") == 1:
        event_time += ":00"
    try:
        event_time = datetime.strptime(event_time, "%H:%M:%S").strftime("%H:%M:%S")
    except ValueError as error:
        raise ValueError("请选择正确的纪念时间") from error

    reminder_type = payload.get("reminder_type", "daily")
    if reminder_type not in ("daily", "times"):
        raise ValueError("提醒频率无效")

    try:
        advance_days = int(payload.get("advance_days", 0))
        max_reminders = payload.get("max_reminders")
        max_reminders = int(max_reminders) if max_reminders not in (None, "") else None
    except (TypeError, ValueError) as error:
        raise ValueError("提醒次数必须是数字") from error

    if not 0 <= advance_days <= 3650:
        raise ValueError("提前提醒天数应在 0 到 3650 之间")
    if reminder_type == "times" and (max_reminders is None or not 1 <= max_reminders <= 3650):
        raise ValueError("请设置 1-3650 次提醒")

    reminder_time = str(payload.get("reminder_time", "09:00"))
    try:
        datetime.strptime(reminder_time, "%H:%M")
    except ValueError as error:
        raise ValueError("提醒时间格式不正确") from error

    webhook_url = str(payload.get("webhook_url", "")).strip()
    if webhook_url:
        parsed = urlparse(webhook_url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError("微信机器人地址需要使用有效的 HTTPS URL")

    accent = str(payload.get("accent", "#E85C4A"))
    if len(accent) != 7 or not accent.startswith("#"):
        accent = "#E85C4A"

    return {
        "title": title,
        "accent": accent,
        "mode": mode,
        "event_date": event_date,
        "event_time": event_time,
        "calendar_type": calendar_type,
        "lunar_year": lunar_year,
        "lunar_month": lunar_month,
        "lunar_day": lunar_day,
        "lunar_is_leap": 1 if lunar_is_leap else 0,
        "repeat_rule": repeat_rule,
        "reminder_enabled": 1 if payload.get("reminder_enabled", True) else 0,
        "advance_days": advance_days,
        "reminder_type": reminder_type,
        "max_reminders": max_reminders if reminder_type == "times" else None,
        "reminder_time": reminder_time,
        "webhook_url": webhook_url or None,
        "web_push_enabled": 1 if payload.get("web_push_enabled", True) else 0,
        "note": str(payload.get("note", "")).strip()[:240],
    }


def create_anniversary(user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    item = validate_payload(payload)
    item = {"user_id": user_id, **item}
    fields = ", ".join(item)
    placeholders = ", ".join("?" for _ in item)
    with db_connection() as connection:
        cursor = connection.execute(
            f"INSERT INTO anniversaries ({fields}) VALUES ({placeholders})", tuple(item.values())
        )
        anniversary_id = cursor.lastrowid
    return get_anniversary(anniversary_id, user_id)  # type: ignore[return-value]


def update_anniversary(
    anniversary_id: int, user_id: int, payload: dict[str, Any]
) -> dict[str, Any] | None:
    item = validate_payload(payload)
    assignments = ", ".join(f"{field} = ?" for field in item)
    schedule_fields = (
        "mode",
        "event_date",
        "event_time",
        "calendar_type",
        "lunar_year",
        "lunar_month",
        "lunar_day",
        "lunar_is_leap",
        "repeat_rule",
        "reminder_enabled",
        "advance_days",
        "reminder_type",
        "max_reminders",
        "reminder_time",
        "webhook_url",
        "web_push_enabled",
    )
    with db_connection() as connection:
        existing = connection.execute(
            "SELECT * FROM anniversaries WHERE id = ? AND user_id = ?",
            (anniversary_id, user_id),
        ).fetchone()
        if existing is None:
            return None
        schedule_changed = any(existing[field] != item[field] for field in schedule_fields)
        reset_schedule = (
            ", reminders_sent = 0, last_reminded_on = NULL, reminder_occurrence_date = NULL"
            if schedule_changed
            else ""
        )
        cursor = connection.execute(
            f"""UPDATE anniversaries
            SET {assignments}{reset_schedule}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?""",
            (*item.values(), anniversary_id, user_id),
        )
    if cursor.rowcount == 0:
        return None
    return get_anniversary(anniversary_id, user_id)


def delete_anniversary(anniversary_id: int, user_id: int) -> bool:
    with db_connection() as connection:
        connection.execute(
            "DELETE FROM push_logs WHERE anniversary_id = ? AND user_id = ?",
            (anniversary_id, user_id),
        )
        cursor = connection.execute(
            "DELETE FROM anniversaries WHERE id = ? AND user_id = ?",
            (anniversary_id, user_id),
        )
    return cursor.rowcount > 0


def relative_days(item: dict[str, Any], today: date | None = None) -> int:
    today = today or date.today()
    event_date = date.fromisoformat(item["event_date"])
    if item["mode"] == "countdown":
        reference = datetime.combine(today, dt_time.min)
        target_date = next_occurrence_datetime(item, reference).date()
        return (target_date - today).days
    return (today - event_date).days


def notification_message(item: dict[str, Any]) -> str:
    days = relative_days(item)
    if item["mode"] == "countdown":
        count_text = "就是今天" if days == 0 else f"还有 {days} 天"
        intro = f"{item['title']} {count_text}。"
    else:
        intro = f"{item['title']}已经第 {days} 天了。"
    note = f"\n{item['note']}" if item["note"] else ""
    return f"[纪念日提醒] {intro}{note}"


def send_wecom_webhook(url: str, message: str) -> tuple[bool, str]:
    body = json.dumps({"msgtype": "text", "text": {"content": message}}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read().decode("utf-8", errors="replace")
        decoded = json.loads(raw) if raw else {}
        if decoded.get("errcode", 0) != 0:
            return False, decoded.get("errmsg", "企业微信返回错误")
        return True, "推送成功"
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as error:
        return False, f"推送失败：{error}"


def save_push_subscription(
    user_id: int, payload: dict[str, Any], user_agent: str
) -> dict[str, Any]:
    subscription = payload.get("subscription", payload)
    if not isinstance(subscription, dict):
        raise ValueError("推送订阅格式不正确")
    endpoint = str(subscription.get("endpoint", "")).strip()
    keys = subscription.get("keys", {})
    p256dh = str(keys.get("p256dh", "")).strip() if isinstance(keys, dict) else ""
    auth = str(keys.get("auth", "")).strip() if isinstance(keys, dict) else ""
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.netloc or len(endpoint) > 4096:
        raise ValueError("推送订阅地址无效")
    if not p256dh or not auth or len(p256dh) > 512 or len(auth) > 512:
        raise ValueError("推送订阅密钥无效")
    try:
        p256dh_bytes = base64.b64decode(
            p256dh + "=" * ((4 - len(p256dh) % 4) % 4), altchars=b"-_", validate=True
        )
        auth_bytes = base64.b64decode(
            auth + "=" * ((4 - len(auth) % 4) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, TypeError) as error:
        raise ValueError("推送订阅密钥无效") from error
    if len(p256dh_bytes) != 65 or p256dh_bytes[0] != 4 or len(auth_bytes) != 16:
        raise ValueError("推送订阅密钥无效")

    with db_connection() as connection:
        cursor = connection.execute(
            """
            UPDATE push_subscriptions
            SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?,
                last_error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE endpoint = ?
            """,
            (user_id, p256dh, auth, user_agent[:300], endpoint),
        )
        if cursor.rowcount == 0:
            connection.execute(
                """
                INSERT INTO push_subscriptions
                (user_id, endpoint, p256dh, auth, user_agent)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_id, endpoint, p256dh, auth, user_agent[:300]),
            )
        count = connection.execute(
            "SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
    return {"subscribed": True, "subscription_count": count}


def delete_push_subscription(user_id: int, payload: dict[str, Any]) -> bool:
    endpoint = str(payload.get("endpoint", "")).strip()
    if not endpoint:
        raise ValueError("缺少推送订阅地址")
    with db_connection() as connection:
        cursor = connection.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            (user_id, endpoint),
        )
    return cursor.rowcount > 0


def push_subscription_count(user_id: int) -> int:
    with db_connection() as connection:
        return connection.execute(
            "SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?", (user_id,)
        ).fetchone()[0]


def send_web_push_to_user(
    user_id: int, title: str, body: str, tag: str = "anniversary-reminder"
) -> tuple[int, int, str]:
    with db_connection() as connection:
        subscriptions = connection.execute(
            "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
            (user_id,),
        ).fetchall()

    if not subscriptions:
        return 0, 0, "该用户还没有开启系统通知"

    data = json.dumps(
        {
            "title": title,
            "body": body,
            "icon": "/icons/icon-192.png",
            "badge": "/icons/icon-192.png",
            "url": "/",
            "tag": tag,
        },
        ensure_ascii=False,
    )
    success_count = 0
    failure_count = 0
    errors: list[str] = []
    for subscription in subscriptions:
        subscription_info = {
            "endpoint": subscription["endpoint"],
            "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=data,
                vapid_private_key=str(VAPID_PRIVATE_PATH),
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=86400,
            )
            success_count += 1
            with db_connection() as connection:
                connection.execute(
                    """
                    UPDATE push_subscriptions
                    SET last_success_at = CURRENT_TIMESTAMP, last_error = NULL
                    WHERE id = ?
                    """,
                    (subscription["id"],),
                )
        except WebPushException as error:
            failure_count += 1
            status_code = getattr(getattr(error, "response", None), "status_code", None)
            detail = f"{status_code or 'error'}: {error}"
            errors.append(detail[:180])
            with db_connection() as connection:
                if status_code in (404, 410):
                    connection.execute(
                        "DELETE FROM push_subscriptions WHERE id = ?", (subscription["id"],)
                    )
                else:
                    connection.execute(
                        "UPDATE push_subscriptions SET last_error = ? WHERE id = ?",
                        (detail[:500], subscription["id"]),
                    )
        except Exception as error:
            failure_count += 1
            detail = str(error)
            errors.append(detail[:180])
            with db_connection() as connection:
                connection.execute(
                    "UPDATE push_subscriptions SET last_error = ? WHERE id = ?",
                    (detail[:500], subscription["id"]),
                )

    detail = f"成功 {success_count} 台，失败 {failure_count} 台"
    if errors:
        detail += f"；{errors[0]}"
    return success_count, failure_count, detail


def log_push(
    user_id: int, anniversary_id: int, channel: str, status: str, detail: str
) -> None:
    with db_connection() as connection:
        connection.execute(
            """INSERT INTO push_logs (user_id, anniversary_id, channel, status, detail)
            VALUES (?, ?, ?, ?, ?)""",
            (user_id, anniversary_id, channel, status, detail[:500]),
        )


def reminder_is_due(item: dict[str, Any], now: datetime) -> bool:
    if not item["reminder_enabled"] or not (
        item["webhook_url"] or item["web_push_enabled"]
    ):
        return False
    if item["last_reminded_on"] == now.date().isoformat():
        return False
    if now.strftime("%H:%M") != item["reminder_time"]:
        return False
    if item["mode"] == "countdown":
        days = relative_days(item, now.date())
        if days < 0 or days > item["advance_days"]:
            return False
    elif relative_days(item, now.date()) < 0:
        return False
    if item["reminder_type"] == "times":
        occurrence_date = next_occurrence_datetime(
            item, datetime.combine(now.date(), dt_time.min)
        ).date().isoformat()
        reminders_sent = (
            item["reminders_sent"]
            if item.get("reminder_occurrence_date") == occurrence_date
            else 0
        )
        if reminders_sent >= item["max_reminders"]:
            return False
    return True


def dispatch_scheduled_reminders() -> None:
    now = datetime.now().replace(second=0, microsecond=0)
    for item in list_anniversaries():
        if not reminder_is_due(item, now):
            continue
        message = notification_message(item)
        delivered = False

        if item["web_push_enabled"]:
            success_count, failure_count, detail = send_web_push_to_user(
                item["user_id"], "纪念日提醒", message, f"anniversary-{item['id']}"
            )
            if success_count or failure_count:
                log_push(
                    item["user_id"],
                    item["id"],
                    "web_push",
                    "success" if success_count else "failed",
                    detail,
                )
            delivered = delivered or success_count > 0

        if item["webhook_url"]:
            success, detail = send_wecom_webhook(item["webhook_url"], message)
            log_push(
                item["user_id"],
                item["id"],
                "wecom",
                "success" if success else "failed",
                detail,
            )
            delivered = delivered or success

        if delivered:
            occurrence_date = next_occurrence_datetime(
                item, datetime.combine(now.date(), dt_time.min)
            ).date().isoformat()
            with db_connection() as connection:
                connection.execute(
                    """
                    UPDATE anniversaries
                    SET last_reminded_on = ?,
                        reminders_sent = CASE
                            WHEN reminder_occurrence_date = ? THEN reminders_sent + 1
                            ELSE 1
                        END,
                        reminder_occurrence_date = ?
                    WHERE id = ? AND user_id = ?
                    """,
                    (
                        now.date().isoformat(),
                        occurrence_date,
                        occurrence_date,
                        item["id"],
                        item["user_id"],
                    ),
                )


def reminder_worker() -> None:
    while True:
        try:
            dispatch_scheduled_reminders()
        except Exception as error:  # Keep the local service alive if one webhook fails unexpectedly.
            print(f"[reminder] {error}")
        threading.Event().wait(30)


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def json_response(self, status: int, data: Any) -> None:
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_json(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("请求数据不是有效 JSON") from error
        if not isinstance(payload, dict):
            raise ValueError("请求数据格式不正确")
        return payload

    def bearer_token(self) -> str:
        authorization = self.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        return token.strip() if separator and scheme.lower() == "bearer" else ""

    def require_user(self) -> dict[str, Any] | None:
        user = user_for_token(self.bearer_token())
        if user is None:
            self.json_response(HTTPStatus.UNAUTHORIZED, {"error": "登录状态无效，请重新进入"})
        return user

    def do_GET(self) -> None:
        parsed_path = urlparse(self.path)
        route = parsed_path.path
        if route == "/api/health":
            self.json_response(HTTPStatus.OK, {"status": "ok"})
            return
        if route == "/api/auth/me":
            user = self.require_user()
            if user:
                self.json_response(
                    HTTPStatus.OK,
                    {"user": user, "push_public_key": VAPID_PUBLIC_KEY},
                )
            return
        if route == "/api/anniversaries":
            user = self.require_user()
            if user:
                self.json_response(
                    HTTPStatus.OK, {"items": list_anniversaries(user["id"])}
                )
            return
        if route == "/api/lunar/options":
            user = self.require_user()
            if user:
                try:
                    query = parse_qs(parsed_path.query)
                    solar_text = query.get("solar_date", [""])[0]
                    selected = None
                    if solar_text:
                        solar_date = date.fromisoformat(solar_text)
                        selected = LunarDate.fromSolarDate(
                            solar_date.year, solar_date.month, solar_date.day
                        )
                        year = selected.year
                    else:
                        year = int(query.get("year", [str(date.today().year)])[0])
                    self.json_response(
                        HTTPStatus.OK, lunar_year_options(year, selected)
                    )
                except (TypeError, ValueError) as error:
                    self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        if route in ("/api/push/config", "/api/anniversaries/push-config"):
            user = self.require_user()
            if user:
                self.json_response(
                    HTTPStatus.OK,
                    {
                        "public_key": VAPID_PUBLIC_KEY,
                        "subscription_count": push_subscription_count(user["id"]),
                    },
                )
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/auth/login":
            try:
                result = login_user(self.read_json())
                result["push_public_key"] = VAPID_PUBLIC_KEY
                self.json_response(HTTPStatus.OK, result)
            except ValueError as error:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        if self.path == "/api/auth/logout":
            user = self.require_user()
            if user:
                revoke_token(self.bearer_token())
                self.json_response(HTTPStatus.OK, {"logged_out": True})
            return

        user = self.require_user()
        if user is None:
            return

        if self.path in (
            "/api/push/subscriptions",
            "/api/anniversaries/push-subscription",
        ):
            try:
                result = save_push_subscription(
                    user["id"], self.read_json(), self.headers.get("User-Agent", "")
                )
                self.json_response(HTTPStatus.OK, result)
            except ValueError as error:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        if self.path in ("/api/push/test", "/api/anniversaries/push-test"):
            success_count, failure_count, detail = send_web_push_to_user(
                user["id"],
                "纪念簿通知已开启",
                "这是一条测试消息，今后的纪念日会按你的设置提醒。",
                "anniversary-test",
            )
            if success_count:
                self.json_response(
                    HTTPStatus.OK,
                    {"success": True, "message": detail, "sent": success_count},
                )
            else:
                status = HTTPStatus.BAD_REQUEST if failure_count == 0 else HTTPStatus.BAD_GATEWAY
                self.json_response(status, {"error": detail})
            return

        if self.path == "/api/anniversaries":
            try:
                self.json_response(
                    HTTPStatus.CREATED,
                    {"item": create_anniversary(user["id"], self.read_json())},
                )
            except ValueError as error:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        parts = self.path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "anniversaries"] and parts[3] == "test-webhook":
            try:
                anniversary_id = int(parts[2])
            except ValueError:
                self.json_response(HTTPStatus.NOT_FOUND, {"error": "找不到纪念日"})
                return
            item = get_anniversary(anniversary_id, user["id"])
            if not item:
                self.json_response(HTTPStatus.NOT_FOUND, {"error": "找不到纪念日"})
            elif not item["webhook_url"]:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": "请先填写企业微信机器人地址"})
            else:
                success, detail = send_wecom_webhook(item["webhook_url"], notification_message(item))
                log_push(
                    user["id"],
                    anniversary_id,
                    "wecom",
                    "success" if success else "failed",
                    f"测试：{detail}",
                )
                self.json_response(HTTPStatus.OK if success else HTTPStatus.BAD_GATEWAY, {"success": success, "message": detail})
            return

        self.json_response(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})

    def do_PUT(self) -> None:
        user = self.require_user()
        if user is None:
            return
        parts = self.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "anniversaries"]:
            try:
                updated = update_anniversary(
                    int(parts[2]), user["id"], self.read_json()
                )
                if updated:
                    self.json_response(HTTPStatus.OK, {"item": updated})
                else:
                    self.json_response(HTTPStatus.NOT_FOUND, {"error": "找不到纪念日"})
            except ValueError as error:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self.json_response(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})

    def do_DELETE(self) -> None:
        user = self.require_user()
        if user is None:
            return
        if self.path in (
            "/api/push/subscriptions",
            "/api/anniversaries/push-subscription",
        ):
            try:
                deleted = delete_push_subscription(user["id"], self.read_json())
                self.json_response(HTTPStatus.OK, {"deleted": deleted})
            except ValueError as error:
                self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        parts = self.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "anniversaries"]:
            try:
                deleted = delete_anniversary(int(parts[2]), user["id"])
            except ValueError:
                deleted = False
            self.json_response(HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND, {"deleted": True} if deleted else {"error": "找不到纪念日"})
            return
        self.json_response(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")


def main() -> None:
    global VAPID_PUBLIC_KEY
    init_database()
    VAPID_PUBLIC_KEY = ensure_vapid_keys()
    threading.Thread(target=reminder_worker, daemon=True, name="reminder-worker").start()
    server = ThreadingHTTPServer((APP_HOST, APP_PORT), AppHandler)
    print(f"Anniversary app running at http://{APP_HOST}:{APP_PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
