// js/testmodules/ui.js

import { db, collection, query, orderBy, limit, getDocs, doc, getDoc, deleteDoc } from './firebase.js'; 
import { state, allTitles, allBadges, mapStyles } from './config.js';
import { initializeMap, setMapStyle, centerOnRoute } from './map.js';
import { initializeAuthListener, handleSignUp, handleLogIn, handleLogOut, handleAccountDeletion, handlePasswordReset } from './auth.js';
import { findMe, toggleTracking, startTracking, handlePhoto, shareCleanupResults, resetFindMeState, handleQuickPinPhoto, saveQuickPin, cancelQuickPin } from './tracking.js';
import { saveSession, loadSession, exportGeoJSON } from './data.js';
import { 
    toggleCommunityView, publishRoute, populatePublishedRoutesList, 
    loadProfileForEditing, saveProfile, fetchAndDisplayLeaderboard,
    fetchSquadsLeaderboard, 
    fetchAndDisplayMyStats,
    handleMeetupSubmit, validateMeetupForm, toggleRouteLike, 
    openAchievementsModal, openEventBadgesModal, openCurrentChallenges,
    getUserQuests, joinChallenge, getAdminChallenges, deleteChallenge, createNewChallenge, fetchAndDisplayAllEvents , initializeSquad, fetchLocalSquads, fetchSquadDetails
} from './community.js';
import { openAdminPanel, showAdminTab } from './admin.js';
import { closeReportPinModal, submitPendingReport } from './reports.js';
import { openMyProfileModal } from './profile.js';

// IMPORT THE NEW MODAL MANAGER
import { ModalManager } from './modal.js';

