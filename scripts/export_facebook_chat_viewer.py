from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SUPPORTED_EXTENSIONS = {".json"}
MEDIA_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".mp4", ".mov", ".webm", ".heic", ".avi", ".mkv"}
TIMESTAMP_RE = re.compile(r"\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: UTC)?\b")


@dataclass
class ChatMessage:
    timestamp: str | None
    sender: str | None
    text: str
    source_file: str
    attachments: list[str] = field(default_factory=list)
    reactions: list[str] = field(default_factory=list)
    deleted: bool = False


@dataclass
class ChatThread:
    thread_id: str
    title: str
    participants: list[str] = field(default_factory=list)
    messages: list[ChatMessage] = field(default_factory=list)
    source_files: list[str] = field(default_factory=list)


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    text = html.unescape(value).replace("\xa0", " ")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10**12:
            return dt.datetime.fromtimestamp(number / 1000, tz=dt.timezone.utc).isoformat()
        return dt.datetime.fromtimestamp(number, tz=dt.timezone.utc).isoformat()
    text = clean_text(str(value))
    if not text:
        return None
    for candidate in (text.replace(" UTC", "Z"), text):
        try:
            parsed = dt.datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed.astimezone(dt.timezone.utc).isoformat()
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S UTC", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %I:%M %p", "%b %d, %Y %I:%M:%S %p"):
        try:
            parsed = dt.datetime.strptime(text, fmt).replace(tzinfo=dt.timezone.utc)
            return parsed.astimezone(dt.timezone.utc).isoformat()
        except ValueError:
            continue
    return None


def fmt_timestamp(value: str | None) -> str:
    if not value:
        return "Unknown"
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return parsed.astimezone().strftime("%b %d, %Y %I:%M %p")


def sender_name(message: dict[str, Any]) -> str | None:
    for key in ("sender_name", "sender", "from", "author", "name"):
        value = message.get(key)
        if isinstance(value, str):
            cleaned = clean_text(value)
            if cleaned:
                return cleaned
    return None


def message_text(message: dict[str, Any]) -> str:
    for key in ("content", "text", "message", "body", "snippet"):
        value = message.get(key)
        if isinstance(value, str):
            cleaned = clean_text(value)
            if cleaned:
                return cleaned
    for key in ("photos", "videos", "audio_files", "gifs", "files"):
        value = message.get(key)
        if isinstance(value, list) and value:
            return f"{len(value)} {key.replace('_', ' ')}"
    return ""


def attachments(message: dict[str, Any]) -> list[str]:
    items: list[str] = []
    for key in ("photos", "videos", "audio_files", "gifs", "files"):
        value = message.get(key)
        if isinstance(value, list) and value:
            items.append(f"{len(value)} {key.replace('_', ' ')}")
    share = message.get("share")
    if isinstance(share, dict):
        share_text = clean_text(str(share.get("link") or share.get("share_text") or share.get("title") or ""))
        if share_text:
            items.append(share_text)
    return items


def reactions(message: dict[str, Any]) -> list[str]:
    value = message.get("reactions")
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for reaction in value:
        if not isinstance(reaction, dict):
            continue
        actor = clean_text(str(reaction.get("actor") or reaction.get("name") or ""))
        symbol = clean_text(str(reaction.get("reaction") or reaction.get("emoji") or ""))
        if actor and symbol:
            items.append(f"{actor} reacted {symbol}")
        elif actor:
            items.append(f"{actor} reacted")
        elif symbol:
            items.append(symbol)
    return items


def parse_message_list(messages: list[Any], source_file: str) -> list[ChatMessage]:
    parsed: list[ChatMessage] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        text = message_text(message)
        atts = attachments(message)
        reacts = reactions(message)
        sender = sender_name(message)
        timestamp = normalize_timestamp(message.get("timestamp_ms") or message.get("timestamp") or message.get("created_at"))
        deleted = bool(message.get("is_unsent") or message.get("deleted") or message.get("is_deleted"))
        if not (text or atts or reacts or sender):
            continue
        parsed.append(
            ChatMessage(
                timestamp=timestamp,
                sender=sender,
                text=text or "; ".join(atts) or "Attachment or metadata only",
                source_file=source_file,
                attachments=atts,
                reactions=reacts,
                deleted=deleted,
            )
        )
    parsed.sort(key=lambda item: item.timestamp or "")
    return parsed


