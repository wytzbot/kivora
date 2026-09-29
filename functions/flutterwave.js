// Hosted Flutterwave checkout + server-side verification.
// The merchant secret is never exposed to the browser.
import { isKivoraOwnerEmail } from './access.js';

const BASE='https://api.flutterwave.com/v3';
function secret(){const v=process.env.FLW_SECRET_KEY||process.env.FLUTTERWAVE_SECRET_KEY; if(!v) throw new Error('FLW_SECRET_KEY is not configured on the server.'); return v}
function ref(){return `KIVORA-${Date.now()}-${Math.random().toString(36).slice(2,10)}`.replace(/[^A-Za-z0-9-]/g,'').slice(0,42)}

export function shouldBypassBilling(authenticatedEmail){return isKivoraOwnerEmail(authenticatedEmail)}

export async function createHostedPayment({email,name,campaignId,amountNgn}){
  const amount=Math.round(Number(amountNgn)); if(!Number.isFinite(amount)||amount<1) throw new Error('Invalid payment amount.');
  const tx_ref=ref();
  const redirectBase=process.env.KIVORA_PAYMENT_REDIRECT_URL||process.env.VERCEL_URL&&`https://${process.env.VERCEL_URL}`||'http://localhost:5173';
  const redirect_url=`${redirectBase.replace(/\/$/,'')}/?payment=campaign&campaignId=${encodeURIComponent(campaignId)}`;
  const response=await fetch(`${BASE}/payments`,{method:'POST',headers:{Authorization:`Bearer ${secret()}`,'Content-Type':'application/json',accept:'application/json'},body:JSON.stringify({tx_ref,amount,currency:'NGN',redirect_url,customer:{email,name:name||email},customizations:{title:'Kivora sponsored Short',description:`Kivora campaign ${campaignId}`},meta:{product:'kivora',campaignId}})});
  const data=await response.json(); if(!response.ok||data?.status!=='success'||!data?.data?.link) throw new Error(data?.message||'Flutterwave could not create the checkout.');
  return {tx_ref,link:data.data.link};
}

export async function verifyHostedPayment({transactionId,expectedReference,expectedAmount,expectedCurrency='NGN'}){
  const id=encodeURIComponent(String(transactionId));
  const response=await fetch(`${BASE}/transactions/${id}/verify`,{headers:{Authorization:`Bearer ${secret()}`,accept:'application/json'}});
  const data=await response.json(); if(!response.ok||data?.status!=='success') return {success:false,status:data?.message||'verification_failed'};
  const d=data.data||{};
  const success=d.status==='successful'&&String(d.tx_ref||'')===String(expectedReference||'')&&String(d.currency||'')===expectedCurrency&&Number(d.amount||0)>=Number(expectedAmount||0);
  return {success,status:d.status,amount:Number(d.amount||0),currency:d.currency,tx_ref:d.tx_ref};
}
