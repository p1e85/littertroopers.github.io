import { db, collection, query, orderBy, limit, getDocs, doc, getDoc, deleteDoc } from './firebase.js'; 
import { state, allTitles, allBadges, mapStyles } from './config.js';
import { initializeMap, setMapStyle, centerOnRoute } from './map.js';
import { initializeAuthListener, handleSignUp, handleLogIn, handleLogOut, handlePasswordReset } from './auth.js';
import { findMe, toggleTracking, startTracking, handlePhoto, shareCleanupResults, resetFindMeState, handleQuickPinPhoto, saveQuickPin, cancelQuickPin } from './tracking.js';
import { saveSession, loadSession, exportGeoJSON } from './data.js';
import { 
    toggleCommunityView, publishRoute, populatePublishedRoutesList, 
    loadProfileForEditing, saveProfile, fetchAndDisplayLeaderboard,
    fetchSquadsLeaderboard, 
    fetchAndDisplayMyStats,
    handleMeetupSubmit, validateMeetupForm, toggleRouteLike, 
    openAchievementsModal, openEventBadgesModal, openCurrentChallenges,
    // Logic Helpers
    getUserQuests, joinChallenge, getAdminChallenges, deleteChallenge, createNewChallenge, fetchAndDisplayAllEvents , initializeSquad, fetchLocalSquads, fetchSquadDetails
} from './community.js';
import { openAdminPanel, showAdminTab } from './admin.js';
import { closeReportPinModal, submitPendingReport } from './reports.js';
import { openMyProfileModal } from './profile.js';

