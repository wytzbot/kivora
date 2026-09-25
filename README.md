# Kivora

Kivora is a mobile-first independent entertainment discovery web app. It is intentionally **not a YouTube clone**.

## Current safeguards and flows

- Google authentication uses popup-first sign-in with automatic redirect fallback.
- Anonymous watch-first access remains available; Google can be connected later.
- Redirect results are processed after returning to Kivora.
- Videos use the official YouTube IFrame Player API.
- A video automatically starts muted when roughly 55% of its player reaches the viewport and pauses when it leaves the viewing area.
- Kivora supplies its own mute/unmute and captions controls around the player.
- Comments are disabled to reduce Firestore storage/read/write costs.
- Kivora actions are separate from YouTube engagement: Like, Save and Share belong to Kivora.

## Notifications: one alert per 10 eligible new videos

Kivora does **not** notify a user for every new movie/video. The intended server-side flow is:

1. A trusted catalog process adds an eligible new video.
2. The user's pending counter increases by one.
3. Nothing is sent while the counter is below 10.
4. At 10 or more, the trusted backend sends one FCM notification and subtracts exactly 10 from the pending counter.
5. Any remaining eligible videos stay pending for the next batch.

`functions/notification-policy.js` contains the deterministic batch policy. The browser must not be trusted to increment, clear, or consume the pending counter; those operations belong on the server.

Web push requires HTTPS, browser support, Firebase Messaging configuration and explicit user permission. A web page cannot silently grant notification permission.

## Chinese and Bollywood discovery

Kivora uses originality ratings as a recommendation signal rather than a hard trusted-channel ban. Unreviewed creators are not banned. Videos can remain searchable while low-confidence or low-originality signals reduce recommendation exposure. Spam-pattern filtering still protects recommendation surfaces.

Do not describe a creator as "official" or "authorized" merely because a search result exists. Kivora should only make that designation after a separate rights/creator review.

## Pro translated captions

Translated captions are a **Kivora Pro** feature. The UI keeps the caption/translation control visible but locked for Free users. Pro users can select supported language codes and Kivora requests the selected caption track through the official YouTube IFrame Player API. YouTube supports `cc_load_policy`, `cc_lang_pref`, and caption-track controls in embedded players. citeturn0search1turn0search2

Important limitation: the official embedded player does not expose arbitrary third-party YouTube caption text to Kivora for client-side retranslating. Therefore Kivora should not pretend that it is extracting YouTube captions and sending them to Google Cloud Translation. The current implementation uses the source player's available translated caption tracks. If Google Cloud Translation is added later, it must be done server-side with an authorized caption-text source and the required Google attribution/markup rules. Google requires clear attribution when its Cloud Translation output is displayed directly to users. citeturn0search0turn0search5

The Pro entitlement is checked from a server-issued Firebase Auth custom claim (`pro=true` or `plan=pro`). The frontend must not use a localStorage or client-only "premium" flag as proof of payment.

## Advertising: pre-bill calculation and monitoring

Before payment, Kivora performs a preflight check for:

- supported asset format;
- destination URL;
- prohibited political/adult terms;
- positive target impression count (minimum 1,500);
- duration limits;
- required brand/title information.

Supported assets:

- **Square banner:** Google Drive file ID or permitted public image URL.
- **Rectangle banner:** Google Drive file ID or permitted public image URL.
- **Video:** Google Drive file ID or YouTube URL.

A Drive file ID alone is not proof that the browser can access the file. The server should verify the file's MIME type, access and download/view capability before activation. Google Drive permissions determine who can read a file, and Drive exposes capabilities that should be checked rather than assuming access. citeturn0search0turn0search4

The UI shows an estimated bill **before** payment. The current rate is **$1.99 per 1,500 impressions**. Target impressions are rounded up to whole 1,500-impression billing blocks, so the server and browser preview use the same deterministic calculation. The server must calculate the amount again, then validate currency, reference, asset status, moderation status and campaign status before creating/accepting a charge.

`functions/ad-engine.js` contains the server-authoritative calculation helpers for:

- impression-based billing at **$1.99 per 1,500 impressions**;
- activation gating;
- impression/click/spend monitoring;
- CTR and remaining-budget calculation;
- automatic impression-target monitoring state.

The browser must never be the source of truth for billing, spend, impressions, clicks or Pro entitlement.

## Drive assets

