import { 
    db, serverTimestamp, Timestamp, collection, getDocs, query, orderBy, addDoc, doc, getDoc, where, setDoc, deleteDoc, updateDoc, onSnapshot, limit, startAt, endAt, storage, ref, uploadBytes, getDownloadURL, runTransaction, deleteField 
} from './firebase.js';
import { state, allBadges, allTitles, profanityList } from './config.js';
import { convertRouteForFirestore, convertPinsForFirestore, convertRouteFromFirestore, convertPinsFromFirestore, calculateRouteDistance } from './utils.js';
import { clearCurrentSession } from './data.js';
import { showPublicProfile } from './ui.js';
import { checkXpDelta, getLevelBadgeHTML, renderProfileXpSection } from './xp.js';
import { geohashQueryBounds, distanceBetween } from 'https://cdn.jsdelivr.net/npm/geofire-common@6.0.0/+esm';

// utils.calculateRouteDistance returns METERS; convert to miles when needed.
const METERS_TO_MILES = 0.000621371;

// --- Helper: Get Distance for Events ---
function getDistanceInMiles(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return null;
    const R = 3958.8; 
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
    return R * c;
}

// --- Community recency window (Phase 1, community-view redesign) ---
// config/communityView.windowDays is the shared, admin-controlled window for
// the individual community pin layer, synced across Android / iOS / web.
// Clamp [7, 90], fallback 45 if missing/unreadable. Plain getDoc on public
// config — guest-safe, no auth assumed.
const COMMUNITY_WINDOW_DEFAULT = 45;
const COMMUNITY_WINDOW_MIN = 7;
const COMMUNITY_WINDOW_MAX = 90;

export async function fetchCommunityWindowDays() {
  try {
    const snap = await getDoc(doc(db, "config", "communityView"));
    if (!snap.exists()) return COMMUNITY_WINDOW_DEFAULT;
    const n = Number(snap.data().windowDays);
    if (!Number.isFinite(n)) return COMMUNITY_WINDOW_DEFAULT;
    return Math.min(Math.max(Math.round(n), COMMUNITY_WINDOW_MIN), COMMUNITY_WINDOW_MAX);
  } catch (e) {
    console.warn("communityView config read failed; using default window:", e);
    return COMMUNITY_WINDOW_DEFAULT;
  }
}

// Writes the global community recency window. Affects every user on every
// platform. merge so it self-seeds and never clobbers sibling config fields.
// Clamped [7,90] on write too — defense in depth so no reader sees out-of-range.
export async function setCommunityWindowDays(days) {
  const clamped = Math.min(Math.max(Math.round(Number(days)), COMMUNITY_WINDOW_MIN), COMMUNITY_WINDOW_MAX);
  await setDoc(doc(db, "config", "communityView"), { windowDays: clamped }, { merge: true });
  return clamped;
}

// --- Community View (Phase 4: geohash viewport fetch + smooth refresh) ---
//
// Reads are bounded by the visible viewport via geohash ranges — no longer the
// whole collection. Recency (windowDays) is enforced CLIENT-SIDE so every query
// stays single-field on `geohash` (automatic index, no composite index needed).
// Pins update via source.setData() so panning doesn't tear down/rebuild layers.
export async function fetchAndDisplayCommunityRoutes() {
  try {
    if (!state.map || !state.map.isStyleLoaded()) return;

    const windowDays = await fetchCommunityWindowDays();
    const now = Date.now();

    // Viewport → center + radius (metres) reaching the far corner, so the
    // geohash circle covers the visible box.
    const b = state.map.getBounds();
    const center = [b.getCenter().lat, b.getCenter().lng]; // geofire wants [lat, lng]
    const ne = b.getNorthEast();
    const radiusM = Math.max(distanceBetween([center[0], center[1]], [ne.lat, ne.lng]) * 1000, 1);

    // Up to ~9 geohash range pairs covering the circle — one query each.
    const bounds = geohashQueryBounds(center, radiusM);
    const snaps = await Promise.all(
      bounds.map(([start, end]) =>
        getDocs(query(
          collection(db, "publishedRoutes"),
          orderBy("geohash"),
          startAt(start),
          endAt(end)
        )).catch(err => {
          console.warn('Community geohash query failed for a bound:', err);
          return { forEach: () => {} }; // shape-compatible empty result
        })
      )
    );

    // Merge + dedupe by doc id, then build pin features (recency + coord filtered).
    const seen = new Set();
    const allPinFeatures = [];
    const mapBounds = state.map.getBounds();

    snaps.forEach(snap => {
      snap.forEach(doc => {
        if (seen.has(doc.id)) return;
        seen.add(doc.id);

        const routeData = doc.data();
        const routeId = doc.id;

        // Route age (days) from the single publish timestamp — shared by all its
        // pins. Missing → age 0 (full opacity). Recency drop happens here.
        const _ts = routeData.timestamp;
        const _tsMs = _ts && typeof _ts.toMillis === 'function'
          ? _ts.toMillis()
          : (_ts && _ts.seconds ? _ts.seconds * 1000 : (_ts instanceof Date ? _ts.getTime() : null));
        const routeAgeDays = _tsMs != null ? (now - _tsMs) / 86400000 : 0;
        if (routeAgeDays >= windowDays) return; // outside the window — skip

        const mapboxPins = convertPinsFromFirestore(routeData.pins);
        if (!mapboxPins) return;

        mapboxPins.forEach(pin => {
          // Validate coords (a bad pair poisons the whole GeoJSON source).
          if (!pin || !pin.coords) {
            console.warn('Skipping community pin with missing coords', { routeId, pin });
            return;
          }
          const c = pin.coords;
          const lngLat = Array.isArray(c)
            ? (c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null)
            : (Number.isFinite(c.lng) && Number.isFinite(c.lat) ? [c.lng, c.lat] : null);
          if (!lngLat) {
            console.warn('Skipping community pin with invalid coords', { routeId, pin });
            return;
          }
          // Geohash false-positive trim: keep only pins actually in the viewport box.
          if (!mapBounds.contains(lngLat)) return;

          allPinFeatures.push({
            'type': 'Feature',
            'properties': {
              title: pin.title,
              category: pin.category,
              imageURL: pin.imageURL,
              thumbnailURL: pin.thumbnailURL,
              username: routeData.username,
              userId: routeData.userId,
              routeId: routeId,       // Saved for God Mode Deletion
              ageDays: routeAgeDays   // Phase 3 — per-pin age fade
            },
            'geometry': { 'type': 'Point', 'coordinates': lngLat }
          });
        });
      });
    });

    // Ensure the source + layers exist (once), then just swap the data.
    ensureCommunityLayers(windowDays);
    const src = state.map.getSource('community-pins');
    if (src) src.setData({ 'type': 'FeatureCollection', 'features': allPinFeatures });

  } catch (error) {
    console.error("Error fetching community routes:", error);
  }
}

// One-time setup of the community-pins source, cluster/point layers, and click
// handlers. Idempotent: safe to call on every fetch — it no-ops once built.
// windowDays drives the age-fade interpolate stops.
function ensureCommunityLayers(windowDays) {
  if (!state.map || state.map.getSource('community-pins')) return;

  state.map.addSource('community-pins', {
    type: 'geojson',
    data: { 'type': 'FeatureCollection', 'features': [] },
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50
  });

  state.map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'community-pins',
    filter: ['has', 'point_count'],
    paint: { 'circle-color': '#4A7C59', 'circle-radius': ['step', ['get', 'point_count'], 20, 100, 30, 750, 40] }
  });

  state.map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'community-pins',
    filter: ['has', 'point_count'],
    layout: { 'text-field': '{point_count_abbreviated}', 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'], 'text-size': 12 },
    paint: { 'text-color': '#ffffff' }
  });

  // Phase 3 — age fade. Full opacity ≤7d, linear ramp to 0 by day N.
  // max(windowDays, 8) guards the N=7 case (interpolate stops must ascend).
  const fadeExpr = [
    'interpolate', ['linear'], ['get', 'ageDays'],
    7, 1.0,
    Math.max(windowDays, 8), 0.0
  ];
  state.map.addLayer({
    id: 'unclustered-point',
    type: 'circle',
    source: 'community-pins',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': '#4A7C59',
      'circle-radius': 8,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': fadeExpr,
      'circle-stroke-opacity': fadeExpr
    }
  });

  state.map.on('click', 'clusters', (e) => {
    const features = state.map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
    const clusterId = features[0].properties.cluster_id;
    state.map.getSource('community-pins').getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      state.map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom });
    });
  });

  state.map.on('click', 'unclustered-point', async (e) => {
    const properties = e.features[0].properties;
    showPublicProfile(properties.userId, properties);
  });

  ['clusters', 'unclustered-point'].forEach(layer => {
    state.map.on('mouseenter', layer, () => { state.map.getCanvas().style.cursor = 'pointer'; });
    state.map.on('mouseleave', layer, () => { state.map.getCanvas().style.cursor = ''; });
  });
}
export function toggleCommunityView() {
    state.isCommunityViewOn = !state.isCommunityViewOn;
    const communityBtn = document.getElementById('communityBtn');
    if (state.isCommunityViewOn) {
        communityBtn.textContent = '🌎 Community View: ON';
        communityBtn.classList.remove('off');
        fetchAndDisplayCommunityRoutes();
    } else {
        communityBtn.textContent = '🌎 Community View: OFF';
        communityBtn.classList.add('off');
        clearCommunityRoutes();
    }
}

function clearCommunityRoutes() {
  if (!state.map || !state.map.isStyleLoaded()) return;
  if (state.map.getLayer('clusters')) state.map.removeLayer('clusters');
  if (state.map.getLayer('cluster-count')) state.map.removeLayer('cluster-count');
  if (state.map.getLayer('unclustered-point')) state.map.removeLayer('unclustered-point');
  if (state.map.getSource('community-pins')) state.map.removeSource('community-pins');
  state.communityLayers.forEach(layer => {
    if (state.map.getLayer(layer.id)) state.map.removeLayer(layer.id);
    if (state.map.getSource(layer.id)) state.map.removeSource(layer.id);
  });
  state.communityLayers = [];
}

// --- Publishing & Profile Management ---

