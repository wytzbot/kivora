# Kivora campaign persistence and retention

Campaign records are stored server-side in the Firestore `campaigns` collection, keyed by campaign ID and owned by `advertiserId`. The Ads Studio reads the signed-in user's records from Firestore, so clearing browser/app cache does not erase ongoing or completed campaign records.

## Automatic deletion five days after completion

When the impression endpoint marks a campaign `completed`, it writes:
- `completedAt`: Firestore timestamp for completion
- `expiresAt`: timestamp five days after completion

Enable Firestore TTL for this collection:
1. Open Google Cloud Console → Firestore → Time-to-live (TTL).
2. Create a TTL policy for collection group `campaigns` using field `expiresAt`.
3. Wait for the policy to become active.

Firestore TTL deletion is asynchronous; expiration is scheduled at five days, but actual physical deletion may occur later (commonly within up to 24 hours). It is not an exact-to-the-second deletion guarantee. Campaigns that have not yet reached `completed` are not assigned an expiry and are retained. This policy deletes the campaign document; Firestore does not recursively delete its `impressionEvents` subcollection, so a separate recursive cleanup job is needed if those subcollection records must also be purged.
