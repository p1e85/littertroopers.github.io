// js/testmodules/admin.js
//
// Admin panel module.
// - Stats tab: live counts pulled from Firestore (getCountFromServer is cheap;
//   one read per collection regardless of size).
// - Pending Events: approves docs from `eventRequests` by creating in `meetups`
//   and marking the request approved. Rejection marks the request rejected.
// - Pending Squads: same flow for `squadRequests` -> `squads`.
//
// All writes here go through the user's auth. Security relies on the deployed
// Firestore rules — these client-side admin checks are UX only.

import {
    db, collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, getCountFromServer, functions, httpsCallable
} from './firebase.js';
import { state } from './config.js';
import { renderReportsTab } from './reports.js';
import { getAdminChallenges, createNewChallenge, deleteChallenge,
         fetchCommunityWindowDays, setCommunityWindowDays } from './community.js';import { calculateRouteDistance, convertRouteFromFirestore } from './utils.js';
import { toast } from './toast.js';
import { logAdminAction, fetchAuditLog, getActionLabel } from './audit.js';

// utils.calculateRouteDistance returns meters; we present miles.
const METERS_TO_MILES = 0.000621371;

// ---------------------------------------------------------------------------
// PERMISSION HELPERS
// ---------------------------------------------------------------------------

/**
 * Reads the currently signed-in user's publicProfile and returns role flags.
 */
export async function getCurrentUserPermissions() {
    if (!state.currentUser) {
        return { isAdmin: false, isApprovedEventOrganizer: false, signedIn: false };
    }
    try {
        const snap = await getDoc(doc(db, 'publicProfiles', state.currentUser.uid));
        if (!snap.exists()) {
            return { isAdmin: false, isApprovedEventOrganizer: false, signedIn: true };
        }
        const data = snap.data();
        return {
            isAdmin: data.role === 'admin',
            isApprovedEventOrganizer: data.isApprovedEventOrganizer === true,
            signedIn: true
        };
    } catch (err) {
        console.error('getCurrentUserPermissions failed:', err);
        return { isAdmin: false, isApprovedEventOrganizer: false, signedIn: true };
    }
}

export async function userIsAdmin() {
    const p = await getCurrentUserPermissions();
    return p.isAdmin;
}
export async function userCanCreateEventsDirectly() {
    const p = await getCurrentUserPermissions();
    return p.isAdmin || p.isApprovedEventOrganizer;
}

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------

/**
 * Returns a snapshot of live counts. Uses Firestore's count aggregator so we
 * pay 1 read per query regardless of collection size. Pin/mile aggregates
 * scan `publishedRoutes` docs - fine while small (<2000), should move to a
 * Cloud Function aggregate if the DB ever grows past that.
 */
export async function fetchAdminStats() {
    const stats = {
        users: 0, publishedRoutes: 0, meetups: 0, squads: 0, challenges: 0,
        pendingEvents: 0, pendingSquads: 0, openReports: 0,
        totalPins: 0, totalMiles: 0, recentRoutes7d: 0,
        errors: []
    };

    const safeCount = async (name, q) => {
        try {
            const snap = await getCountFromServer(q);
            return snap.data().count;
        } catch (err) {
            console.warn(`Count failed for ${name}:`, err);
            stats.errors.push(name);
            return 0;
        }
    };

    [
        stats.users, stats.publishedRoutes, stats.meetups, stats.squads,
        stats.challenges, stats.pendingEvents, stats.pendingSquads
    ] = await Promise.all([
        safeCount('publicProfiles', collection(db, 'publicProfiles')),
        safeCount('publishedRoutes', collection(db, 'publishedRoutes')),
        safeCount('meetups', collection(db, 'meetups')),
        safeCount('squads', collection(db, 'squads')),
        safeCount('challenges', collection(db, 'challenges')),
        safeCount('eventRequests', query(collection(db, 'eventRequests'), where('status', '==', 'pending'))),
        safeCount('squadRequests', query(collection(db, 'squadRequests'), where('status', '==', 'pending')))
    ]);

    stats.openReports = await safeCount(
        'reports-open',
        query(collection(db, 'reports'), where('status', '==', 'open'))
    );

    if (stats.publishedRoutes > 0 && stats.publishedRoutes <= 2000) {
        try {
            const routesSnap = await getDocs(collection(db, 'publishedRoutes'));
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            let pins = 0, miles = 0, recent = 0;
            routesSnap.forEach(d => {
                const data = d.data();
                if (Array.isArray(data.pins)) pins += data.pins.length;

                // Always compute miles from the actual route coords. The stored
                // `distance` field is unreliable: it's missing on Android publishes
                // and on web routes published before the test version, and is
                // sometimes in different units. Going to the source coords is the
                // only consistent path.
                if (Array.isArray(data.route) && data.route.length > 1) {
                    const lngLatArr = convertRouteFromFirestore(data.route);
                    if (lngLatArr && lngLatArr.length > 1) {
                        const meters = calculateRouteDistance(lngLatArr);
                        if (Number.isFinite(meters)) {
                            miles += meters * METERS_TO_MILES;
                        }
                    }
                }

                const ts = data.timestamp;
                const tsMs = ts && typeof ts.toMillis === 'function'
                    ? ts.toMillis()
                    : (ts && ts.seconds ? ts.seconds * 1000 : null);
                if (tsMs && tsMs >= sevenDaysAgo) recent++;
            });
            stats.totalPins = pins;
            stats.totalMiles = miles;
            stats.recentRoutes7d = recent;
        } catch (err) {
            console.warn('Failed to aggregate route details:', err);
            stats.errors.push('route-aggregate');
        }
    } else if (stats.publishedRoutes > 2000) {
        stats.errors.push('routes-too-large-skipped');
    }

    return stats;
}

// ---------------------------------------------------------------------------
// PENDING EVENTS (eventRequests -> meetups)
// ---------------------------------------------------------------------------

export async function fetchPendingEvents() {
    try {
        // Pull all & filter client-side; volumes are tiny and avoids needing a
        // composite index for (status, createdAt).
        const snap = await getDocs(collection(db, 'eventRequests'));
        const rows = [];
        snap.forEach(d => {
            const data = d.data();
            if ((data.status || 'pending') === 'pending') {
                rows.push({ id: d.id, ...data });
            }
        });
        rows.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
            const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
            return tb - ta;
        });
        return rows;
    } catch (err) {
        console.error('fetchPendingEvents failed:', err);
        return [];
    }
}

/**
 * Approve a pending event: create the meetup, then mark the request approved.
 * We keep the request doc (not delete) so there's an audit trail.
 */
export async function approveEventRequest(requestId) {
    try {
        const reqRef = doc(db, 'eventRequests', requestId);
        const reqSnap = await getDoc(reqRef);
        if (!reqSnap.exists()) {
            toast('Request not found (already processed?).', 'error');
            return false;
        }
        const r = reqSnap.data();
        const meetup = {
            organizerId: r.organizerId,
            organizerName: r.organizerName || 'Anonymous',
            poiName: r.poiName || null,
            title: r.title || 'Untitled Event',
            description: r.description || '',
            eventDate: r.eventDate || null,
            createdAt: new Date(),
            coordinates: r.coordinates || null,
            approvedBy: state.currentUser ? state.currentUser.uid : null,
            approvedAt: new Date(),
            fromRequestId: requestId
        };
        const newDoc = await addDoc(collection(db, 'meetups'), meetup);
        await updateDoc(reqRef, {
            status: 'approved',
            meetupId: newDoc.id,
            reviewedBy: state.currentUser ? state.currentUser.uid : null,
            reviewedAt: new Date()
        });
        logAdminAction('approveEvent', {
            targetId: newDoc.id,
            targetType: 'meetup',
            summary: r.title || 'Untitled Event',
            requestId
        });
        return true;
    } catch (err) {
        console.error('approveEventRequest failed:', err);
        toast('Could not approve event: ' + err.message, 'error');
        return false;
    }
}