export async function publishRoute() {
    if (!state.currentUser) return;
    if (state.routeCoordinates.length < 2 || state.photoPins.length === 0) {
        alert("You need a tracked route and at least one photo pin to publish.");
        return;
    }
    
    const publishBtn = document.getElementById('publishBtn');
    const originalText = publishBtn.innerText;
    publishBtn.innerText = "Publishing...";
    publishBtn.disabled = true;
    document.getElementById('dataModal').style.display = 'none';

    try {
        const publicProfileRef = doc(db, "publicProfiles", state.currentUser.uid);
        const beforeSnap = await getDoc(publicProfileRef);
        const badgesBefore = beforeSnap.exists() ? Object.keys(beforeSnap.data().badges || {}) : [];
        const username = beforeSnap.exists() ? beforeSnap.data().username : "Anonymous";

        // Snapshot XP + level BEFORE the write for the post-publish XP delta check.
        const xpBefore    = beforeSnap.exists() ? (beforeSnap.data().xp    ?? 0) : 0;
        const levelBefore = beforeSnap.exists() ? (beforeSnap.data().level  ?? 1) : 1;

        // calculateRouteDistance returns METERS; store both for safety.
        const distanceMeters = calculateRouteDistance(state.routeCoordinates);
        const distanceMiles = distanceMeters * METERS_TO_MILES;
        const distanceStr = `${distanceMiles.toFixed(2)} mi`;

        // 1. Try to upload the specific "Summary Photo"
        let cleanupPhotoURL = null;
        if (state.cleanupPhoto) {
            try {
                const photoRef = ref(storage, `cleanup_photos/${state.currentUser.uid}/${Date.now()}.jpg`);
                const snapshot = await uploadBytes(photoRef, state.cleanupPhoto);
                cleanupPhotoURL = await getDownloadURL(snapshot.ref);
            } catch (uploadError) {
                console.error("Photo upload failed:", uploadError);
            }
        }

        // 2. FALLBACK: If no summary photo, use the first Pin Photo!
        if (!cleanupPhotoURL && state.photoPins.length > 0) {
            const firstPin = state.photoPins[0];
            // Only use it if it's already a valid Firebase URL (from logged-in tracking)
            if (firstPin.imageURL && firstPin.imageURL.startsWith('http')) {
                cleanupPhotoURL = firstPin.imageURL;
            }
        }

        // 3. Save to Firestore
        await addDoc(collection(db, "publishedRoutes"), {
            userId: state.currentUser.uid,
            username: username,
            timestamp: new Date(),
            route: convertRouteForFirestore(state.routeCoordinates),
            pins: convertPinsForFirestore(state.photoPins),
            distance: distanceMiles, // miles, matches what UI displays
            distanceMiles: distanceStr,
            cleanupPhotoURL: cleanupPhotoURL,
            likeCount: 0,
            likedBy: []
        });

        // Trigger the milestone check (server-side adds to publicProfiles)
        await checkForTitleMilestones(state.currentUser.uid, state.routeCoordinates);

        // Confirm publish immediately - no blocking 2s wait on the Cloud Function.
        alert("Success! Your route has been published.");
        clearCurrentSession();

        // Listen in the background for new badges. If/when the badge-awarding Cloud
        // Function updates the profile doc, show the achievement popup.
        let unsubscribe = null;
        const timeoutId = setTimeout(() => {
            if (unsubscribe) unsubscribe();
        }, 15000);

        unsubscribe = onSnapshot(publicProfileRef, (snap) => {
            if (!snap.exists()) return;
            const badgesAfter = Object.keys(snap.data().badges || {});
            const newBadges = badgesAfter.filter(b => !badgesBefore.includes(b));
            if (newBadges.length > 0) {
                clearTimeout(timeoutId);
                if (unsubscribe) unsubscribe();
                showPopup(newBadges[0]);
            }
        });

        // Non-blocking XP check: waits 3s, reads updated profile, shows XP toast
        // or level-up overlay if XP increased. Silent if delta === 0.
        checkXpDelta(state.currentUser.uid, xpBefore, levelBefore);
    } catch (error) {
        console.error("Error publishing route:", error);
        alert("There was an error publishing your route.");
    } finally {
        publishBtn.innerText = originalText;
        publishBtn.disabled = false;
    }
}

export async function populatePublishedRoutesList() {
    const publishedRoutesList = document.getElementById('publishedRoutesList');
    publishedRoutesList.innerHTML = '<li>Loading your publications...</li>';
    try {
        const q = query(collection(db, "publishedRoutes"), where("userId", "==", state.currentUser.uid), orderBy("timestamp", "desc"));
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
            publishedRoutesList.innerHTML = '<li>You have not published any routes yet.</li>';
            return;
        }
        publishedRoutesList.innerHTML = '';
        querySnapshot.forEach(doc => {
            const routeData = doc.data();
            const li = document.createElement('li');
            li.innerHTML = `<div><span>Route published on</span><br><small class="session-date">${new Date(routeData.timestamp.seconds * 1000).toLocaleString()}</small></div><button class="delete-session-btn">Delete</button>`;
            li.querySelector('button').addEventListener('click', (e) => {
                e.stopPropagation();
                deletePublishedRoute(doc.id);
            });
            publishedRoutesList.appendChild(li);
        });
    } catch (error) {
        console.error("Error fetching published routes:", error);
        publishedRoutesList.innerHTML = '<li>Could not load publications.</li>';
    }
}

async function deletePublishedRoute(routeId) {
    // Only confirm if not already confirmed by the UI calling this
    try {
        await deleteDoc(doc(db, "publishedRoutes", routeId));
        alert("Route deleted from the community map.");
        populatePublishedRoutesList();
        if (state.isCommunityViewOn) {
            fetchAndDisplayCommunityRoutes();
        }
    } catch (error) {
        console.error("Error deleting published route:", error);
        alert("Failed to delete route.");
    }
}

export async function loadProfileForEditing() {
    if (!state.currentUser) return;
    try {
        const docSnap = await getDoc(doc(db, "publicProfiles", state.currentUser.uid));
        if (docSnap.exists()) {
            const profileData = docSnap.data();
            document.getElementById('bioInput').value = profileData.bio || '';
            document.getElementById('locationInput').value = profileData.location || '';
            document.getElementById('coffeeLinkInput').value = profileData.buyMeACoffeeLink || '';
            // Note: selectedTitle is no longer in this form — it lives in My Profile.
        }
    } catch (error) {
        console.error("Error loading profile:", error);
        alert("Could not load your profile for editing.");
    }
}

export async function saveProfile() {
    if (!state.currentUser) return;
    const bio = document.getElementById('bioInput').value;
    const location = document.getElementById('locationInput').value;
    const coffeeLink = document.getElementById('coffeeLinkInput').value;

    try {
        const publicProfileRef = doc(db, "publicProfiles", state.currentUser.uid);
        await updateDoc(publicProfileRef, { 
            bio, 
            location, 
            buyMeACoffeeLink: coffeeLink
            // selectedTitle intentionally omitted — managed in My Profile only
        });
        alert("Profile updated successfully!");
        document.getElementById('profileModal').style.display = 'none';
    } catch (error) {
        console.error("Error saving profile:", error);
        alert("Error saving profile.");
    }
}

export async function fetchAndDisplayLeaderboard(metric) {
    const leaderboardList = document.getElementById('leaderboardList');
    if (!leaderboardList) return;
    leaderboardList.innerHTML = '<li style="padding:16px; text-align:center; color:#888;">Loading…</li>';

    const RANK_EMOJI = { 1: '🥇', 2: '🥈', 3: '🥉' };

    try {
        const q = query(
            collection(db, "publicProfiles"),
            where(metric, ">", 0),
            orderBy(metric, "desc"),
            limit(10)
        );
        const snap = await getDocs(q);

        if (snap.empty) {
            leaderboardList.innerHTML = '<li style="padding:20px; text-align:center; color:#888;">No active Troopers yet. Be the first!</li>';
            return;
        }

        const currentUid = state.currentUser?.uid;
        leaderboardList.className = 'lb-list';
        leaderboardList.innerHTML = '';
        let rank = 1;

        snap.forEach(d => {
            const p = d.data();
            const uid = d.id;
            const isMe = uid === currentUid;

            const score = metric === 'totalDistance'
                ? `${((p.totalDistance || 0) * 0.000621371).toFixed(1)} mi`
                : (p[metric] || 0).toLocaleString();

            const initial = (p.username || '?')[0].toUpperCase();
            const rankDisplay = RANK_EMOJI[rank]
                ? `<span class="lb-rank-emoji">${RANK_EMOJI[rank]}</span>`
                : `<span class="lb-rank-num">${rank}</span>`;

            // Level badge — respects showLevel && level > 1
            const badge = (p.showLevel !== false && (p.level ?? 1) > 1)
                ? `<span style="
                    display:inline-flex; align-items:center; justify-content:center;
                    width:18px; height:18px; border-radius:50%;
                    background:radial-gradient(circle at 40% 35%,#FFD700,#FF8C00);
                    color:white; font-weight:700; font-size:10px; line-height:1;
                    vertical-align:middle; margin-left:3px; flex-shrink:0;
                  ">${p.level}</span>`
                : '';

            const titleLine = (p.selectedTitle && allTitles[p.selectedTitle])
                ? `<div class="lb-title">${allTitles[p.selectedTitle].name}</div>`
                : '';

            const li = document.createElement('li');
            li.className = `lb-card${rank === 1 ? ' lb-rank-1' : rank === 2 ? ' lb-rank-2' : rank === 3 ? ' lb-rank-3' : ''}${isMe ? ' lb-me' : ''}`;
            li.dataset.uid = uid;
            li.innerHTML = `
                ${rankDisplay}
                <div class="lb-avatar">${initial}</div>
                <div class="lb-info">
                    <div class="lb-name-row">
                        <span class="lb-username">${escLb(p.username || 'Unknown')}</span>
                        ${badge}
                        ${isMe ? '<span style="font-size:0.72em; color:#4A7C59; margin-left:4px;">(you)</span>' : ''}
                    </div>
                    ${titleLine}
                </div>
                <div class="lb-score">${score}</div>
            `;
            // Whole card is clickable → profile viewer
            li.addEventListener('click', () => {
                document.getElementById('leaderboardModal').style.display = 'none';
                showPublicProfile(uid);
            });
            leaderboardList.appendChild(li);
            rank++;
        });

    } catch (error) {
        console.error("Error fetching leaderboard:", error);
        leaderboardList.innerHTML = '<li style="padding:16px; text-align:center; color:#888;">Could not load leaderboard.</li>';
    }
}

/**
 * Squads leaderboard — ranked by totalPins, shows callsign, name, member count.
 * Rendered into #squadsLeaderboardContainer.
 */
export async function fetchSquadsLeaderboard() {
    const container = document.getElementById('squadsLeaderboardContainer');
    if (!container) return;
    container.innerHTML = '<p style="padding:16px; text-align:center; color:#888;">Loading…</p>';

    const RANK_EMOJI = { 1: '🥇', 2: '🥈', 3: '🥉' };

    try {
        const q = query(
            collection(db, "squads"),
            where("totalPins", ">", 0),
            orderBy("totalPins", "desc"),
            limit(10)
        );
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = '<p style="padding:20px; text-align:center; color:#888;">No squads have logged pins yet. Yours could be first!</p>';
            return;
        }

        const currentUid = state.currentUser?.uid;
        let html = '<ul class="lb-list">';
        let rank = 1;

        snap.forEach(d => {
            const sq = d.data();
            const memberCount = sq.memberCount
                || (sq.members && typeof sq.members === 'object' && !Array.isArray(sq.members)
                    ? Object.keys(sq.members).length : 0);
            const isMySquad = sq.members &&
                typeof sq.members === 'object' &&
                !Array.isArray(sq.members) &&
                currentUid && sq.members[currentUid];
            const rankEmoji = RANK_EMOJI[rank] || rank;

            html += `
                <li class="lb-squad-card${rank === 1 ? ' lb-rank-1' : ''}${isMySquad ? ' lb-me' : ''}">
                    <div class="lb-rank-emoji">${rankEmoji}</div>
                    <div class="lb-squad-callsign">[${escLb(sq.callsign || '?')}]</div>
                    <div class="lb-squad-info">
                        <div class="lb-squad-name">${escLb(sq.squadName || '(unnamed)')}</div>
                        <div class="lb-squad-meta">
                            ${memberCount} member${memberCount === 1 ? '' : 's'}
                            ${sq.homeSector ? ` · ${escLb(sq.homeSector)}` : ''}
                            ${isMySquad ? ' · <span style="color:#4A7C59; font-weight:600;">Your Squad</span>' : ''}
                        </div>
                    </div>
                    <div class="lb-squad-score">${(sq.totalPins || 0).toLocaleString()} pins</div>
                </li>
            `;
            rank++;
        });
        html += '</ul>';
        container.innerHTML = html;

    } catch (err) {
        console.error('fetchSquadsLeaderboard failed:', err);
        container.innerHTML = '<p style="padding:16px; text-align:center; color:#888;">Could not load squads leaderboard.</p>';
    }
}