// --- DOM Element Selection ---
const elements = {
    // Admin Elements
    // NOTE: Old btnAdminPanel + adminChallengeModal + form fields removed.
    // Challenge creation is now in the Challenges tab of the unified Admin Panel.
    myProfileBtn: document.getElementById('myProfileBtn'),
    
    // General Modals
    termsModal: document.getElementById('termsModal'),
    authModal: document.getElementById('authModal'),
    dataModal: document.getElementById('dataModal'),
    sessionsModal: document.getElementById('sessionsModal'),
    localSessionsModal: document.getElementById('localSessionsModal'),
    infoModal: document.getElementById('infoModal'),
    publishedRoutesModal: document.getElementById('publishedRoutesModal'),
    profileModal: document.getElementById('profileModal'),
    publicProfileModal: document.getElementById('publicProfileModal'),
    safetyModal: document.getElementById('safetyModal'),
    summaryModal: document.getElementById('summaryModal'),
    leaderboardModal: document.getElementById('leaderboardModal'),
    meetupModal: document.getElementById('meetupModal'),
    viewMeetupsModal: document.getElementById('viewMeetupsModal'),
    menuModal: document.getElementById('menuModal'),
    eventsModal: document.getElementById('eventsModal'),
    
    // Challenge System Modals
    challengeMenuModal: document.getElementById('challengeMenuModal'),
    activeChallengesModal: document.getElementById('activeChallengesModal'),
    pastChallengesModal: document.getElementById('pastChallengesModal'),
    achievementsModal: document.getElementById('achievementsModal'), // The List Modal
    achievementModal: document.getElementById('achievementModal'), // The Popup Modal

    // Buttons
    agreeBtn: document.getElementById('agreeBtn'),
    skipBtn: document.getElementById('skipBtn'),
    findMeBtn: document.getElementById('findMeBtn'),
    trackBtn: document.getElementById('trackBtn'),
    pictureBtn: document.getElementById('pictureBtn'),
    dataBtn: document.getElementById('dataBtn'),
    saveBtn: document.getElementById('saveBtn'),
    loadBtn: document.getElementById('loadBtn'),
    exportBtn: document.getElementById('exportBtn'),
    communityBtn: document.getElementById('communityBtn'),
    publishBtn: document.getElementById('publishBtn'),
    loginSignupBtn: document.getElementById('loginSignupBtn'),
    infoBtn: document.getElementById('infoBtn'),
    authActionBtn: document.getElementById('authActionBtn'),
    managePublicationsBtn: document.getElementById('managePublicationsBtn'),
    saveProfileBtn: document.getElementById('saveProfileBtn'),
    deleteAccountBtn: document.getElementById('deleteAccountBtn'),
    safetyModalOkBtn: document.getElementById('safetyModalOkBtn'),
    centerOnRouteBtn: document.getElementById('centerOnRouteBtn'),
    summaryOkBtn: document.getElementById('summaryOkBtn'),
    leaderboardBtn: document.getElementById('leaderboardBtn'),
    achievementOkBtn: document.getElementById('achievementOkBtn'),
    createMeetupBtn: document.getElementById('createMeetupBtn'),
    shareBtn: document.getElementById('shareBtn'),
    menuBtn: document.getElementById('menuBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    btnPastChallengesBack: document.getElementById('btnPastChallengesBack'),
    
    // Hub Navigation
    hubModal: document.getElementById('hubModal'),
    hubBtn: document.getElementById('hubBtn'),
    hubChallengesBtn: document.getElementById('hubChallengesBtn'),
    hubEventsBtn: document.getElementById('hubEventsBtn'),
    hubFeedBtn: document.getElementById('hubFeedBtn'),
    feedModal: document.getElementById('feedModal'),
    feedContainer: document.getElementById('feedContainer'),
    
    // Inputs
    cameraInput: document.getElementById('cameraInput'),
    termsCheckbox: document.getElementById('termsCheckbox'),
    ageCheckbox: document.getElementById('ageCheckbox'),
    emailInput: document.getElementById('emailInput'),
    passwordInput: document.getElementById('passwordInput'),
    usernameInput: document.getElementById('usernameInput'),
    safetyCheckbox: document.getElementById('safetyCheckbox'),
    meetupTitleInput: document.getElementById('meetupTitleInput'),
    meetupDescriptionInput: document.getElementById('meetupDescriptionInput'),
    meetupDateInput: document.getElementById('meetupDateInput'),
    
    // Lists & Containers
    leaderboardTabs: document.querySelectorAll('.leaderboard-tab'),
    leaderboardList: document.getElementById('leaderboardList'),
    publicChallengeList: document.getElementById('publicChallengeList'),
    pastChallengesContent: document.getElementById('pastChallengesContent'),
    achievementsList: document.getElementById('achievementsList'),
    achievementsTitle: document.getElementById('achievementsTitle'),
    
    // Specific Navigation Buttons
    communityChallengeBtn: document.getElementById('communityChallengeBtn'), 
    btnAchievements: document.getElementById('btnAchievements'), // Main Menu Button
    btnViewEventBadges: document.getElementById('btnViewEventBadges'), // Challenge Hub Button
    achievementListBackBtn: document.getElementById('achievementListBackBtn'), // Dynamic Back Button
    
    btnCurrentChallenges: document.getElementById('btnCurrentChallenges'),
    btnPastChallenges: document.getElementById('btnPastChallenges'),
    btnBackToMenu: document.querySelector('#pastChallengesModal .ok-btn'), // History Back
    btnBackFromCurrent: document.getElementById('btnBackFromCurrent'), // Current Back
    btnchallengeMenuBack: document.getElementById('btnchallengeMenuBack'),
    
    // Tabs
    tabCompleted: document.getElementById('tabCompleted'),
    tabUncompleted: document.getElementById('tabUncompleted'),
    
    // LOG TRASH ITEMS (NEW)
    logTrashBtn: document.getElementById('logTrashBtn'),
    logTrashModal: document.getElementById('logTrashModal'),
    trashCountInput: document.getElementById('trashCountInput'),
    confirmTrashBtn: document.getElementById('confirmTrashBtn')
};

/**
 * Main initializer for the entire UI.
 */
export function initializeUI() {
    initializeMap();
    state.map.on('dragstart', (e) => { if (e.originalEvent) resetFindMeState(); });
    state.map.on('zoomstart', (e) => { if (e.originalEvent) resetFindMeState(); });
    initializeAuthListener();
    attachEventListeners();
    if (sessionStorage.getItem('termsAccepted')) {
        elements.termsModal.style.display = 'none';
        document.getElementById('userStatus').style.display = 'flex';
    } else {
        elements.termsModal.style.display = 'flex';
    }

    const dateElement = document.getElementById('dynamicDateDay');
    if (dateElement) {
        dateElement.textContent = new Date().getDate(); 
    }
    
}

export function attachEventListeners() {
    
    // --- AUTHENTICATION ---
    if (elements.loginBtn) {
        elements.loginBtn.addEventListener('click', () => {
            const email = prompt("Enter email:");
            const password = prompt("Enter password:");
            if (email && password) loginUser(email, password);
        });
    }

    if (elements.logoutBtn) {
        elements.logoutBtn.addEventListener('click', handleLogOut);
    }
    
    elements.termsCheckbox.addEventListener('change', () => elements.agreeBtn.disabled = !elements.termsCheckbox.checked);
    
    elements.agreeBtn.addEventListener('click', () => {
        elements.termsModal.style.display = 'none';
        sessionStorage.setItem('termsAccepted', 'true');
        document.getElementById('userStatus').style.display = 'flex';
        if (!state.currentUser) elements.authModal.style.display = 'flex';
    });

    elements.loginSignupBtn.addEventListener('click', () => elements.authModal.style.display = 'flex');
    elements.skipBtn.addEventListener('click', () => elements.authModal.style.display = 'none');
    
    elements.authModal.addEventListener('click', (e) => {
        if (e.target.id === 'switchAuthModeLink') {
            e.preventDefault();
            state.isSignUpMode = !state.isSignUpMode;
            updateAuthModalUI();
        }
    });

    elements.authActionBtn.addEventListener('click', async (event) => { 
        event.preventDefault();
        if (state.isSignUpMode) await handleSignUp();
        else await handleLogIn();
    });

    elements.emailInput.addEventListener('input', validateSignUpForm);
    elements.passwordInput.addEventListener('input', validateSignUpForm);
    elements.usernameInput.addEventListener('input', validateSignUpForm);
    elements.ageCheckbox.addEventListener('change', validateSignUpForm);
elements.deleteAccountBtn.addEventListener('click', () => {
    alert("Account deletion is temporarily disabled during updates. Please contact support.");
});
    // --- MAP & TRACKING ---
    elements.findMeBtn.addEventListener('click', findMe);
    elements.trackBtn.addEventListener('click', toggleTracking);
    
    // pictureBtn routes to different behavior based on tracking state:
    //  - During tracking: triggers the regular route-photo cameraInput
    //  - When NOT tracking (but logged in): triggers the quick pin camera
    elements.pictureBtn.addEventListener('click', () => {
        if (state.isTracking) {
            elements.cameraInput.click();
        } else {
            document.getElementById('quickPinCameraInput')?.click();
        }
    });
    elements.cameraInput.addEventListener('change', handlePhoto);

    // Quick pin camera and modal wiring
    const quickPinInput = document.getElementById('quickPinCameraInput');
    if (quickPinInput) quickPinInput.addEventListener('change', handleQuickPinPhoto);
    document.getElementById('quickPinSaveBtn')?.addEventListener('click', saveQuickPin);
    document.getElementById('quickPinCancelBtn')?.addEventListener('click', cancelQuickPin);
    // Also close on overlay click (matches all other modals)
    document.getElementById('quickPinModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'quickPinModal') cancelQuickPin();
    });

    // --- SETTINGS: MAP STYLE SELECTOR ---
    // The old top-bar 🎨 Change Style button was removed. Style selection now
    // lives in Settings (infoModal) as full-width option cards, matching
    // Android/iOS. Event delegation on the container; cards are re-rendered
    // on every selection so the green highlight + ✓ move immediately.
    document.getElementById('mapStyleOptions')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.map-style-option');
        if (!btn) return;
        setMapStyle(parseInt(btn.dataset.styleIndex, 10));
        renderMapStyleOptions();
    });
    
    // --- MAIN MENU NAVIGATION ---
    elements.menuBtn.addEventListener('click', () => elements.menuModal.style.display = 'flex');
    
    // 2. Main Menu: Achievements
    if (elements.btnAchievements) {
        elements.btnAchievements.addEventListener('click', () => {
            elements.menuModal.style.display = 'none';
            elements.achievementsModal.style.display = 'flex';
            
            openAchievementsModal(); // Calls the code above
            
            // Back Button logic...
            if (elements.achievementListBackBtn) {
                const newBackBtn = elements.achievementListBackBtn.cloneNode(true);
                elements.achievementListBackBtn.parentNode.replaceChild(newBackBtn, elements.achievementListBackBtn);
                elements.achievementListBackBtn = newBackBtn; 

                newBackBtn.addEventListener('click', () => {
                    elements.achievementsModal.style.display = 'none';
                    elements.menuModal.style.display = 'flex';
                });
            }
        });
    }

    // 3. Community Map View
    elements.communityBtn.addEventListener('click', toggleCommunityView);
    
    // 4. Info / Settings — renders the map-style cards and account section
    // fresh on every open so both always reflect current state.
    // NOTE: the old #viewTermsLink footer was removed from the Settings modal;
    // Terms/Privacy are now plain <a> link buttons in the HTML (no JS needed).
    elements.infoBtn.addEventListener('click', () => {
        renderMapStyleOptions();
        renderSettingsAccountSection();
        elements.infoModal.style.display = 'flex';
    });

    // Settings > Account buttons (rendered dynamically, so delegate)
    document.getElementById('settingsAccountSection')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.id === 'settingsEditProfileBtn') {
            elements.infoModal.style.display = 'none';
            loadProfileForEditing();
            elements.profileModal.style.display = 'flex';
        } else if (btn.id === 'settingsSignOutBtn') {
            elements.infoModal.style.display = 'none';
            handleLogOut();
        } else if (btn.id === 'settingsLoginBtn') {
            elements.infoModal.style.display = 'none';
            elements.authModal.style.display = 'flex';
        }
    });

    // --- DATA & SAVING ---
    elements.safetyModalOkBtn.addEventListener('click', () => {
        elements.safetyModal.style.display = 'none';
        startTracking();
    });

    elements.summaryOkBtn.addEventListener('click', () => { 
        elements.summaryModal.style.display = 'none';
        document.getElementById('cleanupPhotoPreviewContainer').style.display = 'none';
        document.getElementById('cleanupPhotoPreview').src = '#';
    });

    elements.dataBtn.addEventListener('click', () => {
        elements.menuModal.style.display = 'none';
        elements.dataModal.style.display = 'flex';
    });

    elements.saveBtn.addEventListener('click', saveSession);
    
    elements.loadBtn.addEventListener('click', () => {
        elements.dataModal.style.display = 'none';
        loadSession();
    });
    
    elements.exportBtn.addEventListener('click', exportGeoJSON);

    elements.publishBtn.addEventListener('click', publishRoute);
    
    elements.managePublicationsBtn.addEventListener('click', () => {
        if (!state.currentUser) { alert("You must be logged in to manage your publications."); return; }
        elements.dataModal.style.display = 'none';
        populatePublishedRoutesList();
        elements.publishedRoutesModal.style.display = 'flex';
    });

    // --- PROFILE ---
    // myProfileBtn opens the new My Profile modal.
    // The Edit Profile button now lives INSIDE that modal (profile.js).
    if (elements.myProfileBtn) {
        elements.myProfileBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent overlay-close handler
            elements.menuModal.style.display = 'none';
            openMyProfileModal();
        });
    }
    elements.saveProfileBtn.addEventListener('click', saveProfile);

    // --- LEADERBOARD ---
    elements.leaderboardBtn.addEventListener('click', () => {
        elements.leaderboardModal.style.display = 'flex';
        _leaderboardShowTab('totalPins');
    });

    elements.leaderboardTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.id === 'myStatsBtn') _leaderboardShowTab('myStats');
            else if (tab.id === 'squadsLeaderboardBtn') _leaderboardShowTab('squads');
            else _leaderboardShowTab(tab.dataset.metric);
        });
    });

    // Clicking a user row on any leaderboard → open their public profile
    document.getElementById('leaderboardModal')?.addEventListener('click', (e) => {
        const link = e.target.closest('.lb-profile-link');
        if (link) {
            e.preventDefault();
            const uid = link.dataset.uid;
            if (uid) {
                elements.leaderboardModal.style.display = 'none';
                showPublicProfile(uid);
            }
        }
    });

    // --- CLEANUP PHOTOS ---
    const addCleanupPhotoBtn = document.getElementById('addCleanupPhotoBtn');
    const cleanupCameraInput = document.getElementById('cleanupCameraInput');
    const photoPreviewContainer = document.getElementById('cleanupPhotoPreviewContainer');
    const photoPreview = document.getElementById('cleanupPhotoPreview');

    if (addCleanupPhotoBtn) { 
        addCleanupPhotoBtn.addEventListener('click', () => {
            cleanupCameraInput.click(); 
        });
    }
    if (cleanupCameraInput) {
        cleanupCameraInput.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (file) {
                state.cleanupPhoto = file; 
                const objectURL = URL.createObjectURL(file);
                photoPreview.src = objectURL;
                photoPreviewContainer.style.display = 'flex';
                event.target.value = '';
            } else {
                state.cleanupPhoto = null;
                photoPreview.src = '#';
                photoPreviewContainer.style.display = 'none';
            }
        });
    }

    // --- MEETUPS ---
    elements.safetyCheckbox.addEventListener('change', validateMeetupForm);
    elements.meetupTitleInput.addEventListener('input', validateMeetupForm);
    elements.meetupDescriptionInput.addEventListener('input', validateMeetupForm);
    elements.createMeetupBtn.addEventListener('click', handleMeetupSubmit);
    elements.shareBtn.addEventListener('click', shareCleanupResults);
    elements.meetupDateInput.addEventListener('change', validateMeetupForm);

    // --- HUB NAVIGATION (Feed/Events) ---
    elements.hubBtn.addEventListener('click', async () => {
        elements.menuModal.style.display = 'none';
        elements.hubModal.style.display = 'flex';
        // Refresh pending squad invites strip whenever the hub opens. Lazy
        // import avoids loading squads.js until needed.
        try {
            const squadsMod = await import('./squads.js');
            await renderHubInvitesStrip(squadsMod);
        } catch (err) {
            console.warn('Could not load pending invites:', err);
        }
    });
    if (elements.hubChallengesBtn) {
        elements.hubChallengesBtn.addEventListener('click', () => {
            elements.hubModal.style.display = 'none'; 
            elements.challengeMenuModal.style.display = 'flex'; 
        });
    }
    elements.hubEventsBtn.addEventListener('click', () => {
        elements.hubModal.style.display = 'none';
        elements.eventsModal.style.display = 'flex';
        fetchAndDisplayAllEvents();
    });
    elements.hubFeedBtn.addEventListener('click', () => {
        elements.hubModal.style.display = 'none';
        elements.feedModal.style.display = 'flex';
        loadActivityFeed();
    });

    // --- CHALLENGE MENU NAVIGATION ---

    // 1. EVENT BADGES (Challenge Menu -> Event Rewards)
    if (elements.btnViewEventBadges) {
        elements.btnViewEventBadges.addEventListener('click', () => {
            elements.challengeMenuModal.style.display = 'none'; // Close Hub
            elements.achievementsModal.style.display = 'flex';  // Open List
            
            // Call the Specific Function for Events
            openEventBadgesModal(); 
            
            // DYNAMIC BACK BUTTON: Returns to Challenge Hub
            if (elements.achievementListBackBtn) {
                // Clone node to strip old listeners
                const newBackBtn = elements.achievementListBackBtn.cloneNode(true);
                elements.achievementListBackBtn.parentNode.replaceChild(newBackBtn, elements.achievementListBackBtn);
                elements.achievementListBackBtn = newBackBtn; 

                newBackBtn.addEventListener('click', () => {
                    elements.achievementsModal.style.display = 'none';
                    elements.challengeMenuModal.style.display = 'flex'; // <--- Go back to Challenge Hub
                });
            }
        });
    }

    // 2. Current Challenges
    if (elements.btnCurrentChallenges) {
        elements.btnCurrentChallenges.addEventListener('click', () => {
            elements.challengeMenuModal.style.display = 'none';
            elements.activeChallengesModal.style.display = 'flex';
            
            // Call the correct function from community.js!
            openCurrentChallenges(); 
        });
    }
    
    // Back from Current -> Hub
    if (elements.btnBackFromCurrent) {
        elements.btnBackFromCurrent.addEventListener('click', (e) => {
            e.stopPropagation();
            elements.activeChallengesModal.style.display = 'none';
            elements.challengeMenuModal.style.display = 'flex';
        });
    }

    // 3. Challenge Menu BACK Button (The Fix!)
    if (elements.btnchallengeMenuBack) {
        elements.btnchallengeMenuBack.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close the Challenge Menu
            elements.challengeMenuModal.style.display = 'none';
            // Return to the Community Hub
            elements.hubModal.style.display = 'flex';
        });
    }

    // 4. Past Challenges
    elements.btnPastChallenges.addEventListener('click', () => {
        elements.challengeMenuModal.style.display = 'none';
        elements.pastChallengesModal.style.display = 'flex';
        elements.tabCompleted.classList.add('active');
        elements.tabUncompleted.classList.remove('active');
        loadPastChallenges('completed'); 
    });

    // Back from History -> Hub
    if (elements.btnBackToMenu) {
        elements.btnBackToMenu.addEventListener('click', () => {
            elements.pastChallengesModal.style.display = 'none';
            elements.challengeMenuModal.style.display = 'flex';
        });
    }

    // 5. History Tabs
    elements.tabCompleted.addEventListener('click', () => {
        elements.tabCompleted.classList.add('active');
        elements.tabUncompleted.classList.remove('active');
        loadPastChallenges('completed');
    });

    elements.tabUncompleted.addEventListener('click', () => {
        elements.tabUncompleted.classList.add('active');
        elements.tabCompleted.classList.remove('active');
        loadPastChallenges('uncompleted');
    });

    // 6. Admin Panel
    // NOTE: The old "Admin: Create Challenge" button (btnAdminPanel) and its modal
    // (adminChallengeModal) were removed. Challenge creation now lives in the
    // Challenges tab of the unified Admin Panel (see admin.js renderChallengesTab).


    // --- NEW ADMIN PANEL (Phase 1) ---
    // Opens the multi-tab admin panel (stats / pending events / pending squads).
    // The button is added to maptest.html in the menuModal and only displayed
    // to admins via checkAdminPermissions().
    const btnAdminPanelFull = document.getElementById('btnAdminPanelFull');
    if (btnAdminPanelFull) {
        btnAdminPanelFull.addEventListener('click', async (e) => {
            // Stop the click bubbling to the window-level handler that closes any
            // .modal-overlay clicked. Without this, the click opens the admin
            // panel and then immediately closes it on the same bubbling click.
            e.stopPropagation();
            elements.menuModal.style.display = 'none';
            await openAdminPanel();
        });
    }
    // Tab switching inside the admin panel
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => showAdminTab(btn.dataset.tab));
    });
    // Close button for admin panel
    const adminPanelCloseBtn = document.querySelector('#adminPanelModal .close-btn');
    if (adminPanelCloseBtn) {
        adminPanelCloseBtn.addEventListener('click', () => {
            document.getElementById('adminPanelModal').style.display = 'none';
        });
    }

    // --- REPORT PIN MODAL (Phase 2) ---
    // The modal itself is opened from map.js via openReportPinModal() when the
    // user clicks 🚩 on a community pin. Here we just wire the close/submit buttons.
    const reportCloseBtn = document.getElementById('reportPinCloseBtn');
    if (reportCloseBtn) reportCloseBtn.addEventListener('click', closeReportPinModal);
    const reportCancelBtn = document.getElementById('reportCancelBtn');
    if (reportCancelBtn) reportCancelBtn.addEventListener('click', closeReportPinModal);
    const reportSubmitBtn = document.getElementById('reportSubmitBtn');
    if (reportSubmitBtn) reportSubmitBtn.addEventListener('click', submitPendingReport);

    // --- LOCAL EVENTS BACK BUTTON ---
    const btnEventsBack = document.getElementById('btnEventsBack');
    if (btnEventsBack) {
        btnEventsBack.addEventListener('click', () => {
            // Close the Events Modal
            elements.eventsModal.style.display = 'none';
            // Return to the Community Hub
            elements.hubModal.style.display = 'flex';
        });
    }

    if (elements.btnPastChallengesBack) {
        elements.btnPastChallengesBack.addEventListener('click', () => {
            elements.pastChallengesModal.style.display = 'none';
            elements.challengeMenuModal.style.display = 'flex';
        });
    }
    
    // --- LOG TRASH (NEW BUTTONS) ---
    if (elements.logTrashBtn) {
        elements.logTrashBtn.addEventListener('click', () => {
            elements.logTrashModal.style.display = 'flex';
            elements.trashCountInput.value = ''; 
            elements.trashCountInput.focus();
        });
    }

    if (elements.confirmTrashBtn) {
        elements.confirmTrashBtn.addEventListener('click', () => {
            const count = parseInt(elements.trashCountInput.value);
            if (count > 0) {
                // We add these to the 'state' temporarily, or we could just alert for now.
                // Since we are using "1 Pin = 1 Item" for the main logic, 
                // this button is likely for "Bulk Logging" if you decided to keep it.
                // If you opted for "1 Pin = 1 Item" only, you might not need this listener logic connected to DB yet.
                alert(`Logged ${count} items! (This will be saved when you stop tracking).`);
                
                // Optional: Push dummy pins to count as items?
                // For now, just close modal.
                elements.logTrashModal.style.display = 'none';
            } else {
                alert("Please enter a valid number.");
            }
        });
    }

    const forgotLink = document.getElementById('forgotPasswordLink');
    if (forgotLink) {
        forgotLink.addEventListener('click', (e) => {
            e.preventDefault();
            handlePasswordReset();
        });
    }

