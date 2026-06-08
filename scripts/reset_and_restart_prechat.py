import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "data" / "tongpin.sqlite"
DEFAULT_SERVER_BASE_URL = "http://localhost:3000"
RESTART_HELPER_PATH = REPO_ROOT / "scripts" / "restart_prechat_helper.mjs"
RESTART_JOB_DIR = REPO_ROOT / "data" / "prechat-reset-jobs"
PRECHAT_TABLES = [
    "conversation_turns",
    "stage_reports",
    "human_input_requests",
    "sensitive_question_requests",
    "prechat_rounds",
    "prechat_sessions",
]


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def backup_database(db_path: Path) -> Path:
    backup_path = db_path.with_name(f"{db_path.name}.bak-prechat-reset-{now_stamp()}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def clear_prechat_history(db_path: Path, max_attempts: int = 12) -> None:
    delay_s = 0.25
    last_error: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        conn = sqlite3.connect(str(db_path), timeout=30)
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA busy_timeout = 30000")
            conn.execute("BEGIN IMMEDIATE")
            for table in PRECHAT_TABLES:
                conn.execute(f"DELETE FROM {table}")
            conn.commit()
            return
        except sqlite3.OperationalError as error:
            last_error = error
            try:
                conn.rollback()
            except sqlite3.Error:
                pass

            is_locked = "locked" in str(error).lower()
            if not is_locked or attempt >= max_attempts:
                raise
        except Exception as error:
            last_error = error
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

        time.sleep(delay_s)
        delay_s = min(delay_s * 1.5, 2.0)

    if last_error is not None:
        raise last_error


def request_json(method: str, url: str, payload: dict | None = None) -> dict:
    body = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def ensure_restart_job_dir() -> Path:
    RESTART_JOB_DIR.mkdir(parents=True, exist_ok=True)
    return RESTART_JOB_DIR


def run_node_restart_helper_foreground(db_path: Path, wait_ms: int) -> dict:
    env = os.environ.copy()
    env["TONGPIN_DB_PATH"] = str(db_path)
    completed = subprocess.run(
        ["node", str(RESTART_HELPER_PATH), str(wait_ms)],
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        env=env,
        check=True,
    )
    return json.loads(completed.stdout or "{}")


def start_node_restart_helper_background(db_path: Path, wait_ms: int) -> dict:
    job_dir = ensure_restart_job_dir()
    job_id = f"prechat-reset-{now_stamp()}"
    summary_path = job_dir / f"{job_id}.summary.json"
    log_path = job_dir / f"{job_id}.log"
    env = os.environ.copy()
    env["TONGPIN_DB_PATH"] = str(db_path)
    creationflags = 0
    popen_kwargs: dict[str, object] = {
        "cwd": str(REPO_ROOT),
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stderr": subprocess.STDOUT,
        "close_fds": True,
    }

    if os.name == "nt":
        creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if creationflags:
            popen_kwargs["creationflags"] = creationflags
    else:
        popen_kwargs["start_new_session"] = True

    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            ["node", str(RESTART_HELPER_PATH), str(wait_ms), str(summary_path)],
            stdout=log_file,
            **popen_kwargs,
        )

    return {
        "mode": "background_helper",
        "jobId": job_id,
        "pid": process.pid,
        "summaryPath": str(summary_path),
        "logPath": str(log_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Delete all historical prechat sessions and restart Twin-Twin prechat."
    )
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH), help="Path to the SQLite database.")
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Skip creating a DB backup before clearing history.",
    )
    parser.add_argument(
        "--wait-ms",
        type=int,
        default=1500,
        help="Milliseconds to wait after restart so automation can begin. Default: 1500.",
    )
    parser.add_argument(
        "--background",
        action="store_true",
        help="Clear locally and run the restart helper in the foreground.",
    )
    parser.add_argument(
        "--server-async",
        action="store_true",
        help="Use the running localhost server to clear and restart prechat asynchronously.",
    )
    parser.add_argument(
        "--server-base-url",
        default=DEFAULT_SERVER_BASE_URL,
        help="Base URL for --server-async. Default: http://localhost:3000",
    )
    args = parser.parse_args()

    db_path = Path(args.db_path).resolve()
    if not db_path.exists():
        print(f"Database does not exist: {db_path}", file=sys.stderr)
        return 1

    backup_path = None
    if not args.no_backup:
        backup_path = backup_database(db_path)

    if args.server_async:
        base_url = args.server_base_url.rstrip("/")
        try:
            result = request_json(
                "POST",
                f"{base_url}/api/admin/reset-and-restart-prechat",
                {"waitMs": args.wait_ms},
            )
            print(
                json.dumps(
                    {
                        "database": str(db_path),
                        "backup": str(backup_path) if backup_path else None,
                        "restartMode": "server_async",
                        "serverBaseUrl": base_url,
                        "job": result.get("job"),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        except urllib.error.URLError as error:
            clear_prechat_history(db_path)
            fallback_job = start_node_restart_helper_background(db_path, args.wait_ms)
            print(
                json.dumps(
                    {
                        "database": str(db_path),
                        "backup": str(backup_path) if backup_path else None,
                        "restartMode": "background_helper_fallback",
                        "serverBaseUrl": base_url,
                        "serverAsyncError": str(error.reason or error),
                        "restartJob": fallback_job,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

    if not args.background:
        clear_prechat_history(db_path)
        restart_job = start_node_restart_helper_background(db_path, args.wait_ms)
        print(
            json.dumps(
                {
                    "database": str(db_path),
                    "backup": str(backup_path) if backup_path else None,
                    "cleared_tables": PRECHAT_TABLES,
                    "restartMode": "background_local_clear",
                    "restartJob": restart_job,
                    "note": "This resets prechat data and starts a fresh helper using the latest source on disk."
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    clear_prechat_history(db_path)
    restart_summary = run_node_restart_helper_foreground(db_path, args.wait_ms)

    print(
        json.dumps(
            {
                "database": str(db_path),
                "backup": str(backup_path) if backup_path else None,
                "cleared_tables": PRECHAT_TABLES,
                "restartMode": "foreground_legacy",
                "restartSummary": restart_summary,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
