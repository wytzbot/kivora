import { initializeApp } from "firebase/app";
import { KIVORA_OWNER_EMAIL } from "./access.js";
import { getAnalytics, isSupported } from "firebase/analytics";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInAnonymously, onAuthStateChanged,
  linkWithPopup, linkWithRedirect, signOut
} from "firebase/auth";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc,
  deleteDoc, query, orderBy, limit, onSnapshot, serverTimestamp, runTransaction,
  increment, arrayUnion, arrayRemove
} from "firebase/firestore";
import { getMessaging, getToken, onMessage, isSupported as messagingSupported } from "firebase/messaging";

const firebaseConfig = {
  apiKey:"AIzaSyCSnUww6XmaNkdrDEnwpzZIWQHz2SW58sI",
  authDomain:"kivoraa.firebaseapp.com", projectId:"kivoraa",
  storageBucket:"kivoraa.firebasestorage.app", messagingSenderId:"739770885881",
  appId:"1:739770885881:web:3a17f6eab7e6c4b0612428", measurementId:"G-1W86Q64XKQ"
};
export const app=initializeApp(firebaseConfig);
export const auth=getAuth(app);
export const db=getFirestore(app);
export const googleProvider=new GoogleAuthProvider();
googleProvider.setCustomParameters({prompt:"select_account"});

if(typeof window!=="undefined") isSupported().then(ok=>ok&&getAnalytics(app)).catch(()=>{});

export async function finishGoogleRedirect(){
  try { return await getRedirectResult(auth); } catch(e) {
    if(e?.code === "auth/popup-closed-by-user") return null;
    throw e;
  }
}
export async function startAnonymousSession(){
  if(auth.currentUser) return auth.currentUser;
  return (await signInAnonymously(auth)).user;
}
export async function signInWithGoogle(){
  if(auth.currentUser?.isAnonymous){
    try { return (await linkWithPopup(auth.currentUser,googleProvider)).user; }
    catch(e){
      if(["auth/popup-blocked","auth/operation-not-supported-in-this-environment","auth/cancelled-popup-request"].includes(e?.code)){
        await linkWithRedirect(auth.currentUser,googleProvider); return null;
      }
      throw e;
    }
  }
  try { return (await signInWithPopup(auth,googleProvider)).user; }
  catch(e){
    if(["auth/popup-blocked","auth/operation-not-supported-in-this-environment","auth/cancelled-popup-request"].includes(e?.code)){
      await signInWithRedirect(auth,googleProvider); return null;
    }
    throw e;
  }
}
export async function logOut(){return signOut(auth);}
export {onAuthStateChanged};

export async function getProEntitlement(user=auth.currentUser){
  if(!user || user.isAnonymous) return false;
  if(String(user.email||"").trim().toLowerCase()===KIVORA_OWNER_EMAIL) return true;
  try {
    const token=await user.getIdTokenResult();
    return token?.claims?.pro===true || token?.claims?.plan==='pro';
  } catch { return false; }
}

export async function enablePushNotifications(){
  if(!("serviceWorker"in navigator)||!("Notification"in window))
    throw new Error("Push notifications are not supported in this browser.");
  if(!(await messagingSupported())) throw new Error("Push notifications are not supported here.");
  const permission=await Notification.requestPermission();
  if(permission!=="granted") throw new Error("Notification permission was not granted.");
  const registration=await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const token=await getToken(getMessaging(app),{
    vapidKey:"BA4mWG9DitwYKMr9ntWeCHMNTwYqTmGzzvba0mqlHocHeuLlHB0lspXOWs07CYSkmUtB_6GeLV1YcRtVJcZkI_U",
    serviceWorkerRegistration:registration
  });
  if(auth.currentUser && token){
    await setDoc(doc(db,"users",auth.currentUser.uid),{
      fcmTokens:arrayUnion(token), updatedAt:serverTimestamp()
    },{merge:true});
  }
  return token;
}
export async function listenForForegroundMessages(callback){
  if(!(await messagingSupported())) return ()=>{};
  return onMessage(getMessaging(app),callback);
}

export async function toggleLike(videoId, uid){
  if(!uid) throw new Error("Sign in to like videos.");
  const likeRef=doc(db,"videos",videoId,"likes",uid);
  const videoRef=doc(db,"videos",videoId);
  return runTransaction(db,async tx=>{
    const likeSnap=await tx.get(likeRef);
    const videoSnap=await tx.get(videoRef);
    if(!videoSnap.exists()) throw new Error("This video is not available.");
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
}
export async function saveVideo(videoId,uid){
  if(!uid) throw new Error("Sign in to save videos.");
  const ref=doc(db,"users",uid);
  const snap=await getDoc(ref);
  const saved=snap.data()?.savedVideos||[];
  const next=saved.includes(videoId)?saved.filter(x=>x!==videoId):[...saved,videoId].slice(-200);
  await setDoc(ref,{savedVideos:next,updatedAt:serverTimestamp()},{merge:true});
  return next.includes(videoId);
}
