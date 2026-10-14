# Kivora PWA setup

Kivora is configured as an installable Progressive Web App (PWA).

## Included
- Web app manifest with standalone display, portrait orientation, theme colors, icons, and shortcuts.
- Service worker for app-shell caching and an offline navigation fallback.
- Static same-origin assets may be cached after first load.
- API routes, authentication routes, and third-party YouTube media are deliberately not cached. This prevents stale account data and avoids trying to cache protected/API responses.
- Service worker registration is enabled in production builds only.
- Android/iOS web-app metadata and install prompt handling.

## Deploy
1. Ensure the site is served over HTTPS (required for service workers outside localhost).
2. Deploy the app normally; `public/manifest.webmanifest`, `public/service-worker.js`, and the icon PNGs are copied to the deployment root by Vite.
3. Run `npm run build` and inspect `dist/manifest.webmanifest` and `dist/service-worker.js`.
4. In Chrome on Android, open the deployed site, then use the browser menu's **Install app** or **Add to Home screen** option. Some browsers only show the install prompt after engagement and will not fire `beforeinstallprompt` on every visit.
5. In Safari on iOS, use Share → **Add to Home Screen**. The browser's install prompt API is not supported there.
6. Test a first online load, a repeat load, an offline navigation, an update deployment, Google sign-in, YouTube playback, and API calls while online.

## Caching policy
YouTube playback, OAuth flows, Firebase account state, and `/api/*` requests must remain network-driven. Offline mode can open the cached app shell, but it cannot guarantee video playback, search, authentication, or campaign actions without a connection. Do not describe Kivora as an offline video downloader.

## Deployment headers
Serve `service-worker.js` as JavaScript and avoid long-lived immutable caching for it so browsers can detect updates. The web server should serve the manifest as `application/manifest+json` (or a compatible JSON MIME type). The app must use HTTPS in production.