function escLb(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export async function fetchAndDisplayMyStats() {
    const myStatsContainer = document.getElementById('myStatsContainer');
    myStatsContainer.innerHTML = '';
    if (!state.currentUser) {
        myStatsContainer.innerHTML = '<p class="login-prompt">Please log in to view your personal stats.</p>';
        return;
    }
    try {
        const publicProfileRef = doc(db, "publicProfiles", state.currentUser.uid);
        const publicProfileSnap = await getDoc(publicProfileRef);
        if (!publicProfileSnap.exists()) {
            myStatsContainer.innerHTML = '<p class="login-prompt">Could not find your profile data.</p>';
            return;
        }
        const profileData = publicProfileSnap.data();

        // XP / Level section — rendered first so it's the first thing the user sees.
        // The uid param enables the show-level toggle write (the only permitted client write).
        const xpDiv = document.createElement('div');
        renderProfileXpSection(xpDiv, profileData, state.currentUser.uid);
        myStatsContainer.appendChild(xpDiv);

        const distanceMiles = ((profileData.totalDistance || 0) * 0.000621371).toFixed(2);
        let statsHTML = `
            <div class="my-stats-grid">
                <div class="stat-card"><div class="my-stats-value">${profileData.totalPins || 0}</div><div class="my-stats-label">Items Pinned</div></div>
                <div class="stat-card"><div class="my-stats-value">${distanceMiles}</div><div class="my-stats-label">Miles Cleaned</div></div>
                <div class="stat-card"><div class="my-stats-value">${profileData.totalRoutes || 0}</div><div class="my-stats-label">Routes Completed</div></div>
            </div>
            <h4>My Badges</h4><div class="my-stats-badges"><div class="badge-container">`;
        const userBadges = profileData.badges || {};
        let earnedBadgesCount = 0;
        for (const badgeKey in allBadges) {
            if (userBadges[badgeKey] === true) {
                earnedBadgesCount++;
                const badgeInfo = allBadges[badgeKey];
                statsHTML += `<div class="badge-item" title="${badgeInfo.name}: ${badgeInfo.description}">${badgeInfo.icon}</div>`;
            }
        }
        if (earnedBadgesCount === 0) statsHTML += '<p class="no-badges-message">You haven\'t earned any badges yet. Keep cleaning!</p>';
        statsHTML += `</div></div>`;

        const statsDiv = document.createElement('div');
        statsDiv.innerHTML = statsHTML;
        myStatsContainer.appendChild(statsDiv);
    } catch (error) {
        console.error("Error fetching your stats:", error);
        myStatsContainer.innerHTML = '<p class="login-prompt">Could not load your stats.</p>';
    }
}

function showPopup(badgeKey) {
    const badge = allBadges[badgeKey];
    if (!badge) return;
    const Modal = document.getElementById('Modal');
    // Assuming you have modal structure for badges
    if(Modal) {
        Modal.querySelector('.badge-icon').textContent = badge.icon;
        document.getElementById('badgeName').textContent = badge.name;
        document.getElementById('badgeDescription').textContent = badge.description;
        Modal.style.display = 'flex';
    }
}

// --- POI Listeners & Meetups ---

export function setupPoiClickListeners() {
    const poiLayers = ['poi-label', 'transit-label', 'airport-label', 'natural-point-label', 'natural-line-label', 'water-point-label', 'water-line-label', 'waterway-label'];
    
    poiLayers.forEach(layerId => {
        if (state.map.getLayer(layerId)) {
            state.map.on('click', layerId, (e) => {
                if (e.features.length > 0) {
                    const feature = e.features[0];
                    const name = feature.properties.name || "Unknown Location";
                    const coords = e.lngLat; 

                    const popupHTML = `
                        <div>
                            <strong>${name}</strong>
                            <div class="poi-popup-buttons">
                                <button class="modal-button schedule-btn">Schedule Meetup</button>
                                <button class="modal-button view-btn">View Meetups</button>
                            </div>
                        </div>`;
                        
                    const popup = new mapboxgl.Popup()
                        .setLngLat(coords)
                        .setHTML(popupHTML)
                        .addTo(state.map);

                    popup.getElement().querySelector('.schedule-btn').addEventListener('click', () => {
                        openMeetupModal(name, coords.lat, coords.lng);
                        popup.remove();
                    });

                    popup.getElement().querySelector('.view-btn').addEventListener('click', () => {
                        openViewMeetupsModal(name);
                        popup.remove();
                    });
                }
            });
            state.map.on('mouseenter', layerId, () => { state.map.getCanvas().style.cursor = 'pointer'; });
            state.map.on('mouseleave', layerId, () => { state.map.getCanvas().style.cursor = ''; });
        }
    });
}

function openMeetupModal(poiName, lat, lng) {
    if (!state.currentUser) {
        alert("Please log in to schedule a meetup.");
        return;
    }
    
    document.getElementById('meetupLocationName').textContent = poiName;
    document.getElementById('poiNameInput').value = poiName;
    document.getElementById('meetupLat').value = lat;
    document.getElementById('meetupLng').value = lng;
    document.getElementById('meetupDateInput').value = '';
    document.getElementById('meetupModal').style.display = 'flex';
    validateMeetupForm();
}

// Build a single word-boundary regex once. Substring matching would flag innocent
// words like "class" or "assignment" because they contain banned substrings.
const _escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _profanityRegex = profanityList && profanityList.length
    ? new RegExp('\\b(' + profanityList.map(_escapeRegex).join('|') + ')\\b', 'i')
    : null;

export function validateMeetupForm() {
    const title = document.getElementById('meetupTitleInput').value.trim();
    const description = document.getElementById('meetupDescriptionInput').value.trim();
    const dateVal = document.getElementById('meetupDateInput').value;
    const safetyChecked = document.getElementById('safetyCheckbox').checked;
    const createBtn = document.getElementById('createMeetupBtn');
    const profanityWarning = document.getElementById('profanityWarning');

    const hasProfanity = _profanityRegex
        ? (_profanityRegex.test(title) || _profanityRegex.test(description))
        : false;
    if (profanityWarning) profanityWarning.style.display = hasProfanity ? 'block' : 'none';

    createBtn.disabled = !(title && description && dateVal && safetyChecked && !hasProfanity);
}

export async function handleMeetupSubmit() {
    if (!state.currentUser) return;

    const title = document.getElementById('meetupTitleInput').value.trim();
    const description = document.getElementById('meetupDescriptionInput').value.trim();
    const dateVal = document.getElementById('meetupDateInput').value;
    const poiName = document.getElementById('poiNameInput').value;
    const latStr = document.getElementById('meetupLat').value;
    const lngStr = document.getElementById('meetupLng').value;

    try {
        const publicProfileRef = doc(db, "publicProfiles", state.currentUser.uid);
        const docSnap = await getDoc(publicProfileRef);
        if (!docSnap.exists()) throw new Error("Could not find your public profile.");

        const profile = docSnap.data();
        const username = profile.username;
        const canCreateDirectly = profile.role === 'admin' || profile.isApprovedEventOrganizer === true;

        const coordinates = (latStr && lngStr) ? {
            lat: parseFloat(latStr),
            lng: parseFloat(lngStr)
        } : null;

        if (canCreateDirectly) {
            // Approved organizer / admin path — write straight to meetups, no review.
            await addDoc(collection(db, "meetups"), {
                organizerId: state.currentUser.uid,
                organizerName: username,
                poiName: poiName,
                title: title,
                description: description,
                eventDate: new Date(dateVal),
                createdAt: new Date(),
                coordinates: coordinates
            });
            alert("Meetup scheduled successfully!");
        } else {
            // Default user path — submit to eventRequests for admin approval.
            // termsAccepted is required by the security rules.
            await addDoc(collection(db, "eventRequests"), {
                organizerId: state.currentUser.uid,
                organizerName: username,
                poiName: poiName || null,
                title: title,
                description: description,
                eventDate: new Date(dateVal),
                createdAt: new Date(),
                coordinates: coordinates,
                status: "pending",
                termsAccepted: true
            });
            alert("Your event has been submitted for admin review. You'll see it on the map once approved.");
        }

        document.getElementById('meetupModal').style.display = 'none';
        document.getElementById('meetupTitleInput').value = '';
        document.getElementById('meetupDescriptionInput').value = '';
        document.getElementById('meetupDateInput').value = '';
        document.getElementById('safetyCheckbox').checked = false;
    } catch (error) {
        console.error("Error scheduling meetup:", error);
        alert("There was an error scheduling your meetup.");
    }
}

// --- EVENTS / MEETUPS SYSTEM (With Admin/Owner Delete) ---
export async function fetchAndDisplayAllEvents() {
    const list = document.getElementById('eventsList');
    if (!list) return;

    list.innerHTML = '<p style="text-align:center;">Scanning for local signals...</p>';

    try {
        // 1. Check Admin Status
        let isAdmin = false;
        if (state.currentUser) {
            try {
                const profileDoc = await getDoc(doc(db, "publicProfiles", state.currentUser.uid));
                if (profileDoc.exists() && profileDoc.data().role === 'admin') {
                    isAdmin = true;
                }
            } catch (e) { console.log("Not admin"); }
        }

        // 2. Query Events
        const q = query(
            collection(db, "meetups"),
            orderBy("eventDate", "asc") 
        );

        const querySnapshot = await getDocs(q);
        list.innerHTML = ""; 

        if (querySnapshot.empty) {
            list.innerHTML = `
                <div style="text-align:center; padding:20px; color:#666;">
                    <h3>No Active Signals</h3>
                    <p>There are no scheduled cleanups.</p>
                </div>
            `;
            return;
        }

        // 3. Loop and Create Cards
        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const eventId = docSnap.id;
            
            // PERMISSIONS: Admin OR Organizer
            const isOrganizer = state.currentUser && (data.organizerId === state.currentUser.uid);
            const canDelete = isAdmin || isOrganizer;

            // --- DATE & TIME FORMATTING ---
            let dateStr = "Date TBD";
            let timeStr = "";
            let isPast = false;

            if (data.eventDate && data.eventDate.seconds) {
                const dateObj = new Date(data.eventDate.seconds * 1000);
                if (dateObj < new Date()) isPast = true; 

                dateStr = dateObj.toLocaleDateString(undefined, { 
                    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' 
                });
                timeStr = dateObj.toLocaleTimeString(undefined, { 
                    hour: 'numeric', minute: '2-digit' 
                });
            }

            // Visual style
            const cardOpacity = isPast ? '0.6' : '1';
            const statusLabel = isPast ? '<span style="color:red; font-size:0.8em;">(ENDED)</span>' : '';
            const borderStyle = isPast ? '4px solid #ccc' : '4px solid #4682B4';

            const card = document.createElement('div');
            card.className = 'hub-card'; 
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.gap = '5px';
            card.style.textAlign = 'left';
            card.style.borderLeft = borderStyle;
            card.style.opacity = cardOpacity;


            // --- NEW RSVP LOGIC STARTS HERE ---
            const attendees = data.attendees || [];
            const waitlist = data.waitlist || [];
            const maxAttendees = data.maxAttendees || 25;
            const currentUid = state.currentUser ? state.currentUser.uid : null;
            
            const isAttending = currentUid && attendees.includes(currentUid);
            const isWaiting = currentUid && waitlist.includes(currentUid);
            const isFull = attendees.length >= maxAttendees;

            let rsvpBtnHtml = '';
            if (!isPast) {
                if (isAttending) {
                    rsvpBtnHtml = `<button class="modal-button rsvp-action-btn" data-meetup-id="${eventId}" style="margin-top:10px; font-size:0.8em; padding:5px 10px; background:transparent; border:1px solid #D9534F; color:#D9534F;">❌ Cancel RSVP</button>`;
                } else if (isWaiting) {
                    rsvpBtnHtml = `<button class="modal-button rsvp-action-btn" data-meetup-id="${eventId}" style="margin-top:10px; font-size:0.8em; padding:5px 10px; background:transparent; border:1px solid #D9534F; color:#D9534F;">Leave Waitlist</button>`;
                } else if (isFull) {
                    rsvpBtnHtml = `<button class="modal-button rsvp-action-btn" data-meetup-id="${eventId}" style="margin-top:10px; font-size:0.8em; padding:5px 10px; background:#FFF8E1; color:#B8860B; border:1px solid #B8860B;">Join Waitlist</button>`;
                } else {
                    rsvpBtnHtml = `<button class="modal-button rsvp-action-btn btn-primary" data-meetup-id="${eventId}" style="margin-top:10px; font-size:0.8em; padding:5px 10px;">👋 I'll be there</button>`;
                }
            }

            const attendeeStatusHtml = `<div style="font-size:0.85em; color:#4A7C59; margin-top:8px; font-weight:600;">👥 ${attendees.length} / ${maxAttendees} going ${waitlist.length > 0 ? `<span style="color:#B8860B;">(${waitlist.length} waiting)</span>` : ''}</div>`;
            // --- NEW RSVP LOGIC ENDS HERE ---


            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <h3 style="margin:0; font-size:1.1em;">
                            ${data.title || 'Untitled Event'} ${statusLabel}
                        </h3>
                        <div style="font-size:0.9em; color:#666;">
                            📅 <strong>${dateStr}</strong> @ ${timeStr}
                        </div>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:center;">
                        <span style="font-size:1.5em;">${isPast ? '🏁' : '📍'}</span>
                        ${canDelete ? `<button class="delete-event-btn" style="background:none; border:none; cursor:pointer; font-size:1.2em; margin-top:5px;" title="Delete Event">🗑️</button>` : ''}
                    </div>
                </div>
                
                <p style="font-size:0.9em; margin:5px 0; color:#444;">
                    ${data.description || 'No details provided.'}
                </p>

                <div style="font-size:0.85em; color:#888;">
                    <strong>Location:</strong> ${data.poiName || data.location || 'Unknown'} <br>
                    <small>Organizer: ${data.organizerName || 'Anonymous'}</small>
                </div>

                ${attendeeStatusHtml}
                ${rsvpBtnHtml}
            `;


            // --- NEW RSVP CLICK LISTENER STARTS HERE ---
            const rsvpBtn = card.querySelector('.rsvp-action-btn');
            if (rsvpBtn) {
                rsvpBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const btnMeetupId = e.target.getAttribute('data-meetup-id');
                    e.target.disabled = true;
                    e.target.textContent = "Processing...";
                    await toggleRSVP(btnMeetupId);
                });
            }
            // --- NEW RSVP CLICK LISTENER ENDS HERE ---


            // ATTACH DELETE LISTENER
            if (canDelete) {
                const delBtn = card.querySelector('.delete-event-btn');
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const warning = isAdmin && !isOrganizer 
                        ? "⚠️ ADMIN: Delete this user's event?" 
                        : "Delete your scheduled event?";
                        
                    if (confirm(warning)) {
                        try {
                            // Ensure deleteDoc is imported from firebase.js
                            await deleteDoc(doc(db, "meetups", eventId));
                            fetchAndDisplayAllEvents(); // Refresh list
                        } catch (err) {
                            console.error("Error deleting event:", err);
                            alert("Failed to delete event.");
                        }
                    }
                });
            }

            list.appendChild(card);
        });

    } catch (error) {
        console.error("Error loading events:", error);
        list.innerHTML = '<p style="color:red; text-align:center;">Error retrieving communication.</p>';
    }
}

function openViewMeetupsModal(poiName) {
    document.getElementById('viewMeetupsLocationName').textContent = poiName;
    const meetupsList = document.getElementById('meetupsList');
    meetupsList.innerHTML = '<li>Loading meetups...</li>';
    document.getElementById('viewMeetupsModal').style.display = 'flex';

    const q = query(collection(db, "meetups"), where("poiName", "==", poiName), orderBy("createdAt", "desc"));
    
    onSnapshot(q, (querySnapshot) => {
        meetupsList.innerHTML = '';
        if(querySnapshot.empty) { meetupsList.innerHTML = '<li>No meetups here.</li>'; return; }
        
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const dateObj = data.eventDate ? data.eventDate.toDate() : data.createdAt.toDate();
            const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            const li = document.createElement('li');
            li.innerHTML = `
                <strong>${data.title}</strong> (${dateStr})<br>
                ${data.description}
                ${state.currentUser && state.currentUser.uid === data.organizerId ? `<br><button class="del-meetup-btn" style="color:red; font-size:0.8em;">Delete</button>` : ''}
            `;
            const delBtn = li.querySelector('.del-meetup-btn');
            if(delBtn) delBtn.addEventListener('click', () => deleteMeetup(doc.id));
            
            meetupsList.appendChild(li);
        });
    });
}

async function deleteMeetup(meetupId) {
    if (confirm("Delete this meetup?")) {
        try { await deleteDoc(doc(db, "meetups", meetupId)); } 
        catch (e) { console.error(e); }
    }
}

// --- Like Functionality ---
export async function toggleRouteLike(routeId) {
    if (!state.currentUser) {
        alert("Please log in to like a route.");
        return null;
    }
    const userId = state.currentUser.uid;
    const routeRef = doc(db, "publishedRoutes", routeId);
    try {
        const routeSnap = await getDoc(routeRef);
        if (!routeSnap.exists()) return null;

        const data = routeSnap.data();
        let likedBy = data.likedBy || [];
        let likeCount = data.likeCount || 0;
        let isLiked = false;

        if (likedBy.includes(userId)) {
            likedBy = likedBy.filter(id => id !== userId);
            likeCount = Math.max(0, likeCount - 1);
            isLiked = false;
        } else {
            likedBy.push(userId);
            likeCount++;
            isLiked = true;
        }

        await updateDoc(routeRef, { likedBy: likedBy, likeCount: likeCount });
        return { likeCount, isLiked };
    } catch (error) {
        console.error("Error toggling like:", error);
        return null;
    }
}

// --- Challenges & Achievements (RESTORED & FIXED) ---

export async function openAchievementsModal() {
    const grid = document.getElementById('achievementsList');
    const title = document.getElementById('achievementsTitle');
    if (title) title.innerText = "🏆 All Achievements";
    if (!grid) return;

    grid.innerHTML = '<p>Loading...</p>';
    if (!state.currentUser) {
        grid.innerHTML = "<p>Please log in to see your achievements.</p>";
        return;
    }

    try {
        const profileRef = doc(db, "publicProfiles", state.currentUser.uid);
        const profileSnap = await getDoc(profileRef);
        const userBadges = profileSnap.exists() ? (profileSnap.data().badges || {}) : {};

        grid.innerHTML = '';
        Object.entries(allBadges).forEach(([badgeId, badgeInfo]) => {
            const hasBadge = !!userBadges[badgeId];
            const card = document.createElement('div');
            card.className = `achievement-card ${hasBadge ? 'unlocked' : 'locked'}`;
            card.title = hasBadge ? `EARNED: ${badgeInfo.description}` : `LOCKED: ${badgeInfo.description}`;
            card.innerHTML = `
                <div class="achievement-icon">${badgeInfo.icon}</div>
                <div class="achievement-name">${badgeInfo.name}</div>
                <div class="achievement-desc">${badgeInfo.description}</div>
            `;
            card.addEventListener('click', () => {
                alert(`${badgeInfo.name}\n\n${badgeInfo.description}\n\nStatus: ${hasBadge ? "✅ Earned" : "🔒 Locked"}`);
            });
            grid.appendChild(card);
        });
    } catch (error) {
        console.error("Error loading achievements:", error);
        grid.innerHTML = '<p>Error loading data.</p>';
    }
}

export async function openEventBadgesModal() {
    const list = document.getElementById('achievementsList');
    const title = document.getElementById('achievementsTitle');
    if (!list) return;
    if(title) title.innerText = "⚔️ Event Badges (Earned)";
    list.innerHTML = "<p>Loading...</p>";

    let userBadges = {};
    if (state.currentUser) {
        try {
            const userDoc = await getDoc(doc(db, "users", state.currentUser.uid));
            if (userDoc.exists()) userBadges = userDoc.data().badges || {};
        } catch (e) { console.error(e); }
    }

    list.innerHTML = ""; 
    let count = 0;
    let displayList = { ...allBadges };
    Object.keys(userBadges).forEach(k => {
        if(!displayList[k]) displayList[k] = userBadges[k];
    });

    Object.entries(displayList).forEach(([key, config]) => {
        const badgeData = userBadges[key];
        const isUnlocked = !!badgeData;
        const isChallengeBadge = key.includes('warrior') || (config.source === 'challenge') || (badgeData && badgeData.source === 'challenge');

        if (isChallengeBadge && isUnlocked) {
            count++;
            const safeConfig = {
                name: config.name || badgeData.name || "Event Badge",
                description: config.description || badgeData.description || "Legacy Reward",
                icon: config.icon || badgeData.icon || "🛡️",
                color: config.color || badgeData.color || "#FFD700"
            };
            
            const badgeEl = document.createElement('div');
            badgeEl.className = `achievement-item unlocked`;
            badgeEl.innerHTML = `
                <div class="badge-icon" style="background:${safeConfig.color}; font-size: 2em; width: 60px; height: 60px; display:flex; align-items:center; justify-content:center; border-radius:50%; margin: 0 auto;">
                    ${safeConfig.icon}
                </div>
                <div style="margin-top: 10px;">
                    <strong>${safeConfig.name}</strong>
                    <p style="font-size: 0.8em; color: #666;">${safeConfig.description}</p>
                </div>
            `;
            list.appendChild(badgeEl);
        }
    });

    if (count === 0) {
        list.innerHTML = `
            <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; color: #888; text-align: center;">
                <div style="font-size: 3em; margin-bottom: 10px; opacity: 0.5;">🛡️</div>
                <h4 style="margin: 0; color: #666;">No Event Badges Yet</h4>
                <p style="margin-top: 5px; font-size: 0.9em;">Complete a Quest to earn your first reward!</p>
            </div>`;
    }
}

// --- Public Challenges UI ---
// Replacing "openCurrentChallenges" with "loadPublicChallenges" to match your desired UI flow
// --- Public Challenges UI (Updated with Admin Delete) ---
export async function openCurrentChallenges() {
    console.log("🔥 THE NEW FUNCTION IS RUNNING!"); // <--- Add this line
    const listContainer = document.getElementById('activeChallengesList');
    if (!listContainer) return;
    listContainer.innerHTML = "<p>Loading quests...</p>";

    try {
        // 1. Check Admin Status
        let isAdmin = false;
        if (state.currentUser) {
            try {
                const profileDoc = await getDoc(doc(db, "publicProfiles", state.currentUser.uid));
                if (profileDoc.exists() && profileDoc.data().role === 'admin') {
                    isAdmin = true;
                }
            } catch (e) { console.log("Not admin"); }
        }

        const challenges = await getAdminChallenges();
        let myQuests = {};
        if (state.currentUser) {
            myQuests = await getUserQuests(state.currentUser.uid);
        }

        listContainer.innerHTML = ""; 

        if (challenges.length === 0) {
            listContainer.innerHTML = "<p>No active challenges found.</p>";
            return;
        }

        // Sort: Active Joined -> New -> Completed
        challenges.sort((a, b) => {
            const statA = myQuests[a.id] ? myQuests[a.id].status : 'new';
            const statB = myQuests[b.id] ? myQuests[b.id].status : 'new';
            if (statA === 'completed' && statB !== 'completed') return 1;
            if (statA !== 'completed' && statB === 'completed') return -1;
            return 0;
        });

        challenges.forEach(chal => {
            const card = document.createElement('div');
            card.className = "hub-card"; 
            
            const type = chal.challengeType || 'distance';
            const goalVal = chal.goalValue || chal.goal_miles;
            const goalText = type === 'count' ? `${goalVal} Items` : `${goalVal} Miles`;
            
            const questData = myQuests[chal.id];
            const isJoined = !!questData;
            const isCompleted = questData && questData.status === 'completed';
            const userProgress = isJoined ? questData.progress : 0;
            
            // Allow deletion if Admin OR if the current user created it (if you store creatorId)
            const isCreator = state.currentUser && chal.creatorId === state.currentUser.uid;
            const canDelete = isAdmin || isCreator;

            let buttonHtml = "";
            let statusBadge = "";

            if (isCompleted) {
                card.style.border = "2px solid #FFD700"; 
                statusBadge = `<span style="color:#B8860B; font-weight:bold;">🏆 COMPLETED</span>`;
            } else if (isJoined) {
                card.style.border = "1px solid #4A7C59"; 
                statusBadge = `<span style="color:#4A7C59; font-weight:bold;">✅ Active (${userProgress.toFixed(1)} / ${goalVal})</span>`;
            } else {
                buttonHtml = `<button class="modal-button primary start-btn">Start</button>`;
            }

            // HTML Structure
            card.innerHTML = `
                <div style="flex-grow:1;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                         <h4 style="margin: 0; color: #4A7C59;">${chal.title}</h4>
                         ${canDelete ? `<button class="delete-chal-btn" style="background:none; border:none; cursor:pointer;" title="Delete Challenge">🗑️</button>` : ''}
                    </div>
                    <p style="font-size: 0.9em; color: #666; margin: 5px 0;">${chal.description}</p>
                    <div style="font-size: 0.85em; margin-top:5px;">
                        🎯 Goal: ${goalText} ${statusBadge}
                    </div>
                </div>
                <div>${buttonHtml}</div>
            `;
            
            // Start Listener
            if (!isJoined && !isCompleted) {
                const btn = card.querySelector('.start-btn');
                btn.addEventListener('click', async () => {
                    if (!state.currentUser) { alert("Please login first!"); return; }
                    btn.innerText = "Joining...";
                    await joinChallenge(chal.id, chal.title, state.currentUser.uid);
                    openCurrentChallenges(); // Refresh
                });
            }

            // Delete Listener (Admin)
            if (canDelete) {
                const delBtn = card.querySelector('.delete-chal-btn');
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if(confirm(`⚠️ ADMIN: Delete "${chal.title}" for EVERYONE?`)) {
                        await deleteChallenge(chal.id);
                        openCurrentChallenges(); // Refresh UI
                    }
                });
            }

            listContainer.appendChild(card);
        });
    } catch (e) {
        console.error("Error loading challenges:", e);
        listContainer.innerHTML = "<p>Error loading content.</p>";
    }
}

// --- Past Challenges (User History with Delete) ---
export async function openPastChallenges(type) {
    const content = document.getElementById('pastChallengesContent');
    content.innerHTML = `<p>Loading ${type} history...</p>`;
    
    if (!state.currentUser) {
        content.innerHTML = "<p>Please log in.</p>";
        return;
    }

    try {
        const myQuests = await getUserQuests(state.currentUser.uid);
        const questIds = Object.keys(myQuests);
        
        if (questIds.length === 0) {
            content.innerHTML = `<p>No challenge history found.</p>`;
            return;
        }

        content.innerHTML = "";
        let count = 0;

        for (const [chalId, data] of Object.entries(myQuests)) {
            const isCompleted = data.status === 'completed';
            
            // Keeps your existing tab logic working perfectly
            const showIt = (type === 'completed' && isCompleted) || (type === 'uncompleted' && !isCompleted);

            if (showIt) {
                count++;
                
                // --- THE FIX: Force the correct status label ---
                // If it's not completed, don't show "In Progress". Show "Expired".
                let displayStatus = isCompleted ? "COMPLETED" : "EXPIRED / UNCOMPLETED";

                const div = document.createElement('div');
                div.className = "hub-card";
                
                // Creates the card WITH the delete button for both tabs
                div.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${data.title}</strong><br>
                            <span style="font-size:0.8em; color:#666;">
                                Status: <strong>${displayStatus}</strong> • Progress: ${data.progress}
                            </span>
                        </div>
                        <button class="forget-quest-btn" style="color: #d32f2f; background: none; border: 1px solid #ffcdd2; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 1.1em;" title="Remove from list">
                             🗑️
                        </button>
                    </div>
                `;

                // Wires up the delete button so it actually works
                const forgetBtn = div.querySelector('.forget-quest-btn');
                forgetBtn.addEventListener('click', async () => {
                    if(confirm("Permanently remove this from your list?")) {
                        try {
                            const userRef = doc(db, "users", state.currentUser.uid);
                            await updateDoc(userRef, {
                                [`active_quests.${chalId}`]: deleteField()
                            });
                            div.remove(); // Removes it from the screen
                            count--;
                            if (count === 0) {
                                content.innerHTML = `<p>No ${type} challenges found.</p>`;
                            }
                        } catch(err) {
                            console.error("Error removing quest:", err);
                            alert("Failed to remove.");
                        }
                    }
                });

                content.appendChild(div);
            }
        }
        
        if (count === 0) content.innerHTML = `<p>No ${type} challenges found.</p>`;

    } catch(e) {
        console.error(e);
        content.innerHTML = "<p>Error loading history.</p>";
    }
}

