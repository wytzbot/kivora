# Kivora payment verification through WyBuild's Flutterwave v4 webhook

Configure Flutterwave to deliver payment webhooks to WyBuild:

`https://wybuild-black.vercel.app/api/billing/webhook`

WyBuild validates the Flutterwave webhook signature, retrieves the authoritative charge directly from Flutterwave v4, and forwards Kivora charge confirmations to this Kivora endpoint:

`https://YOUR-KIVORA-DOMAIN/api/wybuild-payment-confirmation`

Configure `KIVORA_PAYMENT_CONFIRM_URL` and `KIVORA_WEBHOOK_SHARED_SECRET` in WyBuild. Configure the exact same shared secret in Kivora as `WYBUILD_WEBHOOK_SHARED_SECRET`. These are server-side environment variables only.

Kivora compares the transaction reference, succeeded status, exact NGN amount, and currency against the campaign saved in Firestore before activating it. The authenticated client-side verification route remains available as a fallback. Do not configure `/api/flutterwave-webhook` as the Flutterwave dashboard destination for this flow; WyBuild owns webhook signature verification and v4 charge retrieval.
