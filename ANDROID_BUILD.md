# Kivora Android build layer

Kivora stays a React/Vite app. Capacitor wraps the built `dist/` files in a native Android shell.

## One-time setup

1. **Deploy the web app to Vercel first.** The APK contains only static files; video search, ads and
   payments call your Vercel `/api/*` routes. Note the deployed URL.
2. **Firebase Google sign-in on Android** (popup sign-in does not work in a WebView):
   - Firebase console → Project settings → add an Android app with package `com.kivora.app`.
   - Add the SHA-1 of your signing key (debug and release) and enable Google sign-in.
   - Download `google-services.json`.
3. **Signing key (for an installable release APK):**
   `keytool -genkey -v -keystore release.keystore -alias kivora -keyalg RSA -keysize 2048 -validity 10000`
   then `base64 -w0 release.keystore`.

## GitHub Actions secrets (Settings → Secrets and variables → Actions)

| Secret | Required | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | yes | Deployed Vercel URL, e.g. `https://kivora.vercel.app` |
| `VITE_PUBLIC_URL` | no | Share-link URL (defaults to the API URL) |
| `VITE_FLUTTERWAVE_PUBLIC_KEY` | no | Flutterwave public key |
| `GOOGLE_SERVICES_JSON` | for Google login | Full contents of `google-services.json` |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | for release APK | Without these the workflow builds a debug APK, which is still installable |

Run **Actions → Build Kivora APK → Run workflow**, then download the `kivora-apk` artifact.

## Build locally

```bash
npm install
VITE_API_BASE_URL=https://your-app.vercel.app npm run build
npm run android:setup
cp /path/to/google-services.json android/app/
npx cap sync android
npm run android:prepare
cd android && ./gradlew assembleDebug   # APK: app/build/outputs/apk/debug/app-debug.apk
```

Requires Node 22+, Java 21, Android SDK 36.

## Known limits

- Push notifications (web service worker) are disabled in the APK; native push needs
  `@capacitor/push-notifications` and FCM setup.
- After the Flutterwave payment the user returns via the website, then reopens the app.
