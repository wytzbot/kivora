// Server-to-server payment confirmation from WyBuild's Flutterwave v4 webhook.
// Configure this endpoint in WyBuild as KIVORA_PAYMENT_CONFIRM_URL.
import { timingSafeEqual } from 'node:crypto';
import { adminDb } from '../functions/server-auth.js';
import { FieldValue } from 'firebase-admin/firestore';

function secretMatches(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const expectedSecret = process.env.WYBUILD_WEBHOOK_SHARED_SECRET || '';
  if (!secretMatches(req.headers['x-wybuild-webhook-secret'], expectedSecret)) {
    return res.status(401).json({ error: 'Unauthorized webhook sender.' });
  }
  try {
    const body = req.body || {};
    const reference = String(body.reference || '').trim();
    const transactionId = String(body.id || '').trim();
    const status = String(body.status || '').toLowerCase();
    const amount = Number(body.amount);
    const currency = String(body.currency || '').toUpperCase();
    if (body.source !== 'wybuild-flutterwave-v4' || !/^KIVORA-[A-Za-z0-9-]+$/i.test(reference) || !transactionId) {
      return res.status(400).json({ error: 'Invalid payment confirmation payload.' });
    }
    // This endpoint only accepts a succeeded charge reported by WyBuild after
    // it fetched the authoritative charge from Flutterwave v4.
    if (status !== 'succeeded' || !Number.isFinite(amount) || amount <= 0 || currency !== 'NGN') {
      return res.status(200).json({ received: true, verified: false });
    }
    const db = adminDb();
    let matches = await db.collection('campaigns').where('paymentReference', '==', reference).limit(1).get();
    // The card form can be retried, so the reference of an earlier (late-confirmed) attempt is looked up too.
    if (matches.empty) matches = await db.collection('campaigns').where('paymentReferences', 'array-contains', reference).limit(1).get();
    if (matches.empty) return res.status(404).json({ error: 'No campaign matches this payment reference.' });
    const doc = matches.docs[0];
    const campaign = doc.data() || {};
    if (Number(campaign.totalBudgetNgn) !== amount || String(campaign.currency || 'NGN').toUpperCase() !== currency) {
      return res.status(409).json({ error: 'Verified charge does not match the campaign amount or currency.' });
    }
    const now = new Date().toISOString();
    // Persist both the campaign state and an auditable payment record in
    // Firestore. The deterministic event ID makes webhook retries idempotent.
    const paymentRef = db.collection('paymentEvents').doc(`flutterwave_${transactionId}`);
    const outcome = await db.runTransaction(async (tx) => {
      const freshCampaign = await tx.get(doc.ref);
      const existingPayment = await tx.get(paymentRef);
      if (!freshCampaign.exists) throw new Error('Campaign disappeared during payment confirmation.');
      const fresh = freshCampaign.data() || {};
      if (fresh.paymentStatus === 'verified' && fresh.paymentTransactionId === transactionId) {
        if (!existingPayment.exists) {
          tx.create(paymentRef, {
            provider: 'flutterwave', providerVersion: 'v4', transactionId,
            reference, campaignId: doc.id, advertiserId: fresh.advertiserId || null,
            amount, currency, status: 'verified', verifiedBy: 'wybuild-webhook',
            createdAt: now,
          });
        }
        return 'alreadyProcessed';
      }
      if (fresh.paymentStatus === 'verified' && fresh.paymentTransactionId && fresh.paymentTransactionId !== transactionId) {
        // A second successful charge for an already-paid campaign. Answer 200 so Flutterwave stops retrying, and flag it for refund.
        tx.update(doc.ref, { duplicatePaymentChargeIds: FieldValue.arrayUnion(transactionId), refundReview: true, updatedAt: now });
        return 'duplicate';
      }
      const knownReference = String(fresh.paymentReference || '') === reference || (Array.isArray(fresh.paymentReferences) && fresh.paymentReferences.includes(reference));
      if (Number(fresh.totalBudgetNgn) !== amount || String(fresh.currency || 'NGN').toUpperCase() !== currency || !knownReference) {
        throw new Error('Verified charge no longer matches the campaign payment details.');
      }
      if (existingPayment.exists) {
        const saved = existingPayment.data() || {};
        if (saved.reference !== reference || saved.campaignId !== doc.id || Number(saved.amount) !== amount || saved.currency !== currency) {
          throw new Error('Transaction ID is already recorded against different payment details.');
        }
      } else {
        tx.create(paymentRef, {
          provider: 'flutterwave', providerVersion: 'v4', transactionId,
          reference, campaignId: doc.id, advertiserId: fresh.advertiserId || null,
          amount, currency, status: 'verified', verifiedBy: 'wybuild-webhook',
          createdAt: now,
        });
      }
      const paid = {
        paymentStatus: 'verified', paymentTransactionId: transactionId, paymentReference: reference,
        paidAmount: amount, paymentVerifiedBy: 'wybuild-flutterwave-v4-webhook',
        paymentVerifiedAt: now, paymentInFlightUntil: 0, updatedAt: now,
      };
      // Paid after the advertiser cancelled: do not serve it, but record that money is owed back.
      if (fresh.status === 'cancelled') tx.update(doc.ref, { ...paid, refundRequired: true });
      else tx.update(doc.ref, { ...paid, status: 'ready' });
      return 'verified';
    });
    return res.status(200).json({ received: true, verified: true, alreadyProcessed: outcome === 'alreadyProcessed', campaignId: doc.id });
  } catch (error) {
    console.error('WyBuild payment confirmation failed:', error?.message || error);
    return res.status(500).json({ error: 'Could not process payment confirmation.' });
  }
}