export async function rejectEventRequest(requestId, reason) {
    try {
        // Capture the title before update so the audit log can reference it
        const before = await getDoc(doc(db, 'eventRequests', requestId));
        const summary = before.exists() ? (before.data().title || 'Untitled') : 'Unknown';
        await updateDoc(doc(db, 'eventRequests', requestId), {
            status: 'rejected',
            rejectionReason: reason || '(no reason provided)',
            reviewedBy: state.currentUser ? state.currentUser.uid : null,
            reviewedAt: new Date()
        });
        logAdminAction('rejectEvent', {
            targetId: requestId,
            targetType: 'eventRequest',
            summary,
            reason: reason || null
        });
        return true;
    } catch (err) {
        console.error('rejectEventRequest failed:', err);
        toast('Could not reject event: ' + err.message, 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
// PENDING SQUADS (squadRequests -> squads)
// ---------------------------------------------------------------------------

export async function fetchPendingSquads() {
    try {
        const snap = await getDocs(collection(db, 'squadRequests'));
        const rows = [];
        snap.forEach(d => {
            const data = d.data();
            if ((data.status || 'pending') === 'pending') {
                rows.push({ id: d.id, ...data });
            }
        });
        rows.sort((a, b) => {
            const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
            const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
            return tb - ta;
        });
        return rows;
    } catch (err) {
        console.error('fetchPendingSquads failed:', err);
        return [];
    }
}

/**
 * Approve a pending squad: create the squad with the requester as leader
 * and as the only member (fixing the bug where new squads had no leader).
 */
export async function approveSquadRequest(requestId) {
    try {
        const reqRef = doc(db, 'squadRequests', requestId);
        const reqSnap = await getDoc(reqRef);
        if (!reqSnap.exists()) {
            toast('Request not found (already processed?).', 'error');
            return false;
        }
        const r = reqSnap.data();

        // Field compatibility: new initializeSquad writes leaderId/leaderName
        // (matching Android). Older requests used creatorId/creatorName, and
        // some older Android docs might use requesterId. Accept all three.
        const ownerId = r.leaderId || r.creatorId || r.requesterId;
        const ownerName = r.leaderName || r.creatorName || r.requesterName;
        if (!ownerId) {
            toast('Request is missing the leader ID; cannot approve.', 'error');
            return false;
        }

        // If we don't have a name from the request (legacy data), fetch one.
        let leaderName = ownerName;
        if (!leaderName) {
            try {
                const profSnap = await getDoc(doc(db, 'publicProfiles', ownerId));
                leaderName = profSnap.exists() ? (profSnap.data().username || 'Unknown') : 'Unknown';
            } catch (_) {
                leaderName = 'Unknown';
            }
        }

        // Pull policy fields, defaulting per the Android spec.
        const isOpen = r.isOpen !== false; // default true unless explicitly false
        let maxMembers = parseInt(r.maxMembers, 10);
        if (!Number.isFinite(maxMembers) || maxMembers < 2) maxMembers = 20;
        if (maxMembers > 50) maxMembers = 50;

        // Android schema: members is a MAP<uid, SquadMember>.
        const leaderMember = {
            uid: ownerId,
            username: leaderName,
            role: 'leader',
            totalPins: 0,
            totalRoutes: 0,
            joinedAt: new Date()
        };

        const squad = {
            squadName: r.squadName,
            callsign: r.callsign,
            homeSector: r.homeSector || null,
            bio: r.bio || '',
            isOpen: isOpen,
            maxMembers: maxMembers,
            memberCount: 1,
            leaderId: ownerId,
            coLeaderIds: [],
            members: { [ownerId]: leaderMember },
            totalPins: 0,
            totalDistance: 0,
            totalRoutes: 0,
            createdAt: new Date(),
            // Audit metadata (not in Android spec but harmless to include)
            approvedBy: state.currentUser ? state.currentUser.uid : null,
            approvedAt: new Date(),
            fromRequestId: requestId
        };
        const newDoc = await addDoc(collection(db, 'squads'), squad);

        // Mark request as approved with a pointer to the live squad.
        await updateDoc(reqRef, {
            status: 'approved',
            squadId: newDoc.id,
            reviewedBy: state.currentUser ? state.currentUser.uid : null,
            reviewedAt: new Date()
        });

        // Denormalize squad affiliation onto the new leader's publicProfile.
        // This is what enforces one-squad-per-user across both apps.
        try {
            await updateDoc(doc(db, 'publicProfiles', ownerId), {
                squadId: newDoc.id,
                squadCallsign: r.callsign,
                squadRole: 'leader'
            });
        } catch (profErr) {
            // Best-effort: a stale profile shouldn't block the approval.
            // We log and let the admin know so they can manually fix if needed.
            console.warn('Could not update leader publicProfile:', profErr);
            toast('Squad approved, but failed to update leader profile. Leader may need to refresh.', 'warn');
        }

        logAdminAction('approveSquad', {
            targetId: newDoc.id,
            targetType: 'squad',
            summary: `[${r.callsign}] ${r.squadName}`,
            requestId
        });
        return true;
    } catch (err) {
        console.error('approveSquadRequest failed:', err);
        toast('Could not approve squad: ' + err.message, 'error');
        return false;
    }
}

export async function rejectSquadRequest(requestId, reason) {
    try {
        const before = await getDoc(doc(db, 'squadRequests', requestId));
        const summary = before.exists()
            ? `[${before.data().callsign || '???'}] ${before.data().squadName || ''}`
            : 'Unknown';
        await updateDoc(doc(db, 'squadRequests', requestId), {
            status: 'rejected',
            rejectionReason: reason || '(no reason provided)',
            reviewedBy: state.currentUser ? state.currentUser.uid : null,
            reviewedAt: new Date()
        });
        logAdminAction('rejectSquad', {
            targetId: requestId,
            targetType: 'squadRequest',
            summary,
            reason: reason || null
        });
        return true;
    } catch (err) {
        console.error('rejectSquadRequest failed:', err);
        toast('Could not reject squad: ' + err.message, 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
// PANEL ORCHESTRATION
// ---------------------------------------------------------------------------

export async function openAdminPanel() {
    const modal = document.getElementById('adminPanelModal');
    if (!modal) {
        console.error('Admin panel modal not found in DOM.');
        return;
    }
    const perms = await getCurrentUserPermissions();
    if (!perms.isAdmin) {
        alert('Admin access required.');
        return;
    }
    modal.style.display = 'flex';
    switchAdminTab('stats');
}

export async function switchAdminTab(tabName) {
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // HTML uses .admin-tab-body (not .admin-tab-panel)
    document.querySelectorAll('.admin-tab-body').forEach(panel => {
        panel.style.display = panel.dataset.tab === tabName ? 'block' : 'none';
    });
    // HTML uses data-tab="pendingEvents" and "pendingSquads"
    switch (tabName) {
        case 'stats': await renderStatsTab(); break;
        case 'pendingEvents': await renderPendingEventsTab(); break;
        case 'pendingSquads': await renderPendingSquadsTab(); break;
        case 'activeEvents': await renderActiveEventsTab(); break;
        case 'activeSquads': await renderActiveSquadsTab(); break;
        case 'users': await renderUsersTab(); break;
        case 'reports': await renderReportsTab(); break;
        case 'challenges': await renderChallengesTab(); break;
        case 'audit': await renderAuditLogTab(); break;
        case 'mail': await renderMailTab(); break;
        default: console.warn('Unknown admin tab:', tabName);
    }
}

export const showAdminTab = switchAdminTab;

// --- TAB RENDERERS ----------------------------------------------------------

async function renderStatsTab() {
    const container = document.getElementById('adminStatsContent');
    if (!container) return;
    container.innerHTML = '<p>Loading stats…</p>';
    const stats = await fetchAdminStats();

    // CSS class names match what's in maptest.html: admin-stats-grid (plural),
    // admin-stat-card, admin-stat-attention for warning cards.
    const card = (label, value, opts = {}) => {
        const cls = 'admin-stat-card' + (opts.attention ? ' admin-stat-attention' : '');
        return `
            <div class="${cls}">
                <div class="admin-stat-value">${value}</div>
                <div class="admin-stat-label">${label}</div>
                ${opts.extra ? `<div class="admin-stat-extra" style="font-size:0.75em;color:#666;margin-top:4px;">${opts.extra}</div>` : ''}
            </div>
        `;
    };

    container.innerHTML = `
        <div class="admin-stats-grid">
            ${card('Users', stats.users)}
            ${card('Published Routes', stats.publishedRoutes, { extra: `${stats.recentRoutes7d} this week` })}
            ${card('Pins Logged', stats.totalPins)}
            ${card('Miles Cleaned', stats.totalMiles.toFixed(1))}
            ${card('Meetups', stats.meetups)}
            ${card('Squads', stats.squads)}
            ${card('Challenges', stats.challenges)}
            ${card('Open Reports', stats.openReports, { attention: stats.openReports > 0 })}
            ${card('Pending Events', stats.pendingEvents, { attention: stats.pendingEvents > 0, extra: stats.pendingEvents > 0 ? '⚠️ Needs review' : '' })}
            ${card('Pending Squads', stats.pendingSquads, { attention: stats.pendingSquads > 0, extra: stats.pendingSquads > 0 ? '⚠️ Needs review' : '' })}
        </div>
        ${stats.errors.length ? `<p style="color:#b00; margin-top:10px;">Some counts failed: ${stats.errors.join(', ')}</p>` : ''}

        <div id="communityWindowAdmin" style="margin-top:18px; padding:14px 16px; background:#1A1A2E; border-radius:10px; color:#fff;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:2px;">
                <span style="font-size:1.1em;">🕑</span>
                <strong style="font-size:1em;">Community Pin Window</strong>
            </div>
            <div style="font-size:0.78em; opacity:0.7; margin-bottom:12px;">
                Global — how many days back individual community pins load and show. Affects every user on all platforms. Older cleanups still count toward impact forever.
            </div>
            <div style="display:flex; align-items:baseline; gap:6px; margin-bottom:8px;">
                <span id="cwWindowValue" style="font-size:1.8em; font-weight:700; color:#FFD54F;">—</span>
                <span style="opacity:0.7; font-size:0.85em;">days</span>
            </div>
            <input type="range" id="cwWindowSlider" min="7" max="90" step="1" value="45" disabled
                style="width:100%; accent-color:#FFD54F; cursor:pointer;">
            <div style="display:flex; justify-content:space-between; font-size:0.72em; opacity:0.6; font-family:monospace;">
                <span>7d</span><span>90d</span>
            </div>
            <div id="cwWindowStatus" style="font-size:0.78em; color:#FFD54F; margin-top:8px; min-height:1em;"></div>
        </div>

        <h4 style="margin:20px 0 8px 0; color:#444; font-size:1em;">🏆 Top 10 Users by Routes Published</h4>
        <div id="adminTopUsersList" style="margin-bottom:14px;">
            <p style="color:#666; font-size:0.9em;">Computing…</p>
        </div>

        <div style="display:flex; gap:8px; justify-content:center; margin-top:14px; flex-wrap:wrap;">
            <button id="adminStatsRefreshBtn" class="modal-button btn-secondary" style="width:auto; padding:6px 16px;">🔄 Refresh</button>
            <button id="adminBootstrapBtn" class="modal-button" style="width:auto; padding:6px 16px; background:#1A1A2E; color:white; border-color:#1A1A2E;">📊 Bootstrap Landing Stats</button>
        </div>
        <div id="adminBootstrapResult" style="display:none; margin-top:10px; padding:10px; background:#E8F5E9; border-radius:6px; font-size:0.85em; color:#333;"></div>
    `;
    document.getElementById('adminStatsRefreshBtn')?.addEventListener('click', renderStatsTab);

    // Community Pin Window control — reads/writes config/communityView.windowDays
    // (global, synced to Android + iOS). Loads async so the grid renders first.
    (async () => {
        const slider = document.getElementById('cwWindowSlider');
        const valueEl = document.getElementById('cwWindowValue');
        const statusEl = document.getElementById('cwWindowStatus');
        if (!slider) return;
        let committed = await fetchCommunityWindowDays();
        slider.value = String(committed);
        valueEl.textContent = String(committed);
        slider.disabled = false;

        // Live label while dragging (no writes yet).
        slider.addEventListener('input', () => { valueEl.textContent = slider.value; });

        // Commit on release — one write per adjustment. Reverts on failure.
        slider.addEventListener('change', async () => {
            const days = parseInt(slider.value, 10);
            if (days === committed) return;
            slider.disabled = true;
            statusEl.textContent = 'Saving…';
            try {
                const saved = await setCommunityWindowDays(days);
                committed = saved;
                slider.value = String(saved);
                valueEl.textContent = String(saved);
                statusEl.textContent = `Window set to ${saved} days for all users.`;
                logAdminAction('setCommunityWindow', { targetType: 'config', summary: `${saved} days` });
            } catch (err) {
                slider.value = String(committed);
                valueEl.textContent = String(committed);
                statusEl.textContent = 'Could not save: ' + (err.message || err);
            } finally {
                slider.disabled = false;
            }
        });
    })();

    // Bootstrap Stats — calls the `bootstrapAppStats` Cloud Function (admin-only,
    // does a full rescan of publishedRoutes and publicProfiles, rewrites config/appStats).
    document.getElementById('adminBootstrapBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('adminBootstrapBtn');
        const resultEl = document.getElementById('adminBootstrapResult');
        btn.disabled = true;
        btn.textContent = '⏳ Bootstrapping…';
        resultEl.style.display = 'none';
        try {
            const bootstrapFn = httpsCallable(functions, 'bootstrapAppStats');
            const result = await bootstrapFn();
            const d = result.data || {};
            resultEl.innerHTML = `
                ✅ <strong>Landing page stats updated!</strong><br>
                ${d.totalPins   != null ? `📍 ${d.totalPins.toLocaleString()} pins &nbsp;` : ''}
                ${d.totalMiles  != null ? `🚶 ${(typeof d.totalMiles === 'number' ? d.totalMiles.toFixed(1) : d.totalMiles)} mi &nbsp;` : ''}
                ${d.totalRoutes != null ? `🗺️ ${d.totalRoutes.toLocaleString()} routes &nbsp;` : ''}
                ${d.totalUsers  != null ? `👥 ${d.totalUsers.toLocaleString()} users` : ''}
            `;
            resultEl.style.display = 'block';
        } catch (err) {
            resultEl.innerHTML = `❌ Bootstrap failed: ${err.message || err}`;
            resultEl.style.background = '#FFE8E8';
            resultEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = '📊 Bootstrap Landing Stats';
        }
    });

    // Fire the top-users computation asynchronously so the stats grid renders first.
    renderTopUsers();
}

/**
 * Computes a leaderboard of top users by published routes count. Runs as a
 * second pass after the main stats render so the page doesn't block on it.
 *
 * Pulls all publishedRoutes (we already do this in fetchAdminStats but keep it
 * separate for simplicity; cached on a future iteration if it becomes slow).
 */
async function renderTopUsers() {
    const container = document.getElementById('adminTopUsersList');
    if (!container) return;

    try {
        const [routesSnap, profilesSnap] = await Promise.all([
            getDocs(collection(db, 'publishedRoutes')),
            getDocs(collection(db, 'publicProfiles'))
        ]);
        // Build uid -> {count, miles, pins}
        const stats = {};
        routesSnap.forEach(d => {
            const data = d.data();
            const uid = data.userId;
            if (!uid) return;
            if (!stats[uid]) stats[uid] = { count: 0, miles: 0, pins: 0 };
            stats[uid].count++;
            if (Array.isArray(data.pins)) stats[uid].pins += data.pins.length;
            if (Array.isArray(data.route) && data.route.length > 1) {
                const lngLatArr = convertRouteFromFirestore(data.route);
                if (lngLatArr && lngLatArr.length > 1) {
                    const meters = calculateRouteDistance(lngLatArr);
                    if (Number.isFinite(meters)) stats[uid].miles += meters * METERS_TO_MILES;
                }
            }
        });
        // Build uid -> username
        const usernames = {};
        profilesSnap.forEach(d => {
            const u = d.data();
            usernames[d.id] = u.username || '(no username)';
        });
        // Top 10 by route count, tiebreak by miles
        const top = Object.entries(stats)
            .map(([uid, s]) => ({ uid, ...s }))
            .sort((a, b) => b.count - a.count || b.miles - a.miles)
            .slice(0, 10);

        if (top.length === 0) {
            container.innerHTML = '<p style="color:#666; font-size:0.9em;">No published routes yet.</p>';
            return;
        }

        container.innerHTML = `
            <div style="display:grid; grid-template-columns:auto 1fr auto auto auto; gap:6px 12px; align-items:center; font-size:0.85em;">
                <div style="font-weight:600; color:#666; font-size:0.8em;">#</div>
                <div style="font-weight:600; color:#666; font-size:0.8em;">USER</div>
                <div style="font-weight:600; color:#666; font-size:0.8em; text-align:right;">ROUTES</div>
                <div style="font-weight:600; color:#666; font-size:0.8em; text-align:right;">MILES</div>
                <div style="font-weight:600; color:#666; font-size:0.8em; text-align:right;">PINS</div>
                ${top.map((u, i) => `
                    <div style="color:#888;">${i + 1}</div>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(usernames[u.uid] || '(unknown)')}</div>
                    <div style="text-align:right; font-weight:600; color:#4A7C59;">${u.count}</div>
                    <div style="text-align:right; color:#666;">${u.miles.toFixed(1)}</div>
                    <div style="text-align:right; color:#666;">${u.pins}</div>
                `).join('')}
            </div>
        `;
    } catch (err) {
        console.warn('Failed to compute top users:', err);
        container.innerHTML = '<p style="color:#b00; font-size:0.9em;">Failed to compute leaderboard.</p>';
    }
}

async function renderPendingEventsTab() {
    const container = document.getElementById('adminPendingEventsContent');
    if (!container) return;
    container.innerHTML = '<p>Loading pending events…</p>';
    const rows = await fetchPendingEvents();
    if (rows.length === 0) {
        container.innerHTML = emptyState('🎉', 'No pending events', 'Events submitted by regular users will appear here when they need review. Approved Event Organizers can post events directly without going through this queue.');
        return;
    }
    container.innerHTML = rows.map(r => `
        <div class="admin-queue-card" data-id="${r.id}">
            <div>
                <h4>${escapeHtml(r.title || '(untitled)')}</h4>
                <p class="admin-queue-meta">
                    Organizer: <strong>${escapeHtml(r.organizerName || 'Unknown')}</strong>
                    ${r.poiName ? ` • Location: ${escapeHtml(r.poiName)}` : ''}
                    ${r.eventDate && r.eventDate.toDate ? ` • ${escapeHtml(r.eventDate.toDate().toLocaleString())}` : ''}
                </p>
                <p class="admin-queue-desc">${escapeHtml(r.description || '')}</p>
            </div>
            <div class="admin-queue-card-actions">
                <button class="modal-button btn-primary admin-approve-btn">Approve</button>
                <button class="modal-button btn-danger admin-reject-btn">Reject</button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.admin-approve-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.closest('.admin-queue-card').dataset.id;
            btn.disabled = true; btn.textContent = 'Approving…';
            const ok = await approveEventRequest(id);
            if (ok) renderPendingEventsTab();
            else { btn.disabled = false; btn.textContent = 'Approve'; }
        });
    });
    container.querySelectorAll('.admin-reject-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.closest('.admin-queue-card').dataset.id;
            const reason = prompt('Reason for rejection (optional):', '');
            if (reason === null) return;
            btn.disabled = true; btn.textContent = 'Rejecting…';
            const ok = await rejectEventRequest(id, reason);
            if (ok) renderPendingEventsTab();
            else { btn.disabled = false; btn.textContent = 'Reject'; }
        });
    });
}

async function renderPendingSquadsTab() {
    const container = document.getElementById('adminPendingSquadsContent');
    if (!container) return;
    container.innerHTML = '<p>Loading pending squads…</p>';
    const rows = await fetchPendingSquads();
    if (rows.length === 0) {
        container.innerHTML = emptyState('🎉', 'No pending squads', 'Squad creation requests from regular users will appear here. Approve to officially commission the squad with the requester as leader.');
        return;
    }
    container.innerHTML = rows.map(r => {
        const policyText = r.isOpen === false ? '🔒 Invite-only' : '🟢 Open';
        const cap = r.maxMembers || '?';
        const requesterName = r.leaderName || r.creatorName || r.requesterName || 'Unknown';
        return `
            <div class="admin-queue-card" data-id="${r.id}">
                <div>
                    <h4>[${escapeHtml(r.callsign || '???')}] ${escapeHtml(r.squadName || '(unnamed)')}</h4>
                    <p class="admin-queue-meta">
                        Requester: <strong>${escapeHtml(requesterName)}</strong>
                        ${r.homeSector ? ` • Sector: ${escapeHtml(r.homeSector)}` : ''}
                        • ${policyText} • max ${cap}
                    </p>
                    <p class="admin-queue-desc">${escapeHtml(r.bio || '')}</p>
                </div>
                <div class="admin-queue-card-actions">
                    <button class="modal-button btn-primary admin-approve-btn">Approve</button>
                    <button class="modal-button btn-danger admin-reject-btn">Reject</button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.admin-approve-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.closest('.admin-queue-card').dataset.id;
            btn.disabled = true; btn.textContent = 'Approving…';
            const ok = await approveSquadRequest(id);
            if (ok) renderPendingSquadsTab();
            else { btn.disabled = false; btn.textContent = 'Approve'; }
        });
    });
    container.querySelectorAll('.admin-reject-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.closest('.admin-queue-card').dataset.id;
            const reason = prompt('Reason for rejection (optional):', '');
            if (reason === null) return;
            btn.disabled = true; btn.textContent = 'Rejecting…';
            const ok = await rejectSquadRequest(id, reason);
            if (ok) renderPendingSquadsTab();
            else { btn.disabled = false; btn.textContent = 'Reject'; }
        });
    });
}

