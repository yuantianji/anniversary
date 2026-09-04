#!/usr/bin/env python3
"""Export the local SQLite runtime data as D1-compatible INSERT statements."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path
from typing import Any


TABLES = ("users", "sessions", "anniversaries", "push_logs", "push_subscriptions")


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return f"X'{value.hex()}'"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def export_table(connection: sqlite3.Connection, table: str) -> list[str]:
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if not exists:
        return []
    columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
    rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
    names = ", ".join(f'"{column}"' for column in columns)
    return [
        f'INSERT OR REPLACE INTO "{table}" ({names}) VALUES ({", ".join(sql_literal(value) for value in row)});'
        for row in rows
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="anniversaries.db")
    parser.add_argument("--output", default="anniversary-data.sql")
    args = parser.parse_args()
    database = Path(args.database)
    if not database.is_file():
        raise SystemExit(f"Database not found: {database}")
    lines = ["-- Generated for: wrangler d1 execute anniversary --remote --file <this-file>"]
    with sqlite3.connect(database) as connection:
        for table in TABLES:
            lines.extend(export_table(connection, table))
    lines.append("")
    output = Path(args.output)
    output.write_text("\n".join(lines), encoding="utf-8")
    print(f"Exported runtime data to {output}")


if __name__ == "__main__":
    main()