// --- SQUADS NAVIGATION ---
const hubSquadsBtn = document.getElementById('hubSquadsBtn');
if (hubSquadsBtn) {
    hubSquadsBtn.addEventListener('click', () => {
        openModal('squadsModal');
        // Ensure it always opens to the list, not a half-filled form
        if (typeof switchSquadView === 'function') {
            switchSquadView('registry');
        }
        // Load the data
        if (typeof fetchLocalSquads === 'function') {
            fetchLocalSquads(); 
        }
    });
}

const btnFinalizeSquad = document.getElementById('btnFinalizeSquad');
if (btnFinalizeSquad) {
    btnFinalizeSquad.addEventListener('click', () => {
         // Safety check
         if (typeof initializeSquad === 'function') {
            initializeSquad();
        } else {
            console.error("initializeSquad function missing");
        }
    });
}
    
//  document.getElementById('hubSquadsBtn').addEventListener('click', () => {
//  openModal('squadsModal');
//  fetchLocalSquads(); // Refresh list every time it opens
//});

document.getElementById('btnFinalizeSquad')?.addEventListener('click', initializeSquad);
    
    // Generic Close Listeners
    addAllModalCloseListeners();

    
} //********************end event listern**************

function addAllModalCloseListeners() {
    const allModals = Object.values(elements).filter(el => el && el.classList && el.classList.contains('modal-overlay'));
    allModals.forEach(modal => {
        const closeBtn = modal.querySelector('.close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => modal.style.display = 'none');
        }
        // NOTE: We don't auto-close on generic .ok-btn anymore because we have specific logic for them now
    });
    window.addEventListener('click', (event) => {
        if (event.target.classList.contains('modal-overlay')) {
            event.target.style.display = 'none';
        }
    });
}

