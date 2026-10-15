// Flutterwave v4 hosted checkout + server-side transaction verification.
// Client credentials are server-only. Never expose them through VITE_ variables.
import { isKivoraOwnerEmail } from './access.js';

const API_BASE = process.env.FLW_API_BASE_URL || 'https://api.flutterwave.com/v4';
const TOKEN_URL = process.env.FLW_TOKEN_URL || 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
let cachedToken = '';
let tokenExpiresAt = 0;

function credentials() {
  const clientId = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('FLW_CLIENT_ID and FLW_CLIENT_SECRET must be configured for Flutterwave v4.');
  }
  return { clientId, clientSecret };
}

async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    console.error('Flutterwave v4 token request failed:', response.status, data?.error || data?.message || '');
    throw new Error('Could not authenticate with Flutterwave v4. Check the v4 Client ID and Client Secret.');
  }
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 300)) * 1000;
  return cachedToken;
}

async function apiRequest(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw flwError('v4', path, response.status, data);
  return data;
}

function flwDetail(data) {
  const e = data?.error;
  const parts = [data?.message, typeof e === 'string' ? e : e?.message, e?.code, e?.type,
    ...(Array.isArray(e?.validation_errors) ? e.validation_errors.map(v => v?.field_name ? `${v.field_name}: ${v.message}` : v?.message) : [])]
    .filter(Boolean).map(String);
  return [...new Set(parts)].join(' — ');
}

function flwError(version, path, status, data) {
  const detail = flwDetail(data);
  console.error(`Flutterwave ${version} ${path} failed:`, status, JSON.stringify(data || {}).slice(0, 600));
  const hint = status === 404 || status === 405
    ? ' (this endpoint does not exist on this API version; hosted checkout needs FLW_SECRET_KEY)'
    : status === 401 || status === 403 ? ' (check the Flutterwave key and that it matches live/test mode)' : '';
  return new Error(`Flutterwave ${version} request failed (HTTP ${status})${detail ? ': ' + detail : ''}${hint}`);
}

// Hosted checkout ("Flutterwave Standard") lives on the v3 API and is authorised with the account's secret key.
const V3_BASE = process.env.FLW_V3_BASE_URL || 'https://api.flutterwave.com/v3';
function secretKey() { return String(process.env.FLW_SECRET_KEY || '').trim(); }

async function apiRequestV3(path, options = {}) {
  const response = await fetch(`${V3_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.status === 'error') throw flwError('v3', path, response.status, data);
  return data;
}

function ref() {
  return `KIVORA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    .replace(/[^A-Za-z0-9-]/g, '').slice(0, 42);
}

export function shouldBypassBilling(authenticatedEmail) {
  return isKivoraOwnerEmail(authenticatedEmail);
}

export async function createHostedPayment({ email, name, campaignId, amountNgn }) {
  const amount = Math.round(Number(amountNgn));
  if (!Number.isFinite(amount) || amount < 1) throw new Error('Invalid payment amount.');
  const tx_ref = ref();
  const configuredRedirect = process.env.KIVORA_PAYMENT_REDIRECT_URL;
  const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5173';
  const redirect_url = `${(configuredRedirect || host).replace(/\/$/, '')}/?payment=campaign&campaignId=${encodeURIComponent(campaignId)}`;

  // Flutterwave v4 payment creation. Store tx_ref on the campaign and verify it server-side.
  const call = secretKey() ? apiRequestV3 : apiRequest;
  const data = await call('/payments', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref,
      amount: String(amount),
      currency: 'NGN',
      redirect_url,
      customer: { email, name: name || email },
      customizations: {
        title: 'Kivora sponsored Short',
        description: `Kivora campaign ${campaignId}`
      },
      meta: { product: 'kivora', campaignId }
    })
  });
  const paymentData = data?.data || data;
  const link = paymentData?.link || paymentData?.checkout_url || paymentData?.payment_link;
  if (!link) throw new Error('Flutterwave v4 did not return a hosted checkout URL.');
  return { tx_ref, link };
}

export async function verifyHostedPayment({ transactionId, expectedReference, expectedAmount, expectedCurrency = 'NGN' }) {
  const id = encodeURIComponent(String(transactionId));
  let data;
  try {
    data = await (secretKey() ? apiRequestV3 : apiRequest)(`/transactions/${id}/verify`, { method: 'GET' });
  } catch (error) {
    return { success: false, status: error?.message || 'verification_failed' };
  }
  const d = data?.data || data;
  const status = String(d?.status || '').toLowerCase();
  const reference = String(d?.tx_ref || d?.reference || '');
  const currency = String(d?.currency || '');
  const amount = Number(d?.amount || 0);
  const success = ['successful', 'succeeded', 'completed'].includes(status) &&
    reference === String(expectedReference || '') &&
    currency === expectedCurrency &&
    amount === Number(expectedAmount || 0);
  return { success, status, amount, currency, tx_ref: reference };
}
