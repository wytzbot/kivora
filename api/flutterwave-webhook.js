// Flutterwave transaction webhook for Kivora advertiser campaigns.
// Configure this endpoint in Flutterwave: https://YOUR-KIVORA-DOMAIN/api/flutterwave-webhook
// The webhook is only a notification: the transaction is always re-verified server-side.
import { timingSafeEqual } from 'node:crypto';
import { adminDb } from '../functions/server-auth.js';
import { verifyHostedPayment } from '../functions/flutterwave.js';

function validHash(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const expectedHash = process.env.FLW_WEBHOOK_SECRET_HASH || process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
  const receivedHash = req.headers['verif-hash'];
  if (!validHash(receivedHash, expectedHash)) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  try {
    const event = req.body || {};
    const data = event.data || {};
    const transactionId = String(data.id || '').trim();
    const txRef = String(data.tx_ref || '').trim();
    if (!transactionId || !txRef) {
      // Acknowledge unrelated event types; they do not represent a verifiable transaction.
      return res.status(200).json({ received: true, ignored: true });
    }

    const db = adminDb();
    const matches = await db.collection('campaigns').where('paymentReference', '==', txRef).limit(1).get();
    if (matches.empty) {
      // Unknown references must never activate a campaign.
      return res.status(200).json({ received: true, ignored: true });
    }

    const campaignDoc = matches.docs[0];
    const campaign = campaignDoc.data() || {};
    if (campaign.status === 'cancelled') {
      return res.status(200).json({ received: true, ignored: true, cancelled: true });
    }
    if (campaign.paymentStatus === 'verified' && campaign.paymentTransactionId) {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    const verification = await verifyHostedPayment({
      transactionId,
      expectedReference: campaign.paymentReference,
      expectedAmount: campaign.totalBudgetNgn,
      expectedCurrency: 'NGN',
    });

    if (!verification.success) {
      // Non-successful/pending transactions are acknowledged but do not change campaign state.
      return res.status(200).json({ received: true, verified: false, status: verification.status || 'pending' });
    }

    await campaignDoc.ref.update({
      paymentStatus: 'verified',
      status: 'ready',
      paymentTransactionId: transactionId,
      paidAmount: verification.amount,
      paymentVerifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({ received: true, verified: true, campaignId: campaignDoc.id });
  } catch (error) {
    // Non-2xx response asks Flutterwave to retry transient failures.
    console.error('Kivora Flutterwave webhook failed:', error?.message || error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
}