// --- SETTINGS: MAP STYLE CARDS -----------------------------------------------
// Renders the full-width style option cards inside #mapStyleOptions (Settings
// modal). The active style gets the green card + ✓, everything else is a gray
// card — matching the Android/iOS Settings screen. Data source is the
// mapStyles array in config.js, so adding a style there automatically shows
// it here.
function renderMapStyleOptions() {
    const container = document.getElementById('mapStyleOptions');
    if (!container) return;
    container.innerHTML = mapStyles.map((style, i) => {
        const selected = i === state.currentStyleIndex;
        return `
            <button type="button" class="map-style-option${selected ? ' selected' : ''}" data-style-index="${i}">
                <span>${style.name}</span>
                ${selected ? '<span class="map-style-check">✓</span>' : ''}
            </button>`;
    }).join('');
}

// --- SETTINGS: ACCOUNT SECTION ------------------------------------------------
// Renders the user card (avatar / username / email) + Edit Profile + Sign Out
// inside #settingsAccountSection, matching the Android Settings screen. Guests
// get a Log In / Sign Up button instead. Renders instantly with the email,
// then swaps in the username after one publicProfiles read.
function buildSettingsAccountHTML(initial, username, email) {
    return `
        <div class="settings-account-card">
            <div class="settings-avatar">${escapeAttr(initial)}</div>
            <div class="settings-account-info">
                <strong>${escapeAttr(username)}</strong>
                <span>${escapeAttr(email)}</span>
            </div>
        </div>
        <button type="button" id="settingsEditProfileBtn" class="settings-btn-solid">✏️ Edit Profile</button>
        <button type="button" id="settingsSignOutBtn" class="settings-btn-danger-outline">🚪 Sign Out</button>`;
}