// --- CHALLENGES TAB ---------------------------------------------------------

/**
 * Renders the Challenges tab: creation form on top, active challenges list
 * below. Replaces the old adminChallengeModal that used to be its own modal
 * opened from Challenge Central.
 */
async function renderChallengesTab() {
    const container = document.getElementById('adminChallengesContent');
    if (!container) return;

    // Today's date as the min for the expiry input
    const today = new Date().toISOString().split('T')[0];

    container.innerHTML = `
        <div class="admin-form-container" style="text-align:left;">
            <div class="form-group">
                <label>Quest Title</label>
                <input type="text" id="newChalTitle" placeholder="e.g. The Weekend Warrior" style="width:100%; padding:8px;">
            </div>
            <div class="form-group">
                <label>Brief Briefing</label>
                <textarea id="newChalDesc" rows="3" placeholder="Explain the mission objectives..." style="width:100%; padding:8px;"></textarea>
            </div>
            <div class="form-row" style="display:flex; gap:10px;">
                <div class="form-group" style="flex:1;">
                    <label>Type</label>
                    <select id="newChalType" style="width:100%; padding:8px;">
                        <option value="distance">📏 Distance (Miles)</option>
                        <option value="count">🗑 Item Count</option>
                    </select>
                </div>
                <div class="form-group" style="flex:1;">
                    <label>Target Goal</label>
                    <input type="number" id="newChalGoal" placeholder="e.g. 50" style="width:100%; padding:8px;">
                </div>
            </div>
            <div class="form-row" style="display:flex; gap:10px;">
                <div class="form-group" style="flex:1;">
                    <label>Time Limit (Mins, optional)</label>
                    <input type="number" id="newChalTime" placeholder="Optional" style="width:100%; padding:8px;">
                </div>
                <div class="form-group" style="flex:1;">
                    <label>Badge Icon</label>
                    <input type="text" id="newChalBadge" value="🏅" style="width:100%; padding:8px; text-align:center; font-size:1.2em;">
                </div>
            </div>
            <div class="form-group">
                <label>Quest Expires On</label>
                <input type="date" id="newChalExpire" min="${today}" style="width:100%; padding:8px;">
            </div>
            <button id="newChalSubmitBtn" class="modal-button btn-primary" style="width:100%; margin-top:8px;">
                🚀 LAUNCH CHALLENGE
            </button>
        </div>

        <hr style="margin:20px 0;">

        <h4 style="margin-bottom:8px;">Manage Active Challenges</h4>
        <div id="adminChallengeListInPanel" style="max-height:300px; overflow-y:auto;">
            <p>Loading…</p>
        </div>
    `;

    // Wire create button
    document.getElementById('newChalSubmitBtn').addEventListener('click', async () => {
        const title = document.getElementById('newChalTitle').value.trim();
        const desc = document.getElementById('newChalDesc').value.trim();
        const type = document.getElementById('newChalType').value;
        const goal = document.getElementById('newChalGoal').value;
        const timeLimit = document.getElementById('newChalTime').value;
        const badge = document.getElementById('newChalBadge').value || '🏅';
        const expire = document.getElementById('newChalExpire').value;

        if (!title || !goal || !expire) {
            toast('Please fill in Title, Goal, and Expiration Date.', 'error');
            return;
        }
        const submitBtn = document.getElementById('newChalSubmitBtn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Launching…';
        try {
            await createNewChallenge(title, desc, type, goal, timeLimit, badge, expire);
            logAdminAction('createChallenge', {
                targetType: 'challenge',
                summary: title
            });
            toast('Challenge created!', 'success');
            // Refresh list and clear inputs
            await renderChallengesTab();
        } catch (err) {
            console.error('Failed to create challenge:', err);
            toast('Could not create challenge: ' + err.message, 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = '🚀 LAUNCH CHALLENGE';
        }
    });

    // Load the active challenges list
    await loadChallengeListInPanel();
}

async function loadChallengeListInPanel() {
    const listEl = document.getElementById('adminChallengeListInPanel');
    if (!listEl) return;
    listEl.innerHTML = '<p>Loading…</p>';

    let challenges;
    try {
        challenges = await getAdminChallenges();
    } catch (err) {
        console.error('Failed to load challenges:', err);
        listEl.innerHTML = '<p style="color:#b00;">Failed to load challenges.</p>';
        return;
    }

    if (!challenges || challenges.length === 0) {
        listEl.innerHTML = emptyState('🎯', 'No active challenges', 'Use the form above to launch a global quest. All users can join and earn the badge by completing the goal before the expiry date.');
        return;
    }

    listEl.innerHTML = '';
    challenges.forEach(chal => {
        const item = document.createElement('div');
        item.style.cssText = 'border-bottom:1px solid #eee; padding:10px; display:flex; justify-content:space-between; align-items:center; gap:10px;';
        const expiresDisplay = chal.expires_at && chal.expires_at.seconds
            ? new Date(chal.expires_at.seconds * 1000).toLocaleDateString()
            : 'N/A';
        // Goal field name varies by older docs - try a couple
        const goalDisplay = chal.goal_miles || chal.goal_count || chal.goal || '—';
        item.innerHTML = `
            <div style="flex:1; min-width:0;">
                <strong>${escapeHtml(chal.title || '(no title)')}</strong><br>
                <small style="color:#666;">Goal: ${escapeHtml(String(goalDisplay))} • Exp: ${expiresDisplay}</small>
            </div>
            <button class="admin-chal-delete-btn" style="background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">🗑️</button>
        `;
        item.querySelector('.admin-chal-delete-btn').addEventListener('click', async () => {
            if (!confirm(`Delete the challenge "${chal.title}"? This can't be undone.`)) return;
            try {
                await deleteChallenge(chal.id);
                logAdminAction('deleteChallenge', {
                    targetId: chal.id,
                    targetType: 'challenge',
                    summary: chal.title || 'Untitled'
                });
                toast('Challenge deleted.', 'success');
                await loadChallengeListInPanel();
            } catch (err) {
                console.error('Failed to delete challenge:', err);
                toast('Could not delete challenge: ' + err.message, 'error');
            }
        });
        listEl.appendChild(item);
    });
}

// --- USERS TAB --------------------------------------------------------------

/**
 * Lists all publicProfiles with role/badge info and per-row action buttons.
 */
async function renderUsersTab() {
    const container = document.getElementById('adminUsersContent');
    if (!container) return;
    container.innerHTML = '<p>Loading users…</p>';

    let users = [];
    try {
        const snap = await getDocs(collection(db, 'publicProfiles'));
        snap.forEach(d => users.push({ id: d.id, ...d.data() }));
    } catch (err) {
        console.error('Failed to load users:', err);
        container.innerHTML = '<p style="color:#b00;">Failed to load users.</p>';
        return;
    }

    if (users.length === 0) {
        container.innerHTML = emptyState('👥', 'No users yet', 'Once people sign up and create a username, they\'ll show up here.');
        return;
    }

    // Sort alphabetically by username
    users.sort((a, b) => {
        const ua = (a.username || '').toLowerCase();
        const ub = (b.username || '').toLowerCase();
        return ua.localeCompare(ub);
    });

    const currentUid = state.currentUser ? state.currentUser.uid : null;

    container.innerHTML = `
        <input type="text" id="adminUserSearch" placeholder="🔍 Search by username..."
            style="width:100%; padding:8px; margin-bottom:10px; box-sizing:border-box;">
        <p style="color:#666; font-size:0.85em; margin:4px 0;">${users.length} user${users.length === 1 ? '' : 's'} total</p>
        <div id="adminUserList"></div>
    `;

    const renderList = (filter = '') => {
        const list = document.getElementById('adminUserList');
        const f = filter.toLowerCase().trim();
        const filtered = f
            ? users.filter(u => (u.username || '').toLowerCase().includes(f))
            : users;

        if (filtered.length === 0) {
            list.innerHTML = '<p style="color:#666;">No matches.</p>';
            return;
        }

        list.innerHTML = filtered.map(u => {
            const badgeCount = u.badges ? Object.keys(u.badges).length : 0;
            const isAdminUser = u.role === 'admin';
            const isOrganizer = u.isApprovedEventOrganizer === true;
            const isSelf = u.id === currentUid;

            // Self-row note: admin can't modify their own role from this UI
            // to prevent lockouts (you could demote yourself and lose access).
            // Event-organizer toggling on self is allowed (low-risk; reversible
            // from any other admin or the user themselves doesn't matter — only
            // admins can set this anyway).
            return `
                <div class="admin-user-row" data-uid="${escapeHtml(u.id)}" style="flex-direction:column; align-items:stretch;">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <div>
                            <strong>${escapeHtml(u.username || '(no username)')}</strong>
                            ${isAdminUser ? '<span class="admin-badge admin-badge-admin">ADMIN</span>' : ''}
                            ${isOrganizer ? '<span class="admin-badge admin-badge-organizer">EVENT ORG</span>' : ''}
                            ${isSelf ? '<span class="admin-badge" style="background:#666; color:white;">YOU</span>' : ''}
                        </div>
                        <div style="font-size:0.8em; color:#666;">
                            ${badgeCount} badge${badgeCount === 1 ? '' : 's'}
                            ${u.totalDistance ? ` • ${(u.totalDistance * METERS_TO_MILES).toFixed(1)}mi` : ''}
                            ${u.totalPins ? ` • ${u.totalPins} pins` : ''}
                        </div>
                        <div style="font-size:0.7em; color:#999; font-family:monospace; word-break:break-all;">
                            uid: ${escapeHtml(u.id)}
                        </div>
                    </div>
                    <div class="admin-user-actions" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                        <button class="admin-user-action-btn" data-action="toggleOrganizer"
                            style="font-size:0.8em; padding:5px 10px; cursor:pointer; border:1px solid #4A7C59; background:${isOrganizer ? '#4A7C59' : 'white'}; color:${isOrganizer ? 'white' : '#4A7C59'}; border-radius:4px;">
                            ${isOrganizer ? '✓ Event Organizer' : 'Make Event Organizer'}
                        </button>
                        ${isAdminUser
                            ? `<button class="admin-user-action-btn" data-action="demoteAdmin" ${isSelf ? 'disabled title="Cannot demote yourself"' : ''}
                                  style="font-size:0.8em; padding:5px 10px; cursor:${isSelf ? 'not-allowed' : 'pointer'}; border:1px solid #dc3545; background:#dc3545; color:white; border-radius:4px; opacity:${isSelf ? '0.5' : '1'};">
                                  Remove Admin
                                </button>`
                            : `<button class="admin-user-action-btn" data-action="promoteAdmin" ${isSelf ? 'disabled title="Cannot modify your own role"' : ''}
                                  style="font-size:0.8em; padding:5px 10px; cursor:${isSelf ? 'not-allowed' : 'pointer'}; border:1px solid #dc3545; background:white; color:#dc3545; border-radius:4px; opacity:${isSelf ? '0.5' : '1'};">
                                  ⚠️ Make Admin
                                </button>`}
                    </div>
                </div>
            `;
        }).join('');

        // Wire actions
        list.querySelectorAll('.admin-user-action-btn').forEach(btn => {
            if (btn.disabled) return;
            btn.addEventListener('click', async (e) => {
                const row = e.target.closest('.admin-user-row');
                const uid = row.dataset.uid;
                const action = btn.dataset.action;
                const u = users.find(x => x.id === uid);
                if (!u) return;
                await handleUserAction(action, u, btn);
            });
        });
    };

    renderList();
    document.getElementById('adminUserSearch').addEventListener('input', (e) => {
        renderList(e.target.value);
    });
}

/**
 * Handles one of the per-user action buttons in the Users tab.
 * Each action confirms appropriately and updates the publicProfile.
 */
async function handleUserAction(action, user, btn) {
    const username = user.username || '(no username)';
    const profileRef = doc(db, 'publicProfiles', user.id);
    let updatePayload = null;
    let successMessage = '';

    if (action === 'toggleOrganizer') {
        const newVal = !(user.isApprovedEventOrganizer === true);
        const verb = newVal ? 'GRANT' : 'REVOKE';
        if (!confirm(`${verb} event-organizer status for "${username}"?\n\nThis lets them create events directly without admin approval.`)) {
            return;
        }
        updatePayload = { isApprovedEventOrganizer: newVal };
        successMessage = newVal
            ? `${username} can now create events without approval.`
            : `Event-organizer status removed from ${username}.`;
    } else if (action === 'promoteAdmin') {
        // Two-step confirm because admin powers are unrestricted.
        if (!confirm(`⚠️ MAKE "${username}" AN ADMIN?\n\nAdmins can approve/reject events and squads, delete any content, manage users, create challenges, and resolve reports. This is a powerful role.\n\nClick OK to continue to confirmation.`)) {
            return;
        }
        const typed = prompt(`To confirm, type the word PROMOTE (all caps) and press OK:`);
        if (typed !== 'PROMOTE') {
            toast('Promotion cancelled.', 'info');
            return;
        }
        updatePayload = { role: 'admin' };
        successMessage = `${username} is now an admin.`;
    } else if (action === 'demoteAdmin') {
        if (!confirm(`Remove admin status from "${username}"?\n\nThey will lose all admin powers immediately.`)) {
            return;
        }
        const typed = prompt(`To confirm, type the word DEMOTE (all caps) and press OK:`);
        if (typed !== 'DEMOTE') {
            toast('Demotion cancelled.', 'info');
            return;
        }
        // We can't store `role: null` and rely on the rule. The rule checks
        // `role == 'admin'`, so anything other than "admin" effectively demotes.
        // Setting to "user" makes the data clean and grep-able.
        updatePayload = { role: 'user' };
        successMessage = `${username} is no longer an admin.`;
    } else {
        console.warn('Unknown user action:', action);
        return;
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Saving…';
    try {
        await updateDoc(profileRef, updatePayload);
        // Map UI action -> audit action code
        const auditActionMap = {
            toggleOrganizer: updatePayload.isApprovedEventOrganizer ? 'grantOrganizer' : 'revokeOrganizer',
            promoteAdmin: 'promoteAdmin',
            demoteAdmin: 'demoteAdmin'
        };
        logAdminAction(auditActionMap[action] || action, {
            targetId: user.id,
            targetType: 'user',
            summary: username
        });
        toast(successMessage, 'success');
        await renderUsersTab();
    } catch (err) {
        console.error('User action failed:', err);
        // Most common failure: Firestore rule rejected the update because the
        // current user isn't admin. Surface that clearly.
        const msg = err.code === 'permission-denied'
            ? 'Permission denied. Check that your account has role=admin in publicProfiles.'
            : err.message;
        toast(`Action failed: ${msg}`, 'error');
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// --- ACTIVE EVENTS TAB ------------------------------------------------------

/**
 * Lists currently scheduled meetups (approved events). Admin can delete any.
 */
async function renderActiveEventsTab() {
    const container = document.getElementById('adminActiveEventsContent');
    if (!container) return;
    container.innerHTML = '<p>Loading events…</p>';

    let events = [];
    try {
        const snap = await getDocs(collection(db, 'meetups'));
        snap.forEach(d => events.push({ id: d.id, ...d.data() }));
    } catch (err) {
        console.error('Failed to load events:', err);
        container.innerHTML = '<p style="color:#b00;">Failed to load events.</p>';
        return;
    }

    if (events.length === 0) {
        container.innerHTML = emptyState('📅', 'No active events', 'Once events are scheduled (either directly by approved organizers or via approval from the Pending Events tab), they\'ll appear here.');
        return;
    }

    const now = Date.now();
    // Default sort + filter; user-changeable below
    let currentSort = 'upcoming';
    let currentFilter = 'all';

    // Render the controls + list. Re-callable when the controls change.
    const renderEventsList = () => {
        const filtered = events.filter(ev => {
            if (currentFilter === 'all') return true;
            const t = (ev.eventDate && ev.eventDate.toMillis) ? ev.eventDate.toMillis() : 0;
            const isPast = t > 0 && t < now;
            return currentFilter === 'past' ? isPast : !isPast;
        });
        filtered.sort((a, b) => {
            const ta = (a.eventDate && a.eventDate.toMillis) ? a.eventDate.toMillis() : 0;
            const tb = (b.eventDate && b.eventDate.toMillis) ? b.eventDate.toMillis() : 0;
            if (currentSort === 'upcoming') {
                const aPast = ta > 0 && ta < now;
                const bPast = tb > 0 && tb < now;
                if (aPast !== bPast) return aPast ? 1 : -1;
                return ta - tb;
            } else if (currentSort === 'newest') {
                const ca = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
                const cb = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
                return cb - ca;
            } else if (currentSort === 'organizer') {
                return (a.organizerName || '').localeCompare(b.organizerName || '');
            }
            return 0;
        });

        const listHTML = filtered.length === 0
            ? '<p style="color:#666; font-size:0.9em; padding:20px 0; text-align:center;">No events match this filter.</p>'
            : filtered.map(ev => {
                const date = ev.eventDate && ev.eventDate.toDate ? ev.eventDate.toDate() : null;
                const dateStr = date ? date.toLocaleString() : 'no date';
                const isPast = date && date.getTime() < now;
                return `
                    <div class="admin-queue-card" data-id="${ev.id}">
                        <div style="flex:1; min-width:0;">
                            <h4>
                                ${escapeHtml(ev.title || '(untitled)')}
                                ${isPast ? '<span class="admin-badge admin-badge-past">PAST</span>' : ''}
                            </h4>
                            <p class="admin-queue-meta">
                                Organizer: <strong>${escapeHtml(ev.organizerName || 'Unknown')}</strong>
                                ${ev.poiName ? ` • ${escapeHtml(ev.poiName)}` : ''}
                            </p>
                            <p class="admin-queue-meta">📅 ${escapeHtml(dateStr)}</p>
                            ${ev.description ? `<p class="admin-queue-desc">${escapeHtml(ev.description)}</p>` : ''}
                        </div>
                        <div class="admin-queue-card-actions">
                            <button class="modal-button btn-danger admin-event-delete-btn">Delete</button>
                        </div>
                    </div>
                `;
            }).join('');

        document.getElementById('adminEventsListBody').innerHTML =
            `<p style="color:#666; font-size:0.85em; margin:4px 0;">${filtered.length} of ${events.length} event${events.length === 1 ? '' : 's'}</p>` + listHTML;

        // Wire delete buttons for the filtered list (must rewire on each render
        // since the DOM nodes are replaced).
        document.querySelectorAll('#adminEventsListBody .admin-event-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const card = e.target.closest('.admin-queue-card');
                const id = card.dataset.id;
                const ev = events.find(x => x.id === id);
                if (!confirm('Delete this event? This cannot be undone.')) return;
                btn.disabled = true;
                btn.textContent = 'Deleting…';
                try {
                    await deleteDoc(doc(db, 'meetups', id));
                    logAdminAction('deleteEvent', {
                        targetId: id,
                        targetType: 'meetup',
                        summary: ev ? (ev.title || 'Untitled') : 'Unknown'
                    });
                    toast('Event deleted.', 'success');
                    renderActiveEventsTab();
                } catch (err) {
                    console.error('Failed to delete event:', err);
                    toast('Could not delete event: ' + err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Delete';
                }
            });
        });
    };

    container.innerHTML = `
        <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:10px; font-size:0.85em;">
            <label>Show:
                <select id="adminEventsFilter" style="padding:4px 6px;">
                    <option value="all">All</option>
                    <option value="upcoming">Upcoming only</option>
                    <option value="past">Past only</option>
                </select>
            </label>
            <label>Sort:
                <select id="adminEventsSort" style="padding:4px 6px;">
                    <option value="upcoming">Upcoming first</option>
                    <option value="newest">Recently created</option>
                    <option value="organizer">By organizer</option>
                </select>
            </label>
        </div>
        <div id="adminEventsListBody"></div>
    `;

    document.getElementById('adminEventsFilter').addEventListener('change', (e) => {
        currentFilter = e.target.value;
        renderEventsList();
    });
    document.getElementById('adminEventsSort').addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderEventsList();
    });

    renderEventsList();
}

// --- ACTIVE SQUADS TAB ------------------------------------------------------

async function renderActiveSquadsTab() {
    const container = document.getElementById('adminActiveSquadsContent');
    if (!container) return;
    container.innerHTML = '<p>Loading squads…</p>';

    let squads = [];
    try {
        const snap = await getDocs(collection(db, 'squads'));
        snap.forEach(d => squads.push({ id: d.id, ...d.data() }));
    } catch (err) {
        console.error('Failed to load squads:', err);
        container.innerHTML = '<p style="color:#b00;">Failed to load squads.</p>';
        return;
    }

    if (squads.length === 0) {
        container.innerHTML = emptyState('⚔️', 'No active squads', 'Once squads are approved (or created directly by admins), they\'ll show up here.');
        return;
    }

    let currentSort = 'name';

    // Counts members regardless of stored shape:
    //   - data.memberCount (preferred, denormalized by Android + new web code)
    //   - data.members as map<uid, SquadMember>  (Android canonical)
    //   - data.members as array<uid>             (legacy web)
    const countMembers = (sq) => {
        if (Number.isFinite(sq.memberCount)) return sq.memberCount;
        if (sq.members && typeof sq.members === 'object' && !Array.isArray(sq.members)) {
            return Object.keys(sq.members).length;
        }
        if (Array.isArray(sq.members)) return sq.members.length;
        return 0;
    };

    const renderSquadsList = () => {
        squads.sort((a, b) => {
            if (currentSort === 'name') {
                return (a.squadName || '').localeCompare(b.squadName || '');
            } else if (currentSort === 'members') {
                return countMembers(b) - countMembers(a);
            } else if (currentSort === 'newest') {
                const ca = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
                const cb = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
                return cb - ca;
            } else if (currentSort === 'pins') {
                return (b.totalPins || 0) - (a.totalPins || 0);
            }
            return 0;
        });

        document.getElementById('adminSquadsListBody').innerHTML = squads.map(sq => {
            const memberCount = countMembers(sq);
            const maxText = sq.maxMembers ? ` / ${sq.maxMembers}` : '';
            const policyText = sq.isOpen === false ? '🔒 Invite-only' : '🟢 Open';
            return `
                <div class="admin-queue-card" data-id="${sq.id}">
                    <div style="flex:1; min-width:0;">
                        <h4>[${escapeHtml(sq.callsign || '???')}] ${escapeHtml(sq.squadName || '(unnamed)')}</h4>
                        <p class="admin-queue-meta">
                            ${memberCount}${maxText} member${memberCount === 1 ? '' : 's'}
                            • ${policyText}
                            ${sq.homeSector ? ` • ${escapeHtml(sq.homeSector)}` : ''}
                            ${sq.totalPins ? ` • ${sq.totalPins} pins` : ''}
                        </p>
                        ${sq.bio ? `<p class="admin-queue-desc">${escapeHtml(sq.bio)}</p>` : ''}
                        <p class="admin-queue-meta" style="font-size:0.75em; color:#999; font-family:monospace;">
                            leader: ${escapeHtml(sq.leaderId || '(none)')}
                        </p>
                    </div>
                    <div class="admin-queue-card-actions">
                        <button class="modal-button btn-danger admin-squad-delete-btn">Delete</button>
                    </div>
                </div>
            `;
        }).join('');

        document.querySelectorAll('#adminSquadsListBody .admin-squad-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const card = e.target.closest('.admin-queue-card');
                const id = card.dataset.id;
                const sq = squads.find(s => s.id === id);
                const label = sq ? `[${sq.callsign}] ${sq.squadName}` : 'this squad';
                if (!confirm(`Delete ${label}? Members will be removed. This cannot be undone.`)) return;
                btn.disabled = true;
                btn.textContent = 'Deleting…';
                try {
                    await deleteDoc(doc(db, 'squads', id));
                    logAdminAction('deleteSquad', {
                        targetId: id,
                        targetType: 'squad',
                        summary: label
                    });
                    toast('Squad deleted.', 'success');
                    renderActiveSquadsTab();
                } catch (err) {
                    console.error('Failed to delete squad:', err);
                    toast('Could not delete squad: ' + err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Delete';
                }
            });
        });
    };

    container.innerHTML = `
        <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; font-size:0.85em;">
            <p style="color:#666; margin:0;">${squads.length} squad${squads.length === 1 ? '' : 's'} total</p>
            <label style="margin-left:auto;">Sort:
                <select id="adminSquadsSort" style="padding:4px 6px;">
                    <option value="name">By name</option>
                    <option value="members">Most members</option>
                    <option value="pins">Most pins</option>
                    <option value="newest">Newest</option>
                </select>
            </label>
        </div>
        <div id="adminSquadsListBody"></div>
    `;
    document.getElementById('adminSquadsSort').addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderSquadsList();
    });
    renderSquadsList();
}

