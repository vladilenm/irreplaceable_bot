# Amsterdam VLESS Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Развернуть на Amsterdam VPS изолированный Xray/VLESS Reality endpoint с независимыми профилями для `club-bot` и iPhone/v2RayTun, не затронув существующий `tg-parser-demo`.

**Architecture:** Новый compose project живёт в `/opt/club-bot-egress`, публикует только TCP/443 и использует официальный Xray `v26.3.27`, закреплённый по digest после pull. Один Reality inbound содержит два UUID; server config и client exports создаются на VPS с root-only permissions, а существующий compose project и его network не изменяются.

**Tech Stack:** Ubuntu 24.04, Docker Engine/Compose, official `ghcr.io/xtls/xray-core`, Xray VLESS Reality TCP + XTLS Vision, Python 3 для безопасной генерации конфигурации, v2RayTun на iPhone.

## Global Constraints

- Не читать и не печатать root password, VLESS UUID, Reality private key или полные `vless://` URI в tool output/logs.
- Не открывать и не изменять `/opt/tg-parser-demo/docker-compose.yml`; проверять сервис только безопасными Docker metadata commands.
- Не перезапускать `tg-parser-demo` и не присоединять Xray к `tg-parser-demo_default`.
- Не устанавливать 3x-ui, MTProto proxy, TUN или full-tunnel VPN.
- Публично открыть только `147.45.149.185:443/tcp`; SSH, Zabbix и firewall policy в этом плане не менять.
- Server client IDs `club-bot` и `personal-mobile` обязаны иметь разные UUID.
- Реальные credentials остаются только в root-only файлах VPS и task-local `/private/tmp`; в Git они не попадают.
- Перед каждой external mutation ещё раз подтвердить пользователю точное действие.
- Опубликованный в чате root password после завершения работ должен быть заменён отдельной согласованной операцией.

---

### Task 1: Повторный preflight и baseline существующего сервиса

**Files:**
- Read only: remote Docker/OS state
- Record task-local: `/private/tmp/club-bot-egress-baseline.txt`

**Interfaces:**
- Consumes: SSH access к `root@147.45.149.185`.
- Produces: baseline container ID/start time и подтверждение свободного TCP/443 без secrets.

- [ ] **Step 1: Проверить, что target и ресурсы не изменились**

Run each command in an interactive SSH session so the password is entered only at the TTY prompt:

```bash
ssh root@147.45.149.185
ss -lntup
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'
curl -4 -sS -o /dev/null -w 'telegram_http=%{http_code} total=%{time_total}s\n' --connect-timeout 5 --max-time 10 https://api.telegram.org/
python3 --version
```

Expected: TCP/443 отсутствует в `ss`; `tg-parser-demo-tg-parser-1` имеет status `Up`; Telegram возвращает HTTP `200` или redirect `3xx`; Python 3 доступен.

- [ ] **Step 2: Проверить Reality target без изменения VPS**

```bash
curl -4 -sS -o /dev/null -w 'target_http=%{http_code} tls=%{time_appconnect}s\n' --connect-timeout 5 --max-time 10 https://www.microsoft.com/
openssl s_client -connect www.microsoft.com:443 -servername www.microsoft.com -tls1_3 -brief </dev/null
```

Expected: TLS 1.3 handshake succeeds and certificate verification is `OK`. If it does not, stop the task before generating credentials; do not silently substitute another Reality target.

- [ ] **Step 3: Capture a safe baseline locally**

Run from the local workspace without printing container environment or mounts:

```bash
ssh root@147.45.149.185 "docker inspect tg-parser-demo-tg-parser-1 --format 'id={{.Id}} started={{.State.StartedAt}} status={{.State.Status}} network={{.HostConfig.NetworkMode}}'" > /private/tmp/club-bot-egress-baseline.txt
```

Expected file content: one metadata line; no environment values or secrets.

---

### Task 2: Сгенерировать и проверить Xray server bundle

