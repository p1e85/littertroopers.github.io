// Import the functions you need from the SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { 
    getFirestore, doc, getDoc, setDoc, updateDoc, collection, collectionGroup,
    addDoc, getDocs, query, orderBy, where, deleteDoc, limit, startAt, endAt, onSnapshot, serverTimestamp, Timestamp, arrayUnion, arrayRemove, runTransaction, deleteField, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { 
    getStorage, ref, uploadBytes, getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { 
    getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, 
    signOut, onAuthStateChanged, deleteUser, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCE1b6VtJjUs0O5YvyLjeslxuHC8UlgJUM",
    authDomain: "garbagepathv2.firebaseapp.com",
    projectId: "garbagepathv2",
    storageBucket: "garbagepathv2.firebasestorage.app",
    messagingSenderId: "505856089619",
    appId: "1:505856089619:web:682f58d02be4295be4a9e6",
    measurementId: "G-SM46WXV0CN"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const functions = getFunctions(app);

console.log("Firebase Initialized!");

// Export the initialized services and SDK functions for use in other modules
export {
    // Services
    db,
    auth,
    storage,
    functions,
    httpsCallable,
    // Firestore Functions
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    collectionGroup,
    addDoc,
    getDocs,
    query,
    orderBy,
    where,
    deleteDoc,
    limit,
    startAt,
    endAt,
    onSnapshot,
    getCountFromServer,
    // Storage Functions
    ref,
    uploadBytes,
    getDownloadURL,
    // Auth Functions
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    deleteUser,
    serverTimestamp,
    Timestamp,
    arrayUnion,
    arrayRemove,
    runTransaction,
    sendPasswordResetEmail,
    deleteField
};
