# FamilyWatch — GCP Production Server Runbook

**Scope:** How the FamilyWatch production server was migrated from a stuck GCP VM
(`familywatch-server`, zone `us-central1-a`) to a new VM (`familywatch-server-2`,
zone `us-west1-b`), and how to repeat this migration in the future.

**Project:** `project-7f266f68-4742-45ea-882`
**Account:** `fatemasayed760@gmail.com`
**Domain:** `familywatch.duckdns.org`
**Date of migration:** 2026-08-13

---

## 1. Overview / Architecture

Everything runs on a **single GCE VM** (Debian 12, `e2-micro`). There is no load
balancer, no managed database, no separate LiveKit host — one small VM does it all.

```
                         familywatch.duckdns.org (DuckDNS dynamic DNS, free)
                                        │
                                        │  DNS A record -> VM external IP
                                        ▼
                          ┌─────────────────────────────┐
                          │   GCE VM (e2-micro, Debian)  │
                          │                              │
  Internet ── HTTPS:443 ─►│  nginx (Certbot/Let's        │
              HTTP:80  ───►  Encrypt TLS termination)     │
                          │       │                       │
                          │       ├─ location /       ────┼──► localhost:8080
                          │       │                       │    Node.js WS server
                          │       │                       │    (server/index.js,
                          │       │                       │     systemd: familywatch)
                          │       │                       │
                          │       └─ location /livekit/ ─┼──► localhost:7880
                          │                              │    LiveKit SFU
                          │                              │    (Docker container,
                          │                              │     host networking)
                          │                              │    RTC: tcp/7881,
                          │                              │    udp/50000-60000
                          └─────────────────────────────┘
```

Key architectural points:

- **One domain, path-based routing.** LiveKit is NOT on a separate subdomain. nginx
  proxies `/` to the app (port 8080) and `/livekit/` to LiveKit (port 7880), both on
  the same `familywatch.duckdns.org` cert. Both proxy blocks need WebSocket upgrade
  headers because both the app's own WebSocket server and LiveKit's signaling channel
  are WS-based.
- **APK build automation** is a GitHub Actions workflow
  (`.github/workflows/build-apk.yml`) that, on push to `main` (or manual
  `workflow_dispatch`), builds the Android APK and publishes a GitHub Release. It still
  SSHes into the VM once, to install/refresh the nightly backup timer (harmless,
  idempotent, `continue-on-error`) — but it no longer deploys the server itself.
  **Server deploys are manual** (2026-09-01: removed after the VM's 1 vCPU/1GB
  `e2-micro` repeatedly hit `appleboy/ssh-action`'s 10-minute `command_timeout` running
  `npm ci && vite build` on top of the already-running app/nginx/LiveKit). See Section
  3.9-style steps below for the manual sequence: build `client/dist` on a real machine,
  `gcloud compute scp --recurse client/dist ...`, then SSH in for
  `git fetch`/`reset --hard`/`npm --prefix server ci`/`systemctl restart familywatch` —
  order matters, do the git steps *before* copying `dist/` over, since `reset --hard`
  would otherwise wipe it.
- **Everything of value lives on the boot disk**: the app code, the systemd unit, the
  nginx config, the Let's Encrypt cert, and the LiveKit Docker container/config. This
  is why disk migration (Section 3) is so much faster than a from-scratch rebuild.

---

## 2. When to use this runbook

Use this procedure when:

- The production VM is `TERMINATED`/stopped and `gcloud compute instances start`
  fails repeatedly with `ZONE_RESOURCE_POOL_EXHAUSTED` (the zone has no free-tier
  `e2-micro` capacity right now).
- You need to move the server to a different zone/region for any other reason
  (e.g. sustained capacity issues, wanting a region closer to users).
- The VM needs to be recreated for any reason but you still have the original disk
  or a snapshot of it.

Do **not** use this if the VM is merely stopped and capacity is available — just
`gcloud compute instances start` it. Only fall back to migration once repeated start
attempts fail with a capacity error over a meaningful retry window (in this incident:
~23 attempts, 60s apart, ~23 minutes, in `us-central1-a`).

---

## 3. Step-by-step migration procedure

### 3.0 Confirm you're actually stuck (retry loop)

Before concluding the zone is out of capacity, retry a few times with backoff. This is
what was actually run:

```bash
for i in $(seq 1 23); do
  gcloud compute instances start familywatch-server --zone us-central1-a && break
  echo "attempt $i failed, retrying in 60s..."
  sleep 60
done
```

Result: every attempt failed with:

```
ERROR: (gcloud.compute.instances.start) ---
code: ZONE_RESOURCE_POOL_EXHAUSTED
message: The zone 'projects/.../zones/us-central1-a' does not have enough resources
available to fulfill the request.
```

This error is about the **zone's physical capacity**, not your quota or billing — no
amount of retrying alone will fix it if the zone stays saturated. The fix is to move
to a different zone.

### 3.1 Verify free-tier eligibility before touching anything

Since cost matters, confirm exactly what you have before deciding whether recreating
it elsewhere keeps you inside the Always Free tier:

```bash
gcloud compute instances describe familywatch-server \
  --zone us-central1-a \
  --format="yaml(machineType,scheduling.preemptible,disks)"

gcloud compute disks describe familywatch-server \
  --zone us-central1-a \
  --format="yaml(type,sizeGb)"
```

Confirmed for this incident: `e2-micro`, non-preemptible, `pd-standard` 10GB boot
disk. This matches GCP's Always Free tier conditions:

- Machine type `e2-micro`
- One of the three eligible regions: `us-west1`, `us-central1`, `us-east1`
- Non-preemptible
- Boot disk ≤ 30GB `pd-standard`
- (Plus a separate 1GB/month network egress allowance, which can't be fully verified
  in advance — track actual usage if this matters to you.)

**Since `us-west1` is also an eligible free-tier region, recreating the VM there
preserves free-tier eligibility** — this is why `us-west1-b` was chosen as the target
zone rather than a non-free-tier region.

> **Read Section 6 before running two VMs at once** — the free tier is a *shared
> monthly hour quota*, not "one free VM per region." Do not leave both VMs running
> simultaneously.

### 3.2 Snapshot the existing disk

A GCE persistent disk is zone-locked and cannot be attached to an instance in a
different zone or region. A **snapshot**, however, is stored regionally/
multi-regionally and can be used to create a disk in *any* zone. This is the bridge
that lets you move to a new region without rebuilding the server by hand:

```bash
gcloud compute disks snapshot familywatch-server \
  --zone=us-central1-a \
  --snapshot-names=familywatch-server-snap \
  --description="Snapshot before migrating to us-west1"
```

This works even while the source instance is stopped — the disk itself is intact,
only the VM failed to start.

### 3.3 Create a new disk in the target zone from the snapshot

Use the same disk type and size as the original so you stay within the free-tier
disk-size limit:

```bash
gcloud compute disks create familywatch-server-2 \
  --zone=us-west1-b \
  --source-snapshot=familywatch-server-snap \
  --type=pd-standard \
  --size=10GB
```

### 3.4 Create the new VM booting from that disk

```bash
gcloud compute instances create familywatch-server-2 \
  --zone=us-west1-b \
  --machine-type=e2-micro \
  --disk=name=familywatch-server-2,boot=yes,auto-delete=no \
  --tags=http-server,https-server
```

Notes:

- Use `--disk=name=...,boot=yes` (not `--image` / `--image-family`) because you are
  booting from an **existing disk** that already has the OS, app, nginx, Docker, and
  LiveKit installed — not provisioning a fresh OS image.
- `auto-delete=no` is deliberate: it protects the disk from being destroyed if this
  instance is ever deleted later. Without it, `gcloud compute instances delete` would
  also silently delete your only copy of the working disk.
- The `--tags=http-server,https-server` used here turned out to be **wrong** for this
  project's firewall rules — see Gotcha #1 below. Check your actual firewall rules
  first and use the correct tag(s) directly if you already know them (see Section 3.6
  for how to check).

### 3.5 Retag the instance to match the project's actual firewall rules