**Files:**
- Create task-local: `/private/tmp/provision_amsterdam_xray.py`
- Create remote: `/opt/club-bot-egress/compose.yml`
- Create remote: `/opt/club-bot-egress/config/config.json`
- Create remote: `/opt/club-bot-egress/secrets/bot-vless.txt`
- Create remote: `/opt/club-bot-egress/secrets/mobile-vless.txt`
- Create remote: `/opt/club-bot-egress/secrets/smoke-client.json`

**Interfaces:**
- Consumes: official Xray tag `ghcr.io/xtls/xray-core:26.3.27`; fixed endpoint `147.45.149.185:443`; Reality target/SNI `www.cloudflare.com`.
- Produces: digest-pinned compose project, two VLESS URIs and a bot-credential smoke-test config. Secret files are never printed.

- [ ] **Step 1: Create the provisioning program locally with `apply_patch`**

Create `/private/tmp/provision_amsterdam_xray.py` with this complete content:

```python
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from urllib.parse import urlencode
from uuid import uuid4

ROOT = Path('/opt/club-bot-egress')
IMAGE_TAG = 'ghcr.io/xtls/xray-core:26.3.27'
SERVER_IP = '147.45.149.185'
SERVER_PORT = 443
CONTAINER_PORT = 8443
REALITY_NAME = 'www.cloudflare.com'
REALITY_DEST = f'{REALITY_NAME}:443'


def run(args: list[str]) -> str:
    completed = subprocess.run(
        args,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


if ROOT.exists():
    raise SystemExit('Refusing to overwrite existing /opt/club-bot-egress')

run(['docker', 'pull', IMAGE_TAG])
image_ref = run([
    'docker', 'image', 'inspect',
    '--format={{index .RepoDigests 0}}',
    IMAGE_TAG,
])
if '@sha256:' not in image_ref:
    raise SystemExit('Pulled Xray image has no immutable RepoDigest')

x25519 = run(['docker', 'run', '--rm', image_ref, 'x25519'])
private_match = re.search(r'^PrivateKey:\s*(\S+)\s*$', x25519, re.MULTILINE)
public_match = re.search(
    r'^(?:Password(?: \(PublicKey\))?|Public key):\s*(\S+)\s*$',
    x25519,
    re.MULTILINE,
)
if private_match is None or public_match is None:
    raise SystemExit('Unexpected Xray x25519 output shape')

private_key = private_match.group(1)
public_key = public_match.group(1)
short_id = secrets.token_hex(8)
bot_uuid = str(uuid4())
mobile_uuid = str(uuid4())
if bot_uuid == mobile_uuid:
    raise SystemExit('Generated duplicate UUIDs')

server_config = {
    'log': {'access': 'none', 'dnsLog': False, 'loglevel': 'warning'},
    'inbounds': [{
        'listen': '0.0.0.0',
        'port': CONTAINER_PORT,
        'protocol': 'vless',
        'tag': 'vless-reality-in',
        'settings': {
            'clients': [
                {'id': bot_uuid, 'email': 'club-bot', 'flow': 'xtls-rprx-vision'},
                {'id': mobile_uuid, 'email': 'personal-mobile', 'flow': 'xtls-rprx-vision'},
            ],
            'decryption': 'none',
        },
        'streamSettings': {
            'network': 'tcp',
            'security': 'reality',
            'realitySettings': {
                'show': False,
                'dest': REALITY_DEST,
                'xver': 0,
                'serverNames': [REALITY_NAME],
                'privateKey': private_key,
                'shortIds': [short_id],
            },
        },
        'sniffing': {
            'enabled': True,
            'destOverride': ['http', 'tls', 'quic'],
            'routeOnly': True,
        },
    }],
    'outbounds': [
        {'protocol': 'freedom', 'tag': 'direct'},
        {'protocol': 'blackhole', 'tag': 'block'},
    ],
}


def vless_uri(client_id: str, label: str, fingerprint: str) -> str:
    query = urlencode({
        'encryption': 'none',
        'flow': 'xtls-rprx-vision',
        'security': 'reality',
        'sni': REALITY_NAME,
        'fp': fingerprint,
        'pbk': public_key,
        'sid': short_id,
        'type': 'tcp',
    })
    return f'vless://{client_id}@{SERVER_IP}:{SERVER_PORT}?{query}#{label}'


bot_uri = vless_uri(bot_uuid, 'club-bot-amsterdam', 'chrome')
mobile_uri = vless_uri(mobile_uuid, 'personal-mobile-amsterdam', 'chrome')

smoke_client = {
    'log': {'access': 'none', 'dnsLog': False, 'loglevel': 'warning'},
    'inbounds': [{
        'listen': '0.0.0.0',
        'port': 11080,
        'protocol': 'socks',
        'settings': {'auth': 'noauth', 'udp': False},
    }],
    'outbounds': [{
        'protocol': 'vless',
        'settings': {'vnext': [{
            'address': 'xray',
            'port': CONTAINER_PORT,
            'users': [{
                'id': bot_uuid,
                'encryption': 'none',
                'flow': 'xtls-rprx-vision',
            }],
        }]},
        'streamSettings': {
            'network': 'tcp',
            'security': 'reality',
            'realitySettings': {
                'serverName': REALITY_NAME,
                'fingerprint': 'chrome',
                'publicKey': public_key,
                'shortId': short_id,
                'spiderX': '/',
            },
        },
    }],
}

compose = f'''services:
  xray:
    image: "{image_ref}"
    container_name: club-bot-egress-xray
    restart: unless-stopped
    user: "65532:65532"
    command: ["run", "-config", "/usr/local/etc/xray/config.json"]
    ports:
      - "443:{CONTAINER_PORT}/tcp"
    volumes:
      - "./config/config.json:/usr/local/etc/xray/config.json:ro"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 64
    mem_limit: 128m
    cpus: 0.25
    stop_grace_period: 10s
    healthcheck:
      test: ["CMD", "/usr/local/bin/xray", "run", "-test", "-config", "/usr/local/etc/xray/config.json"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
'''

config_dir = ROOT / 'config'
secrets_dir = ROOT / 'secrets'
config_dir.mkdir(parents=True, mode=0o750)
secrets_dir.mkdir(mode=0o700)

(ROOT / 'compose.yml').write_text(compose, encoding='utf-8')
(config_dir / 'config.json').write_text(
    json.dumps(server_config, indent=2) + '\n',
    encoding='utf-8',
)
(secrets_dir / 'bot-vless.txt').write_text(bot_uri + '\n', encoding='utf-8')
(secrets_dir / 'mobile-vless.txt').write_text(mobile_uri + '\n', encoding='utf-8')
(secrets_dir / 'smoke-client.json').write_text(
    json.dumps(smoke_client, indent=2) + '\n',
    encoding='utf-8',
)

os.chown(config_dir, 0, 65532)
os.chown(config_dir / 'config.json', 65532, 65532)
os.chmod(config_dir, 0o750)
os.chmod(config_dir / 'config.json', 0o600)
os.chmod(ROOT / 'compose.yml', 0o600)
for secret_file in secrets_dir.iterdir():
    os.chmod(secret_file, 0o600)
os.chown(secrets_dir / 'smoke-client.json', 65532, 65532)

print('Xray bundle provisioned; secrets were not printed')
```

