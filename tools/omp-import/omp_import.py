#!/usr/bin/env python3
"""Convert OMP agent session transcripts into Claude Code transcript files.

OMP (``~/.omp``) and Claude Code (``~/.claude``) both keep one JSONL transcript
per session, but with different event vocabularies. This script rewrites the
former into the latter so past OMP work on this repository shows up in Claude
Code's session list and can be read and searched there.

Usage (defaults target this repository)::

    python tools/omp-import/omp_import.py --dry-run
    python tools/omp-import/omp_import.py

Both directories are derived from ``--project`` and can be overridden with
``--omp-dir`` and ``--out``. Output session ids are OMP's own UUIDv7 session
ids and record uuids are uuid5-derived, so re-running is idempotent: an
already-imported session is rewritten in place rather than duplicated.

Imported sessions are for reading, not resuming. Thinking blocks keep their
text but lose their originating provider's signature, and tool names are OMP's
(``bash``, ``ast_edit``, ``todo``), so replaying one through the Anthropic API
would be rejected.
"""
from __future__ import annotations

import argparse
import base64
import datetime
import glob
import json
import os
import re
import sys
import uuid

DEFAULT_PROJECT = r"D:\Project KK\Personal projects\GrapiX"
MAX_TOOL_RESULT = 100_000
CLAUDE_VERSION = "2.1.226"
# Fixed namespace so record uuids stay stable across runs.
NS = uuid.UUID("6f0a2b1c-4d3e-4f5a-8b9c-0d1e2f3a4b5c")
MIME_OK = {"image/png", "image/jpeg", "image/gif", "image/webp"}


# --------------------------------------------------------------------------- paths


def omp_slug(project: str) -> str:
    """``D:\\Project KK\\...\\GrapiX`` -> ``--D--Project KK-...-GrapiX--``."""
    return "--" + re.sub(r"[:\\/]", "-", project.rstrip("\\/")) + "--"


def claude_slug(project: str) -> str:
    """``D:\\Project KK\\...\\GrapiX`` -> ``D--Project-KK-...-GrapiX``."""
    return re.sub(r"[^A-Za-z0-9]", "-", project.rstrip("\\/"))


# --------------------------------------------------------------------------- helpers


def iso(ts) -> str:
    if isinstance(ts, str):
        return ts
    if isinstance(ts, (int, float)):
        return (datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc)
                .isoformat().replace("+00:00", "Z"))
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def load_blob(blobs_dir: str, ref: str):
    """Resolve an OMP ``blob:sha256:<hash>`` image reference to base64 bytes."""
    m = re.match(r"blob:sha256:([0-9a-f]{64})", ref or "")
    if not m:
        return None
    h = m.group(1)
    for cand in [os.path.join(blobs_dir, h)] + glob.glob(os.path.join(blobs_dir, h + ".*")):
        if os.path.isfile(cand):
            with open(cand, "rb") as fh:
                return base64.b64encode(fh.read()).decode("ascii")
    return None


def conv_blocks(blocks, blobs_dir, stats):
    """OMP content blocks -> Anthropic content blocks."""
    out = []
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            out.append({"type": "text", "text": b.get("text", "")})
        elif t == "thinking":
            # The originating provider's signature is dropped deliberately: it
            # would not validate against the Anthropic API on a replay.
            out.append({"type": "thinking", "thinking": b.get("thinking", "")})
        elif t == "toolCall":
            out.append({"type": "tool_use",
                        "id": b.get("id") or ("toolu_" + uuid.uuid4().hex[:20]),
                        "name": b.get("name") or "unknown",
                        "input": b.get("arguments") or {}})
        elif t == "image":
            mime = b.get("mimeType") or "image/png"
            data = b.get("data")
            if isinstance(data, str) and data.startswith("blob:"):
                b64 = load_blob(blobs_dir, data)
            elif isinstance(data, str):
                b64 = data
            else:
                b64 = None
            if b64 and mime in MIME_OK:
                stats["images"] += 1
                out.append({"type": "image",
                            "source": {"type": "base64", "media_type": mime, "data": b64}})
            else:
                stats["images_missing"] += 1
                out.append({"type": "text", "text": "[omp-import: image not recoverable: %s]" % data})
        else:
            out.append({"type": "text", "text": json.dumps(b)[:2000]})
    return out


def truncate_result(blocks, stats):
    out = []
    for b in blocks:
        if b.get("type") == "text" and len(b.get("text", "")) > MAX_TOOL_RESULT:
            stats["truncated"] += 1
            original = len(b["text"])
            b = {"type": "text",
                 "text": b["text"][:MAX_TOOL_RESULT] +
                         "\n\n... [omp-import: tool output truncated, %d chars original]" % original}
        out.append(b)
    return out


# --------------------------------------------------------------------------- conversion


