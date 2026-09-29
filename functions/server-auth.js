import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function adminApp(){
  if(getApps().length) return getApps()[0];
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.');
  let service;
  try{service=JSON.parse(raw)}catch{throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON.')}
  return initializeApp({credential:cert(service),projectId:service.project_id||process.env.FIREBASE_PROJECT_ID});
}

export function adminAuth(){return getAuth(adminApp())}
export function adminDb(){return getFirestore(adminApp())}

export async function requireUser(req){
  const header=String(req.headers?.authorization||'');
  const token=header.startsWith('Bearer ')?header.slice(7).trim():'';
  if(!token) throw Object.assign(new Error('Authentication required.'),{statusCode:401});
  try{return await adminAuth().verifyIdToken(token)}
  catch{throw Object.assign(new Error('Authentication token is invalid or expired.'),{statusCode:401})}
}

export async function optionalUser(req){
  const header=String(req.headers?.authorization||'');
  const token=header.startsWith('Bearer ')?header.slice(7).trim():'';
  if(!token) return null;
  try{return await adminAuth().verifyIdToken(token)}catch{return null}
}
