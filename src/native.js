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

// True when running as an installed app without Capacitor: a Trusted Web Activity APK or a standalone PWA.
// Popups and normal navigation leave such an app, so sign-in must use the same-window redirect flow there.
export const isAppShell = (() => {
  if (typeof window === "undefined" || isNative) return false;
  try {
    if (sessionStorage.getItem("kivora-app-shell") === "1") return true;
    const standalone = ["standalone", "fullscreen", "minimal-ui"].some(m => window.matchMedia?.(`(display-mode: ${m})`).matches) || window.navigator.standalone === true;
    const fromAndroidApp = String(document.referrer || "").startsWith("android-app://");
    if (standalone || fromAndroidApp) { sessionStorage.setItem("kivora-app-shell", "1"); return true; }
  } catch {}
  return false;
})();
