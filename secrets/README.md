# secrets/

Service-account keys live here. **Nothing real in this folder is ever committed.**

`.gitignore` ignores `secrets/*` and allows back only `.gitkeep`, `README.md`
and `*.example.json`. The real key filename is therefore untrackable — even
`git add -A` cannot pick it up. Do not `git add -f` it.

## GA4 key — what the recommendation engine needs

The "From the Same Collection" engine reads product views and add-to-carts from
GA4 (money still comes from Shopify). Without the key it does **not** error — it
silently falls back to the first-party view beacon, which has far less data.
That soft failure is why a missing key can go unnoticed, so verify after any
deploy or key change.

Two ways to supply it. The file is read on **every** call, so no restart is
needed after you drop it in.

### Option A — key file (what local dev uses)

1. Put the JSON at `secrets/ga4-service-account.json`
   (copy `ga4-service-account.example.json` and replace the values).
2. Point `.env` at it with an **absolute** path:

   ```
   GA4_PROPERTY_ID=478308692
   GA4_SERVICE_ACCOUNT_FILE=/home/<user>/lucira-backend/secrets/ga4-service-account.json
   ```

   A relative path is resolved against the process working directory, not the
   repo root — fine for `npm start` from the backend folder, but it breaks under
   pm2/systemd if they set a different cwd. Absolute is safer.

### Option B — inline env var (good for Hostinger / any host with an env UI)

No file on disk at all. Put the whole JSON on one line:

```
GA4_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...",...}
```

`GA4_SERVICE_ACCOUNT_JSON` takes precedence over `GA4_SERVICE_ACCOUNT_FILE`.

## Deploying to Hostinger

`git pull` will never touch the key, because the real filename is not tracked.
Place it once, out of band:

1. `scp` the JSON to `secrets/ga4-service-account.json` on the server (or paste
   the JSON into `GA4_SERVICE_ACCOUNT_JSON` and skip the file entirely).
2. Lock it down: `chmod 600 secrets/ga4-service-account.json`.
3. Set `GA4_PROPERTY_ID=478308692` in the server `.env`.
4. Verify: `node check-ga4.js` — it prints the service-account email, confirms
   auth, then builds the SKU index.

## Verifying it actually works

```
node check-ga4.js
```

Expect "Auth OK", then ~2,700 products with 30d activity. The SKU index build
takes ~4 minutes; that is normal.

To confirm the *running server* is using GA4 (not the beacon):

```
curl -s localhost:8080/api/recommendations/attributes
```

Look for `"ga4Configured": true` and `"viewsSource": "ga4"`.

After a restart the first admin preview reports
`{"views":"beacon","skuIndexPending":true}` for ~4 minutes while the SKU index
builds in the background. That is expected — re-check after it lands rather than
concluding GA4 is broken. Note `check-ga4.js` builds its own copy of the index
in its own process, so running it does not shorten the server's warm-up.

## If a key is ever exposed

Rotating means **deleting the old key** in Google Cloud IAM (Service Accounts →
`lucira-reco-ga4@lucirajewelry-prod.iam.gserviceaccount.com` → Keys). Creating a
new key does not invalidate existing ones — every key stays valid until deleted.
Removing a key from git also does not remove it from history or from any clone.