async function renderSettingsAccountSection() {
    const container = document.getElementById('settingsAccountSection');
    if (!container) return;

    if (!state.currentUser) {
        container.innerHTML = `
            <button type="button" id="settingsLoginBtn" class="settings-btn-solid">Log In / Sign Up</button>`;
        return;
    }

    const email = state.currentUser.email || '';
    const fallbackInitial = (email.charAt(0) || 'T').toUpperCase();
    container.innerHTML = buildSettingsAccountHTML(fallbackInitial, '…', email);

    try {
        const snap = await getDoc(doc(db, 'publicProfiles', state.currentUser.uid));
        const username = (snap.exists() && snap.data().username) ? snap.data().username : 'Trooper';
        // User may have closed Settings or logged out while the read was in
        // flight — only overwrite if we're still showing a logged-in card.
        if (state.currentUser && document.getElementById('settingsEditProfileBtn')) {
            container.innerHTML = buildSettingsAccountHTML(username.charAt(0).toUpperCase(), username, email);
        }
    } catch (err) {
        // Non-critical: card already shows the email; leave the fallback.
        console.warn('Settings account card: username fetch failed', err);
    }
}

export function updateLoggedInStatusUI(isLoggedIn, username = '') {
    const userStatus = document.getElementById('userStatus');
    const loggedInContent = document.getElementById('loggedInContent');
    const guestContent = document.getElementById('guestContent');
    const userEmailSpan = document.getElementById('userEmail');

    if (userStatus) userStatus.style.display = 'flex';

    if (isLoggedIn) {
        if (userEmailSpan) userEmailSpan.textContent = `Logged in as: ${username}`;
        if (loggedInContent) loggedInContent.style.display = 'flex';
        if (guestContent) guestContent.style.display = 'none';
        if (elements.authModal) elements.authModal.style.display = 'none';
        if (elements.publishBtn) elements.publishBtn.style.display = 'block';
        if (elements.managePublicationsBtn) elements.managePublicationsBtn.style.display = 'block';
        // Enable My Profile button (disabled when logged out)
        if (elements.myProfileBtn) elements.myProfileBtn.disabled = false;
        // Enable Quick Pin — pictureBtn is usable whenever logged in (not just during tracking)
        if (elements.pictureBtn) elements.pictureBtn.disabled = false;
    } else {
        if (loggedInContent) loggedInContent.style.display = 'none';
        if (guestContent) guestContent.style.display = 'block';
        if (elements.publishBtn) elements.publishBtn.style.display = 'none';
        if (elements.managePublicationsBtn) elements.managePublicationsBtn.style.display = 'none';
        // Disable My Profile when logged out
        if (elements.myProfileBtn) elements.myProfileBtn.disabled = true;
        // Disable when logged out — Quick Pin requires an account
        if (elements.pictureBtn && !state.isTracking) elements.pictureBtn.disabled = true;
    }
}

export function updateAuthModalUI() {
    const authForm = document.getElementById('authForm');
    const authTitle = document.getElementById('authTitle');
    const authSubtitle = document.getElementById('authSubtitle');
    const forgotLink = document.getElementById('forgotPasswordLink'); // Get the link

    document.getElementById('authError').textContent = '';

    if (state.isSignUpMode) {
        authTitle.textContent = 'Create a Litter Troopers Account';
        authSubtitle.innerHTML = 'Or <a href="#" id="switchAuthModeLink">log in to an existing account.</a>';
        elements.authActionBtn.textContent = 'Sign Up';
        authForm.classList.add('signup-mode');
        authForm.classList.remove('login-mode');
        
        // Hide on Sign Up
        if (forgotLink) forgotLink.style.display = 'none'; 
    } else {
        authTitle.textContent = 'Log In to Litter Troopers';
        authSubtitle.innerHTML = 'Or <a href="#" id="switchAuthModeLink">create a new account.</a>';
        elements.authActionBtn.textContent = 'Log In';
        authForm.classList.add('login-mode');
        authForm.classList.remove('signup-mode');
        
        // Show on Login
        if (forgotLink) forgotLink.style.display = 'inline-block'; 
    }
    validateSignUpForm();
}

function validateSignUpForm() {
    const isEmailValid = elements.emailInput.value.includes('@');
    const isPasswordValid = elements.passwordInput.value.length >= 6;
    const isUsernameValid = elements.usernameInput.value.trim().length >= 3;
    const isAgeChecked = elements.ageCheckbox.checked;

    if (state.isSignUpMode) {
        elements.authActionBtn.disabled = !(isEmailValid && isPasswordValid && isUsernameValid && isAgeChecked);
    } else {
        elements.authActionBtn.disabled = !(isEmailValid && isPasswordValid);
    }
}