- [ ] **Step 2: Upload and run the program without exposing generated values**

```bash
scp /private/tmp/provision_amsterdam_xray.py root@147.45.149.185:/root/provision_amsterdam_xray.py
ssh root@147.45.149.185 'python3 /root/provision_amsterdam_xray.py'
```

Expected: `Xray bundle provisioned; secrets were not printed`. Do not run the script a second time: it must refuse to overwrite the directory.

- [ ] **Step 3: Validate file permissions, Compose and Xray config**

```bash
ssh root@147.45.149.185 "stat -c '%a %u:%g %n' /opt/club-bot-egress /opt/club-bot-egress/compose.yml /opt/club-bot-egress/config /opt/club-bot-egress/config/config.json /opt/club-bot-egress/secrets /opt/club-bot-egress/secrets/*.txt"
ssh root@147.45.149.185 'docker compose -f /opt/club-bot-egress/compose.yml config --quiet'
ssh root@147.45.149.185 'docker run --rm -v /opt/club-bot-egress/config/config.json:/usr/local/etc/xray/config.json:ro ghcr.io/xtls/xray-core:26.3.27 run -test -config /usr/local/etc/xray/config.json'
```

Expected: URI exports are `600 root:root`; server config and smoke config are `600 65532:65532`; Compose is valid; Xray reports configuration success. No file content is printed.

