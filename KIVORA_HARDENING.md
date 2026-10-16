# Kivora hardening pass: feed repeats, ads, payment, login

## 1. Videos no longer repeat after refresh or restart
Causes found:
- A video only counted as "seen" after 1.5 s on screen, so Shorts you scrolled past quickly came back.
- `markSeen` re-parsed and rewrote a 10,000-entry list on every Short (slow scrolling) and lost entries when the app was killed.
- The feed hid watched videos *at render time*, so the card you just watched vanished and the list shifted under you.
- YouTube returns the same results for the same search phrase, so every launch started from the same pool.

Fixes (`src/main.jsx`, `api/youtube-search.js`):
- Seen at 0.6 s on screen, watched (history) at 1.5 s.
- Seen list lives in memory, saved in batches and always on `pagehide` / app hidden; merged across tabs.
- The feed filters against a snapshot taken at launch, refresh and category/search change. Cards you watched stay put while you scroll, and are excluded next time.
- `variant` parameter rotates the category's search phrase on every launch/refresh (same quota cost), so each fresh feed starts from a different pool.
- Auto-fetch of extra pages when most of a page was already seen raised from 3 to 6.

## 2. Ads
- New `api/ad-feed.js`: the server decides which campaigns may show (paid, approved, verified, inside start/end dates, impressions remaining, not your own) and returns only safe fields. Campaigns furthest behind target are served first.
- `firestore.rules`: the public can no longer read campaign documents (they contained advertiser emails and payment references). Advertisers still read their own. **Deploy the rules.**
- Campaigns were previously served before their start date and after their end date; both are now enforced in the feed and the impression endpoint.
- Impressions: one billable impression per viewer per campaign per 6 hours, decided on the server from the verified user (or device id). A refresh, restart or re-mounted card cannot bill twice. Ad cards keep a stable key so they are not re-mounted when the list changes.
- Clicks: a double tap within a minute counts once.

## 3. Payment (card only, Flutterwave v4)
- Campaign creation is serialised with a per-user lock document inside a transaction. Double taps, retries and slow networks return the same campaign instead of creating more `pending_payment` copies, and two requests can no longer cancel each other.
- Only one payment attempt can be in flight; attempts are counted before the card is charged; bad card numbers are rejected without using an attempt.
- Each attempt has its own reference and a stable `X-Idempotency-Key`, so a network retry cannot create a second charge.
- Every charge started for a campaign is remembered and checked, so a bank that confirms an earlier attempt late still activates the campaign (also in the WyBuild webhook).
- Activation happens inside a transaction. A charge that succeeds after the advertiser cancelled never serves, and the campaign is flagged `refundRequired`. A second successful charge is flagged `refundReview`.
- The bank return URL is never the app's own `https://localhost` address; set `KIVORA_PAYMENT_REDIRECT_URL`.
- The card screen checks payment status by itself after a bank redirect or "pending" answer, and again when you return to the app.
- Editing the campaign after the review step no longer pays for the old campaign.
- PIN/OTP attempts are limited; amount check tolerates decimals.

## 4. Login
- One Google sign-in at a time (double taps used to fall through to a full-page redirect).
- Closing the Google window is a quiet cancel, not an error toast.
- Redirect retry guarded so a persistent account conflict cannot loop.
- The YouTube access token now survives an app restart (50-minute expiry) instead of forcing a second consent prompt.
- Clear message when the Android SHA-1 / `google-services.json` is missing.

## Deploy checklist
1. Deploy `firestore.rules`.
2. Set `KIVORA_PAYMENT_REDIRECT_URL` (and optionally `KIVORA_TZ_OFFSET_HOURS`) in Vercel.
3. `npm install && npm run build` (could not be run where this was prepared; the code was syntax-checked only).
4. Test with a Flutterwave test card: success, wrong PIN, OTP, 3-D Secure redirect, double tap on Pay, cancel mid-payment.
