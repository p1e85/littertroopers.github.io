import { state, mapStyles, ZOOM_THRESHOLD } from './config.js';
import { fetchAndDisplayCommunityRoutes, setupPoiClickListeners } from './community.js';
import { pinCategories } from './config.js';
import { showPublicProfile } from './ui.js';
import { openReportPinModal } from './reports.js';
import { getLevelBadgeHTML } from './xp.js';
import { db, doc, getDoc } from './firebase.js';

// localStorage key for the persisted map style preference (index into mapStyles).
const MAP_STYLE_STORAGE_KEY = 'lt_mapStyleIndex';

/**
 * Initializes the Mapbox map, geocoder, and initial event listeners.
 */
export function initializeMap() {
    // Restore persisted style preference (Settings > Map Style). Falls back to 0
    // (Streets) if nothing saved or the saved index is out of range (e.g. the
    // mapStyles array shrank in a later version).
    const savedStyle = parseInt(localStorage.getItem(MAP_STYLE_STORAGE_KEY), 10);
    if (Number.isInteger(savedStyle) && savedStyle >= 0 && savedStyle < mapStyles.length) {
        state.currentStyleIndex = savedStyle;
    }

    mapboxgl.accessToken = 'pk.eyJ1IjoicDFjcmVhdGlvbnMiLCJhIjoiY2p6ajZvejJmMDZhaTNkcWpiN294dm12eCJ9.8ckNT6kfuJry7K7GAeIuxw';
    state.map = new mapboxgl.Map({
        container: 'map',
        style: mapStyles[state.currentStyleIndex].url,
        center: [-87.6298, 41.8781], // Default center
        zoom: 10
    });

    const geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl: mapboxgl,
        marker: false,
        placeholder: 'Search for a place',
        autocomplete: false,
        proximity: 'ip', // Prioritize results near the user's IP address
        types: 'country,region,place,postcode,locality,neighborhood,address,poi' // Expand search to include POIs

    });
    document.getElementById('geocoder-container').appendChild(geocoder.onAdd(state.map));

    const searchInput = document.querySelector('#geocoder-container .mapboxgl-ctrl-geocoder--input');

    // This code makes the input readonly initially, then removes that attribute
    // as soon as the user focuses on it (by clicking or tabbing).
    if (searchInput) {
        searchInput.setAttribute('readonly', 'readonly');
        searchInput.onfocus = () => {
            searchInput.removeAttribute('readonly');
        };
    }

    state.map.on('load', () => {
        initializeMapLayers();
        setupPoiClickListeners(); // From community.js
        // Phase 4 — debounced camera-idle community refetch. moveend fires once
        // when the camera settles (pan or zoom). Guarded on the toggle so it
        // only runs while Community View is on. Smooth: fetch does setData(),
        // no layer teardown.
        let _communityRefetchTimer = null;
        state.map.on('moveend', () => {
            if (!state.isCommunityViewOn) return;
            clearTimeout(_communityRefetchTimer);
            _communityRefetchTimer = setTimeout(() => {
                fetchAndDisplayCommunityRoutes();
            }, 400);
        });

        // Silent initial centering (spec §2.2): if location permission is already
        // granted, ease the camera to the user's area on open. Conditions:
        //   - find-me must be OFF (we don't override an active find-me session)
        //   - not currently tracking a route
        //   - no timeout — if geolocation is slow we just stay on Chicago
        // We use maximumAge:60000 (accept a 1-minute-old cached fix) and
        // enableHighAccuracy:false so this is instant and battery-free.
        // If permission hasn't been granted yet, getCurrentPosition will call the
        // error callback immediately with PERMISSION_DENIED — no prompt shown.
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    // Only center if find-me is still off and we're not tracking
                    if (state.findMeState === 0 && !state.isTracking) {
                        state.map.easeTo({
                            center: [pos.coords.longitude, pos.coords.latitude],
                            zoom: 12,
                            duration: 800
                        });
                    }
                },
                () => { /* Permission denied or unavailable — stay on Chicago. Silent. */ },
                { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 }
            );
        }
    });

    state.map.on('zoom', toggleMarkerVisibility);
}

/**
 * Sets up the initial GeoJSON sources and layers for routes and pins.
 */
