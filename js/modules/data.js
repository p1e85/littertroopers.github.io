import { db, collection, addDoc, getDocs, query, orderBy, doc, getDoc, deleteDoc } from './firebase.js';
import { state } from './config.js';
import { convertPinsForFirestore, convertPinsFromFirestore, convertRouteForFirestore, convertRouteFromFirestore } from './utils.js';
import { createAndAddMarker, updateUserPinsSource, centerOnRoute } from './map.js';
import { storage, ref, uploadBytes, getDownloadURL } from './firebase.js';

/**
 * Saves the current session (route and pins) to local storage for guests
 * or to the user's account in Firestore.
 */
export async function saveSession() {
    const dataModal = document.getElementById('dataModal');
    const sessionName = prompt("Name this Litter Bugs session:", `Cleanup on ${new Date().toLocaleDateString()}`);
    if (!sessionName) return;

    // --- Prepare Session Data ---
    const sessionDataBase = {
        sessionName,
        timestamp: new Date(),
        pins: convertPinsForFirestore(state.photoPins),
        route: convertRouteForFirestore(state.routeCoordinates)
    };

    // --- Handle Cleanup Photo ---
    let cleanupPhotoInfo = {}; // Will hold URL or data
    if (state.cleanupPhoto instanceof File) {
        if (state.currentUser) {
            // Logged-in: Upload to Storage
            try {
                const timestamp = Date.now();
                const storageRef = ref(storage, `cleanupPhotos/${state.currentUser.uid}/${timestamp}-${state.cleanupPhoto.name}`);
                const snapshot = await uploadBytes(storageRef, state.cleanupPhoto);
                cleanupPhotoInfo.cleanupPhotoURL = await getDownloadURL(snapshot.ref); // Get URL
                console.log("Cleanup photo uploaded:", cleanupPhotoInfo.cleanupPhotoURL);
            } catch (error) {
                console.error("Error uploading cleanup photo:", error);
                alert("Could not save the cleanup photo, but session data will be saved.");
            }
        } else {
            // Guest: Convert to Base64 data URL
            try {
                cleanupPhotoInfo.cleanupPhotoData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result);
                    reader.onerror = e => reject(e);
                    reader.readAsDataURL(state.cleanupPhoto);
                });
                console.log("Cleanup photo saved locally as data URL.");
            } catch (error) {
                console.error("Error converting cleanup photo to data URL:", error);
                alert("Could not save the cleanup photo locally, but session data will be saved.");
            }
        }
    }
    // --- End Handle Cleanup Photo ---


    // --- Save Session (Guest or Logged-in) ---
    const sessionDataToSave = { ...sessionDataBase, ...cleanupPhotoInfo }; // Combine base data + photo info

    if (!state.currentUser) {
        // Guest: Save to Local Storage
        const guestSessions = JSON.parse(localStorage.getItem('guestSessions')) || [];
        guestSessions.push(sessionDataToSave);
        localStorage.setItem('guestSessions', JSON.stringify(guestSessions));
        alert(`Session "${sessionName}" saved locally.`);
        dataModal.style.display = 'none';
        state.cleanupPhoto = null; // Clear photo after saving
        return;
    } else {
        // Logged-in: Save to Firestore
        try {
            await addDoc(collection(db, "users", state.currentUser.uid, "privateSessions"), sessionDataToSave);
            alert(`Session "${sessionName}" saved to your account!`);
            dataModal.style.display = 'none';
            state.cleanupPhoto = null; // Clear photo after saving
        } catch (error) {
            console.error("Error saving session to Firestore:", error);
            alert("Could not save session.");
        }
    }
}

/**
 * Initiates the session loading process by showing the appropriate modal.
 */
export async function loadSession() {
    if (!state.currentUser) {
        populateLocalSessionList();
        document.getElementById('localSessionsModal').style.display = 'flex';
    } else {
        await populateSessionList();
        document.getElementById('sessionsModal').style.display = 'flex';
    }
}

/**
 * Populates the modal with a list of locally saved guest sessions.
 */
