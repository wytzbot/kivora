// Flutterwave v4 card payments: card details -> (PIN) -> (OTP) / 3-D Secure redirect -> server-side verification.
// Client credentials and the encryption key are server-only. Never expose them through VITE_ variables.
// Card data is encrypted (AES-256-GCM) before it leaves this process, is never logged and never stored.
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { isKivoraOwnerEmail } from './access.js';

// v4 live: https://f4bexperience.flutterwave.com  |  v4 test: https://developersandbox-api.flutterwave.com
const API_BASE = String(process.env.FLW_API_BASE_URL || 'https://f4bexperience.flutterwave.com').replace(/\/$/, '');
const TOKEN_URL = process.env.FLW_TOKEN_URL || 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
let cachedToken = '';
let tokenExpiresAt = 0;

function credentials() {
  const clientId = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('FLW_CLIENT_ID and FLW_CLIENT_SECRET must be configured for Flutterwave v4.');
  return { clientId, clientSecret };
}

async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const { clientId, clientSecret } = credentials();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
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

function flwDetail(data) {
  const e = data?.error;
  const parts = [data?.message, typeof e === 'string' ? e : e?.message,
    ...(Array.isArray(e?.validation_errors) ? e.validation_errors.map(v => v?.field_name ? `${v.field_name}: ${v.message}` : v?.message) : [])]
    .filter(Boolean).map(String);
  return [...new Set(parts)].join(' — ');
}

class PaymentError extends Error {
  constructor(message, status = 400) { super(message); this.statusCode = status; }
}

async function apiRequest(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Trace-Id': randomUUID(),
      'X-Idempotency-Key': randomUUID(),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Log the response only. The request body (card data) is never logged.
    console.error(`Flutterwave v4 ${options.method || 'GET'} ${path} failed:`, response.status, JSON.stringify(data || {}).slice(0, 500));
    const detail = flwDetail(data);
    throw new PaymentError(detail || `Payment provider error (HTTP ${response.status}).`, response.status >= 500 ? 502 : 400);
  }
  return data;
}

// ---------- encryption (Flutterwave v4: AES-256-GCM, base64 key from Dashboard > API keys, 12-char nonce) ----------
function encryptionKey() {
  const raw = String(process.env.FLW_ENCRYPTION_KEY || '').trim();
  if (!raw) throw new PaymentError('FLW_ENCRYPTION_KEY is not configured (Flutterwave Dashboard > Settings > API keys).', 500);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new PaymentError('FLW_ENCRYPTION_KEY must be the 32-byte base64 key from the Flutterwave Dashboard.', 500);
  return key;
}

function newNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function encrypt(value, nonce) {
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'utf8'));
  const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return enc.toString('base64');
}

// ---------- input validation ----------
function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

export function cleanCard(card = {}) {
  const number = String(card.number || '').replace(/[\s-]/g, '');
  const month = String(card.expMonth || '').replace(/\D/g, '').padStart(2, '0');
  let year = String(card.expYear || '').replace(/\D/g, '');
  if (year.length === 4) year = year.slice(2);
  const cvv = String(card.cvv || '').replace(/\D/g, '');
  if (!/^\d{12,19}$/.test(number) || !luhn(number)) throw new PaymentError('Enter a valid card number.');
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{2}$/.test(year)) throw new PaymentError('Enter a valid expiry date (MM/YY).');
  const now = new Date();
  const expires = new Date(2000 + Number(year), Number(month), 1); // first day after the expiry month
  if (expires <= now) throw new PaymentError('This card has expired.');
  if (!/^\d{3,4}$/.test(cvv)) throw new PaymentError('Enter a valid CVV.');
  return { number, month, year, cvv };
}

