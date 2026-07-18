# SufYam Home — Web Console

A browser front-end for the [SufYam Home](../sufyam-home-app) Flutter app. It
reads and writes the **same Google Sheet** the phone syncs to, so both stay in
step.

Plain HTML/CSS/JS. No build step, no npm, no server. Chart.js is the only
dependency and it comes from a CDN.

## Hosting it (the normal way)

Push this folder to GitHub and turn on **Pages**. Pages serves static files
over `https://`, so there is nothing to run and nothing to keep alive — open
the URL from any device, anywhere.

1. Create a repo on GitHub, e.g. `sufyam-home-web`.
2. `git remote add origin <url>` then `git push -u origin main`.
3. Repo **Settings → Pages** → Source: *Deploy from a branch* → `main` / `/ (root)`.
4. Wait ~1 minute for `https://<user>.github.io/sufyam-home-web/`.

> **Why not Laravel/PHP?** Laravel needs a PHP process running on a server
> somewhere — GitHub Pages can only serve static files, so it can't host it.
> This app is static precisely so it can live on Pages for free with nothing
> running.

Opening `index.html` straight from disk (`file://`) will **not** work: browsers
treat every `file://` page as an anonymous origin, which blocks both ES modules
and Google sign-in. That's a browser rule, not a bug in the app.

### Editing locally (optional)

Only needed if you want to test changes before pushing. Any static server:

```bash
cd "C:/Coding Projek/sufyam-home-web"
python -m http.server 8000     # or: npx serve -l 8000
```

`start-server.bat` does this for you, but it needs Python or Node installed. If
you don't have either, just push and let Pages be your test environment.

## One-time setup

The app needs a Google OAuth **Client ID**. A share link alone isn't enough —
that authorizes a person clicking in a browser, not this page's JavaScript.

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
   and select **the same project the phone app uses**.
2. **Create Credentials → OAuth client ID → Web application**.
3. Under *Authorized JavaScript origins* add your Pages **origin** —
   `https://<user>.github.io` — with **no path and no trailing slash**. Origins
   are scheme + host only; including `/sufyam-home-web` there is the single
   most common reason sign-in gets rejected. Add `http://localhost:8000` too if
   you plan to test locally.
4. Copy the Client ID.
5. Open the app → **Settings** → paste the Client ID and your Google Sheet
   link → **Save & sign in**.

Both values are kept in `localStorage`, per browser — so they are never
committed to this repo. Enter them once on each device you use. The Client ID
is not a secret; browser OAuth clients are public by design. What protects your
data is the origins list plus your own Google sign-in.

**Keep the sheet id out of the code.** If the spreadsheet is shared as "anyone
with the link can edit", that id is effectively its password — in a public repo
it would be readable by anyone. That's why it's entered in Settings instead of
hard-coded in `config.js`.

Scope requested: `spreadsheets` + `email`. No Drive scope — the spreadsheet is
addressed by id from the link you paste, so this app can't see anything else in
your Drive.

## How it stays compatible with the phone

The phone's sync engine (`lib/features/sync/`) has three invariants. Break any
of them and data goes missing quietly rather than loudly, so all writes here
funnel through a single function — `repo.save()` in `js/repo.js`. No view
touches the Sheets API directly.

| Invariant | Where it's enforced |
|---|---|
| `updated_at` is the Last-Write-Wins key — full ISO-8601 UTC, bumped on every write | `repo.save()` |
| Deletes are soft (`is_deleted = true`); rows are never removed, because removing one shifts every row below it and invalidates the row numbers the phone caches | `repo.remove()` |
| **Every data write appends a matching `_Changelog` row** | `repo.save()` |

That last one is the dangerous one. The phone's incremental pull reads *only*
changelog rows past a saved cursor (`sync_engine.dart:203-241`) and never
rescans data tabs. A data row written without a changelog entry is invisible to
your phone **forever**, and gets silently overwritten by the next edit made
there.

Column order in `js/schema.js` is a hand-port of `sheets_schema.dart`. Rows are
written positionally, so the two must stay identical — **append new columns at
the end only, in both files**. On load, the app compares each tab's real header
against the expected order and shows a warning banner if they've drifted.

## Layout

```
index.html
css/styles.css
js/
  config.js      client id + spreadsheet id (localStorage)
  auth.js        Google Identity Services, token + silent refresh
  sheets.js      Sheets v4 REST wrapper — ranges and values only
  schema.js      port of sheets_schema.dart + field definitions
  repo.js        the only writer: audit stamps, soft delete, changelog
  ui.js          DOM/format helpers, modal, toast
  views/
    dashboard.js overview + charts
    entity.js    generic table/form CRUD, drives all 7 tabs
    settings.js  setup + sheet repair
  app.js         routing and boot
```

Adding a field to an entity is a `schema.js` edit — the table and form both
pick it up automatically. Keep the Dart file in sync.

## Deploying to GitHub Pages

Push this folder and enable Pages. Then add the resulting
`https://<user>.github.io` origin to the OAuth credential's *Authorized
JavaScript origins*, or sign-in will be rejected.

## Before you rely on it

Make a copy of the spreadsheet (**File → Make a copy** in Sheets) before the
first round of edits, and confirm a change made here shows up on the phone
after a sync.
