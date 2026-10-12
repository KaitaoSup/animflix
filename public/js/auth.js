// =========================================================================
// --- ANIMFLIX USER AUTHENTICATION & MULTI-DEVICE ANILIST SYNC ---
// =========================================================================

let currentAnimflixUser = null;

// En-têtes d'authentification pour les requêtes fetch
function getAuthHeaders(extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...extraHeaders
    };
    const sessionToken = localStorage.getItem('animflix_auth_token');
    if (sessionToken) {
        headers['Authorization'] = 'Bearer ' + sessionToken;
        headers['x-session-token'] = sessionToken;
    }
    return headers;
}

// Initialisation de la session utilisateur au démarrage
async function initAnimflixAuth() {
    try {
        const res = await fetch('/api/auth/me', {
            method: 'GET',
            headers: getAuthHeaders(),
            credentials: 'include'
        });
        const data = await res.json();
        
        if (data.loggedIn && data.user) {
            currentAnimflixUser = data.user;
            
            // Si le compte Animflix a un compte AniList lié, on synchronise l'environnement local
            if (data.user.anilist && data.user.anilist.token) {
                localStorage.setItem('anilist_token', data.user.anilist.token);
                const anilistUserObj = {
                    id: data.user.anilist.id,
                    name: data.user.anilist.name,
                    avatar: {
                        medium: data.user.anilist.avatar,
                        large: data.user.anilist.avatar
                    },
                    options: data.user.anilist.options || {}
                };
                localStorage.setItem('anilist_user', JSON.stringify(anilistUserObj));
                if (typeof window.currentAnilistUser !== 'undefined') {
                    window.currentAnilistUser = anilistUserObj;
                }
            } else {
                // Si l'utilisateur n'a pas encore lié AniList à son compte Animflix,
                // mais qu'un token AniList existe déjà dans ce navigateur, on propose ou synchronise automatiquement !
                const localToken = localStorage.getItem('anilist_token');
                if (localToken) {
                    tryAutoLinkExistingAnilist(localToken);
                }
            }
        } else {
            currentAnimflixUser = null;
        }
    } catch (e) {
        console.warn("Échec de vérification auth Animflix:", e.message);
        currentAnimflixUser = null;
    }

    renderUserAccountNav();
}

// Lier automatiquement un token AniList déjà présent dans le navigateur au compte connecté
async function tryAutoLinkExistingAnilist(localToken) {
    if (!currentAnimflixUser || (currentAnimflixUser.anilist && currentAnimflixUser.anilist.token)) return;
    try {
        const res = await fetch('/api/auth/anilist/link', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include',
            body: JSON.stringify({ token: localToken })
        });
        const data = await res.json();
        if (data.success && data.user) {
            currentAnimflixUser = data.user;
            renderUserAccountNav();
            if (typeof showToast === 'function') {
                showToast(`⚡ Compte AniList lié à votre compte ${currentAnimflixUser.username} !`);
            }
        }
    } catch (e) {
        console.warn("Auto-link AniList silencieux échoué:", e.message);
    }
}

// Connexion à un compte Animflix
async function loginAnimflix(username, password) {
    if (!username || !password) {
        if (typeof showToast === 'function') showToast("⚠️ Veuillez renseigner votre identifiant et mot de passe.");
        return;
    }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || "Identifiant ou mot de passe incorrect.");
        }

        if (data.sessionToken) {
            localStorage.setItem('animflix_auth_token', data.sessionToken);
        }
        currentAnimflixUser = data.user;

        // Synchroniser le token AniList lié si existant
        if (data.user.anilist && data.user.anilist.token) {
            localStorage.setItem('anilist_token', data.user.anilist.token);
            const anilistUserObj = {
                id: data.user.anilist.id,
                name: data.user.anilist.name,
                avatar: {
                    medium: data.user.anilist.avatar,
                    large: data.user.anilist.avatar
                },
                options: data.user.anilist.options || {}
            };
            localStorage.setItem('anilist_user', JSON.stringify(anilistUserObj));
            if (typeof window.currentAnilistUser !== 'undefined') {
                window.currentAnilistUser = anilistUserObj;
            }
        }

        closeAnimflixAuthModal();
        renderUserAccountNav();

        if (typeof showToast === 'function') {
            showToast(`🎉 Bienvenue ${currentAnimflixUser.username} !`);
        }

        // Rafraîchir les listes AniList si la fonction existe
        if (typeof loadAnilistWatchingList === 'function' && data.user.anilist) {
            loadAnilistWatchingList(true);
        }
    } catch (err) {
        if (typeof showToast === 'function') {
            showToast("❌ " + err.message);
        } else {
            alert(err.message);
        }
    }
}

