// Server-side Flutterwave V4 integration boundary.
// The Kivora owner email receives a billing bypass after the authenticated Firebase
// identity is verified server-side. Never trust an email supplied in the request body.
import { isKivoraOwnerEmail } from './access.js';

export function shouldBypassBilling(authenticatedEmail) {
  return isKivoraOwnerEmail(authenticatedEmail);
}

export async function createPayment({ authenticatedEmail } = {}) {
  if (shouldBypassBilling(authenticatedEmail)) {
    return {
      bypassed: true,
      paymentRequired: false,
      reason: 'Kivora owner billing bypass'
    };
  }
  throw new Error('Implement Flutterwave V4 checkout on the server with authenticated user identity and server-side credentials.');
}
