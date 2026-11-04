    // Appel GraphQL via proxy interne
    async function callAnilistGraphQL(query, variables = {}) {
        const token = localStorage.getItem('anilist_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        const sessionToken = localStorage.getItem('animflix_auth_token');
        if (sessionToken) {
            headers['x-session-token'] = sessionToken;
        }
        const res = await fetch('/api/anilist/graphql', {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ query, variables })
        });
        const data = await res.json();
        if (!res.ok || data.errors) {
            const msg = data.errors?.[0]?.message || 'Erreur AniList';
            throw new Error(msg);
        }
        return data.data;
    }

    // Initialisation session AniList
    async function initAnilistSession() {
        if (typeof initAnimflixAuth === 'function') {
            try {
                await initAnimflixAuth();
            } catch(e) {}
        }
        checkUrlForAnilistToken();
        const token = localStorage.getItem('anilist_token');
        renderAnilistNav();
        renderHomeScreen();

        // Récupérer éventuel Client ID pré-configuré par le serveur
        fetch('/api/anilist/config')
            .then(r => r.json())
            .then(data => {
                if (data && data.clientId && !localStorage.getItem('anilist_client_id')) {
                    localStorage.setItem('anilist_client_id', data.clientId);
                }
            })
            .catch(() => {});

        if (!token) {
            renderHomeScreen();
            return;
        }

        try {
            const query = `
                query {
                    Viewer {
                        id
                        name
                        avatar { large medium }
                        siteUrl
                        options {
                            displayAdultContent
                        }
                    }
                }
            `;
            const data = await callAnilistGraphQL(query);
            if (data && data.Viewer) {
                currentAnilistUser = data.Viewer;
                localStorage.setItem('anilist_user', JSON.stringify(currentAnilistUser));
                renderAnilistNav();
            }
        } catch(err) {
            console.warn("AniList session validation:", err.message);
            if (err.message && (err.message.toLowerCase().includes('token') || err.message.toLowerCase().includes('auth'))) {
                logoutAnilist(false);
                showToast("⚠️ Votre session AniList a expiré.");
                return;
            }
        }

        await loadAnilistWatchingList();
    }

    // Récupération automatique du token OAuth dans le hash de l'URL (#access_token=...)
    function checkUrlForAnilistToken() {
        const hash = window.location.hash;
        if (hash && hash.includes('access_token=')) {
            const params = new URLSearchParams(hash.substring(1));
            const token = params.get('access_token');
            if (token) {
                localStorage.setItem('anilist_token', token);
                history.replaceState(null, '', window.location.pathname + window.location.search);
                if (typeof linkAnilistToAnimflix === 'function' && window.currentAnimflixUser) {
                    linkAnilistToAnimflix(token, true);
                } else {
                    showToast("🎉 Connecté avec succès à AniList !");
                }
                return true;
            }
        }
        return false;
    }

    function toggleAnilistDropdown(e) {
        if (e) e.stopPropagation();
        const badge = document.getElementById('anilistUserBadge');
        if (badge) {
            badge.classList.toggle('active');
        }
    }

    // Rendu du composant de profil ou connexion dans la barre de navigation
    function renderAnilistNav() {
        if (typeof renderUserAccountNav === 'function') {
            renderUserAccountNav();
            return;
        }
        const container = document.getElementById('anilistNavContainer');
        if (!container) return;

        const token = localStorage.getItem('anilist_token');
        if (token && currentAnilistUser) {
            const avatarUrl = currentAnilistUser.avatar?.medium || currentAnilistUser.avatar?.large || 'https://anilist.co/img/icons/icon.svg';
            const showNsfw = getShowNsfwPreference();
            container.innerHTML = `
                <div id="anilistUserBadge" class="anilist-user-badge" onclick="toggleAnilistDropdown(event)" tabindex="0" title="Connecté à AniList : ${escapeHtml(currentAnilistUser.name)}">
                    <img class="anilist-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(currentAnilistUser.name)}" onerror="this.src='https://anilist.co/img/icons/icon.svg'">
                    <span class="anilist-username">${escapeHtml(currentAnilistUser.name)}</span>
                    <span style="font-size: 10px; color: #888;">▼</span>
                    <div class="anilist-dropdown" onclick="event.stopPropagation()">
                        <div style="padding: 4px 10px 8px; border-bottom: 1px solid #23374d; margin-bottom: 6px;">
                            <div style="font-size: 11px; color: #888;">Bienvenue</div>
                            <div style="font-weight: bold; color: #02a9ff; font-size: 13.5px;">${escapeHtml(currentAnilistUser.name)} 👋</div>
                        </div>
                        <div class="anilist-dropdown-nsfw" onclick="toggleNsfwFilter(!getShowNsfwPreference())">
                            <span style="font-size: 12px; font-weight: 600;">🔞 Contenu 18+</span>
                            <label class="switch-nsfw" onclick="event.stopPropagation()">
                                <input type="checkbox" id="nsfwDropdownToggle" ${showNsfw ? 'checked' : ''} onchange="toggleNsfwFilter(this.checked)">
                                <span class="slider-nsfw"></span>
                            </label>
                        </div>
                        <a href="${escapeHtml(currentAnilistUser.siteUrl || 'https://anilist.co')}" target="_blank" rel="noopener">
                            🔗 Profil AniList
                        </a>
                        <button onclick="logoutAnilist(true)">
                            🚪 Se déconnecter
                        </button>
                    </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <button class="btn-anilist-nav" onclick="openAnilistAuthModal()" title="Connecter votre compte AniList">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z"/>
                    </svg>
                    <span>Connexion AniList</span>
                </button>
            `;
        }
    }

    // Gestion de la modale d'authentification
    function openAnilistAuthModal() {
        const modal = document.getElementById('anilistAuthModal');
        if (!modal) return;
        const clientIdInput = document.getElementById('anilistClientIdInput');
        const redirectHint = document.getElementById('anilistRedirectUrlHint');
        if (redirectHint) redirectHint.innerText = window.location.origin;
        if (clientIdInput) {
            clientIdInput.value = localStorage.getItem('anilist_client_id') || '';
        }
        modal.style.display = 'flex';
    }

    function closeAnilistAuthModal() {
        const modal = document.getElementById('anilistAuthModal');
        if (modal) modal.style.display = 'none';
    }

    function loginWithAnilistOAuth() {
        const clientId = document.getElementById('anilistClientIdInput').value.trim();
        if (!clientId) {
            showToast("⚠️ Veuillez entrer un Client ID AniList.");
            return;
        }
        localStorage.setItem('anilist_client_id', clientId);
        const oauthUrl = `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token`;
        window.location.href = oauthUrl;
    }

    async function saveAnilistTokenManual() {
        const token = document.getElementById('anilistTokenInput').value.trim();
        if (!token) {
            showToast("⚠️ Veuillez renseigner un jeton d'accès.");
            return;
        }
        localStorage.setItem('anilist_token', token);
        showToast("Vérification du compte AniList... ⏳");
        try {
            const query = `query { Viewer { id name avatar { large medium } siteUrl options { displayAdultContent } } }`;
            const data = await callAnilistGraphQL(query);
            if (data && data.Viewer) {
                currentAnilistUser = data.Viewer;
                localStorage.setItem('anilist_user', JSON.stringify(currentAnilistUser));
                if (typeof linkAnilistToAnimflix === 'function' && window.currentAnimflixUser) {
                    linkAnilistToAnimflix(token, false).catch(() => {});
                }
                closeAnilistAuthModal();
                renderAnilistNav();
                renderHomeScreen();
                await loadAnilistWatchingList(true);
                if (currentAnimeItem) syncAnilistForDetail(currentAnimeItem);
                showToast(`🎉 Bienvenue ${currentAnilistUser.name} !`);
            }
        } catch(err) {
            localStorage.removeItem('anilist_token');
            showToast("❌ Jeton invalide : " + err.message);
        }
    }

    function logoutAnilist(notify = true) {
        localStorage.removeItem('anilist_token');
        localStorage.removeItem('anilist_user');
        localStorage.removeItem('anilist_watching_cache');
        currentAnilistUser = null;
        currentAnilistMedia = null;
        anilistWatchingList = [];
        renderAnilistNav();
        renderHomeScreen();
        if (currentAnimeItem) renderAnilistDetailCard();
        updatePlayerTrackButton();
        if (notify) showToast("🚪 Vous êtes déconnecté d'AniList.");
    }