// In js/modules/map.js

function initializeMapLayers() {
  // --- User-Specific Layers ---

  // User's route line
  if (!state.map.getSource('user-route')) {
    state.map.addSource('user-route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
  }
  if (!state.map.getLayer('user-route')) {
    state.map.addLayer({
      id: 'user-route',
      type: 'line',
      source: 'user-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#4A7C59', 'line-width': 5 }
    });
  }

  // User's current location dot
  if (!state.map.getSource('user-location-point')) {
    state.map.addSource('user-location-point', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', 'coordinates': [] } } });
  }
  if (!state.map.getLayer('user-location-pulse')) {
    state.map.addLayer({ id: 'user-location-pulse', type: 'circle', source: 'user-location-point', paint: { 'circle-radius': 15, 'circle-color': '#4A7C59', 'circle-opacity': 0.2 } });
  }
  if (!state.map.getLayer('user-location-dot')) {
    state.map.addLayer({ id: 'user-location-dot', type: 'circle', source: 'user-location-point', paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-width': 2, 'circle-stroke-color': '#4A7C59' } });
  }
}

/**
 * Sets the map to a specific style by index (Settings > Map Style selector).
 * Persists the choice to localStorage and restores all layers/markers after
 * the style swap (setStyle wipes every custom source and layer).
 * No-op if the index is invalid or already active.
 * @param {number} index - Index into the mapStyles array (config.js).
 */
export function setMapStyle(index) {
    if (!Number.isInteger(index) || index < 0 || index >= mapStyles.length) return;
    if (index === state.currentStyleIndex) return;

    state.currentStyleIndex = index;
    localStorage.setItem(MAP_STYLE_STORAGE_KEY, String(index));
    state.map.setStyle(mapStyles[index].url);

    state.map.once('style.load', () => {
        // --- Restore the standard stuff (setStyle wiped it) ---
        initializeMapLayers();
        state.userMarkers.forEach(marker => marker.addTo(state.map));
        state.communityMarkers.forEach(marker => marker.addTo(state.map));
        toggleMarkerVisibility();

        if (state.isCommunityViewOn) {
            fetchAndDisplayCommunityRoutes();
        }
        updateUserPinsSource();
    });
}

/**
 * Shows or hides photo markers based on the map's zoom level.
 */
function toggleMarkerVisibility() {
    const display = state.map.getZoom() >= ZOOM_THRESHOLD ? 'block' : 'none';
    state.userMarkers.forEach(marker => marker.getElement().style.display = display);
    state.communityMarkers.forEach(marker => marker.getElement().style.display = display);
}

/**
 * Creates a photo marker with a popup and adds it to the map.
 * @param {object} pinInfo - The data for the pin.
 * @param {string} type - 'user' or 'community'.
 * @param {object} routeInfo - Additional data for community pins.
 * @returns {mapboxgl.Marker} The created marker instance.
 */
export function createAndAddMarker(pinInfo, type, routeInfo = {}) {
    // Guard: reject pins with missing or malformed coords. Without this, a single bad
    // pin throws inside Mapbox's setLngLat() and breaks the forEach loop in
    // displaySessionData/fetchAndDisplayCommunityRoutes -- so every subsequent pin in
    // the same session also fails to render.
    if (!pinInfo || !pinInfo.coords) {
        console.warn('Skipping pin with missing coords:', pinInfo);
        return null;
    }
    const coords = pinInfo.coords;
    const isValidArray = Array.isArray(coords) && coords.length === 2 &&
        Number.isFinite(coords[0]) && Number.isFinite(coords[1]);
    const isValidObject = typeof coords === 'object' && !Array.isArray(coords) &&
        Number.isFinite(coords.lng) && Number.isFinite(coords.lat);
    if (!isValidArray && !isValidObject) {
        console.warn('Skipping pin with invalid coords:', pinInfo);
        return null;
    }
    const lngLat = isValidArray ? coords : [coords.lng, coords.lat];

    const el = document.createElement('div');
    el.className = 'photo-marker';
    el.style.backgroundImage = `url(${pinInfo.thumbnailURL || pinInfo.imageURL || pinInfo.image})`;

    const popup = createPinPopup(pinInfo, type, routeInfo);
    const marker = new mapboxgl.Marker(el).setLngLat(lngLat).setPopup(popup).addTo(state.map);

    if (type === 'user') {
        state.userMarkers.push(marker);
    } else {
        el.style.borderColor = '#28a745'; // Community marker color
        state.communityMarkers.push(marker);
    }
    return marker;
}

/**
 * Creates a Mapbox popup with appropriate controls for a given pin.
 */
function createPinPopup(pinInfo, type, routeInfo = {}) {
    let popupHTML;

    // --- HTML for User's Own Pin (Editable) ---
    if (type === 'user') {
        const mainCategories = Object.keys(pinCategories);
        let mainOptionsHTML = mainCategories.map(cat =>
            `<option value="${cat}" ${pinInfo.category === cat ? 'selected' : ''}>${cat}</option>`
        ).join('');

        // Determine initial sub-categories based on saved data or default
        const currentCategory = pinInfo.category && pinCategories[pinInfo.category] ? pinInfo.category : 'Other';
        let subOptionsHTML = pinCategories[currentCategory].map(subCat =>
            `<option value="${subCat}" ${pinInfo.subCategory === subCat ? 'selected' : ''}>${subCat}</option>`
        ).join('');

        popupHTML = `
            <div>
                <img src="${pinInfo.imageURL || pinInfo.image}" alt="User photo" style="width:100%; height:auto; border-radius: 4px;"/>
                <div class="pin-popup-form">
                    <input type="text" id="title-${pinInfo.id}" value="${pinInfo.title || ''}" placeholder="Enter a title">

                    <label for="category-${pinInfo.id}">Category:</label>
                    <select id="category-${pinInfo.id}">${mainOptionsHTML}</select>

                    <label for="subCategory-${pinInfo.id}">Sub-Category:</label>
                    <select id="subCategory-${pinInfo.id}">${subOptionsHTML}</select>

                    <label for="brand-${pinInfo.id}">Brand (Optional):</label>
                    <input type="text" id="brand-${pinInfo.id}" value="${pinInfo.brand || ''}" placeholder="e.g., Coca-Cola">

                    <div style="display: flex; justify-content: space-between; gap: 10px; margin-top: 10px;">
                        <button id="update-${pinInfo.id}" class="modal-button btn-primary">Update</button>
                        <button id="delete-${pinInfo.id}" class="modal-button btn-danger">Delete</button>
                    </div>
                </div>
            </div>`;

    // --- HTML for Community Pin (Read-only) ---
    } else {
        popupHTML = `
            <div>
                <img src="${pinInfo.thumbnailURL || pinInfo.imageURL}" alt="${pinInfo.title}" style="width:100%; border-radius: 4px;"/>
                <p style="margin: 5px 0 0;"><strong>${pinInfo.title || 'Untitled Pin'}</strong></p>
                <p style="margin: 5px 0 0; font-style: italic; color: #555;">
                    Category: ${pinInfo.category || 'N/A'} ${pinInfo.subCategory ? `(${pinInfo.subCategory})` : ''}
                </p>
                ${pinInfo.brand ? `<p style="margin: 5px 0 0; font-style: italic; color: #555;">Brand: ${pinInfo.brand}</p>` : ''}
                <div style="margin-top:6px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                    <small class="pin-author-line">By: <a href="#" class="profile-link" data-userid="${routeInfo.userId}">${routeInfo.username || 'A user'}</a></small>
                    <button class="report-pin-btn" title="Report this pin"
                        style="background:none; border:none; cursor:pointer; font-size:1.1em; padding:2px 6px;">
                        🚩 Report
                    </button>
                </div>
            </div>
        `;
    }

    // --- Create Popup and Add Event Listeners ---
    const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupHTML);

    popup.on('open', () => {
        // --- Logic for User's Own Pin ---
        if (type === 'user') {
            const categorySelect = document.getElementById(`category-${pinInfo.id}`);
            const subCategorySelect = document.getElementById(`subCategory-${pinInfo.id}`);

            // Update sub-category dropdown when main category changes
            categorySelect?.addEventListener('change', (e) => {
                const selectedCategory = e.target.value;
                const subCategories = pinCategories[selectedCategory] || [];
                subCategorySelect.innerHTML = subCategories.map(subCat =>
                    `<option value="${subCat}">${subCat}</option>`
                ).join('');
            });

            // "Update" button listener
            document.getElementById(`update-${pinInfo.id}`)?.addEventListener('click', () => {
                const pin = state.photoPins.find(p => p.id === pinInfo.id);
                if (pin) {
                    pin.title = document.getElementById(`title-${pinInfo.id}`).value;
                    pin.category = categorySelect.value;
                    pin.subCategory = subCategorySelect.value;
                    pin.brand = document.getElementById(`brand-${pinInfo.id}`).value;
                }
                popup.remove();
                alert("Pin updated! Remember to save your session.");
            });

            // "Delete" button listener
            document.getElementById(`delete-${pinInfo.id}`)?.addEventListener('click', () => {
                if (confirm("Are you sure?")) {
                    // Filter out the deleted pin from the state
                    state.photoPins = state.photoPins.filter(p => p.id !== pinInfo.id);
                    // Find and remove the corresponding marker from the map and state
                    const markerToRemove = state.userMarkers.find(m => {
                        const lngLat = m.getLngLat();
                        const markerCoords = [lngLat.lng, lngLat.lat];
                        const pinCoords = Array.isArray(pinInfo.coords) ? pinInfo.coords : [pinInfo.coords.lng, pinInfo.coords.lat];
                        return markerCoords[0] === pinCoords[0] && markerCoords[1] === pinCoords[1];
                    });
                    if (markerToRemove) {
                        markerToRemove.remove();
                        state.userMarkers = state.userMarkers.filter(m => m !== markerToRemove);
                    }
                    // Update the underlying map source if it exists
                    if (typeof updateUserPinsSource === 'function') { updateUserPinsSource(); }
                    popup.remove();
                }
            });

            // Blur the first input to prevent auto keyboard on mobile
            document.getElementById(`title-${pinInfo.id}`)?.blur();

        // --- Logic for Community Pin ---
        } else {
            // Add click listener for the profile link
            popup.getElement().querySelector(`.profile-link[data-userid="${routeInfo.userId}"]`)?.addEventListener('click', (e) => {
                e.preventDefault();
                showPublicProfile(routeInfo.userId);
            });
            // Add click listener for the 🚩 Report button
            popup.getElement().querySelector('.report-pin-btn')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openReportPinModal(pinInfo, routeInfo);
            });
            // Lazy-load author's level badge. One profile read per popup open.
            // Only shows if showLevel === true AND level > 1 (spec rule).
            if (routeInfo.userId) {
                getDoc(doc(db, 'publicProfiles', routeInfo.userId))
                    .then(snap => {
                        if (!snap.exists()) return;
                        const p = snap.data();
                        const badge = getLevelBadgeHTML(p.level ?? 1, p.showLevel !== false, 18);
                        if (!badge) return;
                        // Inject badge after the profile link inside the pin-author-line
                        const authorEl = popup.getElement().querySelector('.pin-author-line');
                        if (authorEl) authorEl.insertAdjacentHTML('beforeend', badge);
                    })
                    .catch(() => {}); // non-critical
            }
        }
    });
    return popup;
}

/**
 * Updates the 'user-pins-source' GeoJSON with the current pins.
 */
export function updateUserPinsSource() {
    const features = state.photoPins.map(pin => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pin.coords },
        properties: {}
    }));
    if (state.map && state.map.getSource('user-pins-source')) {
        state.map.getSource('user-pins-source').setData({ type: 'FeatureCollection', features });
    }
}

/**
 * Fits the map view to the bounds of the current route and pins.
 */
export function centerOnRoute() {
    if (state.routeCoordinates.length < 1 && state.photoPins.length < 1) {
        alert("No route is currently loaded to center on.");
        return;
    }
    const bounds = new mapboxgl.LngLatBounds();
    state.routeCoordinates.forEach(coord => bounds.extend(coord));
    state.photoPins.forEach(pin => bounds.extend(pin.coords));

    state.map.fitBounds(bounds, {
        padding: { top: 150, bottom: 150, left: 60, right: 60 },
        maxZoom: 16
    });
}