// ---------- charge helpers ----------
export function newReference() {
  return `KIVORA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 42);
}

export function shouldBypassBilling(authenticatedEmail) {
  return isKivoraOwnerEmail(authenticatedEmail);
}

// Normalises a v4 charge into the single next step the UI must show.
export function nextStep(charge = {}) {
  const status = String(charge.status || '').toLowerCase();
  const action = charge.next_action || {};
  const type = String(action.type || '').toLowerCase();
  if (status === 'succeeded') return { step: 'success' };
  if (['failed', 'voided', 'timeout', 'cancelled'].includes(status)) {
    return { step: 'failed', message: String(charge?.processor_response?.message || 'The card was declined. Check the details or use another card.') };
  }
  if (type === 'requires_pin') return { step: 'pin' };
  if (type === 'requires_otp') return { step: 'otp', message: action?.requires_otp?.message || '' };
  if (type === 'redirect_url') {
    const url = action?.redirect_url?.url || action?.redirect_url;
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return { step: 'redirect', redirectUrl: url };
  }
  if (type === 'requires_additional_fields') return { step: 'failed', message: 'This card needs extra billing details that Kivora does not collect yet. Please use another card.' };
  return { step: 'pending', message: 'Waiting for the bank to confirm the payment.' };
}

export async function createCardCharge({ email, name, reference, amountNgn, redirectUrl, card }) {
  const amount = Math.round(Number(amountNgn));
  if (!Number.isFinite(amount) || amount < 1) throw new PaymentError('Invalid payment amount.');
  const c = cleanCard(card);
  const nonce = newNonce();
  const person = String(name || email || 'Kivora Advertiser').trim().split(/\s+/);
  const data = await apiRequest('/orchestration/direct-charges', {
    method: 'POST',
    body: JSON.stringify({
      reference,
      amount,
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email, name: { first: person[0] || 'Kivora', last: person.slice(1).join(' ') || 'Advertiser' } },
      payment_method: {
        type: 'card',
        card: {
          nonce,
          encrypted_card_number: encrypt(c.number, nonce),
          encrypted_expiry_month: encrypt(c.month, nonce),
          encrypted_expiry_year: encrypt(c.year, nonce),
          encrypted_cvv: encrypt(c.cvv, nonce)
        }
      }
    })
  });
  const charge = data?.data || data;
  if (!charge?.id) throw new PaymentError('Flutterwave did not return a charge. Please try again.', 502);
  return { chargeId: String(charge.id), charge };
}

export async function authorizeCharge({ chargeId, type, pin, code }) {
  const id = encodeURIComponent(String(chargeId));
  let authorization;
  if (type === 'pin') {
    if (!/^\d{4}$/.test(String(pin || ''))) throw new PaymentError('Enter your 4-digit card PIN.');
    const nonce = newNonce();
    authorization = { type: 'pin', pin: { nonce, encrypted_pin: encrypt(pin, nonce) } };
  } else if (type === 'otp') {
    if (!/^\d{4,10}$/.test(String(code || ''))) throw new PaymentError('Enter the OTP sent by your bank.');
    authorization = { type: 'otp', otp: { code: String(code) } };
  } else {
    throw new PaymentError('Unsupported authorization step.');
  }
  const data = await apiRequest(`/charges/${id}`, { method: 'PUT', body: JSON.stringify({ authorization }) });
  return data?.data || data;
}

export async function retrieveCharge(chargeId) {
  const data = await apiRequest(`/charges/${encodeURIComponent(String(chargeId))}`, { method: 'GET' });
  return data?.data || data;
}

// Source of truth: the charge fetched from Flutterwave must match reference, amount and currency.
export async function verifyCharge({ chargeId, expectedReference, expectedAmount, expectedCurrency = 'NGN' }) {
  let d;
  try { d = await retrieveCharge(chargeId); } catch (error) { return { success: false, status: error?.message || 'verification_failed' }; }
  const status = String(d?.status || '').toLowerCase();
  const reference = String(d?.reference || '');
  const currency = String(d?.currency || '');
  const amount = Number(d?.amount || 0);
  const success = status === 'succeeded' && reference === String(expectedReference || '') &&
    currency === expectedCurrency && amount === Number(expectedAmount || 0);
  return { success, status, amount, currency, reference, charge: d };
}