// --- ADMIN: MANAGE CHALLENGES (Updated with CLONE) ---

export async function createNewChallenge(title, description, type, goal, timeLimit, badgeIcon, expirationDate) {
    if (!confirm("Are you sure you want to launch this challenge globally?")) return;

    try {
        await addDoc(collection(db, "challenges"), {
            title: title,
            description: description,
            challengeType: type || 'distance',
            goalValue: Number(goal),
            goal_miles: Number(goal), // Legacy support
            timeLimit: timeLimit ? Number(timeLimit) : null,
            badge_icon: badgeIcon || "🏅",
            created_at: serverTimestamp(),
            expires_at: Timestamp.fromDate(new Date(expirationDate))
        });
        alert("✅ Challenge Launched!");
    } catch (e) {
        console.error("Error creating challenge: ", e);
        alert("❌ Error: " + e.message);
    }
}

export async function deleteChallenge(challengeId) {
    if (!confirm("⚠️ Are you sure you want to DELETE this challenge?")) return;
    try {
        await deleteDoc(doc(db, "challenges", challengeId));
        alert("🗑️ Challenge Deleted!");
        openAdminChallengeModal(); // Refresh list
    } catch (e) {
        console.error("Error deleting:", e);
        alert("Error: " + e.message);
    }
}

