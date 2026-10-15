import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function adminApp(){
  if(getApps().length) return getApps()[0];
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.');
  let service;
  let text=String(raw).trim();
  // Accept plain JSON, JSON wrapped in quotes, or base64-encoded JSON (common in Vercel env vars).
  if(!text.startsWith('{')&&!text.startsWith('"')){try{text=Buffer.from(text,'base64').toString('utf8')}catch{}}
  try{service=JSON.parse(text);if(typeof service==='string')service=JSON.parse(service)}catch{throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON.')}
  // Env storage often turns the key's real newlines into literal "\\n".
  if(service.private_key)service.private_key=String(service.private_key).replace(/\\n/g,'\n');
  return initializeApp({credential:cert(service),projectId:service.project_id||process.env.FIREBASE_PROJECT_ID});
}

export function adminAuth(){return getAuth(adminApp())}
export function adminDb(){return getFirestore(adminApp())}

const TOKEN_ERRORS=new Set(['auth/id-token-expired','auth/id-token-revoked','auth/argument-error','auth/invalid-id-token','auth/user-disabled','auth/user-not-found']);

export async function requireUser(req){
  const header=String(req.headers?.authorization||'');
  const token=header.startsWith('Bearer ')?header.slice(7).trim():'';
  if(!token) throw Object.assign(new Error('Authentication required.'),{statusCode:401,code:'auth/missing-token'});
  // Server misconfiguration must not look like a bad user token.
  let auth;
  try{auth=adminAuth()}
  catch(e){console.error('Firebase Admin init failed:',e?.message);throw Object.assign(new Error('Payment service is not configured correctly (Firebase Admin credentials). Please contact support.'),{statusCode:500,code:'server/misconfigured'})}
  try{return await auth.verifyIdToken(token)}
  catch(e){
    console.error('verifyIdToken failed:',e?.code||'',e?.message||'');
    const code=String(e?.code||'');
    // Wrong-project tokens ("incorrect aud/iss") surface as argument-error / invalid-id-token.
    if(TOKEN_ERRORS.has(code)||/token/i.test(String(e?.message||''))) throw Object.assign(new Error('Your session expired. Please try again.'),{statusCode:401,code:code||'auth/invalid-id-token'});
    throw Object.assign(new Error('Could not verify your sign-in right now. Please try again.'),{statusCode:503,code:code||'auth/verify-failed'});
  }
}

export async function optionalUser(req){
  const header=String(req.headers?.authorization||'');
  const token=header.startsWith('Bearer ')?header.slice(7).trim():'';
  if(!token) return null;
  try{return await adminAuth().verifyIdToken(token)}catch{return null}
}
