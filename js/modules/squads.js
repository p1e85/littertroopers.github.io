// js/testmodules/squads.js
//
// Squad membership flows: request-to-join, invites, leave, disband.
// Pulled out of community.js (which is already huge) to keep concerns separated.
//
// All writes here have to keep three things in sync:
//   1. The squad doc's `members` map and `memberCount`
//   2. The relevant subcollection (joinRequests or invites) status
//   3. The user's denormalized publicProfile fields (squadId, squadCallsign,
//      squadRole) — these are how the rest of the app (and Android) knows
//      who's in what squad
//
// We use Firestore transactions for the multi-doc writes so we can't end up
// in a state where (e.g.) the user is in members but their publicProfile
// still says they're squadless.

import {
    db, collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
    query, where, limit, runTransaction
} from './firebase.js';
import { state } from './config.js';
import { toast } from './toast.js';
import { logAdminAction } from './audit.js';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Returns a normalized members map. Tolerates the legacy array shape so old
 * squads (if any survived from before Phase 5A) still render and modify.
 */
function readMembersMap(squadData) {
    if (!squadData || !squadData.members) return {};
    if (typeof squadData.members === 'object' && !Array.isArray(squadData.members)) {
        return squadData.members;
    }
    // Legacy array<uid> form — convert to a thin map so we can write back.
    if (Array.isArray(squadData.members)) {
        const map = {};
        squadData.members.forEach(uid => {
            map[uid] = {
                uid,
                username: 'Unknown',
                role: uid === squadData.leaderId ? 'leader' : 'member',
                totalPins: 0,
                totalRoutes: 0,
                joinedAt: squadData.createdAt || new Date()
            };
        });
        return map;
    }
    return {};
}

/**
 * Returns the SquadMember object for a uid, building one for the leader if the
 * squad doc somehow doesn't have them in the map yet (defensive).
 */
function buildSquadMember(uid, username, role = 'member') {
    return {
        uid,
        username: username || 'Unknown',
        role,
        totalPins: 0,
        totalRoutes: 0,
        joinedAt: new Date()
    };
}

/**
 * Quick read of current user's profile + admin flag. Used in many places
 * below. Cached on state for the session.
 */