def thread_title(payload: dict[str, Any], fallback: str) -> str:
    for key in ("title", "name", "thread_title"):
        value = payload.get(key)
        if isinstance(value, str):
            cleaned = clean_text(value)
            if cleaned:
                return cleaned
    participants = payload.get("participants")
    if isinstance(participants, list):
        names = [clean_text(str(item.get("name") or "")) for item in participants if isinstance(item, dict)]
        names = [name for name in names if name]
        if names:
            return ", ".join(names[:3])
    return clean_text(Path(fallback).stem) or "Messenger thread"


def scan_export(root: Path) -> list[ChatThread]:
    buckets: dict[str, ChatThread] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS or any(part in rel.lower() for part in MEDIA_EXTENSIONS):
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        if not isinstance(payload, dict) or not isinstance(payload.get("messages"), list):
            continue

        thread_id = str(path.parent)
        bucket = buckets.get(thread_id)
        if not bucket:
            bucket = ChatThread(thread_id=thread_id, title=thread_title(payload, path.name))
            buckets[thread_id] = bucket

        if rel not in bucket.source_files:
            bucket.source_files.append(rel)

        participants = payload.get("participants")
        if isinstance(participants, list):
            for participant in participants:
                if isinstance(participant, dict):
                    name = clean_text(str(participant.get("name") or ""))
                    if name and name not in bucket.participants:
                        bucket.participants.append(name)

        bucket.messages.extend(parse_message_list(payload["messages"], rel))

    threads = list(buckets.values())
    for thread in threads:
        thread.messages.sort(key=lambda item: item.timestamp or "")
    threads.sort(key=lambda item: (item.messages[-1].timestamp if item.messages else "", item.title), reverse=True)
    return threads


