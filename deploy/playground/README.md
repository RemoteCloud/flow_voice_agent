# Flow Voice on ai-playground (flowvoice.operationcentric.com)

Same pattern as `/opt/flowdeck`: `node:22-alpine`, bind-mounted bundle, shared Traefik +
`cloudflare-companion`, secrets in `/opt/flowvoice/.env` (chmod 600, never in git).

## Endpoints
- `https://flowvoice.operationcentric.com/` — PWA (OIDC sign-in via Maranics UserManagement)
- `https://flowvoice.operationcentric.com/healthz` — GET, no auth
- `wss://flowvoice.operationcentric.com/v1/audio` — AEP endpoints (Android app / browser)

## Server layout: `/opt/flowvoice/`
`docker-compose.yml`, `hub.mjs` (= `dist/server.mjs`), `public/` (= `dist/public`),
`data-template/` (seeds `/data` on first start), `.env`. Data (`hub.json`, portable
`stations.json` / `mappings.json` / `profiles/`) lives in the `flowvoice_flowvoice-data` volume.

## First deploy
```
# 0. secrets on the server (never paste them into a chat or a ticket)
ssh wg-ai-playground 'mkdir -p /opt/flowvoice && cd /opt/flowvoice && umask 077 && {
  echo "HUB_SECRET=$(openssl rand -base64 32 | tr +/ -_)"
  echo "SESSION_SECRET=$(openssl rand -base64 32 | tr +/ -_)"
  grep -E "^HUB_(TENANT|MARANICS_HOST|OIDC_ISSUER|OIDC_CLIENT_ID|OIDC_CLIENT_SECRET)=" /opt/flowdeck/.env
} > .env'
# 1. UserManagement: add redirect URI https://flowvoice.operationcentric.com/api/auth/callback
#    to the external application whose client id is in .env (or register a new one).
# 2. build + ship (repo root, dev machine)
npm run build
tar czf - -C deploy/playground docker-compose.yml README.md | ssh wg-ai-playground 'tar xzf - -C /opt/flowvoice'
tar czf - -C deploy data-template | ssh wg-ai-playground 'tar xzf - -C /opt/flowvoice'
tar czf - -C dist --transform 's,^server.mjs,hub.mjs,' server.mjs public | ssh wg-ai-playground 'tar xzf - -C /opt/flowvoice'
#    (macOS bsdtar: use  -s ',^server.mjs,hub.mjs,'  instead of --transform)
# 3. the hub runs as uid 1000; the fresh data volume is root-owned → chown once, then start
ssh wg-ai-playground 'cd /opt/flowvoice && docker compose create && docker run --rm -v flowvoice_flowvoice-data:/data alpine chown 1000:1000 /data && docker compose up -d && docker compose logs --tail 20 hub'
# 4. DNS: cloudflare-companion only scans containers when IT starts → docker restart cloudflare-companion
#    then  dig +short flowvoice.operationcentric.com
```

## Redeploy after a rebuild
```
npm run build
tar czf - -C dist -s ',^server.mjs,hub.mjs,' server.mjs public | ssh wg-ai-playground 'tar xzf - -C /opt/flowvoice'
ssh wg-ai-playground 'cd /opt/flowvoice && docker compose restart hub'
```
(`hub.mjs` is bind-mounted; a restart is enough. `public/` is served straight from disk.)

If the piped `tar | ssh` drops with exit 255 (Warpgate sometimes rejects stdin streams), ship a file instead:
```
tar czf /tmp/flowvoice-bundle.tgz -C dist -s ',^server.mjs,hub.mjs,' server.mjs public
scp /tmp/flowvoice-bundle.tgz wg-ai-playground:/opt/flowvoice/incoming.tgz
ssh wg-ai-playground 'cd /opt/flowvoice && tar xzf incoming.tgz && rm incoming.tgz && docker compose restart hub'
```

## Operations
- Health: `curl https://flowvoice.operationcentric.com/healthz`
- Logs: `ssh wg-ai-playground 'cd /opt/flowvoice && docker compose logs -f hub'` (tokens redacted)
- Reset store: stop, `docker run --rm -v flowvoice_flowvoice-data:/d alpine rm /d/hub.json`, start
- Android app: hub address `https://flowvoice.operationcentric.com`
