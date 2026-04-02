// Firebase web SDK initialization — shared by lobby and all game pages
const firebaseConfig = {
  apiKey: "AIzaSyBbAoIZetRNiEjHDq6E-abZ7tEMl5PqVz4",
  authDomain: "arena-25ce8.firebaseapp.com",
  projectId: "arena-25ce8",
  storageBucket: "arena-25ce8.firebasestorage.app",
  messagingSenderId: "125470737477",
  appId: "1:125470737477:web:026054498aad5db2774f2c",
  measurementId: "G-CHZ1140FPQ"
};

// Only initialize once (in case multiple scripts include this file)
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const fbAuth = firebase.auth();