Google Drive supports sharing by file ID and ACL/permission roles. For binary files such as images and videos, the Drive API can download content when the requesting principal has appropriate access; `webContentLink` may also be available for browser downloads. citeturn0search3turn0search4

For production advertising, prefer a server-side asset validation step rather than blindly embedding arbitrary Drive URLs. This prevents broken assets and reduces the chance of billing a campaign that cannot actually render.

## Creator/source policy

Kivora should store YouTube video IDs and permitted metadata, not audiovisual files. The official YouTube embedded player supplies the stream. Do not download, proxy, strip attribution from or re-host YouTube videos.

Kivora's creator policy explains this distinction so creators can see that Kivora is a discovery/embed product rather than claiming ownership of third-party videos.

## Pro and payments

The production flow should be:

1. create a checkout session on the server;
2. calculate the bill server-side;
3. send the user to Flutterwave;
4. verify the transaction server-side;
5. validate amount, currency and reference;
6. process signed webhooks idempotently;
7. grant a server-side Pro entitlement or activate the campaign;
8. expose the verified state to the client.

Never put a Flutterwave secret key in the frontend and never treat a client-side success screen as proof of payment.

## Anti-clash / reliability rules

- Disable duplicate submits while an async operation is running.
- Never charge from a client-side calculated amount.
- Never let the browser increment the notification batch counter.
- Never publish an arbitrary YouTube search result directly to the feed.
- Do not mix Kivora likes/saves with YouTube likes/views.
- Validate Drive/YouTube assets before campaign activation.
- Keep ad monitoring and billing state separate from viewer engagement state.
- Treat missing/invalid third-party media as a recoverable campaign/video state rather than allowing a player or ad component to crash the app.

## Build

```bash
npm install
npm run build
```

The project is React + Vite and can be deployed to Vercel or another static/Node-compatible host, with Firebase used for authentication/data.

## Originality rating security

- Ratings are 1–5 and represent perceived originality only.
- One rating is allowed per authenticated Google account per video.
- The rating is stored under `videos/{videoId}/ratings/{uid}` and the aggregate is updated in the same Firestore transaction.
- Firestore rules reject direct aggregate manipulation and reject standalone rating-document creation.
- Clearing local storage does not allow a second rating because the server-side rating document remains authoritative.
- A video is not deleted because of a low rating. Once enough ratings exist, low originality reduces recommendation exposure through `canRecommend()`.
- The recommendation threshold uses a neutral prior so a single early rating does not immediately bury a new video. The current demo feed also applies the same policy client-side; a production deployment should call a Vercel/API route backed by Firebase Admin for the final FYP/search ranking rather than trusting a browser-calculated ranking.


## Kivora owner billing bypass

The authenticated account `ilemobayotolulope11092003@gmail.com` is hard-coded as the Kivora owner account. When the authenticated Firebase email matches this address, Kivora Pro and advertising billing are treated as free.

This does **not** bypass campaign validation, asset checks, moderation, impression monitoring, notification rules, or Firestore security. The server must derive the email from the authenticated Firebase identity and must never trust an email supplied by the browser. Flutterwave is skipped for this account because no payment is due.

The owner email is intentionally present in the application source because this is an explicit owner-only development/business entitlement. If the project becomes open-source, move the entitlement to a server-side custom claim or private server configuration before publishing the repository.


## Deep-check status

An earlier maintenance pass fixed several flow-level issues: enabling notifications no longer clears the server-owned pending-video counter; client rules no longer allow users to write `pendingNewVideos`; originality ratings are checked against the authenticated Google account instead of localStorage; discovery scoring accepts both object and numeric inputs consistently; the owner billing bypass is accepted by the activation helper; and navigation uses standard scroll behavior.

A follow-up line-by-line pass found and fixed:

