import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, addDoc, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Firebase init ─────────────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyCE1b6VtJjUs0O5YvyLjeslxuHC8UlgJUM",
    authDomain: "garbagepathv2.firebaseapp.com",
    projectId: "garbagepathv2",
    storageBucket: "garbagepathv2.firebasestorage.app",
    messagingSenderId: "505856089619",
    appId: "1:505856089619:web:682f58d02be4295be4a9e6"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ── Live stats counters ───────────────────────────────────────────────────────
function animateCounter(el, target, isFloat, duration) {
    if (!el) return;
    const start = Date.now();
    function tick() {
        const elapsed = Date.now() - start;
        const progress = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3);
        const current = target * ease;
        el.textContent = isFloat ? current.toFixed(1) : Math.floor(current).toLocaleString();
        if (progress < 1) requestAnimationFrame(tick);
    }
    tick();
}

async function loadStats() {
    let targets = { pins: 0, items: 0, miles: 0, routes: 0, troopers: 0 };
    try {
        const snap = await getDoc(doc(db, "config", "appStats"));
        if (snap.exists()) {
            const d = snap.data();
            targets.pins     = d.totalPins     ?? 0;
            targets.items    = d.totalItems    ?? 0;
            targets.miles    = parseFloat((d.totalMiles ?? 0).toFixed(1));
            targets.routes   = d.totalRoutes   ?? 0;
            targets.troopers = d.totalUsers    ?? 0;
        }
    } catch (e) {
        console.warn("Stats fetch failed:", e);
    }
    animateCounter(document.getElementById('cnt-pins'),     targets.pins,     false, 1800);
    animateCounter(document.getElementById('cnt-items'),    targets.items,    false, 1800);
    animateCounter(document.getElementById('cnt-miles'),    targets.miles,    true,  1800);
    animateCounter(document.getElementById('cnt-routes'),   targets.routes,   false, 1800);
    animateCounter(document.getElementById('cnt-troopers'), targets.troopers, false, 1800);

    // Ambient tick
    setTimeout(() => {
        setInterval(() => {
            const pEl = document.getElementById('cnt-pins');
            const iEl = document.getElementById('cnt-items');
            const mEl = document.getElementById('cnt-miles');
            
            if (pEl && pEl.textContent !== '—') {
                if (Math.random() < 0.3) {
                    targets.pins++;
                    pEl.textContent = targets.pins.toLocaleString();
                    
                    // Increment items whenever pins go up (adds 1 to 3 items per pin tick)
                    if (iEl && iEl.textContent !== '—') {
                        targets.items += Math.floor(Math.random() * 3) + 1;
                        iEl.textContent = targets.items.toLocaleString();
                    }
                }
            }
            if (mEl && mEl.textContent !== '—') {
                if (Math.random() < 0.2) {
                    targets.miles = parseFloat((targets.miles + 0.1).toFixed(1));
                    mEl.textContent = targets.miles.toFixed(1);
                }
            }
        }, 8000);
    }, 3000);
}

const counterStrip = document.querySelector('.counter-strip');
if (counterStrip) {
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) { loadStats(); observer.disconnect(); }
    }, { threshold: 0.3 });
    observer.observe(counterStrip);
}

// ── XP bar animation ──────────────────────────────────────────────────────────
const xpBar = document.getElementById('xp-bar');
if (xpBar) {
    const xpObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            xpBar.style.width = '61.2%';
            xpObserver.disconnect();
        }
    }, { threshold: 0.5 });
    xpBar.style.width = '0%';
    xpObserver.observe(xpBar);
}

// ── Smooth scroll ─────────────────────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});

// ── Mailing list signup ───────────────────────────────────────────────────────
const signupForm = document.getElementById('signupForm');
if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const firstName = document.getElementById('firstName').value.trim();
        const email = document.getElementById('email').value.trim();
        const submitBtn = document.getElementById('submitBtn');
        const formMessage = document.getElementById('formMessage');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
        formMessage.textContent = '';
        try {
            await addDoc(collection(db, "mailingList"), {
                firstName, email, timestamp: new Date()
            });
            formMessage.textContent = "Thanks for signing up! We'll be in touch.";
            formMessage.style.color = '#28a745';
            signupForm.reset();
        } catch (err) {
            console.error(err);
            formMessage.textContent = "Something went wrong. Please try again.";
            formMessage.style.color = '#dc3545';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Notify Me';
        }
    });
}

// ── Android beta waitlist ─────────────────────────────────────────────────────
const betaSignupForm = document.getElementById('betaSignupForm');
if (betaSignupForm) {
    betaSignupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById('betaEmailInput');
        const messageEl = document.getElementById('betaSignupMessage');
        const submitBtn = document.getElementById('betaSubmitBtn');
        const email = emailInput.value.trim();

        if (!email.toLowerCase().endsWith('@gmail.com')) {
            messageEl.textContent = "Please provide a valid @gmail.com address for Google Play testing.";
            messageEl.style.color = '#dc3545';
            messageEl.classList.remove('hidden');
            return;
        }

        submitBtn.textContent = "Adding to list...";
        submitBtn.disabled = true;
        try {
            await addDoc(collection(db, "betaWaitlist"), {
                email, platform: "Android", signupDate: new Date()
            });
            messageEl.textContent = "Success! You're on the list. Keep an eye on your inbox.";
            messageEl.style.color = '#28a745';
            messageEl.classList.remove('hidden');
            emailInput.value = '';
        } catch (err) {
            console.error(err);
            messageEl.textContent = "Error saving email. Please try again.";
            messageEl.style.color = '#dc3545';
            messageEl.classList.remove('hidden');
        } finally {
            submitBtn.textContent = "Join the Android Waitlist";
            submitBtn.disabled = false;
        }
    });
}

// ── iOS BETA ────────────────────────────────────────────────
const iosBetaSignupForm = document.getElementById('iosBetaSignupForm');
if (iosBetaSignupForm) {
    iosBetaSignupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById('iosBetaEmailInput');
        const messageEl = document.getElementById('iosBetaSignupMessage');
        const submitBtn = document.getElementById('iosBetaSubmitBtn');
        const email = emailInput.value.trim();

        submitBtn.textContent = "Adding to list...";
        submitBtn.disabled = true;
        try {
            await addDoc(collection(db, "betaWaitlist"), {
                email, platform: "iOS", signupDate: new Date()
            });
            messageEl.textContent = "Success! You're on the list. Keep an eye on your inbox for the TestFlight invite.";
            messageEl.style.color = '#28a745';
            messageEl.classList.remove('hidden');
            emailInput.value = '';
        } catch (err) {
            console.error(err);
            messageEl.textContent = "Error saving email. Please try again.";
            messageEl.style.color = '#dc3545';
            messageEl.classList.remove('hidden');
        } finally {
            submitBtn.textContent = "Join the iOS Waitlist";
            submitBtn.disabled = false;
        }
    });
}
