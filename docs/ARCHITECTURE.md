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

Ad billing is server-authoritative at $1.99 per 1,500 impressions. The requested target is rounded up to whole 1,500-impression blocks. Delivered spend is calculated from server-recorded impressions rather than accepting a client-supplied spend amount. Clicks are capped at impressions and cannot reduce or increase the bill.
