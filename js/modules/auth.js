// js/testmodules/audit.js
//
// Audit log: records every admin action to the `adminActions` Firestore
// collection so there's a paper trail. Used by approve/reject/delete/promote/
// resolve actions across admin.js, reports.js, and community.js.
//
// Schema (adminActions/{auto-id}):
//   {
//     actionType: "approveEvent" | "rejectEvent" | "approveSquad" | ...
//     actorId:    string   (the admin who did it)
//     actorName:  string   (username at time of action)
//     details:    object   (action-specific context: targetId, targetType,
//                          summary, requestId, reason, etc.)
//     timestamp:  Date
//   }
//
// REQUIRED FIRESTORE RULE — add this to firestore.rules:
//
//   match /adminActions/{actionId} {
//     allow read, create: if isAdmin();
//     allow update, delete: if false;   // immutable log
//   }
//
// Without that rule, writes here will fail with permission-denied.
// logAdminAction() swallows that error so it doesn't break the admin action.

import { db, collection, addDoc, getDocs, doc, getDoc } from './firebase.js';
import { state } from './config.js';

/**
 * Record an admin action. Best-effort: never throws back to the caller, so
 * an audit-log write failure can't break the primary admin operation.
 *
 * Schema written:
 *   {
 *     actionType: string
 *     adminId: string
 *     adminUsername: string
 *     timestamp: Date
 *     summary: string | null     // flattened from details.summary for display
 *     reason: string | null      // flattened from details.reason if present
 *     details: object            // full original details object
 *   }
 *
 * @param {string} actionType
 * @param {object} [details]      conventionally has summary, targetId,
 *                                 targetType, reason, etc.
 */
export async function logAdminAction(actionType, details = {}) {
    if (!state.currentUser) return;

    try {
        let adminUsername = state._cachedActorName;
        if (!adminUsername) {
            try {
                const profSnap = await getDoc(doc(db, 'publicProfiles', state.currentUser.uid));
                adminUsername = profSnap.exists() ? (profSnap.data().username || 'Unknown') : 'Unknown';
                state._cachedActorName = adminUsername;
            } catch (_) {
                adminUsername = 'Unknown';
            }
        }

        await addDoc(collection(db, 'adminActions'), {
            actionType,
            adminId: state.currentUser.uid,
            adminUsername,
            timestamp: new Date(),
            summary: details.summary || null,
            reason: details.reason || null,
            details: details || {}
        });
    } catch (err) {
        // If you see this in console, add the firestore rule documented above.
        console.warn('[audit] Could not record action:', actionType, err.message || err);
    }
}

/**
 * Fetch the most recent audit entries, newest first. We pull the whole
 * collection then trim — the volume here is tiny (one entry per admin action,
 * dozens to low hundreds total). If it ever grows huge, add a query orderBy
 * + limit and a composite index.
 */
export async function fetchAuditLog(limitCount = 200) {
    try {
        const snap = await getDocs(collection(db, 'adminActions'));
        const rows = [];
        snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => {
            const ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0;
            const tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0;
            return tb - ta;
        });
        return rows.slice(0, limitCount);
    } catch (err) {
        console.error('Failed to fetch audit log:', err);
        return [];
    }
}

// Map of actionType -> {emoji, label, color} for display in the audit log.
// label is the verb phrase that follows the admin's username, e.g.
// "ADMIN_NAME approved event request EVENT_TITLE"
const ACTION_LABELS = {
    approveEvent:    { emoji: '✅', label: 'approved event request',     color: '#4A7C59' },
    rejectEvent:     { emoji: '❌', label: 'rejected event request',     color: '#dc3545' },
    approveSquad:    { emoji: '✅', label: 'approved squad request',     color: '#4A7C59' },
    rejectSquad:     { emoji: '❌', label: 'rejected squad request',     color: '#dc3545' },
    deleteEvent:     { emoji: '🗑️', label: 'deleted event',               color: '#dc3545' },
    deleteSquad:     { emoji: '🗑️', label: 'deleted squad',               color: '#dc3545' },
    deleteChallenge: { emoji: '🗑️', label: 'deleted challenge',           color: '#dc3545' },
    createChallenge: { emoji: '🚀', label: 'created challenge',           color: '#4A7C59' },
    resolveReport:   { emoji: '✓',  label: 'resolved report',             color: '#4A7C59' },
    dismissReport:   { emoji: '✗',  label: 'dismissed report',            color: '#888'    },
    promoteAdmin:    { emoji: '⬆️', label: 'promoted to admin',           color: '#dc3545' },
    demoteAdmin:     { emoji: '⬇️', label: 'demoted admin',               color: '#b8860b' },
    toggleOrganizer: { emoji: '🎟️', label: 'updated event-organizer for', color: '#4A7C59' }
};

/**
 * Returns {emoji, label, color} for a given actionType. Falls back gracefully
 * for unknown types so newer code with new actionTypes doesn't break the UI.
 */
export function getActionLabel(actionType) {
    return ACTION_LABELS[actionType] || {
        emoji: '•',
        label: actionType || '(unknown action)',
        color: '#666'
    };
}