def convert(path, out_dir, project, blobs_dir):
    stats = {"images": 0, "images_missing": 0, "truncated": 0, "user": 0,
             "assistant": 0, "tool_result": 0, "meta": 0, "skipped": 0}
    sid = None
    title = None
    records = []
    last_user_text = None

    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "session":
            sid = o.get("id")
        elif o.get("type") in ("title", "title_change") and o.get("title"):
            title = title or o["title"].strip()
    if not sid:
        m = re.search(r"_([0-9a-f-]{36})\.jsonl$", path)
        sid = m.group(1) if m else str(uuid.uuid4())

    state = {"prev": None}

    def new_uuid(omp_id, salt=""):
        return str(uuid.uuid5(NS, "%s:%s:%s" % (sid, omp_id, salt)))

    def base(rec_uuid, ts, extra):
        r = {"parentUuid": state["prev"], "isSidechain": False, "uuid": rec_uuid,
             "timestamp": iso(ts), "userType": "external", "entrypoint": "cli",
             "cwd": project, "sessionId": sid, "version": CLAUDE_VERSION}
        r.update(extra)
        return r

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            stats["skipped"] += 1
            continue
        t = o.get("type")
        oid = o.get("id") or uuid.uuid4().hex
        ts = o.get("timestamp")

        if t == "message":
            m = o.get("message") or {}
            role = m.get("role")
            content = m.get("content")
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]

            if role == "user":
                blocks = conv_blocks(content, blobs_dir, stats)
                u = new_uuid(oid)
                records.append(base(u, ts, {"type": "user",
                                            "message": {"role": "user", "content": blocks}}))
                state["prev"] = u
                stats["user"] += 1
                for b in blocks:
                    if b.get("type") == "text":
                        last_user_text = b["text"]

            elif role == "developer":
                blocks = conv_blocks(content, blobs_dir, stats)
                u = new_uuid(oid)
                records.append(base(u, ts, {"type": "user", "isMeta": True,
                                            "message": {"role": "user", "content": blocks}}))
                state["prev"] = u
                stats["meta"] += 1

            elif role == "toolResult":
                blocks = truncate_result(conv_blocks(content, blobs_dir, stats), stats)
                u = new_uuid(oid)
                records.append(base(u, ts, {
                    "type": "user",
                    "message": {"role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": m.get("toolCallId") or "toolu_unknown",
                        "content": blocks}]},
                    "toolUseResult": {"ompToolName": m.get("toolName")}}))
                state["prev"] = u
                stats["tool_result"] += 1

            elif role == "assistant":
                blocks = conv_blocks(content, blobs_dir, stats)
                usage = m.get("usage") or {}
                msg_id = "msg_omp_" + uuid.uuid5(NS, "%s:%s" % (sid, oid)).hex[:20]
                model = m.get("model") or "omp/unknown"
                # Claude Code stores one record per content block, sharing message.id.
                for i, blk in enumerate(blocks):
                    u = new_uuid(oid, "b%d" % i)
                    records.append(base(u, ts, {
                        "type": "assistant",
                        "message": {
                            "id": msg_id, "type": "message", "role": "assistant",
                            "model": model, "content": [blk],
                            "stop_reason": "tool_use" if blk.get("type") == "tool_use" else "end_turn",
                            "stop_sequence": None,
                            "usage": {
                                "input_tokens": usage.get("input", 0),
                                "output_tokens": usage.get("output", 0),
                                "cache_creation_input_tokens": usage.get("cacheWrite", 0),
                                "cache_read_input_tokens": usage.get("cacheRead", 0),
                            }},
                        "isApiErrorMessage": False}))
                    state["prev"] = u
                stats["assistant"] += 1
            else:
                stats["skipped"] += 1

        elif t == "custom_message":
            text = o.get("content")
            if not text:
                stats["skipped"] += 1
                continue
            u = new_uuid(oid)
            records.append(base(u, ts, {"type": "user", "isMeta": True,
                                        "message": {"role": "user",
                                                    "content": [{"type": "text", "text": text}]}}))
            state["prev"] = u
            stats["meta"] += 1

        elif t == "compaction":
            u = new_uuid(oid)
            records.append(base(u, ts, {"type": "user", "isCompactSummary": True,
                                        "message": {"role": "user",
                                                    "content": [{"type": "text",
                                                                 "text": o.get("summary", "")}]}}))
            state["prev"] = u
            stats["meta"] += 1
        else:
            # model_change, thinking_level_change, ttsr_injection, credential_pin,
            # service_tier_change, custom (tool_execution_start, session_exit) —
            # runtime metadata with no Claude Code counterpart.
            stats["skipped"] += 1

    label = title or (last_user_text.strip().splitlines()[0][:60] if last_user_text else "untitled")
    header = [
        {"type": "mode", "mode": "normal", "sessionId": sid},
        {"type": "permission-mode", "permissionMode": "default", "sessionId": sid},
        {"type": "ai-title", "aiTitle": "[omp] " + label, "sessionId": sid},
    ]
    footer = []
    if state["prev"]:
        footer.append({"type": "last-prompt", "lastPrompt": (last_user_text or "")[:200],
                       "leafUuid": state["prev"], "sessionId": sid})

    out_path = os.path.join(out_dir, sid + ".jsonl")
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        for r in header + records + footer:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return out_path, sid, label, stats, len(records)