// --- DOM Element Selection ---
const elements = {
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
    achievementsModal: document.getElementById('achievementsModal'), 
    achievementModal: document.getElementById('achievementModal'), 

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
    btnAchievements: document.getElementById('btnAchievements'), 
    btnViewEventBadges: document.getElementById('btnViewEventBadges'), 
    achievementListBackBtn: document.getElementById('achievementListBackBtn'), 
    
    btnCurrentChallenges: document.getElementById('btnCurrentChallenges'),
    btnPastChallenges: document.getElementById('btnPastChallenges'),
    btnBackToMenu: document.querySelector('#pastChallengesModal .ok-btn'), 
    btnBackFromCurrent: document.getElementById('btnBackFromCurrent'), 
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
    // START THE MODAL MANAGER
    ModalManager.initGlobalListeners();

    initializeMap();
    state.map.on('dragstart', (e) => { if (e.originalEvent) resetFindMeState(); });
    state.map.on('zoomstart', (e) => { if (e.originalEvent) resetFindMeState(); });
    initializeAuthListener();
    attachEventListeners();
    
    if (sessionStorage.getItem('termsAccepted')) {
        ModalManager.close('termsModal');
        document.getElementById('userStatus').style.display = 'flex';
    } else {
        ModalManager.open('termsModal');
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
        ModalManager.close('termsModal');
        sessionStorage.setItem('termsAccepted', 'true');
        document.getElementById('userStatus').style.display = 'flex';
        if (!state.currentUser) ModalManager.open('authModal');
    });

    elements.loginSignupBtn.addEventListener('click', () => ModalManager.open('authModal'));
    elements.skipBtn.addEventListener('click', () => ModalManager.close('authModal'));
    
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
    elements.deleteAccountBtn.addEventListener('click', handleAccountDeletion);

    // --- MAP & TRACKING ---
    elements.findMeBtn.addEventListener('click', findMe);
    elements.trackBtn.addEventListener('click', toggleTracking);
    
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

    // --- SETTINGS: MAP STYLE SELECTOR ---
    document.getElementById('mapStyleOptions')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.map-style-option');
        if (!btn) return;
        setMapStyle(parseInt(btn.dataset.styleIndex, 10));
        renderMapStyleOptions();
    });
    
    // --- MAIN MENU NAVIGATION ---
    elements.menuBtn.addEventListener('click', () => ModalManager.open('menuModal'));
    
    // 2. Main Menu: Achievements
    if (elements.btnAchievements) {
        elements.btnAchievements.addEventListener('click', () => {
            ModalManager.close('menuModal');
            ModalManager.open('achievementsModal');
            
            openAchievementsModal(); 
            
            if (elements.achievementListBackBtn) {
                const newBackBtn = elements.achievementListBackBtn.cloneNode(true);
                elements.achievementListBackBtn.parentNode.replaceChild(newBackBtn, elements.achievementListBackBtn);
                elements.achievementListBackBtn = newBackBtn; 

                newBackBtn.addEventListener('click', () => {
                    ModalManager.close('achievementsModal');
                    ModalManager.open('menuModal');
                });
            }
        });
    }

    // 3. Community Map View
    elements.communityBtn.addEventListener('click', toggleCommunityView);
    
    // 4. Info / Settings
    elements.infoBtn.addEventListener('click', () => {
        renderMapStyleOptions();
        renderSettingsAccountSection();
        ModalManager.open('infoModal');
    });

    document.getElementById('settingsAccountSection')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.id === 'settingsEditProfileBtn') {
            ModalManager.close('infoModal');
            loadProfileForEditing();
            ModalManager.open('profileModal');
        } else if (btn.id === 'settingsSignOutBtn') {
            ModalManager.close('infoModal');
            handleLogOut();
        } else if (btn.id === 'settingsLoginBtn') {
            ModalManager.close('infoModal');
            ModalManager.open('authModal');
        }
    });

    // --- DATA & SAVING ---
    elements.safetyModalOkBtn.addEventListener('click', () => {
        ModalManager.close('safetyModal');
        startTracking();
    });

    elements.summaryOkBtn.addEventListener('click', () => { 
        ModalManager.close('summaryModal');
        document.getElementById('cleanupPhotoPreviewContainer').style.display = 'none';
        document.getElementById('cleanupPhotoPreview').src = '#';
    });

    elements.dataBtn.addEventListener('click', () => {
        ModalManager.close('menuModal');
        ModalManager.open('dataModal');
    });

    elements.saveBtn.addEventListener('click', saveSession);
    
    elements.loadBtn.addEventListener('click', () => {
        ModalManager.close('dataModal');
        loadSession();
    });
    
    elements.exportBtn.addEventListener('click', exportGeoJSON);
    elements.publishBtn.addEventListener('click', publishRoute);
    
    elements.managePublicationsBtn.addEventListener('click', () => {
        if (!state.currentUser) { alert("You must be logged in to manage your publications."); return; }
        ModalManager.close('dataModal');
        populatePublishedRoutesList();
        ModalManager.open('publishedRoutesModal');
    });

    // --- PROFILE ---
    if (elements.myProfileBtn) {
        elements.myProfileBtn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            ModalManager.close('menuModal');
            openMyProfileModal();
        });
    }
    elements.saveProfileBtn.addEventListener('click', saveProfile);

    // --- LEADERBOARD ---
    elements.leaderboardBtn.addEventListener('click', () => {
        ModalManager.open('leaderboardModal');
        _leaderboardShowTab('totalPins');
    });

    elements.leaderboardTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.id === 'myStatsBtn') _leaderboardShowTab('myStats');
            else if (tab.id === 'squadsLeaderboardBtn') _leaderboardShowTab('squads');
            else _leaderboardShowTab(tab.dataset.metric);
        });
    });

    document.getElementById('leaderboardModal')?.addEventListener('click', (e) => {
        const link = e.target.closest('.lb-profile-link');
        if (link) {
            e.preventDefault();
            const uid = link.dataset.uid;
            if (uid) {
                ModalManager.close('leaderboardModal');
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
        ModalManager.close('menuModal');
        ModalManager.open('hubModal');
        try {
            const squadsMod = await import('./squads.js');
            await renderHubInvitesStrip(squadsMod);
        } catch (err) {
            console.warn('Could not load pending invites:', err);
        }
    });
    
    if (elements.hubChallengesBtn) {
        elements.hubChallengesBtn.addEventListener('click', () => {
            ModalManager.close('hubModal');
            ModalManager.open('challengeMenuModal');
        });
    }
    elements.hubEventsBtn.addEventListener('click', () => {
        ModalManager.close('hubModal');
        ModalManager.open('eventsModal');
        fetchAndDisplayAllEvents();
    });
    elements.hubFeedBtn.addEventListener('click', () => {
        ModalManager.close('hubModal');
        ModalManager.open('feedModal');
        loadActivityFeed();
    });

    // --- CHALLENGE MENU NAVIGATION ---
    if (elements.btnViewEventBadges) {
        elements.btnViewEventBadges.addEventListener('click', () => {
            ModalManager.close('challengeMenuModal');
            ModalManager.open('achievementsModal');
            openEventBadgesModal(); 
            
            if (elements.achievementListBackBtn) {
                const newBackBtn = elements.achievementListBackBtn.cloneNode(true);
                elements.achievementListBackBtn.parentNode.replaceChild(newBackBtn, elements.achievementListBackBtn);
                elements.achievementListBackBtn = newBackBtn; 

                newBackBtn.addEventListener('click', () => {
                    ModalManager.close('achievementsModal');
                    ModalManager.open('challengeMenuModal');
                });
            }
        });
    }

    if (elements.btnCurrentChallenges) {
        elements.btnCurrentChallenges.addEventListener('click', () => {
            ModalManager.close('challengeMenuModal');
            ModalManager.open('activeChallengesModal');
            openCurrentChallenges(); 
        });
    }
    
    if (elements.btnBackFromCurrent) {
        elements.btnBackFromCurrent.addEventListener('click', (e) => {
            e.stopPropagation();
            ModalManager.close('activeChallengesModal');
            ModalManager.open('challengeMenuModal');
        });
    }

    if (elements.btnchallengeMenuBack) {
        elements.btnchallengeMenuBack.addEventListener('click', (e) => {
            e.stopPropagation();
            ModalManager.close('challengeMenuModal');
            ModalManager.open('hubModal');
        });
    }

    elements.btnPastChallenges.addEventListener('click', () => {
        ModalManager.close('challengeMenuModal');
        ModalManager.open('pastChallengesModal');
        elements.tabCompleted.classList.add('active');
        elements.tabUncompleted.classList.remove('active');
        loadPastChallenges('completed'); 
    });

    if (elements.btnBackToMenu) {
        elements.btnBackToMenu.addEventListener('click', () => {
            ModalManager.close('pastChallengesModal');
            ModalManager.open('challengeMenuModal');
        });
    }

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

    // --- NEW ADMIN PANEL (Phase 1) ---
    const btnAdminPanelFull = document.getElementById('btnAdminPanelFull');
    if (btnAdminPanelFull) {
        btnAdminPanelFull.addEventListener('click', async (e) => {
            e.stopPropagation();
            ModalManager.close('menuModal');
            await openAdminPanel();
        });
    }
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => showAdminTab(btn.dataset.tab));
    });
    
    // Phase 2: Report Pin Modals
    const reportCloseBtn = document.getElementById('reportPinCloseBtn');
    if (reportCloseBtn) reportCloseBtn.addEventListener('click', closeReportPinModal);
    const reportCancelBtn = document.getElementById('reportCancelBtn');
    if (reportCancelBtn) reportCancelBtn.addEventListener('click', closeReportPinModal);
    const reportSubmitBtn = document.getElementById('reportSubmitBtn');
    if (reportSubmitBtn) reportSubmitBtn.addEventListener('click', submitPendingReport);

    const btnEventsBack = document.getElementById('btnEventsBack');
    if (btnEventsBack) {
        btnEventsBack.addEventListener('click', () => {
            ModalManager.close('eventsModal');
            ModalManager.open('hubModal');
        });
    }

    if (elements.btnPastChallengesBack) {
        elements.btnPastChallengesBack.addEventListener('click', () => {
            ModalManager.close('pastChallengesModal');
            ModalManager.open('challengeMenuModal');
        });
    }
    
    // --- LOG TRASH (NEW BUTTONS) ---
    if (elements.logTrashBtn) {
        elements.logTrashBtn.addEventListener('click', () => {
            ModalManager.open('logTrashModal');
            elements.trashCountInput.value = ''; 
            elements.trashCountInput.focus();
        });
    }

    if (elements.confirmTrashBtn) {
        elements.confirmTrashBtn.addEventListener('click', () => {
            const count = parseInt(elements.trashCountInput.value);
            if (count > 0) {
                alert(`Logged ${count} items! (This will be saved when you stop tracking).`);
                ModalManager.close('logTrashModal');
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
            ModalManager.open('squadsModal');
            if (typeof switchSquadView === 'function') {
                switchSquadView('registry');
            }
            if (typeof fetchLocalSquads === 'function') {
                fetchLocalSquads(); 
            }
        });
    }

    const btnFinalizeSquad = document.getElementById('btnFinalizeSquad');
    if (btnFinalizeSquad) {
        btnFinalizeSquad.addEventListener('click', () => {
             if (typeof initializeSquad === 'function') {
                initializeSquad();
            } else {
                console.error("initializeSquad function missing");
            }
        });
    }

    document.getElementById('btnFinalizeSquad')?.addEventListener('click', initializeSquad);
    
} //********************end event listern**************