// --- AUDIT LOG TAB ----------------------------------------------------------

/**
 * Renders the audit log: a reverse-chronological list of admin actions.
 * Falls back to a friendly empty state if the adminActions collection is
 * missing/empty/inaccessible.
 */
async function renderAuditLogTab() {
    const container = document.getElementById('adminAuditContent');
    if (!container) return;
    container.innerHTML = '<p>Loading audit log…</p>';

    const rows = await fetchAuditLog(100);
    if (rows.length === 0) {
        container.innerHTML = emptyState('🕓', 'No admin actions yet', 'Once admins approve events, manage users, or moderate reports, those actions will be logged here. Make sure the <code>adminActions</code> Firestore rule is deployed (see audit.js header).');
        return;
    }

    container.innerHTML = `<p style="color:#666; font-size:0.85em; margin:4px 0;">Showing most recent ${rows.length} action${rows.length === 1 ? '' : 's'}</p>` + rows.map(r => {
        const label = getActionLabel(r.actionType);
        const ts = r.timestamp && r.timestamp.toDate ? r.timestamp.toDate() : null;
        const tsStr = ts ? ts.toLocaleString() : '';
        return `
            <div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px solid #eee; align-items:flex-start;">
                <div style="font-size:1.4em; line-height:1;">${label.emoji}</div>
                <div style="flex:1; min-width:0;">
                    <div style="font-size:0.95em;">
                        <strong style="color:${label.color};">${escapeHtml(r.adminUsername || r.adminId || 'Unknown admin')}</strong>
                        ${escapeHtml(label.label)}
                        <strong>${escapeHtml(r.summary || '(no summary)')}</strong>
                    </div>
                    ${r.reason ? `<div style="font-size:0.8em; color:#888; margin-top:2px;">reason: ${escapeHtml(r.reason)}</div>` : ''}
                    <div style="font-size:0.75em; color:#999; margin-top:2px;">${escapeHtml(tsStr)}</div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Returns HTML for a friendly empty state. Used by tabs that need a nicer
 * "nothing here" message than just a single-line paragraph.
 */
function emptyState(icon, title, body) {
    return `
        <div style="text-align:center; padding:40px 20px; color:#666;">
            <div style="font-size:3em; margin-bottom:8px;">${icon}</div>
            <div style="font-size:1.1em; font-weight:600; color:#444; margin-bottom:6px;">${title}</div>
            <div style="font-size:0.9em; line-height:1.5; max-width:400px; margin:0 auto;">${body}</div>
        </div>
    `;
}

// --- MAIL TAB ---------------------------------------------------------------

/**
 * Shows mailingList and betaWaitlist collections.
 * Per-entry: copy-email button + delete (with confirm).
 * Section-level: "Copy All N Emails" button.
 */
async function renderMailTab() {
    const container = document.getElementById('adminMailContent');
    if (!container) return;
    container.innerHTML = '<p>Loading…</p>';

    const COLLECTIONS = [
        { id: 'mailingList',  label: '📬 Mailing List',  emailField: 'email' },
        { id: 'betaWaitlist', label: '🚀 Beta Waitlist', emailField: 'email' }
    ];

    let html = '';

    for (const col of COLLECTIONS) {
        let rows = [];
        try {
            const snap = await getDocs(collection(db, col.id));
            snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
            rows.sort((a, b) => {
                const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
                const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
                return tb - ta;
            });
        } catch (err) {
            html += `<p style="color:#b00;">Could not load ${col.label}: ${err.message}</p>`;
            continue;
        }

        const emails = rows.map(r => r[col.emailField] || r.email || '').filter(Boolean);

        html += `
            <div style="margin-bottom:20px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                    <h4 style="margin:0; color:#333;">${col.label} <span style="color:#888; font-weight:normal; font-size:0.9em;">(${rows.length})</span></h4>
                    ${emails.length > 0 ? `<button class="modal-button btn-secondary mail-copy-all-btn" data-col="${col.id}" style="width:auto; padding:5px 12px; font-size:0.85em;">📋 Copy All ${emails.length} Emails</button>` : ''}
                </div>
                ${rows.length === 0 ? `<p style="color:#888; font-size:0.9em;">No signups yet.</p>` : `
                <div style="max-height:280px; overflow-y:auto; border:1px solid #eee; border-radius:6px;">
                    ${rows.map(r => {
                        const email = escapeHtml(r[col.emailField] || r.email || '(no email)');
                        const date = r.createdAt && r.createdAt.toDate
                            ? r.createdAt.toDate().toLocaleDateString()
                            : '';
                        return `
                            <div class="mail-row" data-id="${r.id}" data-col="${col.id}" data-email="${email}"
                                style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 12px; border-bottom:1px solid #f0f0f0;">
                                <div style="min-width:0;">
                                    <div style="font-size:0.9em; font-weight:500; color:#333; word-break:break-all;">${email}</div>
                                    ${date ? `<div style="font-size:0.75em; color:#aaa;">${date}</div>` : ''}
                                </div>
                                <div style="display:flex; gap:6px; flex-shrink:0;">
                                    <button class="mail-copy-btn" title="Copy email"
                                        style="background:none; border:1px solid #ddd; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:0.8em;">📋</button>
                                    <button class="mail-delete-btn" title="Delete entry"
                                        style="background:none; border:1px solid #ddd; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:0.8em; color:#dc3545;">🗑️</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>`}
            </div>
        `;

        // Stash emails on the section for the "Copy All" button
        // (stored as data on the container element after rendering)
        setTimeout(() => {
            const colDiv = container.querySelector(`[data-col="${col.id}"].mail-copy-all-btn`);
            if (colDiv) colDiv._emails = emails;
        }, 0);
    }

    html += `<p style="text-align:center; margin-top:4px;">
        <button id="adminMailRefreshBtn" class="modal-button btn-secondary" style="width:auto; padding:5px 14px; font-size:0.85em;">🔄 Refresh</button>
    </p>`;

    container.innerHTML = html;

    // Store emails arrays on the Copy All buttons
    container.querySelectorAll('.mail-copy-all-btn').forEach(btn => {
        const colId = btn.dataset.col;
        const col = COLLECTIONS.find(c => c.id === colId);
        if (!col) return;
        const allRows = container.querySelectorAll(`.mail-row[data-col="${colId}"]`);
        const emails = [...allRows].map(r => r.dataset.email).filter(Boolean);
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(emails.join('\n'))
                .then(() => toast(`Copied ${emails.length} emails to clipboard.`, 'success'))
                .catch(() => toast('Clipboard copy failed.', 'error'));
        });
    });

    // Per-row: copy email
    container.querySelectorAll('.mail-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const row = e.target.closest('.mail-row');
            const email = row?.dataset.email || '';
            navigator.clipboard.writeText(email)
                .then(() => toast(`Copied: ${email}`, 'success', 2000))
                .catch(() => toast('Clipboard copy failed.', 'error'));
        });
    });

    // Per-row: delete
    container.querySelectorAll('.mail-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('.mail-row');
            const id = row?.dataset.id;
            const colId = row?.dataset.col;
            const email = row?.dataset.email || id;
            if (!id || !colId) return;
            if (!confirm(`Delete "${email}" from the list? This cannot be undone.`)) return;
            btn.disabled = true;
            try {
                await deleteDoc(doc(db, colId, id));
                row.style.transition = 'opacity 0.2s';
                row.style.opacity = '0';
                setTimeout(() => row.remove(), 220);
                toast('Entry deleted.', 'info');
            } catch (err) {
                toast('Could not delete: ' + err.message, 'error');
                btn.disabled = false;
            }
        });
    });

    document.getElementById('adminMailRefreshBtn')?.addEventListener('click', renderMailTab);
}

// --- HELPER -----------------------------------------------------------------

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