// --- ACTIVITY FEED (User View + Admin Controls) ---
async function loadActivityFeed() {
    const container = elements.feedContainer; // Ensure this exists in your DOM elements
    if (!container) return;

    container.innerHTML = '<div class="feed-loader">Loading latest cleanups...</div>';

    try {
        // 1. STRICT ADMIN CHECK
        let isAdmin = false;
        if (state.currentUser) {
            try {
                const profileRef = doc(db, "publicProfiles", state.currentUser.uid);
                const profileSnap = await getDoc(profileRef);
                if (profileSnap.exists()) {
                    const role = profileSnap.data().role;
                    if (role === 'admin') {
                        isAdmin = true;
                    }
                }
            } catch (e) {
                console.warn("Admin check failed:", e);
            }
        }

        console.log("Current User Admin Status:", isAdmin); // <--- CHECK THIS IN CONSOLE

        const q = query(
            collection(db, "publishedRoutes"), 
            orderBy("timestamp", "desc"), 
            limit(20)
        );
        
        const querySnapshot = await getDocs(q);
        container.innerHTML = '';

        if (querySnapshot.empty) {
            container.innerHTML = '<p>No cleanups shared yet. Be the first!</p>';
            return;
        }

        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const routeId = docSnap.id; 

            // Skip broken data
            if (typeof data.distance === 'undefined' && typeof data.distanceMiles === 'undefined') return; 

            const date = data.timestamp?.toDate().toLocaleDateString() || "Recently";
            const photoUrl = data.cleanupPhotoURL || 'https://placehold.co/400x300?text=No+Photo';
            const likeCount = data.likeCount || 0;
            const likedBy = data.likedBy || [];
            const isLiked = state.currentUser && likedBy.includes(state.currentUser.uid);
            const likeBtnClass = isLiked ? 'like-btn active' : 'like-btn';
            
            // 2. PERMISSION LOGIC
            const isOwner = state.currentUser && (data.userId === state.currentUser.uid);
            
            // SHOW BUTTON IF: You are Admin OR You are Owner
            const canDelete = isAdmin || isOwner;

            const card = document.createElement('div');
            card.className = 'feed-card';
            
            card.innerHTML = `
                <div class="feed-header">
                    <div class="feed-avatar">${data.username?.charAt(0).toUpperCase() || 'T'}</div>
                    <div class="feed-user-info">
                        <h4>${data.username || 'Anonymous Trooper'}</h4>
                        <span>${date}</span>
                    </div>
                    ${canDelete ? `<button class="delete-post-btn" style="margin-left:auto; background:none; border:none; cursor:pointer; font-size:1.2em;" title="Delete Post">🗑️</button>` : ''}
                </div>
                <img src="${photoUrl}" class="feed-photo" loading="lazy">
                <div class="feed-body">
                    <div class="feed-stats">
                        <span>📍 <strong>${data.pins?.length || 0}</strong> Items</span>
                        <span>📏 <strong>${data.distanceMiles || '0.00 mi'}</strong></span>
                    </div>
                    <p class="feed-caption">${data.sessionName || 'Just finished a cleanup!'}</p>
                    <div class="feed-actions">
                         <button class="${likeBtnClass}">
                           👍 <span class="like-count">${likeCount}</span>
                         </button>
                    </div>
                </div>
            `;
            container.appendChild(card);

            // --- LISTENERS ---

            // Like Listener
            const likeBtn = card.querySelector('.like-btn');
            likeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Ensure toggleRouteLike is imported!
                const result = await toggleRouteLike(routeId); 
                if (result) {
                    likeBtn.querySelector('.like-count').textContent = result.likeCount;
                    likeBtn.classList.toggle('active', result.isLiked);
                }
            });

            // Delete Listener
            if (canDelete) {
                const delBtn = card.querySelector('.delete-post-btn');
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const warning = isAdmin && !isOwner 
                        ? "⚠️ ADMIN ACTION: Delete this user's post?" 
                        : "Are you sure you want to delete your post?";

                    if (confirm(warning)) {
                        try {
                            await deleteDoc(doc(db, "publishedRoutes", routeId));
                            card.remove(); 
                        } catch (err) {
                            console.error("Error deleting post:", err);
                            alert("Failed to delete post. Check permissions.");
                        }
                    }
                });
            }
        });
    } catch (error) {
        console.error("Error loading feed:", error);
        container.innerHTML = '<p>Failed to load feed. Check your connection.</p>';
    }
}

async function loadAdminChallengeList() {
    // Deprecated: kept as a no-op for now in case anything else still calls it.
    // The challenges admin UI moved into the Challenges tab of the unified
    // Admin Panel (admin.js renderChallengesTab / loadChallengeListInPanel).
}