# --------------------------------------------------------------------------- validation


def validate(paths):
    """Re-read written transcripts and assert the invariants Claude Code relies on."""
    problems = []
    for p in paths:
        tool_ids, uuids = set(), set()
        for i, line in enumerate(open(p, encoding="utf-8")):
            try:
                o = json.loads(line)
            except Exception as exc:
                problems.append("%s:%d unparsable (%s)" % (p, i, exc))
                continue
            m = o.get("message")
            if o.get("type") == "assistant":
                for b in m["content"]:
                    if b.get("type") == "tool_use":
                        tool_ids.add(b["id"])
            if o.get("type") == "user" and isinstance(m, dict) and isinstance(m.get("content"), list):
                for b in m["content"]:
                    if b.get("type") == "tool_result" and b["tool_use_id"] not in tool_ids:
                        problems.append("%s:%d tool_result without a preceding tool_use" % (p, i))
            u = o.get("uuid")
            if u:
                if u in uuids:
                    problems.append("%s:%d duplicate uuid" % (p, i))
                uuids.add(u)
                if o.get("parentUuid") is not None and o["parentUuid"] not in uuids:
                    problems.append("%s:%d parentUuid not yet seen" % (p, i))
    return problems


# --------------------------------------------------------------------------- cli


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=DEFAULT_PROJECT,
                    help="project working directory the sessions belong to")
    ap.add_argument("--omp-home", default=os.path.join(os.path.expanduser("~"), ".omp"))
    ap.add_argument("--claude-home", default=os.path.join(os.path.expanduser("~"), ".claude"))
    ap.add_argument("--omp-dir", help="override the OMP session directory")
    ap.add_argument("--out", help="override the Claude Code project directory")
    ap.add_argument("--only", help="convert only sessions whose filename contains this string")
    ap.add_argument("--dry-run", action="store_true", help="list what would be converted")
    ap.add_argument("--preserve-mtime", action="store_true",
                    help="stamp each output with its source's real mtime. Claude Code deletes "
                         "transcripts older than its retention window (cleanupPeriodDays, 30 by "
                         "default), so only use this with a retention long enough to cover them.")
    args = ap.parse_args(argv)

    omp_dir = args.omp_dir or os.path.join(args.omp_home, "agent", "sessions", omp_slug(args.project))
    out_dir = args.out or os.path.join(args.claude_home, "projects", claude_slug(args.project))
    blobs_dir = os.path.join(args.omp_home, "agent", "blobs")

    if not os.path.isdir(omp_dir):
        print("no OMP sessions at %s" % omp_dir, file=sys.stderr)
        return 1

    files = sorted(glob.glob(os.path.join(omp_dir, "*.jsonl")))
    if args.only:
        files = [f for f in files if args.only in f]

    print("%d OMP session file(s)\n  from %s\n  into %s" % (len(files), omp_dir, out_dir))
    if args.dry_run:
        for f in files:
            print("  would convert %s (%.1f MB)" % (os.path.basename(f), os.path.getsize(f) / 1e6))
        return 0

    os.makedirs(out_dir, exist_ok=True)
    total = {"images": 0, "images_missing": 0, "truncated": 0, "user": 0,
             "assistant": 0, "tool_result": 0, "meta": 0, "skipped": 0}
    written = []
    # Claude Code prunes transcripts whose mtime is older than its retention
    # window, so stamping the sources' real (months-old) mtimes would get the
    # whole import deleted on the next cleanup. Stamp a recent window instead,
    # one minute apart in source order, which keeps the session list ordered.
    files = sorted(files, key=os.path.getmtime)
    now = datetime.datetime.now().timestamp()
    for i, f in enumerate(files):
        out_path, sid, label, stats, n = convert(f, out_dir, args.project, blobs_dir)
        written.append(out_path)
        for k in total:
            total[k] += stats[k]
        mtime = os.path.getmtime(f) if args.preserve_mtime else now - 60 * (len(files) - i)
        os.utime(out_path, (mtime, mtime))
        print("  %s.jsonl %7d rec %7.1f MB  user=%d asst=%d tool=%d img=%d trunc=%d  | %s"
              % (sid, n, os.path.getsize(out_path) / 1e6, stats["user"], stats["assistant"],
                 stats["tool_result"], stats["images"], stats["truncated"], label))

    print("TOTAL:", total)
    problems = validate(written)
    if problems:
        print("VALIDATION FAILED (%d):" % len(problems), file=sys.stderr)
        for p in problems[:20]:
            print("  " + p, file=sys.stderr)
        return 1
    print("validation OK: %d transcript(s), well-formed records, linked tool results, intact uuid chain"
          % len(written))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