function populateLocalSessionList() {
    const localSessionList = document.getElementById('localSessionList');
    const guestSessions = JSON.parse(localStorage.getItem('guestSessions')) || [];
    localSessionList.innerHTML = '';

    if (guestSessions.length === 0) {
        localSessionList.innerHTML = '<li>No locally saved sessions found.</li>';
        return;
    }

    guestSessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).forEach((sessionData, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<div><span>${sessionData.sessionName}</span><br><small class="session-date">${new Date(sessionData.timestamp).toLocaleDateString()}</small></div><button class="delete-session-btn">Delete</button>`;
        li.querySelector('div').addEventListener('click', () => loadSpecificLocalSession(index));
        li.querySelector('button').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteLocalSession(index, sessionData.sessionName);
        });
        localSessionList.appendChild(li);
    });
}

/**
 * Deletes a specific session from local storage.
 */
function deleteLocalSession(sessionIndex, sessionName) {
    if (confirm(`Are you sure you want to delete "${sessionName}"?`)) {
        let guestSessions = JSON.parse(localStorage.getItem('guestSessions')) || [];
        guestSessions.splice(sessionIndex, 1);
        localStorage.setItem('guestSessions', JSON.stringify(guestSessions));
        alert("Session deleted.");
        populateLocalSessionList();
    }
}

/**
 * Loads a specific guest session from local storage into the application state.
 */
function loadSpecificLocalSession(sessionIndex) {
    const guestSessions = JSON.parse(localStorage.getItem('guestSessions')) || [];
    const sessionData = guestSessions[sessionIndex];
    if (sessionData) {
        clearCurrentSession();
        const convertedData = {
            ...sessionData,
            pins: convertPinsFromFirestore(sessionData.pins),
            route: convertRouteFromFirestore(sessionData.route)
        };
        displaySessionData(convertedData);
        alert(`Session "${sessionData.sessionName}" loaded!`);
        document.getElementById('localSessionsModal').style.display = 'none';
        
        // Automatically pan to the loaded route
        centerOnRoute(); 
    }
}

/**
 * Populates the modal with a list of cloud-saved sessions from Firestore.
 */
async function populateSessionList() {
    const sessionList = document.getElementById('sessionList');
    sessionList.innerHTML = '<li>Loading...</li>';
    try {
        const q = query(collection(db, "users", state.currentUser.uid, "privateSessions"), orderBy("timestamp", "desc"));
        const querySnapshot = await getDocs(q);
        sessionList.innerHTML = '';
        if (querySnapshot.empty) {
            sessionList.innerHTML = '<li>No saved cloud sessions found.</li>';
            return;
        }
        querySnapshot.forEach(doc => {
            const sessionData = doc.data();
            const li = document.createElement('li');
            li.innerHTML = `<div><span>${sessionData.sessionName}</span><br><small class="session-date">${new Date(sessionData.timestamp.seconds * 1000).toLocaleDateString()}</small></div><button class="delete-session-btn">Delete</button>`;
            li.querySelector('div').addEventListener('click', () => loadSpecificSession(doc.id));
            li.querySelector('button').addEventListener('click', (e) => {
                e.stopPropagation();
                deletePrivateSession(doc.id, sessionData.sessionName);
            });
            sessionList.appendChild(li);
        });
    } catch (error) {
        console.error("Error fetching sessions:", error);
        sessionList.innerHTML = '<li>Could not load sessions.</li>';
    }
}

/**
 * Deletes a specific private session from Firestore.
 */
async function deletePrivateSession(sessionId, sessionName) {
    if (confirm(`Are you sure you want to delete "${sessionName}"?`)) {
        try {
            await deleteDoc(doc(db, "users", state.currentUser.uid, "privateSessions", sessionId));
            alert("Session deleted.");
            populateSessionList();
        } catch (error) {
            console.error("Error deleting session:", error);
            alert("Failed to delete session.");
        }
    }
}

/**
 * Loads a specific session from Firestore into the application state.
 */
async function loadSpecificSession(sessionId) {
    try {
        const docSnap = await getDoc(doc(db, "users", state.currentUser.uid, "privateSessions", sessionId));
        if (docSnap.exists()) {
            clearCurrentSession();
            const sessionData = docSnap.data();
            displaySessionData({
                ...sessionData,
                pins: convertPinsFromFirestore(sessionData.pins),
                route: convertRouteFromFirestore(sessionData.route)
            });
            alert(`Session "${sessionData.sessionName}" loaded!`);
            document.getElementById('sessionsModal').style.display = 'none';
            
            // Automatically pan to the loaded route
            centerOnRoute(); 
        }
    } catch (error) {
        console.error("Error loading specific session:", error);
        alert("Failed to load session.");
    }
}

/**
 * Clears the current route and pin data from the state and map.
 */
export function clearCurrentSession() {
    state.userMarkers.forEach(marker => marker.remove());
    state.userMarkers = [];
    state.photoPins = [];
    state.routeCoordinates = [];
    updateUserPinsSource();
    if (state.map && state.map.getSource('user-route')) {
        state.map.getSource('user-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
    }
}

/**
 * Renders session data (pins and route) onto the map.
 */
function displaySessionData(data) {
    state.photoPins = data.pins || [];
    state.routeCoordinates = data.route || [];

    state.photoPins.forEach(pin => createAndAddMarker(pin, 'user'));
    updateUserPinsSource();

    if (state.map && state.map.getSource('user-route')) {
        state.map.getSource('user-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: state.routeCoordinates } });
    }
}

/**
 * Exports the current session data as a downloadable GeoJSON file.
 */
export function exportGeoJSON() {
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
    const fileName = `litter_bugs_data_${timestamp}.geojson`;

    const pinFeatures = state.photoPins.map(pin => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pin.coords },
        properties: { title: pin.title, image_url: pin.imageURL || 'local_data', category: pin.category }
    }));
    const routeFeature = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: state.routeCoordinates },
        properties: {}
    };

    const geojson = { type: 'FeatureCollection', features: [...pinFeatures, routeFeature] };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojson, null, 2));

    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", fileName);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    document.getElementById('dataModal').style.display = 'none';
}
