import { Capacitor } from "@capacitor/core";

// True only inside the Android (Capacitor) shell, never in a normal browser.
export const isNative = Capacitor.isNativePlatform();

// The APK bundles only the static web build, so "/api/..." has no server behind it.
// Point native builds at the deployed Vercel site (override with VITE_API_BASE_URL at build time).
const API_BASE = String(import.meta.env.VITE_API_BASE_URL || (isNative ? "https://kivora-ecru.vercel.app" : "")).replace(/\/$/, "");
export const apiUrl = (path) => `${API_BASE}${path}`;

// Public https origin used for share links and the YouTube player "origin" param.
// Inside the APK window.location.origin is https://localhost, which is useless to
// other people and is rejected by the YouTube embed.
export function publicOrigin() {
  if (!isNative) return window.location.origin;
  return String(import.meta.env.VITE_PUBLIC_URL || API_BASE || window.location.origin).replace(/\/$/, "");
}

// Navigating the WebView away to a payment page would strand the user outside the app.
export async function openExternal(url) {
  if (isNative) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } else {
    window.location.href = url;
  }
}

// True only for an installed PWA on iOS (navigator.standalone) where popups are blocked.
// TWA APKs run inside real Chrome and handle popups fine, so they are NOT treated as app shells.
// A TWA is identified by an android-app:// referrer.
export const isAppShell = (() => {
  if (typeof window === "undefined" || isNative) return false;
  try {
    const fromAndroidApp = String(document.referrer || "").startsWith("android-app://");
    if (fromAndroidApp) return false; // TWA: use popup, not redirect
    // iOS standalone PWA: popups open Safari and lose the session
    if (window.navigator.standalone === true) return true;
  } catch {}
  return false;
})();
