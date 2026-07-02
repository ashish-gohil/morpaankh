#!/usr/bin/env python3
"""Google Search Console status check for morpaankh.in.

Auth: a GCP service account key (JSON) whose client_email has been added
as a user on the GSC property. No SDKs needed: the JWT is signed with the
system openssl binary and everything else is stdlib.

Key file location (first match wins):
  $GSC_SA_KEY, then ~/.config/gsc/morpaankh-sa.json

Usage:
  python3 scripts/gsc-check.py            # property + sitemaps + key URL inspection
  python3 scripts/gsc-check.py URL [URL]  # inspect specific URLs instead
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/webmasters"
DEFAULT_URLS = [
    "https://www.morpaankh.in/",
    "https://www.morpaankh.in/collections/kurta-sets",
    "https://www.morpaankh.in/collections/all",
    "https://www.morpaankh.in/collections/one-piece",
    "https://www.morpaankh.in/products/mogra",
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def key_path() -> str:
    for p in (os.environ.get("GSC_SA_KEY"), os.path.expanduser("~/.config/gsc/morpaankh-sa.json")):
        if p and os.path.exists(p):
            return p
    sys.exit(
        "Service account key not found.\n"
        "Save it to ~/.config/gsc/morpaankh-sa.json or set GSC_SA_KEY=/path/to/key.json"
    )


def access_token(sa: dict) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(json.dumps({
        "iss": sa["client_email"],
        "scope": SCOPE,
        "aud": TOKEN_URL,
        "iat": now,
        "exp": now + 3600,
    }).encode())
    signing_input = f"{header}.{claims}".encode()

    # openssl signs with the SA private key; keep the PEM in a 0600 temp file.
    fd, pem = tempfile.mkstemp(suffix=".pem")
    try:
        os.write(fd, sa["private_key"].encode())
        os.close(fd)
        sig = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", pem],
            input=signing_input, capture_output=True, check=True,
        ).stdout
    finally:
        os.unlink(pem)

    jwt = f"{header}.{claims}.{b64url(sig)}"
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": jwt,
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body)) as r:
        return json.load(r)["access_token"]


def api(token: str, url: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    if payload is not None:
        req.data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": e.code, "detail": e.read().decode()[:500]}


def main() -> None:
    sa = json.load(open(key_path()))
    token = access_token(sa)
    print(f"Authenticated as {sa['client_email']}\n")

    sites = api(token, "https://www.googleapis.com/webmasters/v3/sites")
    entries = sites.get("siteEntry", [])
    print("== Properties this service account can see ==")
    if not entries:
        print("  NONE. Add the service account email above as a user (Full) in")
        print("  GSC -> Settings -> Users and permissions, then rerun.")
        return
    for s in entries:
        print(f"  {s['siteUrl']}  (permission: {s['permissionLevel']})")

    # Prefer the domain property, else the www prefix property.
    site = next((s["siteUrl"] for s in entries if s["siteUrl"] == "sc-domain:morpaankh.in"),
                next((s["siteUrl"] for s in entries if "morpaankh" in s["siteUrl"]),
                     entries[0]["siteUrl"]))
    enc = urllib.parse.quote(site, safe="")

    print(f"\n== Sitemaps on {site} ==")
    maps = api(token, f"https://www.googleapis.com/webmasters/v3/sites/{enc}/sitemaps")
    for m in maps.get("sitemap", []):
        contents = ", ".join(
            f"{c['type']}: {c.get('submitted', '?')} submitted / {c.get('indexed', '?')} indexed"
            for c in m.get("contents", [])
        )
        print(f"  {m['path']}")
        print(f"    last read: {m.get('lastDownloaded', 'never')}  errors: {m.get('errors', 0)}  "
              f"warnings: {m.get('warnings', 0)}")
        if contents:
            print(f"    {contents}")
    if not maps.get("sitemap"):
        print("  No sitemaps submitted for this property.")

    urls = sys.argv[1:] or DEFAULT_URLS
    print("\n== URL inspection ==")
    for u in urls:
        res = api(token, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
                  {"inspectionUrl": u, "siteUrl": site})
        if "error" in res:
            print(f"  {u}\n    error {res['error']}: {res['detail']}")
            continue
        idx = res.get("inspectionResult", {}).get("indexStatusResult", {})
        print(f"  {u}")
        print(f"    verdict: {idx.get('verdict', '?')}  coverage: {idx.get('coverageState', '?')}")
        print(f"    last crawl: {idx.get('lastCrawlTime', 'never')}  "
              f"canonical (Google): {idx.get('googleCanonical', 'n/a')}")


if __name__ == "__main__":
    main()
