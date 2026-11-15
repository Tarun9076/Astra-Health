# Deploying ASTRA HEALTH: web app on Vercel, backends on Google Cloud

```
 Browser ──https──▶ Vercel (the web app)
    │                 │  /api/*, /ground-api/*  forwarded (rewrites in apps/web/vercel.json)
    │                 ▼
    └──wss (live)──▶ Google Cloud VM:  Caddy (HTTPS)  ──▶  Habitat backend :8000 ⇄ Ground backend :8001
                                                         (Docker; SQLite databases on volumes)
```

**Why two places?** Vercel hosts the web app well, but it only runs short-lived functions. The two
backends must stay running: they sync with each other every few seconds, keep live (WebSocket)
connections, and store their databases on disk. They run on one small VM. Vercel cannot forward
WebSockets, so the app connects its live updates straight to the VM (`VITE_LIVE_ORIGIN`).

**HTTPS matters:** the camera exercise coach and the smartwatch only work over HTTPS. Vercel gives the
app HTTPS; Caddy on the VM gets a free certificate automatically. No domain needed: `sslip.io` turns
the VM's IP into a name (`34.93.12.7` → `34-93-12-7.sslip.io`).

Total time: about 30–45 minutes. Cost: an `e2-medium` VM is about US$25 a month, covered by Google
Cloud's free trial credits (US$300 for new accounts); Vercel's Hobby plan is free.

---

## Before you start

1. **Push the code to GitHub** (including the `deploy/` folder and `apps/web/vercel.json`).
2. A **Google Cloud** account with billing or free-trial credits, and a project
   (console.cloud.google.com → *Select a project* → *New project*). Note its **project ID**.
3. A **Vercel** account (vercel.com → sign in with GitHub).
4. Your secrets from `services/backend/.env` (NASA key, Anthropic key) if you want live space weather
   and Claude answers. Never commit them; you type them on the server only.

---

## Part 1: the backends on Google Cloud

Open **Cloud Shell** (the `>_` button at the top right of the Google Cloud console). It has `gcloud`
ready; nothing to install. Run these one by one (change `my-project-id`; `asia-south1` is Mumbai, pick
a region near you):

```bash
gcloud config set project my-project-id
gcloud services enable compute.googleapis.com
gcloud compute addresses create astra-ip --region=asia-south1
gcloud compute instances create astra-health \
  --zone=asia-south1-a --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --address=astra-ip --tags=astra-web
gcloud compute firewall-rules create astra-web --allow=tcp:80,tcp:443,udp:443 --target-tags=astra-web
gcloud compute addresses describe astra-ip --region=asia-south1 --format='get(address)'
```

The last command prints the VM's IP, e.g. `34.93.12.7`. Your server name is then
**`34-93-12-7.sslip.io`** (dots become dashes). Use it everywhere below as `YOUR-SERVER.sslip.io`.

Connect to the VM and install Docker:

```bash
gcloud compute ssh astra-health --zone=asia-south1-a
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

Get the code and set the secrets (if the repository is private, `git clone` asks for your GitHub user
name and a personal access token as the password):

```bash
git clone https://github.com/Tarun9076/Astra-Health.git
cd Astra-Health
cp deploy/.env.example deploy/.env
openssl rand -hex 32
openssl rand -hex 32
nano deploy/.env
```

In `nano`, fill in: `ASTRA_DOMAIN=YOUR-SERVER.sslip.io`, `ASTRA_JWT_SECRET` and `ASTRA_SYNC_KEY` (paste
the two random values), and optionally `ASTRA_NASA_API_KEY` and `ANTHROPIC_API_KEY`. Save with
**Ctrl+O, Enter**, quit with **Ctrl+X**.

Start everything (the first build takes about 5–10 minutes):

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f habitat
```

Wait for `Loading the simulated mission data…` to finish (a minute or two), then **Ctrl+C** to leave
the logs (the servers keep running). Check in a browser: `https://YOUR-SERVER.sslip.io/api/system/status`
should answer (a 401 "not signed in" also means it works). The VM also serves the full app at
`https://YOUR-SERVER.sslip.io`, which is a handy backup link.

---

## Part 2: the web app on Vercel

1. In the repository, open `apps/web/vercel.json` and replace both `YOUR-SERVER.sslip.io` with your
   server name. Commit and push.
2. On vercel.com: **Add New → Project → Import** your `Astra-Health` repository.
3. In the import screen:
   - **Root Directory:** `apps/web` (click *Edit* next to it).
   - **Framework Preset:** Vite (the build settings come from `vercel.json`).
   - **Environment Variables:** add `VITE_LIVE_ORIGIN` = `wss://YOUR-SERVER.sslip.io`.
4. Click **Deploy**. When it finishes, open the `*.vercel.app` link and sign in as `ast1` /
   `astra-demo-ast1`.

Check that it all works:
- The header shows **Habitat · live** (live updates connected straight to the VM).
- Sign in as `surgeon1` / `astra-demo-surgeon` in another browser: the crew overview has data (Ground).
- Wellness → Start a coached workout → **Start with the camera** asks for the camera (HTTPS works).

Vercel builds the emergency procedures from the `protocols/` folder outside `apps/web`. That works by
default; if a build fails with "cannot find protocols", turn on *Settings → General → Include files
outside the Root Directory in the Build Step*.

---

## Everyday tasks

| Task | How |
|---|---|
| Update after a code change | Web app: push to GitHub (Vercel redeploys). Backends: on the VM, `cd Astra-Health && git pull && docker compose -f deploy/docker-compose.yml up -d --build` |
| Fresh demo (mission day 121 today, rehearsal data cleared) | On the VM: `docker compose -f deploy/docker-compose.yml down -v` then `up -d --build` again. `-v` **deletes the databases**. |
| See what a server is doing | `docker compose -f deploy/docker-compose.yml logs -f habitat` (or `ground`, `web`) |
| Stop paying for the VM | Google Cloud console → Compute Engine → VM instances → **Stop** (the reserved IP costs a little while the VM is stopped; release it with `gcloud compute addresses delete astra-ip --region=asia-south1` when done) |

## Troubleshooting

| Problem | Fix |
|---|---|
| The browser says the VM's certificate is not valid | Ports 80/443 must be open (the firewall rule above) and `ASTRA_DOMAIN` must match the IP exactly. Look at `docker compose … logs web`. |
| The Vercel app shows "Request failed" on sign-in | `vercel.json` still says `YOUR-SERVER`, or the VM is stopped. Open `https://YOUR-SERVER.sslip.io/api/system/status` to check the VM. |
| The header says the live link is off | `VITE_LIVE_ORIGIN` is missing or wrong in Vercel (it must start with `wss://`). Change it, then *Redeploy*. |
| The build on the VM stops with "Killed" | Not enough memory: use `e2-medium` (4 GB), or add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
| The flight surgeon sees no data | Give the sync a few minutes after the first start (6,600 readings travel over the simulated link), and check `logs ground`. |

## Security notes

- All health data in the demo is simulated. The demo accounts and their passwords are listed in the
  README, so **anyone with the link can sign in**. That is intended for judging; do not enter real
  personal health data on a public deployment (the smartwatch feature would store real readings).
- Secrets live only in `deploy/.env` on the VM (never committed). Use new random values for
  `ASTRA_JWT_SECRET` and `ASTRA_SYNC_KEY`, not the development defaults.
- Only ports 80 and 443 are opened to the internet; the backends themselves are reachable only
  through Caddy.
