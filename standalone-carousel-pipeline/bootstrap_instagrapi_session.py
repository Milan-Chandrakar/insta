from __future__ import annotations

import os
import sys
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")


def main() -> int:
    base = Path(__file__).resolve().parent
    load_dotenv(base / ".env")

    vendor = base / "vendor"
    if vendor.exists():
        sys.path.insert(0, str(vendor))

    try:
        from instagrapi import Client
    except Exception as exc:  # pragma: no cover
        print(f"Missing instagrapi in vendor. Run pip install -r requirements.txt. ({exc})")
        return 2

    username = os.environ.get("INSTAGRAM_USERNAME")
    password = os.environ.get("INSTAGRAM_PASSWORD")
    session_id = os.environ.get("INSTAGRAM_SESSIONID")
    session_file = os.environ.get("INSTAGRAM_SESSION_FILE") or "./.instagrapi-session.json"

    if not session_id and (not username or not password):
        print("Missing credentials. Set INSTAGRAM_SESSIONID or INSTAGRAM_USERNAME / INSTAGRAM_PASSWORD in standalone-carousel-pipeline/.env")
        return 2

    session_path = (base / session_file).resolve() if not os.path.isabs(session_file) else Path(session_file)

    cl = Client()
    if session_path.exists():
        try:
            cl.load_settings(str(session_path))
        except Exception:
            pass

    if session_id:
        try:
            cl.login_by_sessionid(session_id)
        except Exception as exc:
            print(f"Session login failed: {type(exc).__name__}: {exc}")
            print("Set a fresh INSTAGRAM_SESSIONID from a currently logged-in browser session and retry.")
            return 3
    else:
        try:
            cl.login(username, password)
        except Exception as exc:
            msg = str(exc)
            challenge_blocked = "Challenge" in type(exc).__name__ or "challenge" in msg.lower()
            print(f"Login failed: {type(exc).__name__}: {msg}")
            if challenge_blocked:
                print("Status: pending_manual_verification")
                print("Action required:")
                print("- Open Instagram app on your phone for this account.")
                print("- Approve/complete any 'suspicious login' or verification challenge.")
                print("- If no notification arrives, use INSTAGRAM_SESSIONID fallback in .env.")
                return 0
            return 3

    session_path.parent.mkdir(parents=True, exist_ok=True)
    cl.dump_settings(str(session_path))
    print(f"Session saved: {session_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