- **Autoplay race condition:** a video already in view when the page loaded could fail to autoplay, because the IntersectionObserver could fire before the YouTube player finished initializing, and nothing re-checked visibility once the player became ready. The visibility state and the "player ready" state are now tracked independently and re-applied whenever either one changes, so a card that's already on screen plays as soon as its player is ready instead of only after the user scrolls it out and back in.
- **Search hid legitimate results:** the search box reused the home-feed recommendation filter, which also hides videos below the low-confidence originality threshold. That meant a video could be un-findable by exact title search even though the design intent (see "Chinese and Bollywood discovery" above) is that only spam should be excluded from search, while originality only affects default/FYP ranking. Search now filters spam only; the originality threshold is applied solely to the default (no-query) feed.
- **`.env.example` was malformed:** the file contained literal `\n` escape sequences instead of real line breaks, so it rendered as one broken line instead of separate comments/variables.
- **Missing notification/app icons:** `firebase-messaging-sw.js` and the page referenced icon files that didn't exist in `public/`, which would 404 and show a blank/default icon. Placeholder `icon-192.png` and `icon-512.png` were added and wired up via `<link rel="icon">`/`<link rel="apple-touch-icon">` in `index.html`; swap these for real branded artwork before launch.
- **Unmounted-component update on Premium checkout:** the demo checkout's `setTimeout` could fire after a user navigated away from the Pro screen. It now checks the component is still mounted before updating state.

The project was statically checked with Node's JavaScript parser for all `.js` modules, plus a manual line-by-line read of every file and a bracket/paren balance check on the JSX. A complete Vite build could not be executed in this environment because npm registry access is blocked here; run `npm install && npm run build` in your own environment before release to catch anything a static read can't (e.g. actual JSX transform errors).

## Live YouTube discovery setup

Kivora now loads live video discovery through the Vercel serverless endpoint `GET /api/youtube-search`, which calls YouTube Data API v3. The browser then plays returned video IDs with the official YouTube IFrame Player API. YouTube's `search.list` supports `type=video` and returns the video ID plus snippet metadata; the embedded player handles playback.

### Required environment variable

Set this on the deployment platform (for example Vercel), not in `src/` and not in a `VITE_` variable:

`YOUTUBE_API_KEY=...`

The API key must have **YouTube Data API v3** enabled. Because the request is made by the serverless function, do not use an HTTP-referrer restriction intended for a browser key. Keep the key restricted to **YouTube Data API v3**; do not expose it in the client bundle. If you use a Vercel serverless backend without a fixed outbound IP, IP-address restriction is generally not practical.

The IFrame Player API does **not** require a separate API key.

The endpoint filters discovery to embeddable/syndicated videos and returns normalized metadata for Kivora. Search requests from the Kivora search box are debounced and sent to the same endpoint.

## Kivora UI refresh

- No promotional hero block on the FYP; the feed starts with a compact discovery header.
- Larger typography, pill-shaped controls, card-based movie-app styling, light/dark/system themes.
- Collapsible menu sections for personalization, FAQs, legal pages and YouTube.
- Legal information is collapsed below the FYP.
- Videos expose secondary metadata inside an expandable “About this video” section.
- Native-style actions include installable PWA support where the browser exposes the install prompt, device share, fullscreen playback and direct “Watch on YouTube” links.
- Approved sponsored campaigns can appear in the FYP with a visible Sponsored label.
- Banner/image advertising is $1.99 per 1,500 impressions; video advertising is $2.99 per 1,500 impressions.


## Action-movie discovery update
Kivora's FYP is action-movie focused across multiple industries: Suggested, All, New, Hollywood, Bollywood, Chinese, Korean, Japanese, Nollywood, South Indian, Thai, and Indonesian. Discovery queries are action-oriented and the server/client filters exclude recap, explained, summary, review, reaction, trailer/teaser, Shorts, fan-edit and similar non-movie results. YouTube remains the playback source through the official embedded player.

## FYP filtering and presentation update

Kivora now uses a thumbnail-first movie-feed presentation: the FYP shows the source thumbnail, duration, title, channel, views/date and compact actions. A viewer taps the thumbnail to open the official YouTube player.

Discovery is stricter for the action-movie feed. YouTube search requests use the long-duration filter and Kivora applies a 40-minute minimum, action/movie signals, and exclusion rules for recaps, explained videos, reviews, reactions, trailers, Shorts, clips, vlogs, music and other non-movie formats. General All/Suggested/New discovery also excludes common Indian-industry terms so those results are primarily reached through their dedicated categories; Bollywood, South Indian and other industry tabs remain available.

Subtitles can be toggled on/off after playback starts. Pro users can choose a subtitle language when the source video exposes captions. This uses the official YouTube player; caption/language availability is controlled by the source video and YouTube.

## YouTube-style watch page

Tapping a FYP video opens a dedicated watch page with the official YouTube player, compact actions, related action movies and clearly labelled sponsored placements between related videos. Comments remain on YouTube.