// Inscription d'un nouveau compte Animflix
async function registerAnimflix(username, password, linkLocalAnilist = true) {
    if (!username || !password) {
        if (typeof showToast === 'function') showToast("⚠️ Remplissez tous les champs obligatoires.");
        return;
    }

    try {
        const payload = { username, password };
        if (linkLocalAnilist) {
            const localToken = localStorage.getItem('anilist_token');
            if (localToken) payload.anilistToken = localToken;
        }

        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || "Impossible de créer ce compte.");
        }

        if (data.sessionToken) {
            localStorage.setItem('animflix_auth_token', data.sessionToken);
        }
        currentAnimflixUser = data.user;

        if (data.user.anilist && data.user.anilist.token) {
            localStorage.setItem('anilist_token', data.user.anilist.token);
            const anilistUserObj = {
                id: data.user.anilist.id,
                name: data.user.anilist.name,
                avatar: {
                    medium: data.user.anilist.avatar,
                    large: data.user.anilist.avatar
                },
                options: data.user.anilist.options || {}
            };
            localStorage.setItem('anilist_user', JSON.stringify(anilistUserObj));
            if (typeof window.currentAnilistUser !== 'undefined') {
                window.currentAnilistUser = anilistUserObj;
            }
        }

        closeAnimflixAuthModal();
        renderUserAccountNav();

        if (typeof showToast === 'function') {
            showToast(`🎉 Compte créé ! Bienvenue ${currentAnimflixUser.username} 🍿`);
        }

        if (typeof loadAnilistWatchingList === 'function' && data.user.anilist) {
            loadAnilistWatchingList(true);
        }
    } catch (err) {
        if (typeof showToast === 'function') {
            showToast("❌ " + err.message);
        } else {
            alert(err.message);
        }
    }
}

// Déconnexion complète
async function logoutAnimflix() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include'
        });
    } catch (e) {}

    localStorage.removeItem('animflix_auth_token');
    localStorage.removeItem('anilist_token');
    localStorage.removeItem('anilist_user');
    localStorage.removeItem('anilist_watching_cache');

    currentAnimflixUser = null;
    if (typeof window.currentAnilistUser !== 'undefined') {
        window.currentAnilistUser = null;
    }

    renderUserAccountNav();
    if (typeof renderHomeScreen === 'function') renderHomeScreen();

    if (typeof showToast === 'function') {
        showToast("👋 Déconnexion réussie.");
    }
}

// Lier un compte AniList au compte Animflix connecté
async function linkAnilistToAnimflix(token, notify = true) {
    if (!currentAnimflixUser) {
        // Si non connecté à Animflix, on enregistre localement comme avant
        localStorage.setItem('anilist_token', token);
        return;
    }

    try {
        const res = await fetch('/api/auth/anilist/link', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include',
            body: JSON.stringify({ token })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || "Échec de liaison du compte AniList.");
        }

        currentAnimflixUser = data.user;
        localStorage.setItem('anilist_token', token);

        if (data.anilist) {
            const anilistUserObj = {
                id: data.anilist.id,
                name: data.anilist.name,
                avatar: {
                    medium: data.anilist.avatar,
                    large: data.anilist.avatar
                },
                options: data.anilist.options || {}
            };
            localStorage.setItem('anilist_user', JSON.stringify(anilistUserObj));
            if (typeof window.currentAnilistUser !== 'undefined') {
                window.currentAnilistUser = anilistUserObj;
            }
        }

        renderUserAccountNav();
        if (typeof loadAnilistWatchingList === 'function') {
            loadAnilistWatchingList(true);
        }

        if (notify && typeof showToast === 'function') {
            showToast(`🎉 Compte AniList lié avec succès à ${currentAnimflixUser.username} !`);
        }
    } catch (err) {
        if (notify && typeof showToast === 'function') {
            showToast("❌ " + err.message);
        }
        throw err;
    }
}

// Dissocier AniList du compte Animflix connecté
async function unlinkAnilistFromAnimflix() {
    if (!currentAnimflixUser) return;
    if (!confirm("Voulez-vous vraiment dissocier votre compte AniList de votre compte Animflix ?")) {
        return;
    }

    try {
        const res = await fetch('/api/auth/anilist/unlink', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include'
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || "Échec de dissociation.");
        }

        currentAnimflixUser = data.user;
        localStorage.removeItem('anilist_token');
        localStorage.removeItem('anilist_user');
        localStorage.removeItem('anilist_watching_cache');

        if (typeof window.currentAnilistUser !== 'undefined') {
            window.currentAnilistUser = null;
        }

        renderUserAccountNav();
        if (typeof renderHomeScreen === 'function') renderHomeScreen();

        if (typeof showToast === 'function') {
            showToast("✂️ Compte AniList dissocié.");
        }
    } catch (err) {
        if (typeof showToast === 'function') {
            showToast("❌ " + err.message);
        }
    }
}

