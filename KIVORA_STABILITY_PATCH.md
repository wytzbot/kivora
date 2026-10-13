# Kivora stability patch

This patch addresses several concrete problems from the reported mobile experience:

- YouTube iframe players are created only when a Short approaches the viewport, rather than initializing every iframe as soon as the feed renders. This reduces network and CPU contention during scrolling.
- YouTube player error codes now produce actionable in-app messages (including disabled embedding and invalid embed origin cases).
- Likes, comments and saves in the Shorts rail now use the server-side `/api/youtube-actions` endpoint. Comment reading and posting use YouTube's API; comment text is not persisted in Kivora's database. These write actions require a signed-in Google account, a valid Firebase ID token, and an OAuth access token with YouTube scopes. Expired/missing grants must be re-authorized.
- The comment panel stays inside Kivora. Share still uses the platform share sheet or clipboard; it does not force-open the YouTube app.
- Campaign placement in the organic Shorts feed is changed to one sponsored card after each eight organic videos.
- The ad campaign document now stores the advertiser's selected target-location mode and target region for subsequent delivery matching.
- Added in-app comments panel styling and tightened bottom metadata overflow so descriptions cannot push the card into the next viewport.

## Deployment and verification notes

1. Configure Firebase Authentication's Google provider and authorized domains.
2. Ensure `YOUTUBE_API_KEY` and Firebase Admin service-account environment variables are configured server-side on Vercel.
3. Verify the Google OAuth consent screen and scopes (`youtube.force-ssl`, `youtube.readonly`) are approved for the app. Firebase Google sign-in alone does not guarantee an access token for YouTube API writes.
4. The YouTube IFrame Player can still refuse playback for private, age-restricted, region-restricted, removed, or non-embeddable videos. Kivora cannot override those restrictions.
5. Location target mode is persisted on campaigns, but production delivery must still compare the viewer's explicitly consented approximate location against campaign targeting before serving an ad. A Google Maps OAuth scope is not the permission mechanism for browser geolocation; browser geolocation permission and a properly secured Maps/Geocoding API integration are separate concerns.
6. Build verification was not completed in this environment because npm dependencies could not be installed (network/package registry unavailable). Run `npm install` and `npm run build` before deploying.
