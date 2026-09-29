# Kivora Android build layer

This package keeps Kivora's existing React/Vite framework. No React/Vite source was replaced with Kotlin/Compose.

The Android layer uses Capacitor as a native runtime. Capacitor officially supports adding Android to an existing web project and syncing the built web assets into the native Android project.

## Build locally

```bash
npm install
npm run build
npm run android:setup
npm run android:sync
node scripts/prepare-android.mjs
cd android
./gradlew assembleRelease
```

The APK will be at:

`android/app/build/outputs/apk/release/app-release.apk`

## GitHub

Push the project to GitHub and run **Actions → Build Kivora APK → Run workflow**. The workflow builds the existing React/Vite app first, then creates/syncs the Android project and produces the release APK as an Actions artifact.

The web app remains the source of the UI and features. Android-specific behavior is provided by the native Capacitor shell; the app is not a remote website wrapper because the compiled `dist` assets are bundled into the APK.
