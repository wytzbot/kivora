import { initializeApp } from "firebase/app";
import { KIVORA_OWNER_EMAIL } from "./access.js";
import { isNative, isAppShell } from "./native.js";
import { getAnalytics, isSupported } from "firebase/analytics";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInAnonymously, onAuthStateChanged, signInWithCredential,
  linkWithPopup, linkWithRedirect, reauthenticateWithPopup, reauthenticateWithRedirect, signOut
} from "firebase/auth";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc,
  deleteDoc, query, orderBy, limit, onSnapshot, serverTimestamp, runTransaction,
  increment, arrayUnion, arrayRemove
} from "firebase/firestore";

const firebaseConfig = {
  apiKey:"AIzaSyCSnUww6XmaNkdrDEnwpzZIWQHz2SW58sI",
  authDomain:(isAppShell&&typeof window!=="undefined"&&window.location.hostname&&window.location.hostname!=="localhost")?window.location.hostname:"kivoraa.firebaseapp.com", projectId:"kivoraa",
  storageBucket:"kivoraa.firebasestorage.app", messagingSenderId:"739770885881",
  appId:"1:739770885881:web:3a17f6eab7e6c4b0612428", measurementId:"G-1W86Q64XKQ"
};
export const app=initializeApp(firebaseConfig);
export const auth=getAuth(app);
export const db=getFirestore(app);
export const googleProvider=new GoogleAuthProvider();
googleProvider.setCustomParameters({prompt:"select_account"});

if(typeof window!=="undefined") isSupported().then(ok=>ok&&getAnalytics(app)).catch(()=>{});

