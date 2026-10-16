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

// Detect TWA or installed PWA — both need the same-window redirect flow because
// window.open() opens Chrome OUTSIDE the app and never returns.
// We persist the flag in sessionStorage so it survives the auth redirect round-trip.
export const isAppShell = (() => {
  if (typeof window === "undefined" || isNative) return false;
  try {
    if (sessionStorage.getItem("kivora-app-shell") === "1") return true;
    // TWA sets an android-app:// referrer on the very first load
    const fromTWA = String(document.referrer || "").startsWith("android-app://");
    // Both TWA and installed PWA match standalone/fullscreen display-mode
    const isStandalone = ["standalone", "fullscreen", "minimal-ui"].some(
      m => window.matchMedia?.(`(display-mode: ${m})`).matches
    ) || window.navigator.standalone === true;
    if (fromTWA || isStandalone) {
      sessionStorage.setItem("kivora-app-shell", "1");
      return true;
    }
  } catch {}
  return false;
})();
