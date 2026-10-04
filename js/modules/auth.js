import {
    auth,
    db,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    deleteUser,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    query,
    where,
    getDocs,
    deleteDoc,
    sendPasswordResetEmail
} from './firebase.js';
import { state } from './config.js';
import { checkAdminPermissions, updateAuthModalUI, updateLoggedInStatusUI } from './ui.js';
import * as ui from './ui.js';
import { grantTitle } from './community.js';

/**
 * Sets up the listener that responds to changes in the user's login state.
 * This is a core function that updates the UI and application state when a user
 * logs in or out.
 */
export function initializeAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            state.currentUser = user;
            
            try {
                // 1. Check for private user docs
                const userDocRef = doc(db, "users", user.uid);
                const userDocSnap = await getDoc(userDocRef);
                if (userDocSnap.exists() && userDocSnap.data().totalPins === undefined) {
                    await updateDoc(userDocRef, { totalPins: 0, totalDistance: 0, totalRoutes: 0 });
                }

                // 2. Fetch the Public Profile (Where the 'role' lives)
                const publicProfileRef = doc(db, "publicProfiles", user.uid);
                const publicProfileSnap = await getDoc(publicProfileRef);
                
                let username;
                let userProfileData = {}; // Store data here

                if (publicProfileSnap.exists()) {
                    userProfileData = publicProfileSnap.data(); // Get the actual data
                    username = userProfileData.username;
                    
                    // ✅ CORRECT PLACE: Now that we have the data, check for Admin
                    ui.checkAdminPermissions(userProfileData);

                } else {
                    // Create default profile if missing
                    const defaultUsername = user.email.split('@')[0];
                    userProfileData = {
                        username: defaultUsername,
                        bio: "This user is new to Litter Bugs!",
                        location: "",
                        badges: {},
                        role: "user" // Default role
                    };
                    
                    await setDoc(publicProfileRef, userProfileData);
                    username = defaultUsername;
                }
                
                // Update UI
                updateLoggedInStatusUI(true, username);

            } catch (error) {
                console.error("Error fetching user profile:", error);
                updateLoggedInStatusUI(false); 
            }
        } else {
            // Logged Out
            state.currentUser = null;
            updateLoggedInStatusUI(false);
        }
    });
}

/**
 * Handles the user sign-up process.
 */
export async function handleSignUp() {
    const email = document.getElementById('emailInput').value;
    const password = document.getElementById('passwordInput').value;
    const username = document.getElementById('usernameInput').value;
    const ageCheckbox = document.getElementById('ageCheckbox');
    const authError = document.getElementById('authError');
    authError.textContent = '';

    if (!ageCheckbox.checked) {
        authError.textContent = 'You must certify that you are 18 or older to sign up.';
        return;
    }
    if (!username || username.trim().length < 3) {
        authError.textContent = 'Username must be at least 3 characters.';
        return;
    }

    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const userId = userCredential.user.uid;

        // 1. users/{uid} — per spec 1.3 (exact shape required by Cloud Functions)
        await setDoc(doc(db, "users", userId), {
            email: userCredential.user.email,
            createdAt: new Date(),
            fcmToken: "",        // cleared on logout; set if/when push notifications added
            isSuspended: false,
            role: ""
        });

        // 2. publicProfiles/{uid} — per spec 1.3 (ALL fields required for XP,
        //    squad system, leaderboard, My Profile to work correctly from day 1)
        await setDoc(doc(db, "publicProfiles", userId), {
            username: username.trim(),
            email: userCredential.user.email,
            bio: "",
            location: "",
            buyMeACoffeeLink: "",
            badges: {},
            totalPins: 0,
            totalDistance: 0,   // METERS — convert to miles for display
            totalRoutes: 0,
            selectedTitle: "",
            unlockedTitles: ['beta_trooper'],
            // Squad fields — empty until user joins a squad
            squadId: "",
            squadCallsign: "",
            squadRole: "",
            // XP fields — written by Cloud Functions only after this point.
            // NEVER write xp/level/xpToday/xpTodayDate again after signup.
            xp: 0,
            level: 1,
            xpToday: 0,
            xpTodayDate: "",
            showLevel: true,    // user can toggle on My Profile
            // Permissions & flags
            role: "",
            isSuspended: false,
            isApprovedEventOrganizer: false,
            createdAt: new Date()
        });

        // 3. Grant the beta trooper title
        await grantTitle(userId, 'beta_trooper');

        if (elements.authModal) elements.authModal.style.display = 'none';

    } catch (error) {
        authError.textContent = error.message;
    }
}