See [Troubleshooting → Gotcha #1](#gotcha-1-firewall-tag-mismatch) for the full
symptom/diagnosis. Short version — this project's firewall rules target a custom tag
`familywatch`, not the generic `http-server`/`https-server` tags used in step 3.4:

```bash
gcloud compute instances add-tags familywatch-server-2 \
  --zone=us-west1-b \
  --tags=familywatch
```

### 3.6 SSH in and fix git ownership

```bash
gcloud compute ssh familywatch-server-2 --zone=us-west1-b
```

Then, once on the VM, see
[Troubleshooting → Gotcha #2](#gotcha-2-git-dubious-ownership) — run this once so the
GitHub Actions deploy step's `git pull` doesn't break on the next deploy:

```bash
git config --global --add safe.directory /home/fatemasayed760/chat-pwa
```

### 3.7 Point DNS at the new VM

Get the new VM's external IP and update the existing DuckDNS record (same mechanism
already used for the old VM — a local update script/token the operator already has,
not part of this repo):

```bash
NEW_IP=$(gcloud compute instances describe familywatch-server-2 \
  --zone=us-west1-b \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

curl -s "https://www.duckdns.org/update?domains=familywatch&token=<DUCKDNS_TOKEN>&ip=$NEW_IP"
```

DuckDNS supports multiple free subdomains per account, so a dedicated subdomain for
LiveKit is an option in the future — but this migration deliberately kept the existing
single-domain, path-based nginx routing (`/` + `/livekit/`) since that config was
already on the migrated disk and already worked in production. Don't introduce
unrelated architecture changes while doing a capacity-driven migration.

### 3.8 Update the GitHub Actions deploy target

If `.github/workflows/build-apk.yml` (or its repository/environment secrets) hardcodes
the old VM's IP or a hostname that isn't `familywatch.duckdns.org` itself, update it to
point at the new instance so future `git push` deploys land on
`familywatch-server-2`, not the retired VM. (In this migration, DNS itself was the
target, so no workflow change was required — but always check this rather than
assume it.)

### 3.9 Verify (see Section 7 for the full checklist)

At minimum:

```bash
dig +short familywatch.duckdns.org @8.8.8.8
curl -I https://familywatch.duckdns.org
curl -I https://familywatch.duckdns.org/livekit/
```

### 3.10 Retire (don't delete) the old VM

Leave `familywatch-server` **stopped** in `us-central1-a`. Do not delete it and do not
start it back up while `familywatch-server-2` is running — see Section 6. Keeping it
around stopped costs nothing and gives you a fallback (and its disk/snapshot lineage)
if the new VM ever has problems.

---

## 4. Troubleshooting

### Gotcha #1: Firewall tag mismatch

**Symptom:** `https://familywatch.duckdns.org` timed out completely from the public
internet — connection just hung, no TLS handshake, nothing. Yet:

- DNS resolved correctly to the new VM's IP (`dig` confirmed it).
- The app was confirmed healthy **on the VM itself**: `curl http://localhost:8080`
  returned `200`.

This combination — locally healthy, externally unreachable — is the classic signature
of a **firewall rule not applying to the instance**, not an application bug. Don't
waste time debugging nginx or the app when you see this pattern; check firewall rules
and instance tags first.

**Diagnosis:**

```bash
gcloud compute firewall-rules list
```

Showed the project's actual rules target a custom tag, not the generic ones used when
the instance was created:

```
allow-familywatch-web       tcp:80,tcp:443              targetTags: [familywatch]
allow-familywatch-livekit   tcp:7881,udp:50000-60000    targetTags: [familywatch]
```

But `familywatch-server-2` had been created with `--tags=http-server,https-server` (a
plausible-looking guess based on GCP's built-in default tags) — which matched none of
these rules.

**Fix:**

```bash
gcloud compute instances add-tags familywatch-server-2 --zone=us-west1-b --tags=familywatch
```

After this, both `https://familywatch.duckdns.org` and
`https://familywatch.duckdns.org/livekit/` returned `200` within seconds — no other
change needed. Firewall tag propagation is near-instant.

**Lesson for next time:** run `gcloud compute firewall-rules list` *before* creating
the new instance, and pass the correct `--tags` value at creation time in step 3.4 to
skip this step entirely.

### Gotcha #2: git "dubious ownership" after disk migration

**Symptom:** after SSHing into the new VM, any `git` command inside the app repo
failed:

```
fatal: detected dubious ownership in repository at '/home/fatemasayed760/chat-pwa'
```

This is git's `safe.directory` protection. It can trigger after a disk/filesystem
migration even when the actual Unix file ownership (`chown`) is unchanged, because git
also compares other filesystem/mount metadata that can differ across a disk
snapshot→new-disk→new-instance path. Left unfixed, this would silently break the
GitHub Actions deploy step's `git pull origin main` on the very next push to `main` —
the SSH deploy step would fail non-interactively with the same error.

**Fix (run once on the new VM):**

```bash
git config --global --add safe.directory /home/fatemasayed760/chat-pwa
```

Do this proactively for any repo directory on a migrated disk — don't wait for the
next CI deploy to discover it's broken.

---

## 5. "Cold rebuild" reference — if no snapshot or disk is available

If, in some future incident, there is truly no old disk or snapshot to fall back to,
here is everything that was found already configured on the migrated disk. Recreating
all of this by hand is the full scope of a from-scratch rebuild.

### 5.1 Base packages

- Node.js v20.20.2, at `/usr/bin/node`
- nginx
- Docker
- Certbot (with the nginx plugin, for Let's Encrypt)

### 5.2 App repo

```bash
git clone https://github.com/dailycoder09/apkformobile.git /home/fatemasayed760/chat-pwa
```

### 5.3 systemd unit — `/etc/systemd/system/familywatch.service`

```ini
[Unit]
Description=FamilyWatch Server
After=network.target

[Service]
Type=simple
User=fatemasayed760
WorkingDirectory=/home/fatemasayed760/chat-pwa
Environment=PORT=8080
Environment=LIVEKIT_URL=wss://familywatch.duckdns.org/livekit
Environment=LIVEKIT_API_KEY=<see EnvironmentFile, not committed>
Environment=LIVEKIT_API_SECRET=<see EnvironmentFile, not committed>
Environment=ADMIN_PIN=<see EnvironmentFile, not committed — do NOT rely on the code default>
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now familywatch
```

> **2026-08-15 security note:** this file previously reproduced the real production
> LiveKit API key/secret in plaintext. Those values must be treated as compromised
> (this repo was briefly public) and have been rotated; the real values now live only
> on the VM (an `EnvironmentFile=` outside of git) and in the LiveKit container's own
> config, never in version control. The same applies to `ADMIN_PIN` — the code's
> hardcoded `'1234'` fallback (`server/index.js`) must never be relied on in
> production; set a strong value directly in the environment. Do not reproduce real
> secret values in this file again, even for operational reference — use placeholders
> and point to where the real value is stored instead.

### 5.4 nginx site config — `/etc/nginx/sites-enabled/familywatch`

Single server block for `familywatch.duckdns.org`. Two `location` blocks: one proxies
the app, one proxies LiveKit. Both need WebSocket upgrade headers. Port 80 redirects to
443 (this redirect block is managed/inserted by Certbot). Reconstructed shape:

```nginx
server {
    listen 80;
    server_name familywatch.duckdns.org;
    return 301 https://$host$request_uri;   # Certbot-managed redirect
}

server {
    listen 443 ssl;
    server_name familywatch.duckdns.org;

    ssl_certificate     /etc/letsencrypt/live/familywatch.duckdns.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/familywatch.duckdns.org/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location /livekit/ {
        proxy_pass http://localhost:7880/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

To obtain the cert fresh (if not migrating an existing one):

```bash
sudo certbot --nginx -d familywatch.duckdns.org
```

### 5.5 LiveKit — Docker container + config

`config.yaml` (read from the running container via
`sudo docker exec livekit cat /config.yaml`):

```yaml
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  <api-key>: <api-secret>   # rotated 2026-08-15 — real values live only on the VM, never in git
```

The container listens directly on the host's `7880`/`7881` plus the full
`50000-60000` UDP range with no port-mapping flags visible, which is consistent with
it having been run with host networking. Reconstructed run command:

```bash
sudo docker run -d \
  --name livekit \
  --restart always \
  --net=host \
  -v /path/to/config.yaml:/config.yaml \
  livekit/livekit-server:v1.9.1 \
  --config /config.yaml
```

> Pin the image tag explicitly (confirm the actual running version with
> `sudo docker inspect livekit --format '{{.Config.Image}}'` before relying on this for
> a real rebuild) — `livekit/livekit-server` with no tag resolves to `:latest`, an
> unpinned, undocumented dependency for a disaster-recovery procedure.

> The exact original `docker run` invocation was not independently captured in this
> session (only inferred from the running container's network behavior and config).
> Before relying on this in a real cold rebuild, confirm with
> `sudo docker inspect livekit` on a still-running instance if one is available, and
> update this section with the exact flags.

### 5.6 Firewall rules

These already existed at the project level and were **not** recreated during this
migration — they applied automatically once the new instance was tagged correctly
(Gotcha #1). If rebuilding a project from scratch, recreate them:

```bash
gcloud compute firewall-rules create allow-familywatch-web \
  --allow=tcp:80,tcp:443 \
  --target-tags=familywatch

gcloud compute firewall-rules create allow-familywatch-livekit \
  --allow=tcp:7881,udp:50000-50200 \
  --target-tags=familywatch
```

> **2026-08-15 security note:** the UDP range above was narrowed from the previously
> documented `udp:50000-60000` (a needlessly wide 10,000-port exposure) to
> `udp:50000-50200` — 201 ports is generous headroom for a small number of concurrent
> family AV sessions per typical LiveKit sizing guidance (each participant's RTC media
> needs one port from the range). The **live** GCP firewall rule and the VM's LiveKit
> `config.yaml` (`rtc.port_range_start` / `rtc.port_range_end`, see Section 5.5) both
> still need to be updated to match if this narrower range is ever applied for
> real — this section only documents what a from-scratch rebuild *should* create, it
> does not change anything currently running.

Then create the instance with `--tags=familywatch` from the start.

---

## 6. Free-tier cost notes

- The confirmed setup (`e2-micro`, non-preemptible, `pd-standard` ≤30GB, in
  `us-west1`/`us-central1`/`us-east1`) qualifies for GCP's Always Free tier.
- **Critical caveat: the free tier is a shared monthly hour quota (~744 hours, i.e.
  one instance running 24/7) across ALL qualifying `e2-micro` instances on the
  billing account.** It is *not* "one free instance per eligible region."
- Running two free-tier-eligible `e2-micro` instances at the same time, even briefly,
  means their hours **overlap and add together** against that single shared quota —
  once the combined total exceeds ~744 hours in the month, you are billed for the
  excess. This is why the old VM (`familywatch-server`) was left **stopped**, not
  running, once the new VM (`familywatch-server-2`) went live.
- There is also a separate ~1GB/month network egress allowance under the free tier
  that cannot be fully verified in advance from `gcloud describe` output — keep an eye
  on actual billing/usage if egress volume matters for this app.
- Practical rule: **only one FamilyWatch VM should ever be running at a time.**
  Before starting a second VM for any reason (testing, migration, disaster recovery),
  stop the first one, or accept that you are now paying for the overlap.

---

## 7. Post-migration checklist

Run all of these after any future migration; every one of them passed for this
incident.

```bash
# DNS actually points at the new VM
dig +short familywatch.duckdns.org @8.8.8.8

# App reachable over HTTPS
curl -I https://familywatch.duckdns.org

# LiveKit reverse proxy reachable over HTTPS
curl -I https://familywatch.duckdns.org/livekit/

# App can actually mint a LiveKit token (end-to-end signaling path, not just nginx)
curl "https://familywatch.duckdns.org/api/lk-token?room=test&identity=test"
# expect a response containing a JWT and "url": "wss://familywatch.duckdns.org/livekit"
```

On the VM itself (`gcloud compute ssh familywatch-server-2 --zone=us-west1-b`):

```bash
# App service is running
systemctl is-active familywatch          # expect: active

# LiveKit container is running
sudo docker ps                           # expect: livekit container "Up"

# TLS cert is still valid and not about to expire
openssl x509 -enddate -noout \
  -in /etc/letsencrypt/live/familywatch.duckdns.org/fullchain.pem
# this incident: valid until Nov 2026 — no renewal action needed yet
```

Also confirm:

- The old VM (`familywatch-server`, `us-central1-a`) is stopped, not deleted, and not
  also running (see Section 6).
- The snapshot (`familywatch-server-snap`) and old disk are retained for now as a
  fallback, until you're confident the new VM is stable.
- `git config --global --add safe.directory ...` has been run on the new VM
  (Gotcha #2) so the next automated deploy doesn't fail.
- If the GitHub Actions workflow hardcodes a host/IP for SSH deploy, it has been
  updated to target the new VM (Section 3.8).