export async function getAdminChallenges() {
    // 1. Grab everything without the strict Firestore filter
    const q = query(collection(db, "challenges")); 
    const snapshot = await getDocs(q);
    
    let challenges = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 2. Sort them newest to oldest in JavaScript instead
    challenges.sort((a, b) => {
        // Fallback to 0 if the timestamp is completely missing
        const timeA = a.created_at?.toMillis ? a.created_at.toMillis() : (a.created_at || 0);
        const timeB = b.created_at?.toMillis ? b.created_at.toMillis() : (b.created_at || 0);
        return timeB - timeA; 
    });

    return challenges;
}

// --- NEW: Open Admin Modal with Clone Support ---
export function openAdminChallengeModal() {
    const list = document.getElementById('adminChallengeList');
    if (!list) return;
    list.innerHTML = '<li>Loading...</li>';
    const modal = document.getElementById('adminChallengeModal');
    if (modal) modal.style.display = 'flex';

    // Clone Helper
    const fillFormWith = (data) => {
        document.getElementById('challengeTitleInput').value = data.title;
        document.getElementById('challengeDescInput').value = data.description;
        document.getElementById('challengeGoalInput').value = data.goalValue || data.goal_miles;
        document.getElementById('challengeTypeInput').value = data.challengeType || 'distance';
        document.getElementById('challengeStartInput').value = ''; 
        document.getElementById('challengeEndInput').value = '';
        alert(`Cloned "${data.title}"! Set new dates to restart it.`);
    };

    getAdminChallenges().then(challenges => {
        list.innerHTML = '';
        if (challenges.length === 0) { list.innerHTML = '<li>No challenges found.</li>'; return; }

        challenges.forEach(chal => {
            const li = document.createElement('li');
            li.className = "hub-card";
            li.innerHTML = `
                <div style="flex-grow:1;">
                    <strong>${chal.title}</strong><br>
                    <small>Goal: ${chal.goalValue || chal.goal_miles}</small>
                </div>
                <div>
                    <button class="clone-btn" style="cursor:pointer;">🔄</button>
                    <button class="del-btn" style="color:red; cursor:pointer;">🗑️</button>
                </div>
            `;
            li.querySelector('.clone-btn').addEventListener('click', () => fillFormWith(chal));
            li.querySelector('.del-btn').addEventListener('click', () => deleteChallenge(chal.id));
            list.appendChild(li);
        });
    });
}

// --- CHALLENGE PARTICIPATION ---

export async function joinChallenge(challengeId, challengeTitle, userId) {
    try {
        const userRef = doc(db, "users", userId);
        const updateData = {};
        updateData[`active_quests.${challengeId}`] = {
            title: challengeTitle,
            progress: 0.0,
            status: 'active',
            joined_at: new Date()
        };
        await updateDoc(userRef, updateData);
        return true;
    } catch (e) {
        console.error("Error joining challenge:", e);
        // Fallback for new users without map field
        const userRef = doc(db, "users", userId);
        const setObj = { active_quests: {} };
        setObj.active_quests[challengeId] = {
            title: challengeTitle,
            progress: 0.0,
            status: 'active',
            joined_at: new Date()
        };
        await setDoc(userRef, setObj, { merge: true });
        return true;
    }
}

export async function getUserQuests(userId) {
    try {
        const userSnap = await getDoc(doc(db, "users", userId));
        if (userSnap.exists() && userSnap.data().active_quests) {
            return userSnap.data().active_quests;
        }
        return {}; 
    } catch (e) {
        console.error("Error fetching user quests:", e);
        return {};
    }
}

// --- CHALLENGE TRACKING ---

