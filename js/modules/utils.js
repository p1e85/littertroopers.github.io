
/**
 * A collection of reusable utility functions for data conversion and calculations.
 */

// --- DATA CONVERSION UTILITIES ---
// These functions translate data structures between what Mapbox expects ([lng, lat])
// and what is more cleanly stored in Firestore ({lng: val, lat: val}).

export function convertRouteForFirestore(coordsArray) {
    if (!coordsArray) return [];
    return coordsArray.map(coord => ({ lng: coord[0], lat: coord[1] }));
}

export function convertRouteFromFirestore(coordsData) {
    if (!coordsData || coordsData.length === 0) return [];
    const first = coordsData[0];

    // Legacy: already [[lng, lat], ...] — pass through
    if (Array.isArray(first)) {
        return coordsData;
    }
    // Web: [{lng, lat}, ...]
    if (first && Number.isFinite(first.lng) && Number.isFinite(first.lat)) {
        return coordsData.map(c => [c.lng, c.lat]);
    }
    // Android-style alternates: [{latitude, longitude}, ...] or {_latitude, _longitude}
    if (first && Number.isFinite(first.longitude) && Number.isFinite(first.latitude)) {
        return coordsData.map(c => [c.longitude, c.latitude]);
    }
    if (first && Number.isFinite(first._longitude) && Number.isFinite(first._latitude)) {
        return coordsData.map(c => [c._longitude, c._latitude]);
    }
    // Unknown shape - return empty so renderers don't crash on bad geometry
    console.warn('convertRouteFromFirestore: unknown coord shape', first);
    return [];
}

export function convertPinsForFirestore(pinsArray) {
    if (!pinsArray) return [];
    return pinsArray.map(pin => {
        const newPin = { ...pin };
        if (Array.isArray(newPin.coords)) {
            newPin.coords = { lng: newPin.coords[0], lat: newPin.coords[1] };
        }
        return newPin;
    });
}

/**
 * Normalize pins read from Firestore to the web app's internal format:
 * `pin.coords = [lng, lat]` (Mapbox order).
 *
 * Supported input schemas (because the Android app and older web versions wrote
 * different shapes, all of which now coexist in production data):
 *   1. coords: [lng, lat]                           — legacy web array
 *   2. coords: { lng, lat }                         — current web object
 *   3. lat, lng (top-level)                         — Android app
 *   4. coords: { _latitude, _longitude }            — raw Firestore GeoPoint
 *
 * Anything we can't recognize is left as-is; downstream renderers
 * (createAndAddMarker, fetchAndDisplayCommunityRoutes) will skip and log it.
 */
export function convertPinsFromFirestore(pinsData) {
    if (!pinsData || pinsData.length === 0) return [];
    return pinsData.map(pin => {
        const newPin = { ...pin };
        const c = newPin.coords;

        // 1. Already [lng, lat] array
        if (Array.isArray(c) && c.length === 2 &&
            Number.isFinite(c[0]) && Number.isFinite(c[1])) {
            return newPin;
        }

        // 2. {lng, lat} object
        if (c && typeof c === 'object' &&
            Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
            newPin.coords = [c.lng, c.lat];
            return newPin;
        }

        // 3. Android: top-level lat/lng (no coords field at all)
        if (Number.isFinite(newPin.lat) && Number.isFinite(newPin.lng)) {
            newPin.coords = [newPin.lng, newPin.lat];
            return newPin;
        }

        // 4. Firestore GeoPoint serialization: {_latitude, _longitude}
        if (c && typeof c === 'object' &&
            Number.isFinite(c._longitude) && Number.isFinite(c._latitude)) {
            newPin.coords = [c._longitude, c._latitude];
            return newPin;
        }

        // Unknown shape - leave alone, will be skipped by the renderers' guards
        return newPin;
    });
}

// --- DATA MIGRATION ---

/**
 * Checks for an old, incompatible data format in local storage and clears it.
 */
export function checkAndClearOldData() {
    const guestSessionsJSON = localStorage.getItem('guestSessions');
    if (guestSessionsJSON) {
        try {
            const guestSessions = JSON.parse(guestSessionsJSON);
            if (guestSessions.length > 0 && guestSessions[0].route && Array.isArray(guestSessions[0].route[0])) {
                alert("The app has been updated. Your old locally saved sessions are no longer compatible and will be cleared.");
                localStorage.removeItem('guestSessions');
            }
        } catch (error) {
            console.error("Error parsing old guest sessions, clearing data.", error);
            localStorage.removeItem('guestSessions');
        }
    }
}

// --- CALCULATION UTILITIES ---

/**
 * Calculates the total distance of a route in meters using the Haversine formula.
 * @param {Array<Array<number>>} coordinates - An array of [lng, lat] coordinates.
 * @returns {number} The total distance in meters.
 */
export function calculateRouteDistance(coordinates) {
    let totalDistance = 0;
    if (coordinates.length < 2) return 0;

    for (let i = 0; i < coordinates.length - 1; i++) {
        const p1 = { lat: coordinates[i][1], lng: coordinates[i][0] };
        const p2 = { lat: coordinates[i + 1][1], lng: coordinates[i + 1][0] };
        const R = 6371e3; // Earth's radius in meters
        const φ1 = p1.lat * Math.PI / 180;
        const φ2 = p2.lat * Math.PI / 180;
        const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
        const Δλ = (p2.lng - p1.lng) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        totalDistance += R * c; // Distance in meters
    }
    return totalDistance;
}
