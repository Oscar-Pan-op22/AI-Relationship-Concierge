import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "data" / "tongpin.sqlite"
HELPER_PATH = REPO_ROOT / "scripts" / "regenerate_prechat_summaries_helper.mjs"


def run_helper(db_path: Path, session_ids: list[str], round_id: str, use_all: bool) -> dict:
    command = ["node", str(HELPER_PATH)]

    if use_all:
        command.append("--all")
    else:
        for session_id in session_ids:
            command.extend(["--session-id", session_id])

    if round_id:
        command.extend(["--round-id", round_id])

    env = os.environ.copy()
    env["TONGPIN_DB_PATH"] = str(db_path)

    completed = subprocess.run(
        command,
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )

    return json.loads(completed.stdout or "{}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate prechat stage summaries without affecting Twin-Twin automation."
    )
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH), help="Path to the SQLite database.")
    parser.add_argument("--session-id", action="append", default=[], help="Prechat session ID to regenerate.")
    parser.add_argument("--round-id", default="", help="Optional round ID to regenerate instead of the latest round.")
    parser.add_argument("--all", action="store_true", help="Regenerate the latest stage summary for all prechat sessions.")
    args = parser.parse_args()

    db_path = Path(args.db_path).resolve()
    if not db_path.exists():
        print(f"Database does not exist: {db_path}", file=sys.stderr)
        return 1

    session_ids = [session_id.strip() for session_id in args.session_id if session_id.strip()]
    if not args.all and not session_ids:
        print("Pass at least one --session-id, or use --all.", file=sys.stderr)
        return 1

    result = run_helper(db_path, session_ids, args.round_id.strip(), args.all)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