// --- SETTINGS: MAP STYLE CARDS -----------------------------------------------
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
        if (state.currentUser && document.getElementById('settingsEditProfileBtn')) {
            container.innerHTML = buildSettingsAccountHTML(username.charAt(0).toUpperCase(), username, email);
        }
    } catch (err) {
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
        if (elements.authModal) ModalManager.close('authModal');
        if (elements.publishBtn) elements.publishBtn.style.display = 'block';
        if (elements.managePublicationsBtn) elements.managePublicationsBtn.style.display = 'block';
        if (elements.myProfileBtn) elements.myProfileBtn.disabled = false;
        if (elements.pictureBtn) elements.pictureBtn.disabled = false;
    } else {
        if (loggedInContent) loggedInContent.style.display = 'none';
        if (guestContent) guestContent.style.display = 'block';
        if (elements.publishBtn) elements.publishBtn.style.display = 'none';
        if (elements.managePublicationsBtn) elements.managePublicationsBtn.style.display = 'none';
        if (elements.myProfileBtn) elements.myProfileBtn.disabled = true;
        if (elements.pictureBtn && !state.isTracking) elements.pictureBtn.disabled = true;
    }
}

export function updateAuthModalUI() {
    const authForm = document.getElementById('authForm');
    const authTitle = document.getElementById('authTitle');
    const authSubtitle = document.getElementById('authSubtitle');
    const forgotLink = document.getElementById('forgotPasswordLink'); 

    document.getElementById('authError').textContent = '';

    if (state.isSignUpMode) {
        authTitle.textContent = 'Create a Litter Troopers Account';
        authSubtitle.innerHTML = 'Or <a href="#" id="switchAuthModeLink">log in to an existing account.</a>';
        elements.authActionBtn.textContent = 'Sign Up';
        authForm.classList.add('signup-mode');
        authForm.classList.remove('login-mode');
        if (forgotLink) forgotLink.style.display = 'none'; 
    } else {
        authTitle.textContent = 'Log In to Litter Troopers';
        authSubtitle.innerHTML = 'Or <a href="#" id="switchAuthModeLink">create a new account.</a>';
        elements.authActionBtn.textContent = 'Log In';
        authForm.classList.add('login-mode');
        authForm.classList.remove('signup-mode');
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
    const container = elements.feedContainer; 
    if (!container) return;

    container.innerHTML = '<div class="feed-loader">Loading latest cleanups...</div>';

    try {
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

        console.log("Current User Admin Status:", isAdmin);

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

            if (typeof data.distance === 'undefined' && typeof data.distanceMiles === 'undefined') return; 

            const date = data.timestamp?.toDate().toLocaleDateString() || "Recently";
            const photoUrl = data.cleanupPhotoURL || 'https://placehold.co/400x300?text=No+Photo';
            const likeCount = data.likeCount || 0;
            const likedBy = data.likedBy || [];
            const isLiked = state.currentUser && likedBy.includes(state.currentUser.uid);
            const likeBtnClass = isLiked ? 'like-btn active' : 'like-btn';
            
            const isOwner = state.currentUser && (data.userId === state.currentUser.uid);
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

            const likeBtn = card.querySelector('.like-btn');
            likeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const result = await toggleRouteLike(routeId); 
                if (result) {
                    likeBtn.querySelector('.like-count').textContent = result.likeCount;
                    likeBtn.classList.toggle('active', result.isLiked);
                }
            });

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
    // Deprecated
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
    if (modal) ModalManager.open('publicProfileModal');

    if (!allBadges) {
        console.error("CRITICAL ERROR: 'allBadges' is undefined.");
        return;
    }

    const contentEl = document.getElementById('sheetProfileContent');
    const pinArea = document.getElementById('sheetPinPhotoArea');
    const footerEl = document.getElementById('sheetFooterActions');
    
    if (!contentEl) return;

    contentEl.innerHTML = '<div style="padding:60px 20px; text-align:center; color:#888;">Loading profile...</div>';
    if (pinArea) pinArea.style.display = 'none';
    if (footerEl) footerEl.innerHTML = '';

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

        const badgeHTML = (data.showLevel !== false && (data.level ?? 1) > 1)
            ? `<span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:radial-gradient(circle at 40% 35%,#FFD700,#FF8C00); color:white; font-weight:900; font-size:11px; line-height:1; vertical-align:middle; margin-left:6px; box-shadow:0 1px 4px rgba(0,0,0,0.3);">${data.level}</span>`
            : '';

        const titleLine = (data.selectedTitle && allTitles[data.selectedTitle])
            ? `<div style="display:inline-block; background:#4A7C59; color:white; font-size:0.82em; font-weight:600; padding:3px 12px; border-radius:999px; margin-bottom:6px;">${escapeAttr(allTitles[data.selectedTitle].name)}</div>`
            : '';

        const squadLine = data.squadId 
            ? `<div style="display:inline-block; background:rgba(255,255,255,0.15); color:white; font-size:0.82em; font-weight:500; padding:3px 12px; border-radius:999px; margin-top:4px;">🛡️ ${escapeAttr(data.squadCallsign)} · ${escapeAttr(roleDisplay)}</div>`
            : '';

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

        if (data.bio) {
            html += `
                <div style="font-size: 0.8em; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; margin-top: 16px;">About</div>
                <div style="font-size: 0.95em; color: #333; line-height: 1.5; margin-bottom: 16px;">${escapeAttr(data.bio)}</div>
            `;
        }

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

        html += `</div>`; 
        contentEl.innerHTML = html;

        if (footerEl) {
            let footerHtml = '';
            
            if (data.buyMeACoffeeLink) {
                footerHtml += `<button class="modal-button" style="width:100%; background:#FFDD00; color:#333; border:none; margin-bottom:10px; font-weight:700;" onclick="window.open('${escapeAttr(data.buyMeACoffeeLink)}', '_blank')">☕ Support ${escapeAttr(username)}</button>`;
            }

            if (pinData) {
                const isAdmin = state.currentUser && state.isAdmin;
                if (isAdmin) {
                    footerHtml += `<button class="modal-button btn-danger sheet-del-route-btn" style="width:100%; margin-bottom:10px;">⚠️ Admin: Delete Entire Route</button>`;
                }
                footerHtml += `<button class="modal-button sheet-report-pin-btn" style="width:100%; background:transparent; border:1px solid #dc3545; color:#dc3545; margin-bottom:10px;">🚩 Report This Pin</button>`;
            }
            
            footerEl.innerHTML = footerHtml;

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
                                ModalManager.close('publicProfileModal');
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

export function populateTitleDropdown() {}

export function switchSquadView(viewName) {
    const views = {
        'registry': document.getElementById('squadRegistryView'),
        'intel': document.getElementById('squadIntelView'),
        'create': document.getElementById('squadCreateView')
    };

    Object.values(views).forEach(view => { if(view) view.style.display = 'none'; });
    if (views[viewName]) views[viewName].style.display = 'block';
}

window.openCreateSquadForm = () => switchSquadView('create');
window.showSquadRegistry = () => switchSquadView('registry');

// Route window.openModal to the new ModalManager
export function openModal(modalId) {
    ModalManager.open(modalId);
}
export function closeModal(modalId) {
    ModalManager.close(modalId);
}

window.openModal = openModal;
window.closeModal = closeModal;

window.viewSquadIntel = (squadId) => {
    switchSquadView('intel');
    if (typeof fetchSquadDetails === 'function') {
        fetchSquadDetails(squadId);
    }
};

export function checkAdminPermissions(userProfile) {
    const isAdmin = !!(userProfile && userProfile.role === 'admin');
    state.isAdmin = isAdmin;

    const btnAdminPanelFull = document.getElementById('btnAdminPanelFull');
    if (btnAdminPanelFull) btnAdminPanelFull.style.display = isAdmin ? 'flex' : 'none';
}

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

function _leaderboardShowTab(tabKey) {
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
