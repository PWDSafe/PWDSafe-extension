# pwdsafe-firefox-extension

A Firefox extension for [PWDSafe](https://github.com/PWDSafe/PWDSafe). Sign in
to one or more PWDSafe instances, and the extension will find matching
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

## Loading the extension for development

1. Open `about:debugging` in Firefox.
2. Click **This Firefox** → **Load Temporary Add-on…**.
3. Select `manifest.json` from this directory.
4. Open the extension's options page (toolbar icon → ⚙) and add an account.

## Linting

```
npx web-ext lint
```
