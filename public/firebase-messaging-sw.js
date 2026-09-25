importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");
firebase.initializeApp({apiKey:"AIzaSyCSnUww6XmaNkdrDEnwpzZIWQHz2SW58sI",authDomain:"kivoraa.firebaseapp.com",projectId:"kivoraa",storageBucket:"kivoraa.firebasestorage.app",messagingSenderId:"739770885881",appId:"1:739770885881:web:3a17f6eab7e6c4b0612428",measurementId:"G-1W86Q64XKQ"});
const messaging=firebase.messaging();
messaging.onBackgroundMessage(payload=>self.registration.showNotification(payload.notification?.title||"Kivora",{body:payload.notification?.body||"You have a new update.",icon:"/icon-192.png",data:payload.data||{}}));
self.addEventListener("notificationclick",event=>{event.notification.close();event.waitUntil(clients.openWindow(event.notification.data?.url||"/"));});