export async function updateChallengeProgress(userId, distanceMiles) {
    const userRef = doc(db, "users", userId);
    try {
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) return;
        
        const data = userSnap.data();
        const activeQuests = data.active_quests || {};
        const currentBadges = data.badges || {};
        let updatesMade = false;
        let earnedBadges = [];

        for (const [chalId, quest] of Object.entries(activeQuests)) {
            if (quest.status === 'completed') continue;

            const chalRef = doc(db, "challenges", chalId);
            const chalSnap = await getDoc(chalRef);
            
            if (!chalSnap.exists()) continue; 

            const rules = chalSnap.data();
            const now = new Date();
            const expiresAt = new Date(rules.expires_at.seconds * 1000);

            if (now > expiresAt) {
                activeQuests[chalId].status = 'expired';
                updatesMade = true;
                continue;
            }

            const oldProgress = quest.progress || 0;
            const newProgress = oldProgress + distanceMiles;
            
            activeQuests[chalId].progress = parseFloat(newProgress.toFixed(2));
            updatesMade = true;

            const goal = rules.goalValue || rules.goal_miles;
            if (newProgress >= goal) {
                activeQuests[chalId].status = 'completed';
                activeQuests[chalId].completed_at = new Date();
                
                if (rules.badge_id) {
                    currentBadges[rules.badge_id] = {
                        earned_at: new Date(),
                        source: 'challenge'
                    };
                    earnedBadges.push(rules.badge_id);
                }
            }
        }

        if (updatesMade) {
            await updateDoc(userRef, {
                active_quests: activeQuests,
                badges: currentBadges
            });
            return earnedBadges;
        }

    } catch (e) {
        console.error("Error updating challenge progress:", e);
    }
    return [];
}

export async function grantTitle(userId, titleKey) {
    const profileRef = doc(db, "publicProfiles", userId);
    let newlyUnlocked = false; // Track if this is a fresh unlock

    try {
        await runTransaction(db, async (transaction) => {
            const profileDoc = await transaction.get(profileRef);
            if (!profileDoc.exists()) return;

            const userData = profileDoc.data();
            const unlockedTitles = userData.unlockedTitles || [];

            if (!unlockedTitles.includes(titleKey)) {
                unlockedTitles.push(titleKey);
                transaction.update(profileRef, { unlockedTitles: unlockedTitles });
                newlyUnlocked = true; // Mark as new!
            }
        });

        // If it's a new unlock, let the user know!
        if (newlyUnlocked && allTitles[titleKey]) {
            alert(`🏆 NEW TITLE UNLOCKED: ${allTitles[titleKey].name}`);
        }
        
    } catch (error) {
        console.error("Failed to grant title:", error);
    }
}

/**
 * Checks if the user qualifies for any new titles based on their updated stats.
 */
export async function checkForTitleMilestones(userId, routeCoords) {
    try {
        const profileRef = doc(db, "publicProfiles", userId);
        const profileSnap = await getDoc(profileRef);
        if (!profileSnap.exists()) return;

        const data = profileSnap.data();
        const totalPins = data.totalPins || 0;
        const totalRoutes = data.totalRoutes || 0;

        // 1. PIN MILESTONES
        if (totalPins >= 50) await grantTitle(userId, 'trash_wizard');
        if (totalPins >= 100) await grantTitle(userId, 'eco_legend');

        // 2. ROUTE MILESTONES
        if (totalRoutes >= 10) await grantTitle(userId, 'litter_warrior');

        // --- 4. TIME-BASED MILESTONES ---
        const now = new Date();
        const hour = now.getHours(); // 0-23 format

        if (hour < 9) {
            // Early Bird: Before 9:00 AM
            const earlyCount = (data.earlyBirdCount || 0) + 1;
            await updateDoc(profileRef, { earlyBirdCount: earlyCount });
            if (earlyCount >= 5) await grantTitle(userId, 'early_bird');
            
        } 

        if (hour >= 19) {
            // Night Owl: After 7:00 PM
            const nightCount = (data.nightOwlCount || 0) + 1;
            await updateDoc(profileRef, { nightOwlCount: nightCount });
            if (nightCount >= 5) await grantTitle(userId, 'night_owl');
            
    }

    } catch (error) {
        console.error("Error checking milestones:", error);
    }
}


// Add this to your community.js
export async function initializeSquad() {
    // 1. Capture the form data from the UI
    const name = document.getElementById('newSquadName').value.trim();
    const callsign = document.getElementById('newSquadCallsign').value.trim().toUpperCase();
    const sector = document.getElementById('newSquadHomeSector').value;
    const bio = document.getElementById('newSquadBio').value.trim();
    const maxMembersRaw = document.getElementById('newSquadMaxMembers')?.value;
    const inviteOnlyChecked = document.getElementById('newSquadInviteOnly')?.checked === true;

    // 2. Tactical Validation
    if (!name || callsign.length < 3 || callsign.length > 4) {
        alert("Initialization Failed: Squad Name required, Callsign must be 3-4 characters.");
        return;
    }
    if (!/^[A-Z0-9]+$/.test(callsign)) {
        alert("Callsign must contain only letters and numbers.");
        return;
    }
    if (!state.currentUser) {
        alert("You must be logged in to register a squad.");
        return;
    }

    // Parse and clamp maxMembers per spec (2-50). Default 20 if missing/invalid.
    let maxMembers = parseInt(maxMembersRaw, 10);
    if (!Number.isFinite(maxMembers) || maxMembers < 2) maxMembers = 20;
    if (maxMembers > 50) maxMembers = 50;

    // isOpen: true = anyone can request to join. The checkbox is "invite only"
    // so we invert. Default: open.
    const isOpen = !inviteOnlyChecked;

    const finalizeBtn = document.getElementById('btnFinalizeSquad');
    if (finalizeBtn) {
        finalizeBtn.disabled = true;
        finalizeBtn.textContent = 'Checking callsign…';
    }

    try {
        // 3. Callsign uniqueness check — scan both active squads and any pending
        //    squad requests so two users can't grab the same callsign in parallel.
        //    Not airtight against true races (Firestore has no unique index),
        //    but good enough for current scale.
        const [activeMatch, requestMatch] = await Promise.all([
            getDocs(query(collection(db, "squads"), where("callsign", "==", callsign), limit(1))),
            getDocs(query(collection(db, "squadRequests"), where("callsign", "==", callsign), where("status", "==", "pending"), limit(1)))
        ]);
        if (!activeMatch.empty) {
            alert(`Callsign [${callsign}] is already taken by another squad.`);
            if (finalizeBtn) { finalizeBtn.disabled = false; finalizeBtn.textContent = '🚀 INITIALIZE SQUAD'; }
            return;
        }
        if (!requestMatch.empty) {
            alert(`Callsign [${callsign}] is already in a pending squad request. Try another.`);
            if (finalizeBtn) { finalizeBtn.disabled = false; finalizeBtn.textContent = '🚀 INITIALIZE SQUAD'; }
            return;
        }

        // 4. Look up profile data (admin status, username, current squad).
        const profileSnap = await getDoc(doc(db, "publicProfiles", state.currentUser.uid));
        const profile = profileSnap.exists() ? profileSnap.data() : {};
        const isAdmin = profile.role === 'admin';
        const leaderName = profile.username || "Anonymous";

        // 4a. One-squad-per-user enforcement. publicProfiles.squadId is the
        //     source of truth Android uses too.
        if (profile.squadId && profile.squadId.length > 0) {
            alert(`You're already in squad [${profile.squadCallsign || '???'}]. Leave it before creating a new one.`);
            if (finalizeBtn) { finalizeBtn.disabled = false; finalizeBtn.textContent = '🚀 INITIALIZE SQUAD'; }
            return;
        }

        if (finalizeBtn) finalizeBtn.textContent = isAdmin ? 'Initializing…' : 'Submitting for review…';

        if (isAdmin) {
            // ADMIN DIRECT-CREATE PATH
            // Android schema: members is a MAP<uid, SquadMember>, not an array.
            // Also writes denormalized squad fields onto leader's publicProfile.
            const leaderMember = {
                uid: state.currentUser.uid,
                username: leaderName,
                role: "leader",
                totalPins: 0,
                totalRoutes: 0,
                joinedAt: new Date()
            };
            const squadData = {
                squadName: name,
                callsign: callsign,
                homeSector: sector,
                bio: bio,
                isOpen: isOpen,
                maxMembers: maxMembers,
                memberCount: 1,
                leaderId: state.currentUser.uid,
                coLeaderIds: [],
                members: { [state.currentUser.uid]: leaderMember },
                totalPins: 0,
                totalDistance: 0,
                totalRoutes: 0,
                createdAt: new Date()
            };
            const newSquadRef = await addDoc(collection(db, "squads"), squadData);

            await updateDoc(doc(db, "publicProfiles", state.currentUser.uid), {
                squadId: newSquadRef.id,
                squadCallsign: callsign,
                squadRole: "leader"
            });

            alert(`Unit [${callsign}] ${name} has been officially initialized.`);
        } else {
            // REGULAR USER PATH — admin approval queue.
            // Field names match Android spec exactly (leaderId/leaderName, not
            // creatorId/creatorName) so the admin panel can copy across cleanly.
            await addDoc(collection(db, "squadRequests"), {
                squadName: name,
                callsign: callsign,
                homeSector: sector,
                bio: bio,
                isOpen: isOpen,
                maxMembers: maxMembers,
                leaderId: state.currentUser.uid,
                leaderName: leaderName,
                status: "pending",
                adminNote: "",
                createdAt: new Date()
            });
            alert(`Squad request submitted! An admin will review [${callsign}] ${name} shortly.`);
        }

        // 5. Reset UI: Return to the registry list
        if (typeof window.showSquadRegistry === 'function') {
            window.showSquadRegistry();
        }
        fetchLocalSquads();
    } catch (err) {
        console.error("Squad initialization failed:", err);
        alert("Could not create squad: " + (err.message || err));
    } finally {
        if (finalizeBtn) {
            finalizeBtn.disabled = false;
            finalizeBtn.textContent = '🚀 INITIALIZE SQUAD';
        }
    }
}

export async function fetchLocalSquads() {
    const listContainer = document.getElementById('localSquadsList');
    if (!listContainer) return;

    // Show a loading state while we talk to Firebase
    listContainer.innerHTML = '<p class="loading-text">📡 Establishing uplink with Sector Command...</p>';

    try {
        const squadsRef = collection(db, "squads");
        // Optional: Filter by the user's current sector if you want it localized
        const q = query(squadsRef, orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            // Only show the message here, not the button
            listContainer.innerHTML = `
                <p style="text-align: center; padding: 20px; color: #777;">
                    No active units found in this sector.
                </p>`;
        return;
}
        
        // Clear the "Scanning" text
        listContainer.innerHTML = '';

        // Loop through the database results
        querySnapshot.forEach((doc) => {
            const squad = doc.data();
            const squadId = doc.id;

            // Member count: prefer denormalized field, fall back to map size,
            // then legacy array length.
            const mc = Number.isFinite(squad.memberCount)
                ? squad.memberCount
                : (squad.members && typeof squad.members === 'object' && !Array.isArray(squad.members)
                    ? Object.keys(squad.members).length
                    : (Array.isArray(squad.members) ? squad.members.length : 1));
            const cap = squad.maxMembers ? `/${squad.maxMembers}` : '';
            const policy = squad.isOpen === false
                ? '<span style="color:#888; font-size:0.8em;">🔒 Invite-only</span>'
                : '<span style="color:#4A7C59; font-size:0.8em;">🟢 Open</span>';

            // Whole card is the click target now. The Intel button stays visible
            // so the affordance is obvious, but we stop propagation on it so
            // clicking it doesn't fire the card handler twice. The card also
            // gets pointer cursor + hover styling inline for clarity.
            const card = document.createElement('div');
            card.className = 'hub-card squad-card-clickable';
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; cursor:pointer;';
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.squadId = squadId;

            card.innerHTML = `
                <div class="hub-text-wrap">
                    <h3>[${squad.callsign}] ${squad.squadName}</h3>
                    <p>${squad.homeSector} • ${mc}${cap} Members • ${policy}</p>
                </div>
                <button class="modal-button btn-secondary squad-intel-btn"
                        style="width: auto; padding: 8px 15px; pointer-events: none;">
                    Intel
                </button>
            `;

            // Click handler on the card. We don't use onclick on the button at
            // all — pointer-events:none on the button means clicks go to the
            // card, no double-firing.
            card.addEventListener('click', () => {
                if (typeof window.viewSquadIntel === 'function') {
                    window.viewSquadIntel(squadId);
                }
            });
            // Keyboard accessibility: Enter / Space activates the card just
            // like a real button.
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (typeof window.viewSquadIntel === 'function') {
                        window.viewSquadIntel(squadId);
                    }
                }
            });

            listContainer.appendChild(card);
        });

    } catch (error) {
        console.error("Uplink Failed:", error);
        listContainer.innerHTML = '<p style="color: var(--color-accent-danger);">⚠️ Tactical Scan Failed. Check console.</p>';
    }
}

