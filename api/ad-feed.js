import { adminDb, optionalUser } from '../functions/server-auth.js';
import { isWithinFlight } from '../functions/ad-engine.js';

// Public, sanitised list of campaigns that may be shown in the Shorts feed right now.
// The browser can no longer read the campaigns collection directly (it exposed advertiser emails and payment
// references), and every eligibility rule is enforced here, in one place:
//   - paid and verified, approved, asset verified, status "ready"
//   - inside its start/end dates
//   - impressions still remaining
//   - not the viewer's own campaign
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const user = await optionalUser(req);
    const snap = await adminDb().collection('campaigns').where('status', '==', 'ready').limit(60).get();
    const now = new Date();
    const campaigns = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((c) =>
        c.format === 'video' &&
        c.assetSource === 'youtube' &&
        c.moderationStatus === 'approved' &&
        c.assetStatus === 'verified' &&
        c.paymentStatus === 'verified' &&
        Number(c.remainingImpressions ?? c.targetImpressions ?? 1) > 0 &&
        isWithinFlight(c, now) &&
        !(user?.uid && c.advertiserId === user.uid)
      )
      .map((c) => {
        const target = Math.max(1, Number(c.targetImpressions || 1));
        const remaining = Math.max(0, Number(c.remainingImpressions ?? target));
        // Campaigns that are furthest behind their target are shown first; ties are shuffled.
        return { c, behind: remaining / target + Math.random() * 0.05 };
      })
      .sort((a, b) => b.behind - a.behind)
      .slice(0, 24)
      .map(({ c }) => ({
        id: c.id,
        format: 'video',
        assetSource: 'youtube',
        assetId: c.assetId,
        title: c.title || '',
        brand: c.brand || '',
        promotionType: c.promotionType || 'short',
        site: c.promotionType === 'app' ? c.site || '' : '',
        destinationName: c.destinationName || '',
        siteIcon: c.siteIcon || '',
        durationSeconds: Number(c.durationSeconds || 0) || null,
        targetCategories: Array.isArray(c.targetCategories) ? c.targetCategories : ['all'],
        remainingImpressions: Number(c.remainingImpressions ?? c.targetImpressions ?? 0),
      }));
    return res.status(200).json({ campaigns });
  } catch (e) {
    // Ads are optional: a failure here must never break the organic feed.
    console.error('ad-feed failed:', e?.message || e);
    return res.status(200).json({ campaigns: [] });
  }
}