def render_html(threads: list[ChatThread]) -> str:
    payload = {
        "threads": [
            {
                "id": thread.thread_id,
                "title": thread.title,
                "participants": thread.participants,
                "messageCount": len(thread.messages),
                "first": thread.messages[0].timestamp if thread.messages else None,
                "last": thread.messages[-1].timestamp if thread.messages else None,
                "sourceFiles": thread.source_files,
                "messages": [
                    {
                        "timestamp": message.timestamp,
                        "sender": message.sender,
                        "text": message.text,
                        "attachments": message.attachments,
                        "reactions": message.reactions,
                        "deleted": message.deleted,
                        "sourceFile": message.source_file,
                    }
                    for message in thread.messages
                ],
            }
            for thread in threads
        ]
    }
    data_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Facebook Chat Viewer</title>
  <style>
    :root {{ color-scheme: dark; --bg:#071016; --panel:rgba(10,18,25,.96); --line:rgba(113,255,191,.16); --text:#e9f4ff; --muted:#97adc2; --accent:#70ffc2; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:linear-gradient(180deg,#05090d 0%,#08111b 48%,#09131f 100%); color:var(--text); font-family:Segoe UI,system-ui,sans-serif; }}
    .app {{ max-width:1600px; margin:0 auto; min-height:100vh; padding:1rem; display:grid; grid-template-rows:auto auto 1fr; gap:1rem; }}
    .masthead,.toolbar,.sidebar,.viewer {{ border:1px solid var(--line); border-radius:18px; background:var(--panel); box-shadow:0 18px 40px rgba(0,0,0,.35); }}
    .masthead,.toolbar {{ padding:1rem 1.1rem; }}
    .toolbar .controls {{ display:grid; grid-template-columns:220px 220px 1fr auto; gap:.75rem; align-items:end; }}
    .field {{ display:grid; gap:.35rem; }}
    .field span {{ color:var(--muted); font-size:.76rem; letter-spacing:.12em; text-transform:uppercase; }}
    input,select,button {{ font:inherit; }}
    input,select {{ width:100%; padding:.8rem .9rem; border-radius:12px; border:1px solid var(--line); background:rgba(5,10,16,.9); color:var(--text); outline:none; }}
    button {{ border:1px solid var(--line); border-radius:12px; background:rgba(8,16,24,.96); color:var(--text); padding:.78rem .95rem; cursor:pointer; }}
    .button-row {{ display:flex; gap:.65rem; flex-wrap:wrap; justify-content:flex-end; }}
    .layout {{ display:grid; grid-template-columns:340px minmax(0,1fr); gap:1rem; min-height:0; }}
    .sidebar {{ display:grid; grid-template-rows:auto auto 1fr; gap:.8rem; padding:1rem; position:sticky; top:1rem; height:calc(100vh - 2rem); }}
    .viewer {{ display:grid; grid-template-rows:auto 1fr auto; gap:.9rem; padding:1rem; min-height:calc(100vh - 10rem); }}
    .meta {{ color:var(--muted); display:flex; gap:.7rem; flex-wrap:wrap; font-size:.9rem; }}
    .thread-list,.message-list {{ overflow:auto; padding-right:.15rem; display:grid; gap:.6rem; }}
    .thread-card,.message {{ width:100%; text-align:left; }}
    .thread-card {{ padding:.85rem .95rem; display:grid; gap:.4rem; }}
    .thread-card.active {{ border-color:rgba(113,255,191,.28); box-shadow:0 0 0 1px rgba(113,255,191,.2); }}
    .thread-title {{ font-weight:700; }}
    .thread-sub {{ color:var(--muted); font-size:.88rem; display:flex; justify-content:space-between; gap:.7rem; flex-wrap:wrap; }}
    .message {{ display:grid; gap:.45rem; padding:.9rem 1rem; border-radius:16px; border:1px solid var(--line); background:rgba(7,12,18,.9); }}
    .message-head {{ display:flex; justify-content:space-between; gap:.75rem; flex-wrap:wrap; align-items:baseline; }}
    .sender {{ color:#7fe3ff; font-weight:700; }}
    .timestamp {{ color:var(--muted); font-size:.82rem; white-space:nowrap; }}
    .body {{ white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; }}
    .badges {{ display:flex; gap:.45rem; flex-wrap:wrap; }}
    .badge {{ display:inline-flex; align-items:center; padding:.3rem .55rem; border-radius:999px; border:1px solid rgba(112,255,194,.18); color:var(--accent); background:rgba(16,35,28,.7); font-size:.78rem; }}
    .empty {{ color:var(--muted); padding:1rem 0; }}
    .footer {{ display:flex; gap:.75rem; flex-wrap:wrap; justify-content:space-between; align-items:center; color:var(--muted); border-top:1px solid rgba(113,255,191,.1); padding-top:.8rem; }}
    .mono {{ font-family:Consolas,monospace; }}
    @media (max-width:1100px) {{ .layout {{ grid-template-columns:1fr; }} .sidebar {{ position:static; height:auto; }} .toolbar .controls {{ grid-template-columns:1fr; }} }}
  </style>
</head>
<body>
  <div class="app">
    <section class="masthead">
      <h1 style="margin:0 0 .3rem;">Facebook Chat Viewer</h1>
      <div class="meta"><span id="thread-count"></span><span id="message-count"></span><span>Offline static viewer</span></div>
    </section>
    <section class="toolbar">
      <div class="controls">
        <label class="field"><span>Search threads</span><input id="thread-search" type="search" placeholder="Name, group, keyword..." /></label>
        <label class="field"><span>Year</span><select id="year-filter"></select></label>
        <label class="field"><span>Compare with</span><select id="compare-filter"></select></label>
        <div class="button-row"><button id="copy-thread" type="button">Copy text</button><button id="download-thread" type="button">Download TXT</button><button id="reset-filters" type="button">Reset</button></div>
      </div>
    </section>
    <section class="layout">
      <aside class="sidebar">
        <div class="meta"><span id="thread-summary"></span></div>
        <div class="thread-list" id="thread-list"></div>
      </aside>
      <main class="viewer">
        <div><h2 id="viewer-title" style="margin:0 0 .35rem;">Choose a thread</h2><div class="meta" id="viewer-meta"></div></div>
        <div class="message-list" id="message-list"></div>
        <div class="footer"><span id="viewer-footer"></span><span class="mono" id="viewer-source"></span></div>
      </main>
    </section>
  </div>
  <script id="facebook-data" type="application/json">{data_json}</script>
  <script>
    const DATA = JSON.parse(document.getElementById('facebook-data').textContent);
    const state = {{ search:'', year:'all', compare:'all', selectedId: DATA.threads[0]?.id || '' }};
    const els = {{
      threadCount: document.getElementById('thread-count'),
      messageCount: document.getElementById('message-count'),
      threadSummary: document.getElementById('thread-summary'),
      threadSearch: document.getElementById('thread-search'),
      yearFilter: document.getElementById('year-filter'),
      compareFilter: document.getElementById('compare-filter'),
      threadList: document.getElementById('thread-list'),
      viewerTitle: document.getElementById('viewer-title'),
      viewerMeta: document.getElementById('viewer-meta'),
      messageList: document.getElementById('message-list'),
      viewerFooter: document.getElementById('viewer-footer'),
      viewerSource: document.getElementById('viewer-source'),
      copyThread: document.getElementById('copy-thread'),
      downloadThread: document.getElementById('download-thread'),
      resetFilters: document.getElementById('reset-filters'),
    }};
    function esc(value) {{ return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }}
    function yearFrom(value) {{ if (!value) return null; const year = new Date(value).getUTCFullYear(); return Number.isNaN(year) ? null : year; }}
    function fmt(value) {{ if (!value) return 'Unknown'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {{ year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }}); }}
    function fmtShort(value) {{ if (!value) return 'Unknown'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, {{ year:'numeric', month:'short', day:'numeric' }}); }}
    function years() {{ return [...new Set(DATA.threads.flatMap((thread) => thread.messages.map((message) => yearFrom(message.timestamp)).filter((year) => year !== null)))].sort((a, b) => b - a); }}
    function matches(thread) {{
      if (state.year !== 'all') {{
        const wanted = Number(state.year);
        if (!thread.messages.some((message) => yearFrom(message.timestamp) === wanted)) return false;
      }}
      if (!state.search) return true;
      const haystack = [thread.title, thread.participants.join(' '), thread.messages.map((message) => [message.sender, message.text, ...(message.attachments || []), ...(message.reactions || [])].join(' ')).join(' ')].join(' ').toLowerCase();
      return haystack.includes(state.search);
    }}
    function textForThread(thread) {{
      return thread.messages.map((message) => [
        `Timestamp: ${{fmt(message.timestamp)}}`,
        `Sender: ${{message.sender || 'Unknown sender'}}`,
        `Text: ${{message.text || 'No visible text recovered.'}}`,
        message.attachments?.length ? `Attachments: ${{message.attachments.join(', ')}}` : null,
        message.reactions?.length ? `Reactions: ${{message.reactions.join(', ')}}` : null,
        `Source: ${{message.sourceFile}}`,
      ].filter(Boolean).join('\\n')).join('\\n\\n');
    }}
    function messageCard(message) {{
      const badges = [];
      if (message.deleted) badges.push('<span class="badge">deleted / unsent</span>');
      (message.attachments || []).forEach((item) => badges.push(`<span class="badge">${{esc(item)}}</span>`));
      (message.reactions || []).forEach((item) => badges.push(`<span class="badge">${{esc(item)}}</span>`));
      return `<article class="message"><div class="message-head"><span class="sender">${{esc(message.sender || 'Unknown sender')}}</span><span class="timestamp">${{esc(fmt(message.timestamp))}}</span></div><div class="badges">${{badges.join('')}}</div><div class="body">${{esc(message.text || 'No visible text recovered.')}}</div><div class="meta mono">${{esc(message.sourceFile)}}</div></article>`;
    }}
    function render() {{
      const yearsList = ['all', ...years()];
      if (!els.yearFilter.options.length) {{
        els.yearFilter.innerHTML = yearsList.map((year) => `<option value="${{year}}">${{year === 'all' ? 'All years' : year}}</option>`).join('');
        els.compareFilter.innerHTML = ['all', ...years()].map((year) => `<option value="${{year}}">${{year === 'all' ? 'No compare' : year}}</option>`).join('');
      }}
      els.yearFilter.value = state.year;
      els.compareFilter.value = state.compare;
      els.threadCount.textContent = `${{DATA.threads.length}} thread(s)`;
      els.messageCount.textContent = `${{DATA.threads.reduce((sum, thread) => sum + thread.messages.length, 0)}} message(s)`;
      els.threadSummary.textContent = state.year === 'all' ? 'Showing all years' : `Showing year ${{state.year}}`;
      const filtered = DATA.threads.filter(matches).sort((left, right) => (right.last || '').localeCompare(left.last || ''));
      if (!state.selectedId || !filtered.some((thread) => thread.id === state.selectedId)) state.selectedId = filtered[0]?.id || '';
      els.threadList.innerHTML = filtered.map((thread) => `<button class="thread-card ${{thread.id === state.selectedId ? 'active' : ''}}" data-thread-id="${{esc(thread.id)}}" type="button"><div class="thread-title">${{esc(thread.title)}}</div><div class="thread-sub"><span>${{thread.messageCount}} message(s)</span><span>${{esc(fmtShort(thread.first))}} - ${{esc(fmtShort(thread.last))}}</span></div></button>`).join('') || '<div class="empty">No threads matched the current filters.</div>';
      els.threadList.querySelectorAll('[data-thread-id]').forEach((button) => button.addEventListener('click', () => {{ state.selectedId = button.getAttribute('data-thread-id'); render(); }}));
      const thread = DATA.threads.find((item) => item.id === state.selectedId);
      if (!thread) {{
        els.viewerTitle.textContent = 'Choose a thread';
        els.viewerMeta.innerHTML = '';
        els.messageList.innerHTML = '<div class="empty">Pick a thread on the left.</div>';
        els.viewerFooter.textContent = '';
        els.viewerSource.textContent = '';
        return;
      }}
      els.viewerTitle.textContent = thread.title;
      els.viewerMeta.innerHTML = [`<span>${{thread.messageCount}} message(s)</span>`, `<span>First: ${{esc(fmt(thread.first))}}</span>`, `<span>Last: ${{esc(fmt(thread.last))}}</span>`, thread.participants.length ? `<span>Participants: ${{esc(thread.participants.join(', '))}}</span>` : null].filter(Boolean).join('');
      els.messageList.innerHTML = thread.messages.map(messageCard).join('');
      els.viewerFooter.textContent = 'Years present: ' + [...new Set(thread.messages.map((message) => yearFrom(message.timestamp)).filter((year) => year !== null))].join(', ');
      els.viewerSource.textContent = thread.sourceFiles.slice(0, 3).join(' | ');
      const text = textForThread(thread);
      els.copyThread.onclick = async () => {{ try {{ await navigator.clipboard.writeText(text); }} catch {{ alert('Clipboard copy failed.'); }} }};
      els.downloadThread.onclick = () => {{
        const blob = new Blob([text], {{ type: 'text/plain;charset=utf-8' }});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `facebook-chat-${{thread.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'thread'}}.txt`;
        link.click();
        URL.revokeObjectURL(link.href);
      }};
    }}
    els.threadSearch.addEventListener('input', (event) => {{ state.search = event.target.value.trim().toLowerCase(); render(); }});
    els.yearFilter.addEventListener('change', (event) => {{ state.year = event.target.value; render(); }});
    els.compareFilter.addEventListener('change', (event) => {{ state.compare = event.target.value; render(); }});
    els.resetFilters.addEventListener('click', () => {{ state.search = ''; state.year = 'all'; state.compare = 'all'; els.threadSearch.value = ''; render(); }});
    render();
  </script>
</body>
</html>"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an offline Facebook chat viewer on your Desktop.")
    parser.add_argument("folder", help="Extracted Facebook export folder")
    parser.add_argument("--output", default=str(Path.home() / "Desktop" / "facebook_chat_viewer.html"))
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()

    root = Path(args.folder).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Folder not found: {root}")

    threads = scan_export(root)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_html(threads), encoding="utf-8")
    output.with_suffix(".json").write_text(json.dumps(
        {
            "sourceFolder": str(root),
            "threadCount": len(threads),
            "messageCount": sum(len(thread.messages) for thread in threads),
            "threads": [
                {
                    "id": thread.thread_id,
                    "title": thread.title,
                    "participants": thread.participants,
                    "messages": [
                        {
                            "timestamp": message.timestamp,
                            "sender": message.sender,
                            "text": message.text,
                            "sourceFile": message.source_file,
                            "attachments": message.attachments,
                            "reactions": message.reactions,
                            "deleted": message.deleted,
                        }
                        for message in thread.messages
                    ],
                }
                for thread in threads
            ],
        },
        ensure_ascii=False,
        indent=2,
    ), encoding="utf-8")

    print(f"Wrote HTML viewer to {output}")
    if args.open:
        webbrowser.open(output.as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
