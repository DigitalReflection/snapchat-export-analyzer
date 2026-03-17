from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import json
import re
import uuid
from pathlib import Path
from typing import Any

SUPPORTED_EXTENSIONS = {".json", ".csv", ".html", ".htm", ".txt"}
MEDIA_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".mp4",
    ".mov",
    ".webm",
    ".heic",
    ".avi",
    ".mkv",
    ".wav",
    ".mp3",
}
TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC")
TRANSCRIPT_RE = re.compile(
    r"(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)"
    r"(?P<status>Saved|Opened|Received|Delivered|Sent)?"
    r"(?P<contact>[A-Za-z0-9._-]{2,40})?"
    r"(?P<marker>TEXT|MEDIA|CALL|NOTE)?"
)
HTML_TAG_RE = re.compile(r"<[^>]+>")
NOISE_TERMS = {
    "download my data",
    "saved chat history",
    "my data",
    "support history",
    "bitmoji",
    "memories",
    "search history",
    "snap history",
    "user & public profiles",
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def normalize_timestamp(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().replace(" UTC", "Z").replace(" ", "T", 1)
    try:
        return dt.datetime.fromisoformat(cleaned.replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat()
    except ValueError:
        pass

    for fmt in (
        "%Y-%m-%d %H:%M:%S UTC",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %I:%M %p",
    ):
        try:
            parsed = dt.datetime.strptime(value.strip(), fmt)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed.astimezone(dt.timezone.utc).isoformat()
        except ValueError:
            continue
    return None


def categorize(path: str) -> str:
    lower = path.lower().replace("\\", "/")
    if "friend" in lower:
        return "friend"
    if "search" in lower:
        return "search"
    if "location" in lower:
        return "location"
    if "login" in lower or "device" in lower:
        return "login"
    if "memories" in lower or "memory" in lower:
        return "memory"
    if "bitmoji" in lower:
        return "bitmoji"
    if "support" in lower:
        return "support"
    if "purchase" in lower or "shop" in lower:
        return "purchase"
    if "account" in lower or "profile" in lower:
        return "account"
    if "chat" in lower or "message" in lower or "snap" in lower:
        return "chat"
    return "unknown"


def flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    rows: dict[str, Any] = {}
    if isinstance(value, dict):
        for key, nested in value.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            rows.update(flatten(nested, next_prefix))
        return rows
    if isinstance(value, list):
        if all(not isinstance(item, (dict, list)) for item in value):
            rows[prefix or "value"] = ", ".join(str(item) for item in value)
            return rows
        for index, nested in enumerate(value):
            next_prefix = f"{prefix}.{index}" if prefix else str(index)
            rows.update(flatten(nested, next_prefix))
        return rows
    rows[prefix or "value"] = value
    return rows


def sanitize_text(value: str) -> str:
    text = html.unescape(value).replace("\xa0", " ")
    text = HTML_TAG_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def parse_html_records(text: str) -> list[dict[str, Any]]:
    clean = sanitize_text(text)
    if not clean:
        return []
    records: list[dict[str, Any]] = []
    last_end = 0
    matches = list(TIMESTAMP_RE.finditer(clean))
    if not matches:
        if clean.lower() not in NOISE_TERMS:
            records.append({"line": clean})
        return records
    for index, match in enumerate(matches):
        start = match.start()
        if start > last_end:
            leading = clean[last_end:start].strip()
            if leading and leading.lower() not in NOISE_TERMS:
                records.append({"line": leading})
        segment_end = matches[index + 1].start() if index + 1 < len(matches) else len(clean)
        segment = clean[match.start():segment_end].strip()
        records.extend(parse_transcript_blob(segment))
        last_end = segment_end
    return records


def parse_transcript_blob(blob: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    matches = list(TRANSCRIPT_RE.finditer(blob))
    for index, match in enumerate(matches):
        timestamp = match.group("timestamp")
        if not timestamp:
            continue
        message_start = match.end()
        message_end = matches[index + 1].start() if index + 1 < len(matches) else len(blob)
        body = blob[message_start:message_end].strip(" ,")
        record = {
            "timestamp": timestamp,
            "status": match.group("status") or "Saved",
            "contact": match.group("contact"),
            "marker": match.group("marker") or "TEXT",
            "message": body,
        }
        if record["message"] or record["contact"]:
            records.append(record)
    return records


def parse_text_records(text: str) -> list[dict[str, Any]]:
    transcript = parse_transcript_blob(text)
    if transcript:
        return transcript

    records: list[dict[str, Any]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        records.append({"line": line})
    return records


def parse_csv_records(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as handle:
        reader = csv.DictReader(handle)
        return [dict(row) for row in reader]


def parse_json_records(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        payload = json.load(handle)
    if isinstance(payload, list):
        return [flatten(item) if isinstance(item, (dict, list)) else {"value": item} for item in payload]
    if isinstance(payload, dict):
        return [flatten(payload)]
    return [{"value": payload}]


def record_contact(row: dict[str, Any], fallback: str | None = None) -> str | None:
    for key in ("contact", "sender", "from", "to", "friend", "participant", "recipient", "user", "username", "name"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback


def record_text(row: dict[str, Any]) -> str | None:
    for key in ("message", "text", "body", "content", "detail", "line", "caption", "savedchat"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def record_timestamp(row: dict[str, Any]) -> str | None:
    for key in ("timestamp", "created", "created_at", "time", "date", "datetime"):
        value = row.get(key)
        if isinstance(value, str):
            normalized = normalize_timestamp(value)
            if normalized:
                return normalized
    return None


def build_event(upload_id: str, category: str, source_file: str, row: dict[str, Any], fallback_contact: str | None) -> dict[str, Any]:
    contact = record_contact(row, fallback_contact)
    text = record_text(row)
    timestamp = record_timestamp(row)
    detail = None
    if not text:
        detail = ", ".join(f"{key}={value}" for key, value in list(row.items())[:6] if value not in (None, ""))

    attributes: dict[str, Any] = {}
    for key, value in row.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            attributes[str(key)] = value

    evidence = text or detail or json.dumps(attributes, ensure_ascii=True)[:500]
    return {
        "id": f"evt-{uuid.uuid4().hex[:12]}",
        "uploadId": upload_id,
        "category": category,
        "subtype": str(row.get("marker") or row.get("status") or row.get("type") or "") or None,
        "sourceFile": source_file,
        "timestamp": timestamp,
        "contact": contact,
        "text": text,
        "detail": detail,
        "locationName": None,
        "latitude": None,
        "longitude": None,
        "device": None,
        "region": None,
        "evidenceText": evidence,
        "attributes": attributes,
    }


def extract_account(rows: list[dict[str, Any]]) -> dict[str, Any]:
    account = {
        "username": None,
        "displayName": None,
        "email": None,
        "phone": None,
        "region": None,
        "aliases": [],
    }
    for row in rows:
        for key, value in row.items():
            if not isinstance(value, str):
                continue
            lower = key.lower()
            if "username" in lower and not account["username"]:
                account["username"] = value
            elif ("display" in lower or lower.endswith("name")) and not account["displayName"]:
                account["displayName"] = value
            elif "email" in lower and not account["email"]:
                account["email"] = value
            elif ("phone" in lower or "mobile" in lower) and not account["phone"]:
                account["phone"] = value
            elif ("region" in lower or "country" in lower) and not account["region"]:
                account["region"] = value
    aliases = [account["username"], account["displayName"], account["email"], account["phone"]]
    account["aliases"] = [value for value in aliases if isinstance(value, str) and value]
    return account


def process_folder(folder: Path) -> dict[str, Any]:
    upload_id = f"upload-{uuid.uuid4().hex[:12]}"
    file_summaries: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    account_rows: list[dict[str, Any]] = []
    category_counts: dict[str, int] = {}
    total_size = 0
    supported_files = 0
    unsupported_files = 0
    total_files = 0

    for path in folder.rglob("*"):
        if not path.is_file():
            continue
        total_files += 1
        total_size += path.stat().st_size
        rel_path = path.relative_to(folder).as_posix()
        extension = path.suffix.lower()

        if extension in MEDIA_EXTENSIONS:
            unsupported_files += 1
            file_summaries.append(
                {
                    "uploadId": upload_id,
                    "path": rel_path,
                    "extension": extension,
                    "category": categorize(rel_path),
                    "rows": 0,
                    "supported": False,
                }
            )
            continue

        if extension not in SUPPORTED_EXTENSIONS:
            unsupported_files += 1
            continue

        category = categorize(rel_path)
        rows: list[dict[str, Any]]
        if extension == ".json":
            rows = parse_json_records(path)
        elif extension == ".csv":
            rows = parse_csv_records(path)
        else:
            text = path.read_text(encoding="utf-8", errors="ignore")
            rows = parse_html_records(text) if extension in {".html", ".htm"} else parse_text_records(text)

        supported_files += 1
        file_summaries.append(
            {
                "uploadId": upload_id,
                "path": rel_path,
                "extension": extension,
                "category": category,
                "rows": len(rows),
                "supported": True,
            }
        )

        if category == "account":
            account_rows.extend(rows)

        category_counts[category] = category_counts.get(category, 0) + len(rows)
        fallback_contact = path.stem if category == "chat" else None
        for row in rows:
            event = build_event(upload_id, category, rel_path, row, fallback_contact)
            events.append(event)

    account = extract_account(account_rows)
    processed_at = now_iso()
    return {
        "upload": {
            "id": upload_id,
            "fileName": folder.name,
            "sizeBytes": total_size,
            "uploadedAt": processed_at,
            "processedAt": processed_at,
            "totalFiles": total_files,
            "supportedFiles": supported_files,
            "unsupportedFiles": unsupported_files,
            "categoryCounts": category_counts,
            "account": account,
            "warnings": [],
        },
        "fileSummaries": file_summaries,
        "events": events,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Preprocess an extracted Snapchat export into cached JSON.")
    parser.add_argument("folder", help="Path to extracted Snapchat export folder")
    parser.add_argument(
        "--output",
        help="Path to write parsed JSON cache",
        default=str(Path.home() / "Desktop" / "snapchat_export_cache.json"),
    )
    args = parser.parse_args()

    folder = Path(args.folder).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()

    if not folder.exists() or not folder.is_dir():
        raise SystemExit(f"Folder not found: {folder}")

    parsed_upload = process_folder(folder)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(parsed_upload, ensure_ascii=True), encoding="utf-8")
    print(f"Wrote cache JSON to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