async function getMyProfile() {
    if (!state.currentUser) return null;
    try {
        const snap = await getDoc(doc(db, 'publicProfiles', state.currentUser.uid));
        return snap.exists() ? { uid: state.currentUser.uid, ...snap.data() } : null;
    } catch (err) {
        console.warn('getMyProfile failed:', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// REQUEST TO JOIN (open squads only)
// ---------------------------------------------------------------------------

/**
 * Submits a join request for an open squad.
 * Spec: writes to squads/{squadId}/joinRequests/{userId} with the user's uid
 * as the doc ID (so a user can only have one outstanding request per squad).
 */
export async function requestToJoin(squadId, message = '') {
    if (!state.currentUser) {
        toast('Please log in to request joining.', 'error');
        return false;
    }
    const me = await getMyProfile();
    if (!me) {
        toast('Could not load your profile.', 'error');
        return false;
    }
    if (me.squadId && me.squadId.length > 0) {
        toast(`You're already in squad [${me.squadCallsign || '???'}]. Leave it first.`, 'warn');
        return false;
    }

    try {
        // Verify the squad exists and is open. If the leader changed it to
        // invite-only between page load and click, we want to fail clearly.
        const squadSnap = await getDoc(doc(db, 'squads', squadId));
        if (!squadSnap.exists()) {
            toast('That squad no longer exists.', 'error');
            return false;
        }
        const squad = squadSnap.data();
        if (squad.isOpen === false) {
            toast('This squad is invite-only.', 'warn');
            return false;
        }
        const memberMap = readMembersMap(squad);
        if (memberMap[state.currentUser.uid]) {
            toast("You're already a member of this squad.", 'info');
            return false;
        }
        const memberCount = squad.memberCount || Object.keys(memberMap).length;
        if (squad.maxMembers && memberCount >= squad.maxMembers) {
            toast('This squad is full.', 'warn');
            return false;
        }

        // Write the join request. Doc ID = requester's uid (per spec).
        // Pre-read first: if a stale denied/approved request exists from a
        // previous attempt, setDoc would trigger an UPDATE (not create) which
        // requires leader or admin permissions. We avoid that by deleting the
        // stale doc first (delete rule allows the requester to delete their own).
        const requestRef = doc(db, 'squads', squadId, 'joinRequests', state.currentUser.uid);
        const existingSnap = await getDoc(requestRef);
        if (existingSnap.exists()) {
            const existing = existingSnap.data();
            if (existing.status === 'pending') {
                toast('You already have a pending request for this squad.', 'info');
                return false;
            }
            if (existing.status === 'approved') {
                toast("You're already a member of this squad.", 'info');
                return false;
            }
            // status === 'denied' (or any other stale value) — delete and re-request.
            await deleteDoc(requestRef);
        }

        await setDoc(requestRef, {
            userId: state.currentUser.uid,
            username: me.username || 'Unknown',
            message: message || '',
            status: 'pending',
            createdAt: new Date()
        });

        toast('Request submitted! The squad leader will review it.', 'success');
        return true;
    } catch (err) {
        console.error('requestToJoin failed:', err);
        toast('Could not submit request: ' + (err.message || err), 'error');
        return false;
    }
}

/**
 * Cancels the current user's pending join request.
 */
export async function cancelJoinRequest(squadId) {
    if (!state.currentUser) return false;
    try {
        await deleteDoc(doc(db, 'squads', squadId, 'joinRequests', state.currentUser.uid));
        toast('Request cancelled.', 'info');
        return true;
    } catch (err) {
        console.error('cancelJoinRequest failed:', err);
        toast('Could not cancel request: ' + (err.message || err), 'error');
        return false;
    }
}

/**
 * Returns the current user's pending join request for this squad, or null.
 * Used by the UI to decide which button to show.
 */
export async function fetchMyJoinRequest(squadId) {
    if (!state.currentUser) return null;
    try {
        const snap = await getDoc(doc(db, 'squads', squadId, 'joinRequests', state.currentUser.uid));
        if (!snap.exists()) return null;
        const data = snap.data();
        // Only return if still pending — approved/denied ones are stale records
        if (data.status !== 'pending') return null;
        return { id: snap.id, ...data };
    } catch (err) {
        // Permission-denied is normal if the user isn't the requester (rules
        // restrict reads). Anything else is logged.
        if (err.code !== 'permission-denied') console.warn('fetchMyJoinRequest:', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// LEADER: list / approve / deny join requests
// ---------------------------------------------------------------------------

/**
 * Returns all pending join requests for a squad. Leader/co-leader/admin only
 * per rules.
 */
export async function fetchSquadJoinRequests(squadId) {
    try {
        const snap = await getDocs(collection(db, 'squads', squadId, 'joinRequests'));
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
        console.error('fetchSquadJoinRequests failed:', err);
        return [];
    }
}

/**
 * Approve a join request: add the user to the squad's members map, increment
 * memberCount, update their publicProfile, mark the request approved.
 *
 * Uses a transaction so we can't end up partially applied — e.g., user added
 * to members but request not marked approved, leading to a perpetual pending
 * request on a member who's already in.
 */
export async function approveJoinRequest(squadId, requestUid) {
    if (!state.currentUser) {
        toast('Please log in.', 'error');
        return false;
    }
    try {
        const squadRef = doc(db, 'squads', squadId);
        const requestRef = doc(db, 'squads', squadId, 'joinRequests', requestUid);
        const profileRef = doc(db, 'publicProfiles', requestUid);

        await runTransaction(db, async (tx) => {
            const [squadSnap, requestSnap, profileSnap] = await Promise.all([
                tx.get(squadRef), tx.get(requestRef), tx.get(profileRef)
            ]);
            if (!squadSnap.exists()) throw new Error('Squad no longer exists.');
            if (!requestSnap.exists()) throw new Error('Request no longer exists.');
            const squad = squadSnap.data();
            const requestData = requestSnap.data();
            const profile = profileSnap.exists() ? profileSnap.data() : null;

            // Race-safety: user may have joined a different squad in the meantime.
            if (profile && profile.squadId && profile.squadId.length > 0) {
                throw new Error('User has joined another squad since requesting.');
            }
            const memberMap = readMembersMap(squad);
            if (memberMap[requestUid]) {
                throw new Error('User is already a member of this squad.');
            }
            const memberCount = squad.memberCount || Object.keys(memberMap).length;
            if (squad.maxMembers && memberCount >= squad.maxMembers) {
                throw new Error('Squad is at capacity.');
            }

            const newMember = buildSquadMember(
                requestUid,
                requestData.username || (profile && profile.username) || 'Unknown',
                'member'
            );
            memberMap[requestUid] = newMember;

            tx.update(squadRef, {
                members: memberMap,
                memberCount: memberCount + 1
            });
            tx.update(requestRef, {
                status: 'approved',
                reviewedBy: state.currentUser.uid,
                reviewedAt: new Date()
            });
            // Denormalize squad fields onto user's profile so other parts of
            // the app (and Android) know they're in a squad now.
            tx.update(profileRef, {
                squadId,
                squadCallsign: squad.callsign || '',
                squadRole: 'member'
            });
        });

        toast('Member added to squad.', 'success');
        logAdminAction('approveJoinRequest', {
            targetId: requestUid,
            targetType: 'user',
            summary: `Added ${requestUid} to squad ${squadId}`
        });
        return true;
    } catch (err) {
        console.error('approveJoinRequest failed:', err);
        toast('Could not approve: ' + (err.message || err), 'error');
        return false;
    }
}

export async function denyJoinRequest(squadId, requestUid, reason = '') {
    try {
        await updateDoc(doc(db, 'squads', squadId, 'joinRequests', requestUid), {
            status: 'denied',
            denyReason: reason || '',
            reviewedBy: state.currentUser ? state.currentUser.uid : null,
            reviewedAt: new Date()
        });
        toast('Request denied.', 'info');
        logAdminAction('denyJoinRequest', {
            targetId: requestUid,
            targetType: 'user',
            summary: `Denied join request for squad ${squadId}`,
            reason
        });
        return true;
    } catch (err) {
        console.error('denyJoinRequest failed:', err);
        toast('Could not deny: ' + (err.message || err), 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
// INVITES (leader -> user)
// ---------------------------------------------------------------------------

/**
 * Searches publicProfiles by username substring. Used by the invite typeahead.
 * Firestore can't do real "contains" queries, so we pull all profiles and
 * filter client-side. At this scale (~17 users) that's fine; if you ever hit
 * thousands, switch to a prefix query with the >=/< trick or an external index.
 */
export async function searchUsersByUsername(prefix, max = 8) {
    if (!prefix || prefix.length < 1) return [];
    const lower = prefix.toLowerCase();
    try {
        const snap = await getDocs(collection(db, 'publicProfiles'));
        const matches = [];
        snap.forEach(d => {
            const data = d.data();
            const name = (data.username || '').toLowerCase();
            if (name.includes(lower)) matches.push({ uid: d.id, ...data });
        });
        // Best matches first: startsWith > includes, then alphabetical
        matches.sort((a, b) => {
            const aStarts = (a.username || '').toLowerCase().startsWith(lower) ? 0 : 1;
            const bStarts = (b.username || '').toLowerCase().startsWith(lower) ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;
            return (a.username || '').localeCompare(b.username || '');
        });
        return matches.slice(0, max);
    } catch (err) {
        console.error('searchUsersByUsername failed:', err);
        return [];
    }
}

/**
 * Send an invite from the current user (must be leader/co-leader) to another
 * user. The invite doc ID is the invited user's uid (one invite per squad).
 */
export async function sendInvite(squadId, invitedUid, inviterName) {
    if (!state.currentUser) {
        toast('Please log in.', 'error');
        return false;
    }
    if (invitedUid === state.currentUser.uid) {
        toast("You can't invite yourself.", 'warn');
        return false;
    }
    try {
        // Check invited user isn't already in a squad.
        const invitedSnap = await getDoc(doc(db, 'publicProfiles', invitedUid));
        if (!invitedSnap.exists()) {
            toast('User not found.', 'error');
            return false;
        }
        const invited = invitedSnap.data();
        if (invited.squadId && invited.squadId.length > 0) {
            toast(`${invited.username || 'That user'} is already in a squad.`, 'warn');
            return false;
        }

        // Get squad context for the invite (callsign + name shown to invitee).
        const squadSnap = await getDoc(doc(db, 'squads', squadId));
        if (!squadSnap.exists()) {
            toast('Squad not found.', 'error');
            return false;
        }
        const squad = squadSnap.data();

        // Check if there's already a pending invite (don't spam).
        const existingSnap = await getDoc(doc(db, 'squads', squadId, 'invites', invitedUid));
        if (existingSnap.exists() && existingSnap.data().status === 'pending') {
            toast(`${invited.username} already has a pending invite.`, 'info');
            return false;
        }

        await setDoc(doc(db, 'squads', squadId, 'invites', invitedUid), {
            userId: invitedUid,
            username: invited.username || 'Unknown',
            squadId,
            squadName: squad.squadName || '',
            squadCallsign: squad.callsign || '',
            invitedByName: inviterName || 'Unknown',
            status: 'pending',
            createdAt: new Date()
        });

        toast(`Invite sent to ${invited.username || 'user'}.`, 'success');
        logAdminAction('sendInvite', {
            targetId: invitedUid,
            targetType: 'user',
            summary: `Invited ${invited.username || invitedUid} to [${squad.callsign}]`
        });
        return true;
    } catch (err) {
        console.error('sendInvite failed:', err);
        toast('Could not send invite: ' + (err.message || err), 'error');
        return false;
    }
}

/**
 * Lists outstanding invites the leader has sent for this squad (status:pending).
 */
export async function fetchOutstandingInvites(squadId) {
    try {
        const snap = await getDocs(collection(db, 'squads', squadId, 'invites'));
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
        console.error('fetchOutstandingInvites failed:', err);
        return [];
    }
}

/**
 * Leader revokes an invite they previously sent.
 */
export async function revokeInvite(squadId, invitedUid) {
    try {
        await deleteDoc(doc(db, 'squads', squadId, 'invites', invitedUid));
        toast('Invite revoked.', 'info');
        return true;
    } catch (err) {
        console.error('revokeInvite failed:', err);
        toast('Could not revoke invite: ' + (err.message || err), 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
// USER-SIDE: list / accept / decline invites
// ---------------------------------------------------------------------------

/**
 * Returns all pending invites for the current user across all squads.
 *
 * Uses a Firestore collectionGroup query so this is a SINGLE indexed lookup
 * regardless of how many squads exist — not a scan-every-squad pattern.
 *
 * REQUIREMENTS:
 *   1. Firestore composite index on the `invites` collectionGroup with fields
 *      (userId ASC, status ASC). If the index is missing, the first call will
 *      throw with a console error containing a one-click "create index" URL.
 *      Click it once and the index builds in a minute.
 *   2. Firestore rule allowing collectionGroup reads on `invites` where
 *      request.auth.uid == resource.data.userId. See firestore.rules.
 *
 * Falls back to the old per-squad scan if the collectionGroup query fails for
 * any reason (missing index, missing rule). Logs the fallback so you know to
 * fix it.
 */
export async function fetchMyInvites() {
    if (!state.currentUser) return [];
    const uid = state.currentUser.uid;

    // Preferred path: one collectionGroup query.
    try {
        const cg = collectionGroup(db, 'invites');
        const q = query(cg, where('userId', '==', uid), where('status', '==', 'pending'));
        const snap = await getDocs(q);
        const out = [];
        snap.forEach(d => {
            // Reconstruct squadId from the doc's parent path. For a doc at
            // squads/{squadId}/invites/{userId}, parent.parent.id is the squadId.
            const squadId = d.ref.parent.parent ? d.ref.parent.parent.id : null;
            const data = d.data();
            out.push({ squadId, ...data });
        });
        return out;
    } catch (cgErr) {
        // Common reasons we land here:
        //   - composite index not yet created (error message contains a URL)
        //   - collectionGroup rule not yet deployed (permission-denied)
        // Both are recoverable. Log loudly so you can fix; fall back to scan
        // so the feature still works in the meantime.
        console.warn(
            '[squads] collectionGroup fetchMyInvites failed, falling back to per-squad scan.',
            'Most likely cause: missing index or missing security rule. See squads.js header for fix.',
            cgErr
        );
        return await _fetchMyInvitesFallback(uid);
    }
}

/**
 * Slow fallback: scan all squads, attempt a single-doc read of each one's
 * invites/{uid}. Worked before we added the collectionGroup query; kept so
 * the UI doesn't break if the index or rule isn't deployed yet.
 */
async function _fetchMyInvitesFallback(uid) {
    const out = [];
    try {
        const squadsSnap = await getDocs(collection(db, 'squads'));
        const tasks = [];
        squadsSnap.forEach(sq => {
            tasks.push(
                getDoc(doc(db, 'squads', sq.id, 'invites', uid))
                    .then(s => {
                        if (s.exists()) {
                            const data = s.data();
                            if (data.status === 'pending') {
                                out.push({ squadId: sq.id, ...data });
                            }
                        }
                    })
                    .catch(() => { /* swallow per-squad permission errors */ })
            );
        });
        await Promise.all(tasks);
    } catch (err) {
        console.error('fetchMyInvites fallback also failed:', err);
    }
    return out;
}

/**
 * Accept an invite: move user into the squad's members map, denormalize their
 * publicProfile, mark invite accepted. Transactional.
 */
export async function acceptInvite(squadId) {
    if (!state.currentUser) {
        toast('Please log in.', 'error');
        return false;
    }
    try {
        const me = await getMyProfile();
        if (me && me.squadId && me.squadId.length > 0) {
            toast(`You're already in squad [${me.squadCallsign || '???'}]. Leave it first.`, 'warn');
            return false;
        }
        const squadRef = doc(db, 'squads', squadId);
        const inviteRef = doc(db, 'squads', squadId, 'invites', state.currentUser.uid);
        const profileRef = doc(db, 'publicProfiles', state.currentUser.uid);

        await runTransaction(db, async (tx) => {
            const [squadSnap, inviteSnap, profileSnap] = await Promise.all([
                tx.get(squadRef), tx.get(inviteRef), tx.get(profileRef)
            ]);
            if (!squadSnap.exists()) throw new Error('Squad no longer exists.');
            if (!inviteSnap.exists()) throw new Error('Invite no longer exists.');
            const squad = squadSnap.data();
            const memberMap = readMembersMap(squad);
            if (memberMap[state.currentUser.uid]) {
                throw new Error("You're already in this squad.");
            }
            const memberCount = squad.memberCount || Object.keys(memberMap).length;
            if (squad.maxMembers && memberCount >= squad.maxMembers) {
                throw new Error('Squad is full.');
            }
            const profile = profileSnap.exists() ? profileSnap.data() : {};
            if (profile.squadId && profile.squadId.length > 0) {
                throw new Error("You've joined another squad since this invite was sent.");
            }

            memberMap[state.currentUser.uid] = buildSquadMember(
                state.currentUser.uid,
                profile.username || 'Unknown',
                'member'
            );

            tx.update(squadRef, {
                members: memberMap,
                memberCount: memberCount + 1
            });
            tx.update(inviteRef, {
                status: 'accepted',
                acceptedAt: new Date()
            });
            tx.update(profileRef, {
                squadId,
                squadCallsign: squad.callsign || '',
                squadRole: 'member'
            });
        });

        toast('Welcome to the squad!', 'success');
        return true;
    } catch (err) {
        console.error('acceptInvite failed:', err);
        toast('Could not accept invite: ' + (err.message || err), 'error');
        return false;
    }
}

export async function declineInvite(squadId) {
    if (!state.currentUser) return false;
    try {
        await updateDoc(doc(db, 'squads', squadId, 'invites', state.currentUser.uid), {
            status: 'declined',
            declinedAt: new Date()
        });
        toast('Invite declined.', 'info');
        return true;
    } catch (err) {
        console.error('declineInvite failed:', err);
        toast('Could not decline invite: ' + (err.message || err), 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
// LEAVE / DISBAND
// ---------------------------------------------------------------------------

/**
 * Leave the current squad. Per spec: leader cannot leave (they have to
 * disband instead). Transactional: members map updated, count decremented,
 * publicProfile cleared.
 */
export async function leaveSquad() {
    if (!state.currentUser) {
        toast('Please log in.', 'error');
        return false;
    }
    const me = await getMyProfile();
    if (!me || !me.squadId) {
        toast("You're not in a squad.", 'info');
        return false;
    }
    const squadId = me.squadId;

    try {
        const squadRef = doc(db, 'squads', squadId);
        const profileRef = doc(db, 'publicProfiles', state.currentUser.uid);

        await runTransaction(db, async (tx) => {
            const squadSnap = await tx.get(squadRef);
            if (!squadSnap.exists()) {
                // Squad got disbanded out from under us. Just clear the profile.
                tx.update(profileRef, { squadId: '', squadCallsign: '', squadRole: '' });
                return;
            }
            const squad = squadSnap.data();
            if (squad.leaderId === state.currentUser.uid) {
                throw new Error('Leaders must disband the squad instead of leaving.');
            }
            const memberMap = readMembersMap(squad);
            if (!memberMap[state.currentUser.uid]) {
                // Not in members map but profile said we were — fix the profile.
                tx.update(profileRef, { squadId: '', squadCallsign: '', squadRole: '' });
                return;
            }
            delete memberMap[state.currentUser.uid];
            const newCount = Math.max(0, (squad.memberCount || Object.keys(memberMap).length + 1) - 1);

            // Also strip from coLeaderIds if they were a co-leader
            const newCoLeaders = Array.isArray(squad.coLeaderIds)
                ? squad.coLeaderIds.filter(uid => uid !== state.currentUser.uid)
                : [];

            tx.update(squadRef, {
                members: memberMap,
                memberCount: newCount,
                coLeaderIds: newCoLeaders
            });
            tx.update(profileRef, { squadId: '', squadCallsign: '', squadRole: '' });
        });

        toast('Left the squad.', 'success');
        return true;
    } catch (err) {
        console.error('leaveSquad failed:', err);
        toast('Could not leave squad: ' + (err.message || err), 'error');
        return false;
    }
}

/**
 * Disband a squad: delete the squad doc, clear squad fields on every member's
 * publicProfile. Per spec leader or admin only.
 *
 * Note: we do NOT clean up the joinRequests and invites subcollections here —
 * Firestore doesn't recursively delete subcollections on doc deletion, so
 * those become orphan docs. They're harmless (rules block reads now that the
 * parent is gone) but it's worth a future Cloud Function trigger to sweep
 * them. For now the spec accepts this tradeoff.
 */
export async function disbandSquad(squadId) {
    if (!state.currentUser) {
        toast('Please log in.', 'error');
        return false;
    }
    try {
        const squadSnap = await getDoc(doc(db, 'squads', squadId));
        if (!squadSnap.exists()) {
            toast('Squad not found.', 'error');
            return false;
        }
        const squad = squadSnap.data();
        const me = await getMyProfile();
        const isLeader = squad.leaderId === state.currentUser.uid;
        const isAdmin = me && me.role === 'admin';
        if (!isLeader && !isAdmin) {
            toast('Only the squad leader (or an admin) can disband.', 'error');
            return false;
        }

        const memberMap = readMembersMap(squad);
        const memberUids = Object.keys(memberMap);

        // Clear squad affiliation on every member's profile. We do these
        // sequentially with best-effort — if one fails the others still happen.
        for (const uid of memberUids) {
            try {
                await updateDoc(doc(db, 'publicProfiles', uid), {
                    squadId: '', squadCallsign: '', squadRole: ''
                });
            } catch (err) {
                console.warn(`Could not clear profile for ${uid}:`, err);
            }
        }

        await deleteDoc(doc(db, 'squads', squadId));

        toast('Squad disbanded.', 'success');
        logAdminAction('disbandSquad', {
            targetId: squadId,
            targetType: 'squad',
            summary: `Disbanded [${squad.callsign}] ${squad.squadName}`
        });
        return true;
    } catch (err) {
        console.error('disbandSquad failed:', err);
        toast('Could not disband squad: ' + (err.message || err), 'error');
        return false;
    }
}