---

### Task 3: Запустить endpoint и доказать VLESS egress

**Files:**
- Use remote: `/opt/club-bot-egress/compose.yml`
- Use remote secret: `/opt/club-bot-egress/secrets/smoke-client.json`
- Read local baseline: `/private/tmp/club-bot-egress-baseline.txt`

**Interfaces:**
- Consumes: validated server bundle from Task 2.
- Produces: running `club-bot-egress-xray`, HTTPS response through the bot VLESS credential, unchanged baseline service.

- [ ] **Step 1: Perform the final port preflight and start only the new project**

```bash
ssh root@147.45.149.185 "ss -lnt | awk '\$4 ~ /:443$/ {found=1} END {exit found ? 1 : 0}'"
ssh root@147.45.149.185 'docker compose -f /opt/club-bot-egress/compose.yml up -d'
```

Expected: preflight exit code `0`; Compose creates only `club-bot-egress-xray`.

- [ ] **Step 2: Verify status, port and resource boundary**

```bash
ssh root@147.45.149.185 "docker ps --filter name=club-bot-egress-xray --format 'name={{.Names}} status={{.Status}} ports={{.Ports}}'"
ssh root@147.45.149.185 "ss -lntup | awk '\$5 ~ /:443$/ {print}'"
ssh root@147.45.149.185 "docker stats --no-stream --format 'name={{.Name}} mem={{.MemUsage}} mem_percent={{.MemPerc}} cpu={{.CPUPerc}}' club-bot-egress-xray tg-parser-demo-tg-parser-1"
```

Expected: Xray becomes `healthy`, only TCP/443 is newly published, and it remains under the 128 MiB memory limit.

- [ ] **Step 3: Run an end-to-end VLESS smoke test without a bot token**

```bash
ssh root@147.45.149.185 'docker run -d --rm --name club-bot-egress-smoke --network club-bot-egress_default -p 127.0.0.1:11080:11080 -v /opt/club-bot-egress/secrets/smoke-client.json:/usr/local/etc/xray/config.json:ro ghcr.io/xtls/xray-core:26.3.27 run -config /usr/local/etc/xray/config.json'
ssh root@147.45.149.185 "curl --socks5-hostname 127.0.0.1:11080 -sS -o /dev/null -w 'proxied_telegram_http=%{http_code} total=%{time_total}s\n' --connect-timeout 5 --max-time 15 https://api.telegram.org/"
ssh root@147.45.149.185 'docker stop club-bot-egress-smoke'
```

Expected: proxied Telegram request returns HTTP `200` or `3xx`; the transient smoke container is then removed automatically.

- [ ] **Step 4: Prove the existing service was not restarted**

```bash
ssh root@147.45.149.185 "docker inspect tg-parser-demo-tg-parser-1 --format 'id={{.Id}} started={{.State.StartedAt}} status={{.State.Status}} network={{.HostConfig.NetworkMode}}'" > /private/tmp/club-bot-egress-after.txt
diff -u /private/tmp/club-bot-egress-baseline.txt /private/tmp/club-bot-egress-after.txt
```

Expected: `diff` is empty.

---

### Task 4: Передать и проверить профиль v2RayTun

**Files:**
- Copy secret to task-local: `/private/tmp/personal-mobile-vless.txt`
- Create task-local: `/private/tmp/render_vless_qr.swift`
- Create task-local: `/private/tmp/personal-mobile-vless.png`
- Keep remote source: `/opt/club-bot-egress/secrets/mobile-vless.txt`

**Interfaces:**
- Consumes: `personal-mobile` URI from the running endpoint.
- Produces: exact QR code and import link for v2RayTun; explicit user confirmation.

- [ ] **Step 1: Copy the mobile export without printing it**

```bash
scp root@147.45.149.185:/opt/club-bot-egress/secrets/mobile-vless.txt /private/tmp/personal-mobile-vless.txt
chmod 600 /private/tmp/personal-mobile-vless.txt
```

Expected: local file exists with mode `600`; command output contains no URI.

