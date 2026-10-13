# Kivora Shorts upgrade notes

## Implemented
- Home feed is a dedicated, vertically scrolling Shorts viewport with snap-to-item behavior, fixed card sizing, and a responsive desktop viewing column.
- Home feed explanatory long-form sections were removed from the feed view to reduce accidental transitions away from Shorts.
- YouTube like/comment buttons open the original YouTube Short; view/like/comment totals are sourced from YouTube API responses and rendered as display-only values. Kivora does not write those totals to Firestore.
- Discovery uses one YouTube `search.list` request per feed page and a single batched `videos.list` request for format/statistics. Responses use shared cache headers to reduce repeated quota consumption.
- Category results are filtered by category terms after discovery.
- Advertisers must provide a YouTube URL for an already-published, embeddable vertical/square video of 180 seconds or less. Google Drive videos are no longer accepted for new campaigns.
- Sponsored placements appear in the same Shorts feed with a Sponsored label and a clickable destination banner. Clicks are recorded separately from viewable impressions and YouTube engagement.
- Advertiser instructions explain publishing, eligibility checks, pricing, delivery tracking, and the distinction between Kivora placement and YouTube Ads.

## Configuration
Keep `YOUTUBE_API_KEY` on the server only. Do not expose it as a `VITE_*` variable. The frontend uses `/api/youtube-search`; server responses have cache headers. Firebase Admin and Flutterwave secrets remain server-side as documented in `.env.example`.

## Validation note
The API JavaScript files were checked with `node --check`. A full Vite production build could not be run in this environment because npm dependency installation timed out; run `npm install` and `npm run build` locally/CI before deploying.
