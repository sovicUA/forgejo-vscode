#!/usr/bin/env python3
"""Створює реліз Forgejo для тега v<версія> і прикріплює до нього forgejo-connector-<версія>.vsix.

Запускається з Forgejo Actions (.forgejo/workflows/release.yml), але працює й локально:
    FORGEJO_URL=https://git.example.ua FORGEJO_REPO=owner/forgejo-vscode FORGEJO_TOKEN=... \\
    python3 release.py v0.3.0

Опис релізу — повідомлення анотованого тега (git tag -a v0.3.0 -m "що нового").
Повторний запуск для того самого тега замінює файл .vsix у наявному релізі.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def api(method, path, body=None, content_type="application/json"):
    url = f"{os.environ['FORGEJO_URL'].rstrip('/')}/api/v1{path}"
    if body is not None and content_type == "application/json":
        body = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"token {os.environ['FORGEJO_TOKEN']}",
        "Accept": "application/json",
        **({"Content-Type": content_type} if body is not None else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as err:
        if err.code == 404 and method == "GET":
            return None
        sys.exit(f"{method} {path}: HTTP {err.code} {err.read().decode('utf-8', 'replace')}")


def tag_message(tag):
    try:
        out = subprocess.run(["git", "tag", "-l", "--format=%(contents)", tag],
                             cwd=ROOT, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return ""
    # Підпис GPG/SSH, якщо тег підписаний, — не частина опису
    return out.split("-----BEGIN ")[0].strip()


def main():
    if len(sys.argv) != 2:
        sys.exit("Використання: python3 release.py v<версія>")
    tag = sys.argv[1]
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if tag != f"v{pkg['version']}":
        sys.exit(f"Тег {tag} не відповідає версії в package.json ({pkg['version']}): підніміть version і створіть тег v<версія>")

    vsix = Path(subprocess.run([sys.executable, str(ROOT / "build_vsix.py")],
                               capture_output=True, text=True, check=True).stdout.strip())
    repo = os.environ["FORGEJO_REPO"]

    release = api("GET", f"/repos/{repo}/releases/tags/{tag}")
    if release is None:
        notes = tag_message(tag)
        release = api("POST", f"/repos/{repo}/releases", {
            "tag_name": tag,
            "name": f"{pkg['displayName']} {pkg['version']}",
            "body": notes if notes and notes != tag else "",
        })
        print(f"Створено реліз {tag}")

    for asset in release.get("assets") or []:
        if asset["name"] == vsix.name:
            api("DELETE", f"/repos/{repo}/releases/{release['id']}/assets/{asset['id']}")

    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="attachment"; filename="{vsix.name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8") + vsix.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    api("POST", f"/repos/{repo}/releases/{release['id']}/assets?name={vsix.name}", body,
        f"multipart/form-data; boundary={boundary}")
    print(f"Додано {vsix.name} до {release.get('html_url', tag)}")


if __name__ == "__main__":
    main()