- [ ] **Step 2: Validate URI shape without printing credentials**

```bash
node --input-type=module -e 'import{readFileSync}from"node:fs";const u=new URL(readFileSync("/private/tmp/personal-mobile-vless.txt","utf8").trim());const ok=u.protocol==="vless:"&&u.hostname==="147.45.149.185"&&u.port==="443"&&u.searchParams.get("security")==="reality"&&u.searchParams.get("flow")==="xtls-rprx-vision"&&u.searchParams.get("type")==="tcp";if(!ok)process.exit(1);console.log("mobile URI shape ok")'
```

Expected: `mobile URI shape ok`; no username/UUID is emitted.

- [ ] **Step 3: Generate an exact QR artifact with macOS CoreImage**

Create `/private/tmp/render_vless_qr.swift` with `apply_patch`:

```swift
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

let source = URL(fileURLWithPath: "/private/tmp/personal-mobile-vless.txt")
let target = URL(fileURLWithPath: "/private/tmp/personal-mobile-vless.png")
let value = try String(contentsOf: source, encoding: .utf8)
    .trimmingCharacters(in: .whitespacesAndNewlines)
guard let data = value.data(using: .utf8), !data.isEmpty else {
    throw NSError(domain: "VlessQr", code: 1)
}

let filter = CIFilter.qrCodeGenerator()
filter.message = data
filter.correctionLevel = "M"
guard let output = filter.outputImage?.transformed(
    by: CGAffineTransform(scaleX: 12, y: 12)
) else {
    throw NSError(domain: "VlessQr", code: 2)
}

let context = CIContext()
guard let cgImage = context.createCGImage(output, from: output.extent) else {
    throw NSError(domain: "VlessQr", code: 3)
}
let bitmap = NSBitmapImageRep(cgImage: cgImage)
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "VlessQr", code: 4)
}
try png.write(to: target, options: .atomic)
```

Run:

```bash
swift /private/tmp/render_vless_qr.swift
```

Expected: PNG is created entirely locally; the URI is not present in process arguments or network requests.

- [ ] **Step 4: Hand the user both import forms and wait for a real-device check**

Display `/private/tmp/personal-mobile-vless.png` in the Codex app and provide `/private/tmp/personal-mobile-vless.txt` as a local file link. Ask the user to import into v2RayTun, enable the profile, open Telegram and one HTTPS control site, then confirm both work.

Expected: user confirms v2RayTun connects and traffic works. Do not start Timeweb application rollout before this checkpoint.

---

### Task 5: Server acceptance and rollback record

**Files:**
- Create task-local: `/private/tmp/club-bot-egress-acceptance.txt`
- Keep remote bundle: `/opt/club-bot-egress`

**Interfaces:**
- Consumes: running endpoint and mobile confirmation.
- Produces: safe operational acceptance record and exact rollback command.

- [ ] **Step 1: Capture safe acceptance metadata**

```bash
ssh root@147.45.149.185 "docker inspect club-bot-egress-xray --format 'image={{.Config.Image}} started={{.State.StartedAt}} status={{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}} memory={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}}'" > /private/tmp/club-bot-egress-acceptance.txt
ssh root@147.45.149.185 "docker compose -f /opt/club-bot-egress/compose.yml ps --format json" >> /private/tmp/club-bot-egress-acceptance.txt
```

Expected: acceptance file contains only container metadata; no config, environment or URI.

- [ ] **Step 2: Record but do not execute rollback**

Rollback command:

```bash
ssh root@147.45.149.185 'docker compose -f /opt/club-bot-egress/compose.yml down'
```

Expected effect if later approved: only `club-bot-egress` container/network stop; `/opt/club-bot-egress` and all credentials remain recoverable; `tg-parser-demo` is untouched.

- [ ] **Step 3: Remove task-local secret copies after the user imports them**

After explicit confirmation that the iPhone profile is saved:

```bash
rm -f /private/tmp/personal-mobile-vless.txt /private/tmp/personal-mobile-vless.png /private/tmp/render_vless_qr.swift
```

Expected: task-local copies are deleted; root-only server exports remain available for controlled recovery/rotation.