// --- SQUAD INTEL (View Details) ---
export async function fetchSquadDetails(squadId) {
    // 1. Select DOM elements (Make sure your HTML IDs match these!)
    const nameEl = document.getElementById('intelSquadName');
    const callsignEl = document.getElementById('intelSquadCallsign');
    const missionEl = document.getElementById('intelSquadMission');
    const rosterEl = document.getElementById('intelSquadRoster');

    // 2. Clear previous data / Show Loading
    if (nameEl) nameEl.textContent = "Loading Intel...";
    if (callsignEl) callsignEl.textContent = "[...]";
    if (missionEl) missionEl.textContent = "Decryption in progress...";
    if (rosterEl) rosterEl.innerHTML = '<li style="color:#888;">Scanning for lifeforms...</li>';

    try {
        // 3. Fetch the Squad Document
        const squadRef = doc(db, "squads", squadId);
        const squadSnap = await getDoc(squadRef);

        if (!squadSnap.exists()) {
            if (nameEl) nameEl.textContent = "Squad Not Found";
            return;
        }

        const data = squadSnap.data();

        // 4. Populate Basic Info
        if (nameEl) nameEl.textContent = data.squadName || "Unknown Squad";
        if (callsignEl) callsignEl.textContent = `[${data.callsign || '???'}]`;

        // Build mission text with join-policy and capacity hints below the bio.
        const memberCount = data.memberCount
            || (data.members && typeof data.members === 'object' ? Object.keys(data.members).length : 0);
        const maxMembers = data.maxMembers || '?';
        const policyText = data.isOpen === false
            ? '🔒 Invite-only'
            : '🟢 Accepting requests';
        if (missionEl) {
            missionEl.innerHTML = `
                ${escapeIntelHtml(data.bio || "No mission established.")}
                <div style="margin-top:8px; font-size:0.85em; color:#666;">
                    ${policyText} • ${memberCount}/${maxMembers} members
                </div>
            `;
        }

        // 5. Populate Active Roster
        if (rosterEl) {
            rosterEl.innerHTML = "";

            // Spec: members is a map<uid, SquadMember>. Earlier code wrote an
            // array, so we still handle that shape gracefully for any legacy data.
            let memberEntries = []; // [{uid, member}, ...]
            if (data.members && typeof data.members === 'object' && !Array.isArray(data.members)) {
                // Canonical Android shape: members is a map
                memberEntries = Object.entries(data.members).map(([uid, m]) => ({
                    uid,
                    member: m && typeof m === 'object' ? m : null
                }));
            } else if (Array.isArray(data.members)) {
                // Legacy array shape: just uids, no embedded role/username
                memberEntries = data.members.map(uid => ({ uid, member: null }));
            }

            if (memberEntries.length === 0) {
                rosterEl.innerHTML = "<li>No active members.</li>";
            } else {
                // Sort: leader first, then co-leaders, then everyone else alphabetically
                const roleRank = { 'leader': 0, 'co-leader': 1, 'veteran': 2, 'member': 3 };
                memberEntries.sort((a, b) => {
                    const ra = roleRank[(a.member && a.member.role) || 'member'] ?? 99;
                    const rb = roleRank[(b.member && b.member.role) || 'member'] ?? 99;
                    if (ra !== rb) return ra - rb;
                    const na = (a.member && a.member.username) || '';
                    const nb = (b.member && b.member.username) || '';
                    return na.localeCompare(nb);
                });

                for (const { uid, member } of memberEntries) {
                    // Prefer embedded username (saves a read). For legacy
                    // array-shape squads, fall back to a publicProfile fetch.
                    let username = member && member.username;
                    if (!username) {
                        try {
                            const memberDoc = await getDoc(doc(db, "publicProfiles", uid));
                            username = memberDoc.exists() ? memberDoc.data().username : "Unknown Trooper";
                        } catch (_) {
                            username = "Unknown Trooper";
                        }
                    }

                    // Role badge: prefer the embedded member.role, fall back to
                    // the squad's leaderId/coLeaderIds for legacy data.
                    let role = member && member.role;
                    if (!role) {
                        if (uid === data.leaderId) role = 'leader';
                        else if (Array.isArray(data.coLeaderIds) && data.coLeaderIds.includes(uid)) role = 'co-leader';
                        else role = 'member';
                    }
                    const roleBadge = {
                        'leader':    '<span style="color:gold; font-size:0.8em; margin-left:5px;">(Leader)</span>',
                        'co-leader': '<span style="color:#4A7C59; font-size:0.8em; margin-left:5px;">(Co-Leader)</span>',
                        'veteran':   '<span style="color:#888; font-size:0.8em; margin-left:5px;">(Veteran)</span>',
                        'member':    ''
                    }[role] || '';

                    const li = document.createElement('li');
                    li.innerHTML = `
                        <span class="trooper-rank">🛡️</span>
                        ${escapeIntelHtml(username)}
                        ${roleBadge}
                    `;
                    rosterEl.appendChild(li);
                }
            }
        }

        // 6. Render action panels (join/leave/invite buttons + leader queues)
        await renderSquadActionPanels(squadId, data);

    } catch (error) {
        console.error("Error fetching squad intel:", error);
        if (nameEl) nameEl.textContent = "Error loading data.";
    }
}

