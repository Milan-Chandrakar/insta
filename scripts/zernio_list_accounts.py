#!/usr/bin/env python3
"""List Zernio connected accounts and print the account IDs.

Usage:
  python scripts/zernio_list_accounts.py
  python scripts/zernio_list_accounts.py --platform pinterest
  python scripts/zernio_list_accounts.py --platform pinterest --json

Reads ZERNIO_API_KEY from the environment or from a local .env file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_BASE_URL = os.environ.get("ZERNIO_API_URL", "https://zernio.com/api/v1").rstrip("/")


def load_dotenv_if_present() -> None:
    """Minimal .env loader so the script works without extra Python packages."""
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parent.parent / ".env",
    ]

    for env_path in candidates:
        if not env_path.exists():
            continue

        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def build_url(platform: str | None, include_over_limit: bool) -> str:
    query: dict[str, str] = {}
    if platform:
        query["platform"] = platform
    if include_over_limit:
        query["includeOverLimit"] = "true"
    encoded = urllib.parse.urlencode(query)
    return f"{API_BASE_URL}/accounts{('?' + encoded) if encoded else ''}"


def request_json(url: str, api_key: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Zernio request failed: HTTP {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Zernio request failed: {exc.reason}") from exc


def extract_accounts(payload: dict) -> list[dict]:
    accounts = payload.get("accounts")
    if isinstance(accounts, list):
        return accounts
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("accounts"), list):
        return data["accounts"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description="List Zernio connected account IDs.")
    parser.add_argument("--platform", help="Optional platform filter, e.g. pinterest")
    parser.add_argument(
        "--include-over-limit",
        action="store_true",
        help="Include accounts from over-limit profiles if supported by the API.",
    )
    parser.add_argument("--json", action="store_true", help="Print the raw JSON response.")
    args = parser.parse_args()

    load_dotenv_if_present()
    api_key = os.environ.get("ZERNIO_API_KEY", "").strip()
    if not api_key:
        print("Missing ZERNIO_API_KEY. Set it in your environment or .env file.", file=sys.stderr)
        return 1

    url = build_url(args.platform, args.include_over_limit)
    payload = request_json(url, api_key)

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    accounts = extract_accounts(payload)
    if not accounts:
        print("No Zernio accounts returned.")
        return 0

    for account in accounts:
        account_id = account.get("_id") or account.get("id") or account.get("accountId")
        platform = account.get("platform", "-")
        username = account.get("username", "-")
        display_name = account.get("displayName", "-")
        profile_id = account.get("profileId")
        profile_name = profile_id.get("name") if isinstance(profile_id, dict) else "-"
        print(f"ACCOUNT_ID={account_id} | platform={platform} | username={username} | displayName={display_name} | profile={profile_name}")

    if len(accounts) == 1:
        account = accounts[0]
        account_id = account.get("_id") or account.get("id") or account.get("accountId")
        print(f"\nUse this as ZERNIO_ACCOUNT_ID:\n{account_id}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
