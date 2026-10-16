# Google login that stays inside the APK

Kivora picks the sign-in method from how the app is running (src/native.js, src/firebase.js):

| Running as | Sign-in | Leaves the app? |
| --- | --- | --- |
| Capacitor APK (`npm run android:*`, android-apk.yml) | Native Google account sheet via `@capacitor-firebase/authentication`; YouTube scopes requested in the same sheet | No |
| TWA APK (WyBuild "Web to Android") or installed PWA | Same-window redirect; Firebase auth handler is served from the app's own domain through the `/__/auth` rewrite in vercel.json | Only a brief Google sheet, then returns to the app |
| Normal browser | Popup (unchanged) | n/a |

A plain WebView wrapper cannot do Google sign-in at all (Google blocks embedded WebViews). Use Capacitor or TWA.

## One-time setup

### Capacitor
1. Firebase console > Project settings > add Android app `com.kivora.app`; add SHA-1 of the debug AND release keys.
2. Authentication > Sign-in method: Google enabled.
3. Download google-services.json, store its full contents in the GitHub secret `GOOGLE_SERVICES_JSON`, rebuild.

### TWA / PWA
1. Deploy this build so the `/__/auth/*` rewrite is live.
2. Google Cloud Console > APIs & Services > Credentials > the "Web client (auto created by Google Service)" OAuth client:
   add `https://kivora-ecru.vercel.app/__/auth/handler` to Authorized redirect URIs (use your real domain).
3. Firebase console > Authentication > Settings > Authorized domains: add your domain.
4. WyBuild link rules: set `accounts.google.com` to Internal.