// Google access tokens last about an hour. Keep the token (with its expiry) across app restarts so a cold start does not
// force a second Google consent prompt before the first Like/Comment.
const YT_TOKEN_KEY="kivora-yt-token-v1";
const YT_TOKEN_TTL_MS=50*60*1000;
function saveYouTubeToken(token){
  if(!token)return;
  try{localStorage.setItem(YT_TOKEN_KEY,JSON.stringify({token,exp:Date.now()+YT_TOKEN_TTL_MS,uid:auth.currentUser?.uid||""}))}catch{}
  try{sessionStorage.setItem("kivora-youtube-access-token",token)}catch{}
}
function readYouTubeToken(){
  try{
    const v=JSON.parse(localStorage.getItem(YT_TOKEN_KEY)||"null");
    if(v?.token&&Number(v.exp)>Date.now()&&(!v.uid||!auth.currentUser||v.uid===auth.currentUser.uid))return v.token;
    if(v)localStorage.removeItem(YT_TOKEN_KEY);
  }catch{}
  return "";
}
function clearYouTubeToken(){try{localStorage.removeItem(YT_TOKEN_KEY)}catch{}try{sessionStorage.removeItem("kivora-youtube-access-token")}catch{}}
const YOUTUBE_SCOPES=["https://www.googleapis.com/auth/youtube.force-ssl","https://www.googleapis.com/auth/youtube.readonly"];
export async function finishGoogleRedirect(){
  try {
    const result=await getRedirectResult(auth);
    const token=result?GoogleAuthProvider.credentialFromResult(result)?.accessToken:null;
    if(token) saveYouTubeToken(token);
    try{sessionStorage.removeItem("kivora-redirect-retry")}catch{}
    return result;
  } catch(e) {
    if(e?.code === "auth/popup-closed-by-user") return null;
    // A redirect that started by linking an anonymous account can finish with
    // credential-already-in-use when the selected Google account already has
    // a real Kivora account. In that case, authenticate that existing account
    // instead of surfacing a dead-end Firebase error.
    if(["auth/credential-already-in-use","auth/account-exists-with-different-credential"].includes(e?.code)){
      // Retry the redirect once only. Without this guard a persistent conflict bounces the user between Google and
      // Kivora forever.
      let already=false;
      try{already=sessionStorage.getItem("kivora-redirect-retry")==="1"}catch{}
      if(already){try{sessionStorage.removeItem("kivora-redirect-retry")}catch{}throw e;}
      try{sessionStorage.setItem("kivora-redirect-retry","1")}catch{}
      return await signInWithRedirect(auth,googleProvider);
    }
    throw e;
  }
}
export async function startAnonymousSession(){
  if(auth.currentUser) return auth.currentUser;
  return (await signInAnonymously(auth)).user;
}
let signInInFlight=null;
// Only one Google sign-in can run at a time. A double tap used to open a second popup/redirect, which Firebase reports as
// "cancelled-popup-request" and which then fell through to a full-page redirect.
export function signInWithGoogle(){
  if(signInInFlight)return signInInFlight;
  signInInFlight=runGoogleSignIn().finally(()=>{signInInFlight=null});
  return signInInFlight;
}
async function runGoogleSignIn(){
  // Capacitor Android: use the native Google account chooser. Do not launch
  // Firebase web popup/redirect from the WebView, because it can strand the
  // user in Chrome and return to the hosted site instead of the APK.
  if(isNative){
    let result;
    try {
      const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
      // Keep basic authentication separate from optional YouTube scopes. Asking
      // for YouTube scopes at initial login can trigger a second consent flow.
      result = await FirebaseAuthentication.signInWithGoogle();
    } catch(e) {
      if(/cancel|closed|canceled/i.test(String(e?.message||e?.code||""))) {
        throw Object.assign(new Error("Google sign-in was cancelled."),{code:"auth/popup-closed-by-user"});
      }
      // Never fall back to browser OAuth in a native APK: surface the native
      // configuration error instead of sending users outside the application.
      throw Object.assign(new Error(`Native Google sign-in failed: ${e?.message || e?.code || "Check Firebase Android configuration."}`), { code: e?.code || "auth/native-sign-in-failed" });
    }
    const idToken = result?.credential?.idToken;
    if(!idToken) throw Object.assign(new Error("Google's native picker returned no ID token. Check the Android OAuth client and google-services.json."),{code:"auth/invalid-credential"});
    const credential = GoogleAuthProvider.credential(idToken);
    // With skipNativeAuth enabled, the native plugin returns a Google token and
    // the Firebase JS SDK owns the app's web-compatible Firebase session.
    const signedIn = await signInWithCredential(auth, credential);
    const accessToken = result?.credential?.accessToken;
    if(accessToken) saveYouTubeToken(accessToken);
    return signedIn.user;
  }
  // Installed TWA / standalone PWA: this is not a native APK bridge. Use a
  // same-window redirect so Chrome's popup does not escape the app shell.
  if(isAppShell){
    await signInWithRedirect(auth,googleProvider); return null;
  }
  try {
    const result=await signInWithPopup(auth,googleProvider);
    const credential=GoogleAuthProvider.credentialFromResult(result);
    if(credential?.accessToken) saveYouTubeToken(credential.accessToken);
    return result.user;
  }
  catch(e){
    // The user closed the window, or tapped twice: this is a cancel, not an error and not a reason to redirect.
    if(["auth/popup-closed-by-user","auth/cancelled-popup-request","auth/user-cancelled"].includes(e?.code)){
      throw Object.assign(new Error("Google sign-in was cancelled."),{code:"auth/popup-closed-by-user"});
    }
    if(["auth/popup-blocked","auth/operation-not-supported-in-this-environment"].includes(e?.code)){
      await signInWithRedirect(auth,googleProvider); return null;
    }
    if(["auth/credential-already-in-use","auth/account-exists-with-different-credential"].includes(e?.code)){
      await signInWithRedirect(auth,googleProvider); return null;
    }
    throw e;
  }
}

export async function getYouTubeAccessToken(){
  const cached=readYouTubeToken();
  if(cached) return cached;
  const user=auth.currentUser;
  if(!user||user.isAnonymous) throw new Error("Sign in with Google to use YouTube actions.");
  if(isNative){
    const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
    const result = await FirebaseAuthentication.signInWithGoogle({ scopes: YOUTUBE_SCOPES });
    const token = result?.credential?.accessToken;
    if(!token) throw new Error("Google did not return a YouTube access token. Sign in again from the menu.");
    saveYouTubeToken(token);
    return token;
  }
  const provider=new GoogleAuthProvider();
  provider.setCustomParameters({prompt:"consent select_account"});
  YOUTUBE_SCOPES.forEach(sc=>provider.addScope(sc));
  if(isAppShell){
    await reauthenticateWithRedirect(user,provider);
    throw new Error("Opening Google to authorize YouTube actions…");
  }
  const result=await reauthenticateWithPopup(user,provider);
  const credential=GoogleAuthProvider.credentialFromResult(result);
  if(!credential?.accessToken) throw new Error("Google did not return a YouTube access token. Check OAuth consent and authorized domains.");
  saveYouTubeToken(credential.accessToken);
  return credential.accessToken;
}
export async function logOut(){clearYouTubeToken();return signOut(auth);}
export {onAuthStateChanged};