// Gestion de la modale de connexion / inscription
let currentAuthTab = 'login';

function openAnimflixAuthModal(tab = 'login') {
    const modal = document.getElementById('animflixAuthModal');
    if (!modal) return;
    switchAnimflixAuthTab(tab);
    modal.style.display = 'flex';
    setTimeout(() => {
        const input = document.getElementById('authUsernameInput');
        if (input) input.focus();
    }, 100);
}

function closeAnimflixAuthModal() {
    const modal = document.getElementById('animflixAuthModal');
    if (modal) modal.style.display = 'none';
}

function switchAnimflixAuthTab(tab) {
    currentAuthTab = tab;
    const tabLogin = document.getElementById('tabAuthLogin');
    const tabRegister = document.getElementById('tabAuthRegister');
    const title = document.getElementById('animflixAuthModalTitle');
    const submitBtn = document.getElementById('authSubmitBtn');
    const registerNotice = document.getElementById('authRegisterAnilistNotice');

    if (tab === 'register') {
        if (tabLogin) tabLogin.classList.remove('active');
        if (tabRegister) tabRegister.classList.add('active');
        if (title) title.innerText = "✨ Créer un compte Animflix";
        if (submitBtn) submitBtn.innerText = "Créer mon compte";

        // Détecter si un compte AniList est déjà en local
        const localUserRaw = localStorage.getItem('anilist_user');
        if (localUserRaw && registerNotice) {
            try {
                const u = JSON.parse(localUserRaw);
                const nameEl = document.getElementById('authDetectedAnilistName');
                if (nameEl) nameEl.innerText = u.name || 'Connecté';
                registerNotice.style.display = 'block';
            } catch (e) {
                if (registerNotice) registerNotice.style.display = 'none';
            }
        } else if (registerNotice) {
            registerNotice.style.display = 'none';
        }
    } else {
        if (tabLogin) tabLogin.classList.add('active');
        if (tabRegister) tabRegister.classList.remove('active');
        if (title) title.innerText = "👤 Connexion Animflix";
        if (submitBtn) submitBtn.innerText = "Se connecter";
        if (registerNotice) registerNotice.style.display = 'none';
    }
}

function handleAnimflixAuthSubmit(event) {
    if (event) event.preventDefault();
    const usernameInput = document.getElementById('authUsernameInput');
    const passwordInput = document.getElementById('authPasswordInput');
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (currentAuthTab === 'register') {
        const linkAnilist = !!document.getElementById('authAutoLinkAnilistCheckbox')?.checked;
        registerAnimflix(username, password, linkAnilist);
    } else {
        loginAnimflix(username, password);
    }
}