// --- PAST CHALLENGES (History Logic) ---
async function loadPastChallenges(filterType) {
    const listContainer = elements.pastChallengesContent;
    if (!listContainer) return;

    listContainer.innerHTML = "<p>Loading history...</p>";

    try {
        if (!state.currentUser) {
            listContainer.innerHTML = "<p>Please login to see history.</p>";
            return;
        }

        const myQuests = await getUserQuests(state.currentUser.uid);
        const questIds = Object.keys(myQuests);

        if (questIds.length === 0) {
            listContainer.innerHTML = "<p>No challenge history found.</p>";
            return;
        }

        const allChallenges = await getAdminChallenges();
        
        listContainer.innerHTML = ""; 
        let count = 0;

        for (const [chalId, userProgress] of Object.entries(myQuests)) {
            const originalData = allChallenges.find(c => c.id === chalId) || {};
            const title = originalData.title || userProgress.title || "Unknown Quest";
            const goal = originalData.goal_miles || "??";
            
            const isCompleted = userProgress.status === 'completed';
            const isExpired = userProgress.status === 'expired'; 
            
            let showIt = false;
            if (filterType === 'completed' && isCompleted) showIt = true;
            if (filterType === 'uncompleted' && !isCompleted) showIt = true;

            if (showIt) {
                count++;
                const card = document.createElement('div');
                card.className = "hub-card";
                card.style.marginBottom = "10px";
                card.style.textAlign = "left";
                
                const borderColor = isCompleted ? "#FFD700" : (isExpired ? "#ccc" : "#4A7C59");
                const statusText = isCompleted ? "🏆 COMPLETED" : (isExpired ? "⌛ EXPIRED" : "🏃 IN PROGRESS");
                const statusColor = isCompleted ? "#B8860B" : (isExpired ? "#999" : "#4A7C59");

                let dateStr = "";
                if (userProgress.completed_at) {
                    dateStr = `Done: ${new Date(userProgress.completed_at.seconds * 1000).toLocaleDateString()}`;
                } else if (userProgress.joined_at) {
                    dateStr = `Joined: ${new Date(userProgress.joined_at.seconds * 1000).toLocaleDateString()}`;
                }

                card.style.borderLeft = `5px solid ${borderColor}`;
                
                card.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <h4 style="margin:0;">${title}</h4>
                            <small style="color:#666;">${dateStr}</small>
                        </div>
                        <div style="text-align:right;">
                            <strong style="color:${statusColor}; display:block;">${statusText}</strong>
                            <span style="font-size:0.9em;">${userProgress.progress.toFixed(1)} / ${goal} mi</span>
                        </div>
                    </div>
                `;
                listContainer.appendChild(card);
            }
        }

        if (count === 0) {
            listContainer.innerHTML = `<p style="color:#888;">No ${filterType} challenges found.</p>`;
        }

    } catch (e) {
        console.error("Error loading past challenges:", e);
        listContainer.innerHTML = "<p>Error loading content.</p>";
    }
}

// --- PUBLIC PROFILE & PIN SHEET ---
export async function showPublicProfile(userId, pinData = null) {
    const modal = document.getElementById('publicProfileModal');
    if (modal) modal.style.display = 'flex';

    // 1. Verify Imports
    if (!allBadges) {
        console.error("CRITICAL ERROR: 'allBadges' is undefined.");
        return;
    }

    const contentEl = document.getElementById('sheetProfileContent');
    const pinArea = document.getElementById('sheetPinPhotoArea');
    const footerEl = document.getElementById('sheetFooterActions');
    
    if (!contentEl) return;

    // Reset states
    contentEl.innerHTML = '<div style="padding:60px 20px; text-align:center; color:#888;">Loading profile...</div>';
    if (pinArea) pinArea.style.display = 'none';
    if (footerEl) footerEl.innerHTML = '';

    // 2. Handle Pin Data injection
    if (pinData && pinArea) {
        const pinImg = document.getElementById('sheetPinImg');
        const pinTitle = document.getElementById('sheetPinTitle');
        const pinCategory = document.getElementById('sheetPinCategory');
        
        if (pinImg) pinImg.src = pinData.imageURL || pinData.thumbnailURL || '';
        if (pinTitle) pinTitle.textContent = pinData.title || 'Untitled Pin';
        if (pinCategory) pinCategory.textContent = pinData.category || 'Other';
        
        pinArea.style.display = 'block';
    }

    try {
        const docSnap = await getDoc(doc(db, "publicProfiles", userId));
        
        if (!docSnap.exists()) {
            contentEl.innerHTML = '<div style="padding:40px; text-align:center; color:#888;">User not found.</div>';
            return;
        }

        const data = docSnap.data();
        const username = data.username || "Anonymous Trooper";
        const initial = username.charAt(0).toUpperCase();
        const roleDisplay = data.squadRole ? data.squadRole.charAt(0).toUpperCase() + data.squadRole.slice(1) : '';
        const miles = ((data.totalDistance || 0) * 0.000621371).toFixed(1);

        // Level badge — respects showLevel && level > 1
        const badgeHTML = (data.showLevel !== false && (data.level ?? 1) > 1)
            ? `<span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:radial-gradient(circle at 40% 35%,#FFD700,#FF8C00); color:white; font-weight:900; font-size:11px; line-height:1; vertical-align:middle; margin-left:6px; box-shadow:0 1px 4px rgba(0,0,0,0.3);">${data.level}</span>`
            : '';

        const titleLine = (data.selectedTitle && allTitles[data.selectedTitle])
            ? `<div style="display:inline-block; background:#4A7C59; color:white; font-size:0.82em; font-weight:600; padding:3px 12px; border-radius:999px; margin-bottom:6px;">${escapeAttr(allTitles[data.selectedTitle].name)}</div>`
            : '';

        const squadLine = data.squadId 
            ? `<div style="display:inline-block; background:rgba(255,255,255,0.15); color:white; font-size:0.82em; font-weight:500; padding:3px 12px; border-radius:999px; margin-top:4px;">🛡️ ${escapeAttr(data.squadCallsign)} · ${escapeAttr(roleDisplay)}</div>`
            : '';

        // Build HTML
        let html = `
            <div style="background: linear-gradient(180deg, #1A1A2E 0%, #2A2A4E 100%); padding: 32px 20px 24px; text-align: center; position: relative;">
                <div style="width: 72px; height: 72px; border-radius: 50%; background: #4A7C59; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center; font-size: 2em; font-weight: 700; color: white; border: 3px solid rgba(255,255,255,0.2);">${escapeAttr(initial)}</div>
                <div style="font-size: 1.35em; font-weight: 700; color: white; margin-bottom: 6px; display:flex; justify-content:center; align-items:center;">${escapeAttr(username)}${badgeHTML}</div>
                ${titleLine}
                ${data.location ? `<div style="font-size: 0.85em; color: rgba(255,255,255,0.7); margin-bottom: 5px;">📍 ${escapeAttr(data.location)}</div>` : ''}
                ${squadLine}
            </div>
            
            <div style="background: white; padding: 20px 20px 0px;">
                <div style="display: flex; gap: 0; background: #F7F9F7; border: 1px solid #E0EDE5; border-radius: 10px; overflow: hidden; margin-bottom: 16px;">
                    <div style="flex: 1; text-align: center; padding: 14px 8px; border-right: 1px solid #E0EDE5;">
                        <div style="font-size: 1.3em; margin-bottom: 4px;">📍</div>
                        <div style="font-size: 1.2em; font-weight: 700; color: #4A7C59;">${(data.totalPins || 0).toLocaleString()}</div>
                        <div style="font-size: 0.72em; color: #888; margin-top: 2px;">Pins</div>
                    </div>
                    <div style="flex: 1; text-align: center; padding: 14px 8px; border-right: 1px solid #E0EDE5;">
                        <div style="font-size: 1.3em; margin-bottom: 4px;">🗺️</div>
                        <div style="font-size: 1.2em; font-weight: 700; color: #4A7C59;">${(data.totalRoutes || 0).toLocaleString()}</div>
                        <div style="font-size: 0.72em; color: #888; margin-top: 2px;">Routes</div>
                    </div>
                    <div style="flex: 1; text-align: center; padding: 14px 8px;">
                        <div style="font-size: 1.3em; margin-bottom: 4px;">🚶</div>
                        <div style="font-size: 1.2em; font-weight: 700; color: #4A7C59;">${miles}</div>
                        <div style="font-size: 0.72em; color: #888; margin-top: 2px;">Miles</div>
                    </div>
                </div>
        `;

        // Bio
        if (data.bio) {
            html += `
                <div style="font-size: 0.8em; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; margin-top: 16px;">About</div>
                <div style="font-size: 0.95em; color: #333; line-height: 1.5; margin-bottom: 16px;">${escapeAttr(data.bio)}</div>
            `;
        }

        // Badges
        const userBadges = data.badges || {}; 
        const earnedBadges = Object.keys(allBadges).filter(k => userBadges[k]);
        
        if (earnedBadges.length > 0) {
            html += `
                <div style="font-size: 0.8em; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; margin-top: 16px;">Badges (${earnedBadges.length})</div>
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(75px, 1fr)); gap: 8px; margin-bottom: 16px;">
                    ${earnedBadges.map(k => {
                        const b = allBadges[k];
                        if (!b) return '';
                        const badgeObj = userBadges[k] || {};
                        const count = badgeObj.count || 1;
                        const countHTML = count > 1 ? `<span style="background:#333; color:white; font-size:0.7em; padding:1px 4px; border-radius:4px; margin-top:4px; display:inline-block;">x${count}</span>` : '';
                        return `
                            <div style="background:#F5F5F5; border-radius:8px; padding:10px 4px 6px; text-align:center;" title="${escapeAttr(b.description || b.name)}">
                                <span style="font-size: 1.6em; display: block; margin-bottom: 4px;">${b.icon}</span>
                                <div style="font-size: 0.65em; color: #666; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${escapeAttr(b.name)}</div>${countHTML}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        html += `</div>`; // Close body
        contentEl.innerHTML = html;

        // 3. Build Footer Actions
        if (footerEl) {
            let footerHtml = '';
            
            if (data.buyMeACoffeeLink) {
                footerHtml += `<button class="modal-button" style="width:100%; background:#FFDD00; color:#333; border:none; margin-bottom:10px; font-weight:700;" onclick="window.open('${escapeAttr(data.buyMeACoffeeLink)}', '_blank')">☕ Support ${escapeAttr(username)}</button>`;
            }

            if (pinData) {
                const isAdmin = state.currentUser && state.isAdmin; // Powered by checkAdminPermissions
                if (isAdmin) {
                    footerHtml += `<button class="modal-button btn-danger sheet-del-route-btn" style="width:100%; margin-bottom:10px;">⚠️ Admin: Delete Entire Route</button>`;
                }
                footerHtml += `<button class="modal-button sheet-report-pin-btn" style="width:100%; background:transparent; border:1px solid #dc3545; color:#dc3545; margin-bottom:10px;">🚩 Report This Pin</button>`;
            }
            
            footerEl.innerHTML = footerHtml;

            // Wire up footer buttons
            if (pinData) {
                const reportBtn = footerEl.querySelector('.sheet-report-pin-btn');
                if (reportBtn) {
                    reportBtn.addEventListener('click', async () => {
                        const { openReportPinModal } = await import('./reports.js');
                        openReportPinModal(pinData.title, pinData.imageURL || pinData.thumbnailURL, pinData.routeId);
                    });
                }

                const delRouteBtn = footerEl.querySelector('.sheet-del-route-btn');
                if (delRouteBtn) {
                    delRouteBtn.addEventListener('click', async () => {
                        if (confirm("⚠️ PERMANENTLY delete this route from the map?")) {
                            try {
                                await deleteDoc(doc(db, "publishedRoutes", pinData.routeId));
                                alert("Route deleted.");
                                modal.style.display = 'none';
                                const { fetchAndDisplayCommunityRoutes } = await import('./community.js');
                                fetchAndDisplayCommunityRoutes();
                            } catch (err) {
                                console.error(err);
                                alert("Failed to delete.");
                            }
                        }
                    });
                }
            }
        }

    } catch (err) {
        console.error("Error loading profile:", err);
        contentEl.innerHTML = '<div style="padding:40px; text-align:center; color:#888;">Error loading profile data.</div>';
    }
}

// populateTitleDropdown was removed — title selection moved to My Profile (profile.js).
// Kept as a no-op export so any lingering call sites don't throw a module error.
export function populateTitleDropdown() {}

// Switches between the three "screens" in the Squads Modal
export function switchSquadView(viewName) {
    const views = {
        'registry': document.getElementById('squadRegistryView'),
        'intel': document.getElementById('squadIntelView'),
        'create': document.getElementById('squadCreateView')
    };

    // Hide all, then show the requested one
    Object.values(views).forEach(view => { if(view) view.style.display = 'none'; });
    if (views[viewName]) views[viewName].style.display = 'block';
}

// Global-access wrappers for your HTML onclicks
window.openCreateSquadForm = () => switchSquadView('create');
window.showSquadRegistry = () => switchSquadView('registry');

// Modal Utility Functions
export function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'flex';
        // Optional: play a subtle sound or trigger an animation here
    }
}

export function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
    }
}