export async function getProEntitlement(user=auth.currentUser){
  if(!user || user.isAnonymous) return false;
  if(String(user.email||"").trim().toLowerCase()===KIVORA_OWNER_EMAIL) return true;
  try {
    const token=await user.getIdTokenResult();
    return token?.claims?.pro===true || token?.claims?.plan==='pro';
  } catch { return false; }
}

export async function toggleLike(videoId, uid){
  if(!uid) throw new Error("Start a Kivora session before liking videos.");
  const likeRef=doc(db,"videos",videoId,"likes",uid);
  const videoRef=doc(db,"videos",videoId);
  try {
    return await runTransaction(db,async tx=>{
      const likeSnap=await tx.get(likeRef);
      const videoSnap=await tx.get(videoRef);
      // YouTube-discovered videos are not necessarily pre-seeded in Kivora's
      // Firestore. In that case, use the device-level interaction state instead
      // of making the Like button appear dead.
      if(!videoSnap.exists()){
        const key=`kivora-like-${videoId}-${uid}`;
        const next=typeof window!=="undefined" ? localStorage.getItem(key)!=="1" : true;
        if(typeof window!=="undefined") localStorage.setItem(key,next?"1":"0");
        return next;
      }
      const current=Math.max(0,Number(videoSnap.data()?.likeCount||0));
      if(likeSnap.exists()){
        tx.delete(likeRef);
        tx.update(videoRef,{likeCount:Math.max(0,current-1)});
        return false;
      }
      tx.set(likeRef,{uid,createdAt:serverTimestamp()});
      tx.update(videoRef,{likeCount:current+1});
      return true;
    });
  } catch(e) {
    // Firestore rules/network failures should not leave the UI action dead.
    // Keep a local Kivora interaction fallback for dynamically discovered videos.
    const key=`kivora-like-${videoId}-${uid}`;
    if(typeof window!=="undefined") {
      const next=localStorage.getItem(key)!=="1";
      localStorage.setItem(key,next?"1":"0");
      return next;
    }
    throw e;
  }
}
export async function saveVideo(videoId,uid){
  if(!uid) throw new Error("Start a Kivora session before saving videos.");
  const key=`kivora-saved-${videoId}-${uid}`;
  try {
    const ref=doc(db,"users",uid);
    const snap=await getDoc(ref);
    const saved=snap.data()?.savedVideos||[];
    const next=saved.includes(videoId)?saved.filter(x=>x!==videoId):[...saved,videoId].slice(-200);
    await setDoc(ref,{savedVideos:next,updatedAt:serverTimestamp()},{merge:true});
    if(typeof window!=="undefined") localStorage.setItem(key,next.includes(videoId)?"1":"0");
    return next.includes(videoId);
  } catch(e) {
    if(typeof window!=="undefined") {
      const next=localStorage.getItem(key)!=="1";
      localStorage.setItem(key,next?"1":"0");
      return next;
    }
    throw e;
  }
}

// POST/GET to a Kivora API route with a fresh Firebase ID token.
// If the server answers 401 (stale/expired token) the token is force-refreshed and the call retried once,
// so the user never has to sign out and back in just to reach payment.
export async function authedFetch(url,options={}){
  const user=auth.currentUser;
  if(!user||user.isAnonymous) throw Object.assign(new Error("Connect Google before continuing."),{code:"auth/not-signed-in"});
  const send=async force=>{
    const token=await user.getIdToken(force);
    return fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${token}`}});
  };
  let res=await send(false);
  if(res.status===401){
    try{res=await send(true)}catch{}
  }
  if(res.status===401){
    // Refresh did not help: the session itself is gone. Reload the user once and retry.
    try{await user.reload();res=await send(true)}catch{}
  }
  return res;
}
