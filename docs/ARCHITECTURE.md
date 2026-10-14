# Production architecture

Browser -> Firebase Auth -> Firestore
Browser -> backend -> YouTube Data API
Browser -> backend -> Flutterwave V4
Browser -> Google Cloud Translation through a protected backend
Browser -> YouTube official player

## Never
- Put Flutterwave secret keys in frontend code.
- Download/proxy YouTube videos or audio.
- Represent in-app ad impressions as YouTube views.
- Give sponsored YouTube content fake engagement controls.

## Sponsored long-form card
Show: SPONSORED label, brand, title, description, video/player, website link.
Do not add view/download/share/like/comment/subscribe buttons to the sponsored card.

## Translation
Premium gets unlimited long-form subtitle translation. Translate accessible/authorized subtitle text only. Cache translations by video/source-language/target-language/content-version to reduce costs.


## Impression billing

Ad billing is server-authoritative at $1.00 per up to 4,500 impressions. The requested target is rounded up to whole 4,500-impression blocks. Delivered spend is calculated from server-recorded impressions rather than accepting a client-supplied spend amount. Clicks are capped at impressions and cannot reduce or increase the bill.


## Shorts-only feed and engagement boundary

- The feed renders only eligible square/vertical YouTube Shorts and uses viewport-sized snap cards. The embedded YouTube player remains the playback source; Kivora does not download or re-host video.
- Views, likes and comments shown in Kivora are read from YouTube Data API responses. They are display-only and must not be written to Firestore or Kivora campaign documents. Like/comment actions open YouTube so the viewer engages with the source platform.
- Discovery uses one `search.list` request per feed request, followed by a batched `videos.list` lookup, and cache headers reduce repeat quota consumption.
- Advertiser assets must already exist on YouTube and pass server-side Shorts/embedding checks. App/site banners are clickable; click counters are kept separate from viewable-impression billing.