// Rendu unifié de la zone compte / AniList dans la barre de navigation
function renderUserAccountNav() {
    const container = document.getElementById('anilistNavContainer');
    if (!container) return;

    const escape = (typeof escapeHtml === 'function') ? escapeHtml : (s => s || '');
    const showNsfw = (typeof getShowNsfwPreference === 'function') ? getShowNsfwPreference() : false;

    // CAS 1 : Connecté à un compte Animflix
    if (currentAnimflixUser) {
        const hasAnilist = !!(currentAnimflixUser.anilist && currentAnimflixUser.anilist.name);
        const anilistName = hasAnilist ? currentAnimflixUser.anilist.name : null;
        const avatarUrl = (hasAnilist && currentAnimflixUser.anilist.avatar) 
            ? currentAnimflixUser.anilist.avatar 
            : 'https://anilist.co/img/icons/icon.svg';

        container.innerHTML = `
            <div id="anilistUserBadge" class="anilist-user-badge" onclick="toggleAnilistDropdown(event)" tabindex="0" title="Compte Animflix : ${escape(currentAnimflixUser.username)}">
                ${hasAnilist 
                    ? `<img class="anilist-avatar" src="${avatarUrl}" alt="${escape(anilistName)}" onerror="this.src='https://anilist.co/img/icons/icon.svg'">`
                    : `<span class="profile-chip-avatar" style="font-size: 16px; margin-right: 2px;">🍿</span>`
                }
                <span class="anilist-username">${escape(currentAnimflixUser.username)}</span>
                ${hasAnilist ? `<span title="Compte AniList synchronisé" style="font-size: 11px; color: #02a9ff;">⚡</span>` : ''}
                <span style="font-size: 10px; color: #888;">▼</span>
                
                <div class="anilist-dropdown" onclick="event.stopPropagation()">
                    <div style="padding: 6px 10px 10px; border-bottom: 1px solid #23374d; margin-bottom: 6px;">
                        <div style="font-size: 11px; color: #888;">Compte Animflix</div>
                        <div style="font-weight: bold; color: #02a9ff; font-size: 14px;">${escape(currentAnimflixUser.username)} 👋</div>
                    </div>

                    ${hasAnilist ? `
                        <div style="padding: 4px 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 6px; font-size: 12px; color: #aaa;">
                            <span style="color: #4ade80;">●</span> AniList lié : <b style="color: #fff;">${escape(anilistName)}</b>
                        </div>
                        <a href="https://anilist.co/user/${encodeURIComponent(anilistName)}" target="_blank" rel="noopener">
                            🔗 Profil AniList
                        </a>
                        <button onclick="unlinkAnilistFromAnimflix()" style="color: #f87171;">
                            ✂️ Dissocier AniList
                        </button>
                    ` : `
                        <button onclick="openAnilistAuthModal()" style="color: #02a9ff; font-weight: 600;">
                            ⚡ Lier mon compte AniList
                        </button>
                    `}

                    <div class="anilist-dropdown-nsfw" onclick="toggleNsfwFilter(!getShowNsfwPreference())">
                        <span style="font-size: 12px; font-weight: 600;">🔞 Contenu 18+</span>
                        <label class="switch-nsfw" onclick="event.stopPropagation()">
                            <input type="checkbox" id="nsfwDropdownToggle" ${showNsfw ? 'checked' : ''} onchange="toggleNsfwFilter(this.checked)">
                            <span class="slider-nsfw"></span>
                        </label>
                    </div>

                    <button onclick="logoutAnimflix()" style="border-top: 1px solid rgba(255,255,255,0.06); margin-top: 4px;">
                        🚪 Se déconnecter d'Animflix
                    </button>
                </div>
            </div>
        `;
        return;
    }

    // CAS 2 : Non connecté à Animflix, mais session AniList locale résiduelle
    const localToken = localStorage.getItem('anilist_token');
    const localUserRaw = localStorage.getItem('anilist_user');
    let localAnilist = null;
    try {
        if (localUserRaw) localAnilist = JSON.parse(localUserRaw);
    } catch(e) {}

    if (localToken && localAnilist) {
        const avatarUrl = localAnilist.avatar?.medium || localAnilist.avatar?.large || 'https://anilist.co/img/icons/icon.svg';
        container.innerHTML = `
            <div id="anilistUserBadge" class="anilist-user-badge" onclick="toggleAnilistDropdown(event)" tabindex="0" title="AniList invité : ${escape(localAnilist.name)}">
                <img class="anilist-avatar" src="${avatarUrl}" alt="${escape(localAnilist.name)}" onerror="this.src='https://anilist.co/img/icons/icon.svg'">
                <span class="anilist-username">${escape(localAnilist.name)}</span>
                <span style="font-size: 10px; color: #888;">▼</span>
                <div class="anilist-dropdown" onclick="event.stopPropagation()">
                    <div style="padding: 4px 10px 8px; border-bottom: 1px solid #23374d; margin-bottom: 6px;">
                        <div style="font-size: 11px; color: #888;">Session locale</div>
                        <div style="font-weight: bold; color: #02a9ff; font-size: 13.5px;">${escape(localAnilist.name)} (Invité)</div>
                    </div>
                    <button onclick="openAnimflixAuthModal('register')" style="color: #4ade80; font-weight: bold;">
                        💾 Sauvegarder sur un compte
                    </button>
                    <a href="${localAnilist.siteUrl || 'https://anilist.co'}" target="_blank" rel="noopener">
                        🔗 Profil AniList
                    </a>
                    <button onclick="logoutAnilist(true)">
                        🚪 Déconnecter AniList
                    </button>
                </div>
            </div>
            <button class="btn-anilist-nav" onclick="openAnimflixAuthModal('login')" style="margin-left: 6px;" title="Se connecter à un compte Animflix">
                👤 Connexion
            </button>
        `;
        return;
    }

    // CAS 3 : Totalement déconnecté
    container.innerHTML = `
        <button class="btn-anilist-nav" onclick="openAnimflixAuthModal('login')" title="Connexion ou création d'un compte Animflix">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
            <span>Mon Compte</span>
        </button>
    `;
}

// Exposer globalement pour l'interopérabilité
window.currentAnimflixUser = currentAnimflixUser;
window.initAnimflixAuth = initAnimflixAuth;
window.loginAnimflix = loginAnimflix;
window.registerAnimflix = registerAnimflix;
window.logoutAnimflix = logoutAnimflix;
window.linkAnilistToAnimflix = linkAnilistToAnimflix;
window.unlinkAnilistFromAnimflix = unlinkAnilistFromAnimflix;
window.openAnimflixAuthModal = openAnimflixAuthModal;
window.closeAnimflixAuthModal = closeAnimflixAuthModal;
window.switchAnimflixAuthTab = switchAnimflixAuthTab;
window.handleAnimflixAuthSubmit = handleAnimflixAuthSubmit;
window.renderUserAccountNav = renderUserAccountNav;