/**
 * Handles the user login process.
 */
export async function handleLogIn() {
    //console.log('--- handleLogIn function started ---');
    const email = document.getElementById('emailInput').value;
    const password = document.getElementById('passwordInput').value;
    const authError = document.getElementById('authError');
    authError.textContent = '';

try {
    //console.log('Attempting Firebase sign in for:', email); // <-- ADD THIS
    await signInWithEmailAndPassword(auth, email, password);
    //console.log('Firebase sign in successful (or no error thrown)'); // <-- ADD THIS
  } catch (error) {
    //console.error('Firebase sign in failed:', error); // <-- ADD THIS (or confirm it exists)
    authError.textContent = error.message;
  }
}

/**
 * Handles the user logout process.
 */
export async function handleLogOut() {
    try {
        await signOut(auth);
    } catch (error) {
        //console.error("Error signing out:", error);
        alert("Failed to sign out.");
    }
}

/**
 * Handles the permanent deletion of a user's account and all associated data.
 */
export async function handleAccountDeletion() {
    if (!state.currentUser) return;
    if (!confirm("DANGER: Are you absolutely sure you want to permanently delete your account? This action cannot be undone.")) return;
    if (!confirm("All of your private saved sessions and public routes will be deleted forever. Are you still sure?")) return;

    try {
        const userId = state.currentUser.uid;
        //console.log("Starting account deletion for user:", userId);

        // 1. Delete all private sessions
        const privateSessionsQuery = query(collection(db, "users", userId, "privateSessions"));
        const privateSessionsSnapshot = await getDocs(privateSessionsQuery);
        await Promise.all(privateSessionsSnapshot.docs.map(d => deleteDoc(d.ref)));
        //console.log("Private sessions deleted.");

        // 2. Delete all published routes
        const publishedRoutesQuery = query(collection(db, "publishedRoutes"), where("userId", "==", userId));
        const publishedRoutesSnapshot = await getDocs(publishedRoutesQuery);
        await Promise.all(publishedRoutesSnapshot.docs.map(d => deleteDoc(d.ref)));
        //console.log("Published routes deleted.");

        // 3. Delete user documents
        await deleteDoc(doc(db, "users", userId));
        await deleteDoc(doc(db, "publicProfiles", userId));
        //console.log("User documents deleted.");

        // 4. Delete the user from Firebase Authentication
        await deleteUser(state.currentUser);

        alert("Your account and all associated data have been permanently deleted.");
        document.getElementById('profileModal').style.display = 'none';

    } catch (error) {
        //console.error("Error deleting account:", error);
        if (error.code === 'auth/requires-recent-login') {
            alert("This is a sensitive operation. Please log out and log back in to delete your account.");
        } else {
            alert("An error occurred while deleting your account.");
        }
    }
}

export async function handlePasswordReset() {
    const email = document.getElementById('emailInput').value.trim();
    
    if (!email) {
        alert("Please enter your email address first.");
        return;
    }

    try {
        await sendPasswordResetEmail(auth, email);
        alert("Reset link sent! Check your inbox (and spam folder).");
    } catch (error) {
        console.error("Reset Error:", error.code);
        if (error.code === 'auth/user-not-found') {
            alert("No account found with this email.");
        } else {
            alert("Error sending reset link. Please try again.");
        }
    }
}
