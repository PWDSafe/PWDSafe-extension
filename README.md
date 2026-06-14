# pwdsafe-extension

A Firefox and Chrome extension for [PWDSafe](https://github.com/PWDSafe/PWDSafe).
Sign in to one or more PWDSafe instances, and the extension will find matching
credentials for the site you're on and let you fill them into the page's
login form.

## How it works

- **Accounts** (server URL + email/password, with optional TOTP) are managed
  from the extension's options page.
- On login, the extension derives the vault key and login hash client-side
  (the same way the PWDSafe web app and `pwdsafe-cli` do — PBKDF2-SHA256,
  600k iterations) and authenticates via `POST /api/auth/login`. Your raw
  password is never sent to the server.
- The Sanctum bearer token and (still-encrypted) vault key material are
  stored in `browser.storage.local`. The **decrypted** RSA private key is
  kept only in `browser.storage.session` (memory, cleared when the browser
  closes).
- For each page you visit, the background script queries
  `GET /api/credentials/search?domain=<hostname>` on every configured
  instance and badges the toolbar icon with the number of matches.
- Clicking a match in the popup fetches `GET /api/credentials/{id}`, decrypts
  it client-side (AES-256-GCM / RSA-OAEP, with legacy RSA-PKCS1v1.5 support),
  and fills the username + password into the page's login form.

## Requirements

- A PWDSafe server, version 3.2 or later.

## Project layout

Firefox and Chrome share a single source tree under `src/`, written against
the `browser.*` WebExtension API. A small build script produces the two
per-browser extensions in `dist/`:

- `manifest.firefox.json` / `manifest.chrome.json` — per-browser manifests
  (background script type, icon formats, `browser_specific_settings`, etc.)
- `build.js` — copies `src/` into `dist/<target>/`, rewrites `browser.*` to
  `chrome.*` for the Chrome build, copies `icons/`, and writes the merged
  `manifest.json` (with the version from `package.json`).

## Building

```
npm install
npm run build          # builds dist/firefox and dist/chrome
npm run build:firefox   # single target
npm run build:chrome    # single target
```

## Loading the extension for development

**Firefox:**

1. Run `npm run build:firefox`.
2. Open `about:debugging` in Firefox.
3. Click **This Firefox** → **Load Temporary Add-on…**.
4. Select `dist/firefox/manifest.json`.
5. Open the extension's options page (toolbar icon → ⚙) and add an account.

**Chrome:**

1. Run `npm run build:chrome`.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select `dist/chrome`.
4. Open the extension's options page (toolbar icon → ⚙) and add an account.

## Linting

```
npm run lint:firefox
```

## Packaging

```
npm run package         # builds artifacts/pwdsafe-firefox-<version>.zip and pwdsafe-chrome-<version>.zip
```

GitHub Actions builds, lints, and packages both extensions on every push and
pull request (see `.github/workflows/build.yml`), and attaches the zips to a
GitHub Release when a `v*` tag is pushed.

## Publishing

**Firefox (AMO):**

1. `npm run package:firefox` (or download `pwdsafe-firefox-*.zip` from a
   tagged release/CI run).
2. Upload the zip at https://addons.mozilla.org/developers/.

**Chrome Web Store:**

1. `npm run package:chrome` (or download `pwdsafe-chrome-*.zip` from a
   tagged release/CI run).
2. Upload the zip in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
   (one-time $5 developer registration if not already done).

To release a new version, bump `"version"` in `package.json`, commit, and
push a `v*` tag — CI will build, package, and attach both zips to the
GitHub Release.
