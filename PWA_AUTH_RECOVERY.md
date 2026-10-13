# PWA startup and Google OAuth recovery

This patch addresses a stale service-worker bundle as one plausible cause of the blank screen. It does not assume Google OAuth is the root cause: Firebase auth failures should be handled as sign-in state/errors, while a completely blank shell commonly indicates a startup exception or stale/broken JS asset.

## Changes
- Service-worker cache version bumped to v2 so old Kivora caches are removed on activation.
- Navigation remains network-first; JS and CSS are now network-first with cached offline fallback, preventing old app code from overriding a new deployment while online.
- Service-worker installation caches shell assets individually so an optional/missing icon does not abort the whole install.
- Added a React error boundary with Reload and Reset offline cache actions. Reset unregisters service workers and clears only Kivora PWA caches; it does not delete Google accounts or Firebase user records.

## Deployment checks
1. Deploy the full new build to HTTPS.
2. If still blank, open DevTools remote inspection and check the first red console error and failed network request.
3. Confirm the deployed Google OAuth authorized domains include the exact host (including staging/production domains) in Firebase Authentication.
4. Confirm the OAuth client and consent-screen scopes are configured. Firebase Google sign-in does not by itself guarantee YouTube API access tokens/scopes.
5. Test a returning signed-in user and a fresh browser profile.
