# Kivora stability and engagement repair report

## Changes in this patch

- YouTube access tokens are no longer treated as permanently available. When absent/expired, the web client starts a Google re-authentication popup requesting YouTube read/write scopes and stores the newly returned access token for the current tab session.
- The server checks the supplied Google access token against the signed-in Firebase user's Google profile before allowing YouTube write actions. This prevents accidentally using a different Google account's access token.
- Watch-page Like and Save actions now call the same YouTube API action endpoint as the Shorts feed rather than toggling local/Firebase-only engagement state.
- Double-tap Like in the Shorts feed now calls the YouTube action path rather than the old local Kivora like implementation.
- The full video player now attempts autoplay consistently with the Shorts player. Browser/player policy can still block audible autoplay.
- Mobile Shorts sizing uses the dynamic viewport and safe-area insets. Metadata is constrained within the active snap page and the rail adapts on short screens.

## Validation performed

- `node --check` passed for `src/firebase.js`, `api/youtube-actions.js`, `api/ad-campaign.js`, `api/ad-impression.js`, and `src/videoDiscovery.js`.
- A complete Vite build could not be verified: `npm install --ignore-scripts --no-audit --no-fund` timed out in this environment. Run `npm install` and `npm run build` in CI or locally before deployment.

## Explicit remaining deployment requirements

- Google OAuth consent screen must be configured and the YouTube scopes approved. Access tokens expire; the user may need to reauthorize. Native Capacitor Google sign-in still needs a platform-specific token refresh path for YouTube scopes.
- YouTube can deny embeds or block autoplay with sound; the app cannot override those platform restrictions.
- Country/city ad targeting is not safe to claim as active until the serving query matches each campaign to a viewer's consented, resolved location. A Google Maps API key is not an OAuth scope; geolocation requires browser permission and geocoding requires a separately configured Maps API key. Until that matching path is implemented and tested, use All locations campaigns only.
- Real end-to-end tests against a test Google account are still required for like, comment, save, and the ad impression/click billing path.
