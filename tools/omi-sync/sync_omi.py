#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional


API_BASE_URL = "https://api.omi.me/v1/dev/user/conversations"
DEFAULT_LIMIT = 100
DEFAULT_OVERLAP_DAYS = 7
STATE_VERSION = 1


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    default_output_root = repo_root / "data" / "inbox" / "omi"
    default_state_path = default_output_root / "state.json"

    parser = argparse.ArgumentParser(
        description="Incrementally sync Omi conversations into a local AI Brain archive."
    )
    parser.add_argument("--api-key", default=os.environ.get("OMI_API_KEY"))
    parser.add_argument("--api-base-url", default=os.environ.get("OMI_API_BASE_URL", API_BASE_URL))
    parser.add_argument("--output-root", default=str(default_output_root))
    parser.add_argument("--state-path", default=str(default_state_path))
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--overlap-days", type=int, default=DEFAULT_OVERLAP_DAYS)
    parser.add_argument("--full-sync", action="store_true")
    parser.add_argument("--max-pages", type=int, default=0)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def parse_iso8601(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def to_iso8601(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_timestamp(value: Optional[str]) -> str:
    parsed = parse_iso8601(value)
    if parsed is None:
        parsed = datetime.now(timezone.utc)
    return parsed.strftime("%Y-%m-%dT%H-%M-%SZ")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def atomic_write_text(path: Path, content: str) -> None:
    ensure_dir(path.parent)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def load_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {
            "version": STATE_VERSION,
            "last_sync_at": None,
            "last_cursor_started_at": None,
            "conversations": {},
        }

    with path.open("r", encoding="utf-8") as handle:
        loaded = json.load(handle)

    if not isinstance(loaded, dict):
        raise ValueError(f"State file {path} is not a JSON object.")

    loaded.setdefault("version", STATE_VERSION)
    loaded.setdefault("last_sync_at", None)
    loaded.setdefault("last_cursor_started_at", None)
    loaded.setdefault("conversations", {})
    if not isinstance(loaded["conversations"], dict):
        raise ValueError(f"State file {path} has an invalid conversations map.")
    return loaded


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def format_seconds(value: Any) -> str:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return "00:00"

    if seconds < 0:
        seconds = 0.0
    whole_minutes = int(seconds // 60)
    remaining_seconds = seconds - (whole_minutes * 60)
    return f"{whole_minutes:02d}:{remaining_seconds:04.1f}"


def stringify_action_items(action_items: Any) -> List[str]:
    if not isinstance(action_items, list):
        return []
    rendered: List[str] = []
    for item in action_items:
        if not isinstance(item, dict):
            continue
        description = str(item.get("description") or "").strip()
        if not description:
            continue
        suffix_parts: List[str] = []
        if item.get("completed") is True:
            suffix_parts.append("completed")
        due_at = str(item.get("due_at") or "").strip()
        if due_at:
            suffix_parts.append(f"due {due_at}")
        suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
        rendered.append(f"- {description}{suffix}")
    return rendered


def render_markdown(conversation: Mapping[str, Any]) -> str:
    structured = conversation.get("structured")
    structured = structured if isinstance(structured, dict) else {}
    transcript_segments = conversation.get("transcript_segments")
    transcript_segments = transcript_segments if isinstance(transcript_segments, list) else []

    title = str(structured.get("title") or f"Omi Conversation {conversation.get('id', '')}").strip()
    overview = str(structured.get("overview") or "").strip()
    category = str(structured.get("category") or "").strip()
    language = str(conversation.get("language") or "").strip()
    source = str(conversation.get("source") or "omi").strip()
    created_at = str(conversation.get("created_at") or "").strip()
    started_at = str(conversation.get("started_at") or "").strip()
    finished_at = str(conversation.get("finished_at") or "").strip()
    geolocation = conversation.get("geolocation")
    geolocation = geolocation if isinstance(geolocation, dict) else {}

    lines: List[str] = [
        "---",
        "source: omi",
        f"conversation_id: {conversation.get('id', '')}",
        f"created_at: {created_at}",
        f"started_at: {started_at}",
        f"finished_at: {finished_at}",
        f"language: {language or 'unknown'}",
        f"category: {category or 'unknown'}",
        f"origin_source: {source or 'omi'}",
        "---",
        "",
        f"# {title}",
        "",
    ]

    if overview:
        lines.extend([overview, ""])

    lines.extend(
        [
            "## Metadata",
            "",
            f"- Conversation ID: `{conversation.get('id', '')}`",
            f"- Created At: `{created_at}`" if created_at else "- Created At: unknown",
            f"- Started At: `{started_at}`" if started_at else "- Started At: unknown",
            f"- Finished At: `{finished_at}`" if finished_at else "- Finished At: unknown",
            f"- Language: `{language or 'unknown'}`",
            f"- Omi Source: `{source or 'omi'}`",
            f"- Category: `{category or 'unknown'}`",
        ]
    )

    address = str(geolocation.get("address") or "").strip()
    if address:
        lines.append(f"- Address: {address}")

    action_items = stringify_action_items(structured.get("action_items"))
    if action_items:
        lines.extend(["", "## Action Items", ""])
        lines.extend(action_items)

    lines.extend(["", "## Transcript", ""])
    if not transcript_segments:
        lines.append("_No transcript segments were returned by Omi._")
        return "\n".join(lines).rstrip() + "\n"

    for segment in transcript_segments:
        if not isinstance(segment, dict):
            continue
        speaker_name = str(segment.get("speaker_name") or f"Speaker {segment.get('speaker_id', '?')}").strip()
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        start = format_seconds(segment.get("start"))
        end = format_seconds(segment.get("end"))
        lines.append(f"- [{start} - {end}] {speaker_name}: {text}")

    return "\n".join(lines).rstrip() + "\n"


@dataclass
class SyncSummary:
    fetched: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    pages: int = 0

    def to_json(self) -> Dict[str, int]:
        return {
            "fetched": self.fetched,
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
            "pages": self.pages,
        }


class OmiClient:
    def __init__(self, api_key: str, api_base_url: str, timeout_seconds: int) -> None:
        self.api_key = api_key
        self.api_base_url = api_base_url
        self.timeout_seconds = timeout_seconds

    def get_conversations(
        self,
        *,
        limit: int,
        offset: int,
        start_date: Optional[str],
    ) -> List[Dict[str, Any]]:
        params = {
            "limit": str(limit),
            "offset": str(offset),
            "include_transcript": "true",
        }
        if start_date:
            params["start_date"] = start_date

        url = f"{self.api_base_url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Omi API request failed with HTTP {error.code}: {body}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Omi API request failed: {error.reason}") from error

        if not isinstance(payload, list):
            raise RuntimeError(f"Expected a JSON array from Omi, got: {type(payload).__name__}")
        return [item for item in payload if isinstance(item, dict)]


def choose_cursor_started_at(state: Mapping[str, Any], overlap_days: int) -> Optional[str]:
    cursor = parse_iso8601(str(state.get("last_cursor_started_at") or ""))
    if cursor is None:
        return None
    return to_iso8601(cursor - timedelta(days=overlap_days))


def day_partition(base_dir: Path, iso_value: Optional[str]) -> Path:
    parsed = parse_iso8601(iso_value)
    if parsed is None:
        return base_dir / "unknown-date"
    return base_dir / f"{parsed.year:04d}" / f"{parsed.month:02d}" / f"{parsed.day:02d}"


def conversation_file_stem(conversation: Mapping[str, Any]) -> str:
    timestamp = safe_timestamp(
        str(conversation.get("started_at") or "")
        or str(conversation.get("finished_at") or "")
        or str(conversation.get("created_at") or "")
    )
    return f"{timestamp}__omi__{conversation.get('id', 'unknown')}"


def sync_conversations(args: argparse.Namespace) -> Dict[str, Any]:
    if not args.api_key:
        raise SystemExit("OMI_API_KEY is required. Pass --api-key or set OMI_API_KEY in the environment.")

    output_root = Path(args.output_root).resolve()
    raw_root = output_root / "raw"
    normalized_root = output_root / "normalized"
    state_path = Path(args.state_path).resolve()
    ensure_dir(raw_root)
    ensure_dir(normalized_root)
    ensure_dir(state_path.parent)

    state = load_state(state_path)
    state_conversations = state["conversations"]
    assert isinstance(state_conversations, MutableMapping)

    start_date = None if args.full_sync or not state_conversations else choose_cursor_started_at(state, args.overlap_days)
    client = OmiClient(args.api_key, args.api_base_url, args.timeout_seconds)
    summary = SyncSummary()
    latest_started_at = parse_iso8601(str(state.get("last_cursor_started_at") or ""))

    offset = 0
    while True:
        if args.max_pages and summary.pages >= args.max_pages:
            break

        batch = client.get_conversations(limit=args.limit, offset=offset, start_date=start_date)
        summary.pages += 1
        if not batch:
            break

        summary.fetched += len(batch)
        for conversation in batch:
            conversation_id = str(conversation.get("id") or "").strip()
            if not conversation_id:
                continue

            payload_hash = sha256_text(canonical_json(conversation))
            existing = state_conversations.get(conversation_id)
            if isinstance(existing, dict) and existing.get("payload_sha256") == payload_hash:
                summary.skipped += 1
            else:
                stem = conversation_file_stem(conversation)
                raw_dir = day_partition(raw_root, str(conversation.get("started_at") or conversation.get("created_at") or ""))
                normalized_dir = day_partition(normalized_root, str(conversation.get("started_at") or conversation.get("created_at") or ""))
                raw_path = raw_dir / f"{stem}.json"
                normalized_path = normalized_dir / f"{stem}.md"

                if not args.dry_run:
                    atomic_write_json(raw_path, conversation)
                    atomic_write_text(normalized_path, render_markdown(conversation))

                state_conversations[conversation_id] = {
                    "payload_sha256": payload_hash,
                    "created_at": conversation.get("created_at"),
                    "started_at": conversation.get("started_at"),
                    "finished_at": conversation.get("finished_at"),
                    "raw_path": str(raw_path.relative_to(output_root)),
                    "normalized_path": str(normalized_path.relative_to(output_root)),
                }
                if existing is None:
                    summary.created += 1
                else:
                    summary.updated += 1

            started_at = parse_iso8601(str(conversation.get("started_at") or conversation.get("created_at") or ""))
            if started_at and (latest_started_at is None or started_at > latest_started_at):
                latest_started_at = started_at

        offset += args.limit
        if len(batch) < args.limit:
            break

    state["version"] = STATE_VERSION
    state["last_sync_at"] = to_iso8601(datetime.now(timezone.utc))
    state["last_cursor_started_at"] = to_iso8601(latest_started_at)

    if not args.dry_run:
        atomic_write_json(state_path, state)

    return {
        "output_root": str(output_root),
        "state_path": str(state_path),
        "start_date_filter": start_date,
        "dry_run": args.dry_run,
        "summary": summary.to_json(),
        "last_cursor_started_at": state.get("last_cursor_started_at"),
    }


def main() -> None:
    args = parse_args()
    result = sync_conversations(args)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