// ---------------------------------------------------------------------------
// SQUAD ACTION PANELS — populated by fetchSquadDetails after the roster.
// Handles all the context-aware UI: request to join, cancel, leave, disband,
// plus leader-only join-request review and outstanding invites.
// ---------------------------------------------------------------------------
async function renderSquadActionPanels(squadId, squadData) {
    const actionPanel       = document.getElementById('intelActionPanel');
    const actionContent     = document.getElementById('intelActionContent');
    const joinReqsSection   = document.getElementById('intelJoinRequestsSection');
    const joinReqsList      = document.getElementById('intelJoinRequestsList');
    const joinReqsCountEl   = document.getElementById('intelJoinRequestCount');
    const invitesSection    = document.getElementById('intelInvitesSection');
    const invitesList       = document.getElementById('intelInvitesList');
    const invitesCountEl    = document.getElementById('intelInvitesCount');

    // Reset visibility so reopening a different squad doesn't show stale UI
    if (actionPanel) actionPanel.style.display = 'none';
    if (joinReqsSection) joinReqsSection.style.display = 'none';
    if (invitesSection) invitesSection.style.display = 'none';
    if (actionContent) actionContent.innerHTML = '';
    if (joinReqsList) joinReqsList.innerHTML = '';
    if (invitesList) invitesList.innerHTML = '';

    if (!state.currentUser) {
        // Anonymous — show a "log in to interact" hint instead of buttons
        if (actionPanel && actionContent) {
            actionPanel.style.display = 'block';
            actionContent.innerHTML = '<p style="color:#888; font-size:0.85em; margin:0;">Log in to request to join or interact with this squad.</p>';
        }
        return;
    }

    // Pull profile + relationships dynamically (lazy import to avoid cycles)
    const squadsMod = await import('./squads.js');
    const myProfileSnap = await getDoc(doc(db, 'publicProfiles', state.currentUser.uid));
    const myProfile = myProfileSnap.exists() ? myProfileSnap.data() : {};

    const isMember = !!(squadData.members &&
        typeof squadData.members === 'object' &&
        !Array.isArray(squadData.members) &&
        squadData.members[state.currentUser.uid]) ||
        (Array.isArray(squadData.members) && squadData.members.includes(state.currentUser.uid));
    const isLeader = squadData.leaderId === state.currentUser.uid;
    const isCoLeader = Array.isArray(squadData.coLeaderIds) && squadData.coLeaderIds.includes(state.currentUser.uid);
    const isAdmin = myProfile.role === 'admin';
    const canManage = isLeader || isCoLeader || isAdmin;
    const inOtherSquad = myProfile.squadId && myProfile.squadId.length > 0 && myProfile.squadId !== squadId;

    // === MEMBER-FACING ACTIONS ===
    if (actionPanel && actionContent) {
        actionPanel.style.display = 'block';
        const buttons = [];

        if (isLeader) {
            buttons.push(`<button id="intelDisbandBtn" class="modal-button btn-danger">💥 Disband Squad</button>`);
        } else if (isMember) {
            buttons.push(`<button id="intelLeaveBtn" class="modal-button btn-danger">🚪 Leave Squad</button>`);
        } else if (inOtherSquad) {
            buttons.push(`<p style="color:#888; font-size:0.85em; margin:0;">You're already in squad [${escapeIntelHtml(myProfile.squadCallsign || '???')}]. Leave it first to join another.</p>`);
        } else {
            // Not a member, not in another squad. Either request-to-join, cancel
            // an existing request, or "invite only" notice.
            if (squadData.isOpen === false) {
                buttons.push(`<p style="color:#888; font-size:0.85em; margin:0;">🔒 This squad is invite-only. Only the leader can add new members.</p>`);
            } else {
                // Check for existing request
                const pending = await squadsMod.fetchMyJoinRequest(squadId);
                if (pending) {
                    buttons.push(`<p style="color:#4A7C59; font-size:0.85em; margin:0 0 4px 0;">⏳ Your request is pending review.</p>`);
                    buttons.push(`<button id="intelCancelRequestBtn" class="modal-button btn-secondary">Cancel Request</button>`);
                } else {
                    // Check capacity before offering to join
                    const memberCount = squadData.memberCount || (squadData.members && typeof squadData.members === 'object' ? Object.keys(squadData.members).length : 0);
                    if (squadData.maxMembers && memberCount >= squadData.maxMembers) {
                        buttons.push(`<p style="color:#dc3545; font-size:0.85em; margin:0;">⚠️ This squad is at full capacity (${memberCount}/${squadData.maxMembers}).</p>`);
                    } else {
                        buttons.push(`<button id="intelRequestJoinBtn" class="modal-button btn-primary">🙋 Request to Join</button>`);
                    }
                }
            }
        }

        actionContent.innerHTML = buttons.join('');

        // Wire member action buttons
        document.getElementById('intelRequestJoinBtn')?.addEventListener('click', async () => {
            const message = prompt('Optional message to the squad leader:', '') || '';
            const btn = document.getElementById('intelRequestJoinBtn');
            if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
            const ok = await squadsMod.requestToJoin(squadId, message);
            if (ok) await fetchSquadDetails(squadId); // refresh
            else if (btn) { btn.disabled = false; btn.textContent = '🙋 Request to Join'; }
        });
        document.getElementById('intelCancelRequestBtn')?.addEventListener('click', async () => {
            if (!confirm('Cancel your pending request to join this squad?')) return;
            const ok = await squadsMod.cancelJoinRequest(squadId);
            if (ok) await fetchSquadDetails(squadId);
        });
        document.getElementById('intelLeaveBtn')?.addEventListener('click', async () => {
            if (!confirm(`Leave squad [${squadData.callsign}] ${squadData.squadName}?`)) return;
            const ok = await squadsMod.leaveSquad();
            if (ok) {
                if (typeof window.showSquadRegistry === 'function') window.showSquadRegistry();
                fetchLocalSquads();
            }
        });
        document.getElementById('intelDisbandBtn')?.addEventListener('click', async () => {
            if (!confirm(`Disband [${squadData.callsign}] ${squadData.squadName}?\n\nAll members will be removed from the squad. This cannot be undone.`)) return;
            const typed = prompt('To confirm, type the callsign (e.g. ' + squadData.callsign + '):');
            if (typed !== squadData.callsign) {
                alert('Callsign did not match. Disband cancelled.');
                return;
            }
            const ok = await squadsMod.disbandSquad(squadId);
            if (ok) {
                if (typeof window.showSquadRegistry === 'function') window.showSquadRegistry();
                fetchLocalSquads();
            }
        });
    }

    // === LEADER-FACING PANELS ===
    if (canManage) {
        // Pending join requests panel
        if (joinReqsSection && joinReqsList) {
            const requests = await squadsMod.fetchSquadJoinRequests(squadId);
            joinReqsSection.style.display = 'block';
            if (joinReqsCountEl) joinReqsCountEl.textContent = `(${requests.length})`;
            if (requests.length === 0) {
                joinReqsList.innerHTML = '<p style="color:#888; font-size:0.85em;">No pending requests.</p>';
            } else {
                joinReqsList.innerHTML = requests.map(r => `
                    <div class="join-request-row" data-uid="${escapeIntelHtml(r.userId)}" style="display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid #e0e0d8; border-radius:4px; margin-bottom:6px;">
                        <div>
                            <strong>${escapeIntelHtml(r.username || 'Unknown')}</strong>
                            ${r.message ? `<div style="font-size:0.85em; color:#666; margin-top:2px;">"${escapeIntelHtml(r.message)}"</div>` : ''}
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button class="modal-button btn-primary jr-approve" style="flex:1; padding:6px;">Approve</button>
                            <button class="modal-button btn-danger jr-deny" style="flex:1; padding:6px;">Deny</button>
                        </div>
                    </div>
                `).join('');

                joinReqsList.querySelectorAll('.jr-approve').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        const row = e.target.closest('.join-request-row');
                        const uid = row.dataset.uid;
                        btn.disabled = true; btn.textContent = '…';
                        const ok = await squadsMod.approveJoinRequest(squadId, uid);
                        if (ok) await fetchSquadDetails(squadId);
                        else { btn.disabled = false; btn.textContent = 'Approve'; }
                    });
                });
                joinReqsList.querySelectorAll('.jr-deny').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        const row = e.target.closest('.join-request-row');
                        const uid = row.dataset.uid;
                        const reason = prompt('Reason for denial (optional):', '');
                        if (reason === null) return;
                        btn.disabled = true; btn.textContent = '…';
                        const ok = await squadsMod.denyJoinRequest(squadId, uid, reason);
                        if (ok) await fetchSquadDetails(squadId);
                        else { btn.disabled = false; btn.textContent = 'Deny'; }
                    });
                });
            }
        }

        // Outstanding invites panel
        if (invitesSection && invitesList) {
            const invites = await squadsMod.fetchOutstandingInvites(squadId);
            invitesSection.style.display = 'block';
            if (invitesCountEl) invitesCountEl.textContent = `(${invites.length})`;
            if (invites.length === 0) {
                invitesList.innerHTML = '<p style="color:#888; font-size:0.85em;">No outstanding invites.</p>';
            } else {
                invitesList.innerHTML = invites.map(inv => `
                    <div class="invite-row" data-uid="${escapeIntelHtml(inv.userId)}" style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px; border:1px solid #e0e0d8; border-radius:4px; margin-bottom:6px;">
                        <div>
                            <strong>${escapeIntelHtml(inv.username || 'Unknown')}</strong>
                            <div style="font-size:0.75em; color:#888;">Pending</div>
                        </div>
                        <button class="modal-button btn-secondary inv-revoke" style="padding:6px 10px; font-size:0.85em;">Revoke</button>
                    </div>
                `).join('');

                invitesList.querySelectorAll('.inv-revoke').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        const row = e.target.closest('.invite-row');
                        const uid = row.dataset.uid;
                        if (!confirm('Revoke this invite?')) return;
                        btn.disabled = true; btn.textContent = '…';
                        const ok = await squadsMod.revokeInvite(squadId, uid);
                        if (ok) await fetchSquadDetails(squadId);
                        else { btn.disabled = false; btn.textContent = 'Revoke'; }
                    });
                });
            }
        }

        // Wire the "Invite a Trooper" button - opens the picker modal
        document.getElementById('intelInviteBtn')?.addEventListener('click', () => {
            openInvitePicker(squadId, squadData);
        });
    }
}

/**
 * Opens the invite-a-user typeahead modal. Search publicProfiles by username
 * substring, click a result to send an invite to that user.
 */
function openInvitePicker(squadId, squadData) {
    const modal = document.getElementById('invitePickerModal');
    const input = document.getElementById('invitePickerSearch');
    const resultsEl = document.getElementById('invitePickerResults');
    if (!modal || !input || !resultsEl) return;

    input.value = '';
    resultsEl.innerHTML = '<p style="color:#888; font-size:0.85em; padding:10px;">Type to search…</p>';
    modal.style.display = 'flex';
    input.focus();

    let searchTimer = null;
    const handleInput = async () => {
        const q = input.value.trim();
        clearTimeout(searchTimer);
        if (q.length < 1) {
            resultsEl.innerHTML = '<p style="color:#888; font-size:0.85em; padding:10px;">Type to search…</p>';
            return;
        }
        // Debounce typing so we don't run a Firestore query on every keystroke.
        searchTimer = setTimeout(async () => {
            resultsEl.innerHTML = '<p style="color:#888; font-size:0.85em; padding:10px;">Searching…</p>';
            const squadsMod = await import('./squads.js');
            const matches = await squadsMod.searchUsersByUsername(q, 10);
            if (matches.length === 0) {
                resultsEl.innerHTML = '<p style="color:#888; font-size:0.85em; padding:10px;">No matches.</p>';
                return;
            }
            resultsEl.innerHTML = matches.map(u => {
                const alreadyInSquad = u.squadId && u.squadId.length > 0;
                const isSelf = u.uid === state.currentUser?.uid;
                const isMember = !!(squadData.members && typeof squadData.members === 'object' && !Array.isArray(squadData.members) && squadData.members[u.uid]);
                let actionHTML = '';
                if (isSelf) {
                    actionHTML = '<span style="color:#888; font-size:0.8em;">You</span>';
                } else if (isMember) {
                    actionHTML = '<span style="color:#888; font-size:0.8em;">In squad</span>';
                } else if (alreadyInSquad) {
                    actionHTML = `<span style="color:#888; font-size:0.8em;">In [${escapeIntelHtml(u.squadCallsign || '???')}]</span>`;
                } else {
                    actionHTML = `<button class="modal-button btn-primary invite-pick-btn" data-uid="${escapeIntelHtml(u.uid)}" data-username="${escapeIntelHtml(u.username || '')}" style="padding:4px 10px; font-size:0.85em;">Invite</button>`;
                }
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #eee;">
                        <strong>${escapeIntelHtml(u.username || '(no username)')}</strong>
                        ${actionHTML}
                    </div>
                `;
            }).join('');

            resultsEl.querySelectorAll('.invite-pick-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const uid = e.target.dataset.uid;
                    const username = e.target.dataset.username;
                    btn.disabled = true; btn.textContent = '…';

                    // Pull inviter's name for the invite doc
                    let inviterName = 'Unknown';
                    try {
                        const meSnap = await getDoc(doc(db, 'publicProfiles', state.currentUser.uid));
                        if (meSnap.exists()) inviterName = meSnap.data().username || 'Unknown';
                    } catch (_) {}

                    const squadsMod = await import('./squads.js');
                    const ok = await squadsMod.sendInvite(squadId, uid, inviterName);
                    if (ok) {
                        e.target.outerHTML = '<span style="color:#4A7C59; font-size:0.8em;">✓ Invited</span>';
                        // Refresh squad detail in the background so the new invite appears
                        await fetchSquadDetails(squadId);
                    } else {
                        btn.disabled = false;
                        btn.textContent = 'Invite';
                    }
                });
            });
        }, 250);
    };

    input.removeEventListener('input', input._inviteInputHandler);
    input._inviteInputHandler = handleInput;
    input.addEventListener('input', handleInput);

    // Close handlers (idempotent)
    const closeBtn = document.getElementById('invitePickerClose');
    if (closeBtn && !closeBtn._wired) {
        closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
        closeBtn._wired = true;
    }
}

// Tiny inline escaper for squad-detail content (separate from elsewhere; avoids
// importing a helper across modules just for this).
function escapeIntelHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function toggleRSVP(meetupId) {
    if (!state.currentUser) {
        alert("Please log in to RSVP.");
        return;
    }

    const uid = state.currentUser.uid;
    const meetupRef = doc(db, "meetups", meetupId);

    try {
        await runTransaction(db, async (transaction) => {
            const meetupDoc = await transaction.get(meetupRef);
            if (!meetupDoc.exists()) throw new Error("Meetup does not exist.");

            const data = meetupDoc.data();
            let attendees = data.attendees || [];
            let waitlist = data.waitlist || [];
            const maxAttendees = data.maxAttendees || 25;
            let status = data.status || "upcoming";

            const isAttending = attendees.includes(uid);
            const isWaiting = waitlist.includes(uid);

            if (isAttending || isWaiting) {
                // --- UN-RSVP LOGIC ---
                if (isAttending) {
                    attendees = attendees.filter(id => id !== uid);
                    // Promote the first waitlisted Trooper if a spot opens
                    if (waitlist.length > 0) {
                        const promotedUid = waitlist.shift();
                        attendees.push(promotedUid);
                    } else {
                        status = "upcoming"; // Spot officially open
                    }
                } else if (isWaiting) {
                    waitlist = waitlist.filter(id => id !== uid);
                }
            } else {
                // --- RSVP LOGIC ---
                if (attendees.length < maxAttendees) {
                    attendees.push(uid);
                    if (attendees.length >= maxAttendees) {
                        status = "full";
                    }
                } else {
                    waitlist.push(uid);
                }
            }

            // Write the arrays back to Firestore
            transaction.update(meetupRef, { attendees, waitlist, status });
        });

        // Silently refresh the events list so the button states update
        fetchAndDisplayAllEvents();

    } catch (error) {
        console.error("RSVP Transaction failed: ", error);
        alert("Could not update RSVP status. Please try again.");
    }
}