// Make them available to HTML onclicks
window.openModal = openModal;
window.closeModal = closeModal;

// Add to the bottom of ui.js where your other window wrappers are
window.viewSquadIntel = (squadId) => {
    // 1. Switch the view to the Intel screen
    switchSquadView('intel');
    
    // 2. Trigger the data pull for this specific squad
    if (typeof fetchSquadDetails === 'function') {
        fetchSquadDetails(squadId);
    }
};

// --- ADMIN PERMISSIONS ---
// Toggles visibility of admin-only buttons based on the user's profile.
// Called from auth.js whenever the auth state changes.
export function checkAdminPermissions(userProfile) {
    const isAdmin = !!(userProfile && userProfile.role === 'admin');

    // Cache for the admin module so it doesn't need to re-read on every call.
    state.isAdmin = isAdmin;

    // The old btnAdminPanel (in Challenge Central) was removed - challenge admin
    // lives in the Admin Panel's Challenges tab now.

    // Full admin panel button (in the main menu modal).
    const btnAdminPanelFull = document.getElementById('btnAdminPanelFull');
    if (btnAdminPanelFull) btnAdminPanelFull.style.display = isAdmin ? 'flex' : 'none';
}


// --- HUB: PENDING SQUAD INVITES STRIP (Phase 5B) -----------------------------
// Renders the user's outstanding squad invites at the top of the Community Hub
// modal. Inline accept / decline. The strip auto-hides when there are no invites.
async function renderHubInvitesStrip(squadsMod) {
    const strip = document.getElementById('hubInvitesStrip');
    const list = document.getElementById('hubInvitesList');
    if (!strip || !list) return;

    if (!state.currentUser) {
        strip.style.display = 'none';
        return;
    }

    const invites = await squadsMod.fetchMyInvites();
    if (!invites || invites.length === 0) {
        strip.style.display = 'none';
        return;
    }

    list.innerHTML = invites.map(inv => `
        <div data-squad-id="${escapeAttr(inv.squadId)}" style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 8px; background:white; border-radius:4px;">
            <div style="min-width:0;">
                <strong>[${escapeAttr(inv.squadCallsign || '???')}] ${escapeAttr(inv.squadName || '(unknown)')}</strong>
                <div style="font-size:0.8em; color:#666;">From: ${escapeAttr(inv.invitedByName || 'Unknown')}</div>
            </div>
            <div style="display:flex; gap:4px; flex-shrink:0;">
                <button class="modal-button btn-primary hub-invite-accept-btn" style="padding:4px 10px; font-size:0.85em;">Accept</button>
                <button class="modal-button btn-secondary hub-invite-decline-btn" style="padding:4px 10px; font-size:0.85em;">Decline</button>
            </div>
        </div>
    `).join('');
    strip.style.display = 'block';

    list.querySelectorAll('.hub-invite-accept-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('[data-squad-id]');
            const squadId = row.dataset.squadId;
            if (!confirm('Accept invite to this squad?')) return;
            btn.disabled = true; btn.textContent = '…';
            const ok = await squadsMod.acceptInvite(squadId);
            if (ok) await renderHubInvitesStrip(squadsMod);
            else { btn.disabled = false; btn.textContent = 'Accept'; }
        });
    });
    list.querySelectorAll('.hub-invite-decline-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('[data-squad-id]');
            const squadId = row.dataset.squadId;
            if (!confirm('Decline this invite?')) return;
            btn.disabled = true; btn.textContent = '…';
            const ok = await squadsMod.declineInvite(squadId);
            if (ok) await renderHubInvitesStrip(squadsMod);
            else { btn.disabled = false; btn.textContent = 'Decline'; }
        });
    });
}

function escapeAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// LEADERBOARD TAB SWITCHER (private to ui.js)
// Manages the three containers: leaderboardList, myStatsContainer, squadsLeaderboardContainer
// ---------------------------------------------------------------------------
function _leaderboardShowTab(tabKey) {
    // Sync active tab styling
    document.querySelectorAll('.leaderboard-tab').forEach(t => {
        const matches =
            (tabKey === 'myStats'  && t.id === 'myStatsBtn') ||
            (tabKey === 'squads'   && t.id === 'squadsLeaderboardBtn') ||
            (t.dataset.metric === tabKey);
        t.classList.toggle('active', matches);
    });

    const listEl    = document.getElementById('leaderboardList');
    const statsEl   = document.getElementById('myStatsContainer');
    const squadsEl  = document.getElementById('squadsLeaderboardContainer');

    if (tabKey === 'myStats') {
        if (listEl)   listEl.style.display   = 'none';
        if (squadsEl) squadsEl.style.display  = 'none';
        if (statsEl)  statsEl.style.display   = 'block';
        fetchAndDisplayMyStats();
    } else if (tabKey === 'squads') {
        if (listEl)   listEl.style.display   = 'none';
        if (statsEl)  statsEl.style.display  = 'none';
        if (squadsEl) squadsEl.style.display  = 'block';
        fetchSquadsLeaderboard();
    } else {
        if (statsEl)  statsEl.style.display  = 'none';
        if (squadsEl) squadsEl.style.display  = 'none';
        if (listEl)   listEl.style.display    = 'block';
        fetchAndDisplayLeaderboard(tabKey);
    }
}
