"""Download Anthropic's Form S-1 from SEC EDGAR into source/ (optional).

The model does not need this file: the S-1 figures are already transcribed in
scripts/build_historicals.py. Fetch it if you want to check those numbers against the filing.

SEC requires a User-Agent with your name and email. Set SEC_USER_AGENT in .env (see .env.example).

Run:  python3 scripts/fetch_s1.py
"""
import os
import re
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/anthropicpbc-sx1.htm"
OUT_DIR = ROOT / "source"


def user_agent():
    ua = os.environ.get("SEC_USER_AGENT")
    env = ROOT / ".env"
    if not ua and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("SEC_USER_AGENT="):
                ua = line.split("=", 1)[1].strip().strip('"')
    if not ua or "example.com" in ua:
        raise SystemExit("Set SEC_USER_AGENT in .env to your name and email (see .env.example).")
    return ua


def main():
    OUT_DIR.mkdir(exist_ok=True)
    req = urllib.request.Request(URL, headers={"User-Agent": user_agent()})
    html = urllib.request.urlopen(req, timeout=120).read()
    (OUT_DIR / "anthropicpbc-sx1.htm").write_bytes(html)
    text = re.sub(r"<[^>]+>", " ", html.decode("utf-8", "ignore"))
    text = re.sub(r"[ \t\r\f\v]+", " ", unescape(text))
    (OUT_DIR / "s1.txt").write_text(re.sub(r"\n\s*\n+", "\n\n", text))
    print(f"Saved {len(html) / 1e6:.1f} MB to source/anthropicpbc-sx1.htm and a text copy to source/s1.txt")


if __name__ == "__main__":
    main()
