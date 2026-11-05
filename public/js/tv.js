/**
 * =========================================================================
 * ANIMFLIX - MODULE 10-FOOT UI, NAVIGATION SPATIALE & GAMEPAD API
 * =========================================================================
 * Fournit une expérience téléviseur complète optimisée pour la navigation
 * par télécommande TV (D-Pad, touches multimédia) et manettes de jeu (Gamepad API).
 */

(function () {
    'use strict';

    // Constantes de stockage et états
    const STORAGE_KEY_TV_MODE = 'animflix_tv_mode';
    let isTvModeActive = false;
    let isFocusActive = false;
    let currentFocusedElement = null;
    let cursorHideTimeout = null;

    // État de la manette (Gamepad)
    let gamepadLoopId = null;
    let lastGamepadAxesTime = 0;
    let lastGamepadButtonStates = {};
    const AXIS_DEADZONE = 0.45;
    const REPEAT_INITIAL_DELAY = 300; // ms
    const REPEAT_CONTINUOUS_RATE = 120; // ms

    // HUD Gamepad timer
    let hudHideTimeout = null;

    /**
     * Détecte si le terminal actuel est un téléviseur connecté (Android TV, Tizen, WebOS, etc.)
     */
    function isTvEnvironment() {
        const ua = navigator.userAgent || '';
        return /Android TV|SmartTV|GoogleTV|AppleTV|Tizen|Web0S|CrKey|HbbTV|BRAVIA|NetCast|POV_TV/i.test(ua);
    }

    /**
     * Initialisation du mode TV et de la navigation spatiale
     */
    function initTvModule() {
        const savedPref = localStorage.getItem(STORAGE_KEY_TV_MODE);
        const shouldEnable = savedPref === 'enabled' || (savedPref !== 'disabled' && isTvEnvironment());

        if (shouldEnable) {
            enableTvMode(false);
        }

        // Écoute des touches télécommande et clavier
        window.addEventListener('keydown', handleTvKeyDown, { capture: true });

        // Détection de l'utilisation de la souris pour masquer/afficher le curseur
        window.addEventListener('mousemove', handleUserMouseMove);

        // API Gamepad (Manettes USB & Bluetooth)
        window.addEventListener('gamepadconnected', onGamepadConnected);
        window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

        // Si des manettes sont déjà branchées au démarrage
        const initialGamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < initialGamepads.length; i++) {
            if (initialGamepads[i]) {
                onGamepadConnected({ gamepad: initialGamepads[i] });
                break;
            }
        }

        // Mettre à jour le bouton de navbar si présent
        updateTvNavButton();
    }

    /**
     * Active le mode TV ("10-foot UI")
     */
    function enableTvMode(persist = true) {
        isTvModeActive = true;
        document.body.classList.add('tv-mode');
        document.body.classList.add('tv-focus-active');
        isFocusActive = true;

        if (persist) {
            localStorage.setItem(STORAGE_KEY_TV_MODE, 'enabled');
        }

        updateTvNavButton();
        if (typeof showToast === 'function' && persist) {
            showToast("📺 Mode TV & Canapé activé !");
        }

        // Si aucun focus actif, placer le focus sur le premier élément pertinent
        setTimeout(() => {
            if (!currentFocusedElement || !document.contains(currentFocusedElement)) {
                focusInitialElement();
            }
        }, 150);
    }

    /**
     * Désactive le mode TV
     */
    function disableTvMode(persist = true) {
        isTvModeActive = false;
        document.body.classList.remove('tv-mode');
        document.body.classList.remove('cursor-hidden');

        if (persist) {
            localStorage.setItem(STORAGE_KEY_TV_MODE, 'disabled');
        }

        updateTvNavButton();
        if (typeof showToast === 'function' && persist) {
            showToast("🖥️ Mode Bureau / Tactile classique rétabli.");
        }
    }

    /**
     * Bascule l'état du mode TV
     */
    function toggleTvMode() {
        if (isTvModeActive) {
            disableTvMode(true);
        } else {
            enableTvMode(true);
        }
    }

    /**
     * Met à jour le style du bouton Mode TV dans la barre de navigation
     */
    function updateTvNavButton() {
        const btn = document.getElementById('tvModeNavBtn');
        if (btn) {
            if (isTvModeActive) {
                btn.classList.add('active');
                btn.title = "Mode TV Actif (Cliquer pour désactiver)";
            } else {
                btn.classList.remove('active');
                btn.title = "Activer le Mode Téléviseur (10-foot UI)";
            }
        }

        const prefSelect = document.getElementById('prefTvMode');
        if (prefSelect) {
            const savedPref = localStorage.getItem(STORAGE_KEY_TV_MODE) || 'auto';
            prefSelect.value = savedPref;
        }
    }

    /**
     * Gestion du paramètre depuis la modale Réglages
     */
    function onTvModePrefChange(value) {
        localStorage.setItem(STORAGE_KEY_TV_MODE, value);
        if (value === 'enabled') {
            enableTvMode(false);
        } else if (value === 'disabled') {
            disableTvMode(false);
        } else {
            if (isTvEnvironment()) {
                enableTvMode(false);
            } else {
                disableTvMode(false);
            }
        }
    }

    /**
     * Gestion de l'inactivité souris pour masquer le curseur sur TV
     */
    function handleUserMouseMove() {
        if (!isTvModeActive) return;
        document.body.classList.remove('cursor-hidden');
        clearTimeout(cursorHideTimeout);
        cursorHideTimeout = setTimeout(() => {
            if (isTvModeActive) {
                document.body.classList.add('cursor-hidden');
            }
        }, 2500);
    }

    // =========================================================================
    // --- MOTEUR DE NAVIGATION SPATIALE (D-PAD & FLÈCHES DIRECTIONNELLES) ---
    // =========================================================================

    /**
     * Récupère la liste des éléments interactifs visibles
     */
    function getFocusableElements() {
        // 1. Vérifier si une modale overlay est ouverte (le dialogue de confirmation passe devant tout)
        const uiDialog = document.getElementById('uiDialogOverlay');
        if (uiDialog) {
            return Array.from(uiDialog.querySelectorAll('button')).filter(el => isElementVisible(el));
        }
        const activeModal = document.querySelector('.anilist-modal-overlay[style*="display: flex"], .anilist-modal-overlay[style*="display: block"]');
        if (activeModal) {
            return Array.from(activeModal.querySelectorAll('button, input, select, textarea, a, [tabindex="0"]'))
                .filter(el => isElementVisible(el) && !el.disabled);
        }

        // 2. Vérifier si la vue détail / lecteur est ouverte
        const detailView = document.getElementById('detailView');
        if (detailView && detailView.style.display !== 'none') {
            const video = document.getElementById('videoPlayer');
            const isPlaying = video && !video.paused;

            // Si la vidéo joue et les contrôles personnalisés sont actifs
            const selectors = [
                '.btn-back',
                '#detailFavoriteBtn',
                '.btn-play-custom',
                '.player-btn',
                '#playerScrubberTrack',
                '#customVolumeSlider',
                '#customPlayerQualitySelect',
                '#customPlayerSubSelect',
                '#customPlayerAudioSelect',
                '.torrent-item',
                '.file-row',
                '.btn-download-file',
                '.btn-open-folder'
            ];

            return Array.from(detailView.querySelectorAll(selectors.join(',')))
                .filter(el => isElementVisible(el) && !el.disabled);
        }

        // 3. Vue catalogue / accueil normale
        const generalSelectors = [
            '#searchInput',
            '#searchType',
            '#streamMode',
            '.search-box button',
            '#tvModeNavBtn',
            '#pwaInstallBtn',
            '.btn-clean-cache',
            '.btn-settings-nav',
            '#anilistNavContainer button',
            '#anilistNavContainer a',
            '.home-tab-btn',
            '.filter-chip',
            '#searchSortSelect',
            '.card',
            '.calendar-card',
            '.resume-banner button',
            '#searchAnimeMatches button',
            '#animeView button',
            '#animeView select'
        ];

        return Array.from(document.querySelectorAll(generalSelectors.join(',')))
            .filter(el => isElementVisible(el) && !el.disabled);
    }

    /**
     * Vérifie si un élément est visible à l'écran
     */
    function isElementVisible(el) {
        if (!el || el.offsetParent === null) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * Focus l'élément initial de l'écran
     */
    function focusInitialElement() {
        const focusables = getFocusableElements();
        if (focusables.length === 0) return;

        // Privilégier les cartes d'animes, ou les onglets d'accueil, ou la barre de recherche
        const activeTab = document.querySelector('.home-tab-btn.active');
        const firstCard = document.querySelector('.card');
        const searchInput = document.getElementById('searchInput');

        const target = firstCard || activeTab || searchInput || focusables[0];
        setTvFocus(target);
    }

    /**
     * Applique le focus TV sur un élément spécifique
     */
    function setTvFocus(element) {
        if (!element) return;

        if (currentFocusedElement && currentFocusedElement !== element) {
            currentFocusedElement.classList.remove('tv-focused');
        }

        currentFocusedElement = element;
        element.classList.add('tv-focused');
        document.body.classList.add('tv-focus-active');
        isFocusActive = true;

        // Donner le focus natif pour les lecteurs d'écran et formulaires
        if (typeof element.focus === 'function') {
            try {
                element.focus({ preventScroll: true });
            } catch (e) {}
        }

        // Faire défiler doucement dans la vue
        element.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest'
        });

        // Si nous sommes dans le lecteur vidéo, réafficher temporairement les contrôles
        const detailView = document.getElementById('detailView');
        if (detailView && detailView.style.display !== 'none' && typeof window.showCustomPlayerControlsTemporarily === 'function') {
            window.showCustomPlayerControlsTemporarily();
        }
    }

    /**
     * Algorithme de navigation spatiale dans une direction géométrique
     */
    function navigateSpatial(direction) {
        const focusables = getFocusableElements();
        if (focusables.length === 0) return;

        if (!currentFocusedElement || !isElementVisible(currentFocusedElement) || !document.contains(currentFocusedElement)) {
            focusInitialElement();
            return;
        }

        const currRect = currentFocusedElement.getBoundingClientRect();
        const currCenterX = currRect.left + currRect.width / 2;
        const currCenterY = currRect.top + currRect.height / 2;

        let bestCandidate = null;
        let minScore = Infinity;

        focusables.forEach(target => {
            if (target === currentFocusedElement) return;

            const targetRect = target.getBoundingClientRect();
            const targetCenterX = targetRect.left + targetRect.width / 2;
            const targetCenterY = targetRect.top + targetRect.height / 2;

            const deltaX = targetCenterX - currCenterX;
            const deltaY = targetCenterY - currCenterY;

            let isCandidate = false;
            let primaryDist = 0;
            let secondaryDist = 0;

            if (direction === 'up') {
                if (deltaY < -4) {
                    isCandidate = true;
                    primaryDist = -deltaY;
                    secondaryDist = Math.abs(deltaX);
                }
            } else if (direction === 'down') {
                if (deltaY > 4) {
                    isCandidate = true;
                    primaryDist = deltaY;
                    secondaryDist = Math.abs(deltaX);
                }
            } else if (direction === 'left') {
                if (deltaX < -4) {
                    isCandidate = true;
                    primaryDist = -deltaX;
                    secondaryDist = Math.abs(deltaY);
                }
            } else if (direction === 'right') {
                if (deltaX > 4) {
                    isCandidate = true;
                    primaryDist = deltaX;
                    secondaryDist = Math.abs(deltaY);
                }
            }

            if (isCandidate) {
                // Pénalité géométrique pour privilégier l'alignement sur l'axe principal
                let score = primaryDist + (secondaryDist * 2.2);

                // Bonus si les éléments se chevauchent sur l'autre axe (alignement parfait)
                const hasHorizontalOverlap = (targetRect.left <= currRect.right && targetRect.right >= currRect.left);
                const hasVerticalOverlap = (targetRect.top <= currRect.bottom && targetRect.bottom >= currRect.top);

                if ((direction === 'up' || direction === 'down') && hasHorizontalOverlap) {
                    score *= 0.6;
                }
                if ((direction === 'left' || direction === 'right') && hasVerticalOverlap) {
                    score *= 0.6;
                }

                if (score < minScore) {
                    minScore = score;
                    bestCandidate = target;
                }
            }
        });

        if (bestCandidate) {
            setTvFocus(bestCandidate);
        }
    }

    /**
     * Déclenche l'action de validation sur l'élément focusé
     */
    function triggerFocusedAction() {
        if (!currentFocusedElement) return;

        // Si c'est un input ou textarea, donner le focus natif pour écriture
        if (currentFocusedElement.tagName === 'INPUT' || currentFocusedElement.tagName === 'TEXTAREA') {
            currentFocusedElement.focus();
            return;
        }

        // Sinon déclencher le clic
        if (typeof currentFocusedElement.click === 'function') {
            currentFocusedElement.click();
        }
    }

    /**
     * Gestion de la touche Retour (Télécommande TV / Touche Échap / Bouton B)
     */
    function handleTvBackAction() {
        // 0. Dialogue de confirmation : Retour = Annuler
        if (typeof isUiDialogOpen === 'function' && isUiDialogOpen()) {
            cancelUiDialog();
            return true;
        }

        // 1. Fermer les modales ouvertes
        const modals = [
            '#settingsModal',
            '#animflixAuthModal',
            '#anilistAuthModal',
            '#anilistSearchModal',
            '#addProfileModal',
            '#castModal'
        ];

        for (const sel of modals) {
            const m = document.querySelector(sel);
            if (m && (m.style.display === 'flex' || m.style.display === 'block')) {
                m.style.display = 'none';
                return true;
            }
        }

        // 2. Plein écran
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
            return true;
        }

        // 3. Vue détail / lecteur
        const detailView = document.getElementById('detailView');
        if (detailView && detailView.style.display !== 'none') {
            if (typeof window.closeDetailView === 'function') {
                window.closeDetailView();
                return true;
            }
        }

        // 4. Recherche active -> retour à l'accueil
        // 4. Fiche anime ou recherche -> page précédente (ou accueil)
        const animeView = document.getElementById('animeView');
        if (animeView && animeView.style.display !== 'none' && typeof AppRouter !== 'undefined') {
            AppRouter.back('/');
            return true;
        }
        const searchView = document.getElementById('searchView');
        if (searchView && searchView.style.display !== 'none') {
            if (typeof AppRouter !== 'undefined' && AppRouter.previousPath()) {
                AppRouter.back('/');
                return true;
            }
            if (typeof window.handleLogoClick === 'function') {
                window.handleLogoClick();
                return true;
            }
        }

        return false;
    }

    // =========================================================================
    // --- GESTIONNAIRE D'ÉVÉNEMENTS CLAVIER & TÉLÉCOMMANDE TV ---
    // =========================================================================

    function handleTvKeyDown(e) {
        // Ne pas bloquer la saisie dans un champ texte sauf pour les touches spéciales
        const isTextInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

        // Codes de télécommandes Android TV / Tizen / LG webOS
        const isBackKey = e.key === 'Escape' ||
                          e.key === 'BrowserBack' ||
                          e.key === 'GoBack' ||
                          e.keyCode === 27 ||
                          e.keyCode === 10009 || // Samsung Tizen Return
                          e.keyCode === 4;       // Android TV Back

        if (isBackKey) {
            const handled = handleTvBackAction();
            if (handled) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        // Touches multimédia TV
        if (e.key === 'MediaPlayPause' || e.key === 'PlayPause' || e.keyCode === 179) {
            e.preventDefault();
            if (typeof window.toggleCustomPlayPause === 'function') window.toggleCustomPlayPause();
            return;
        }
        if (e.key === 'MediaFastForward' || e.keyCode === 228) {
            e.preventDefault();
            if (typeof window.jumpSeekRelative === 'function') window.jumpSeekRelative(10);
            return;
        }
        if (e.key === 'MediaRewind' || e.keyCode === 227) {
            e.preventDefault();
            if (typeof window.jumpSeekRelative === 'function') window.jumpSeekRelative(-10);
            return;
        }
        if (e.key === 'MediaTrackNext' || e.keyCode === 176) {
            e.preventDefault();
            if (typeof window.playNextEpisodeAuto === 'function') window.playNextEpisodeAuto();
            return;
        }

        // Touches de navigation spatiale
        if (!isTextInput) {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigateSpatial('up');
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigateSpatial('down');
            } else if (e.key === 'ArrowLeft') {
                // Si la timeline est active, seek direct
                if (currentFocusedElement && currentFocusedElement.id === 'playerScrubberTrack') {
                    if (typeof window.jumpSeekRelative === 'function') window.jumpSeekRelative(-10);
                } else {
                    e.preventDefault();
                    navigateSpatial('left');
                }
            } else if (e.key === 'ArrowRight') {
                if (currentFocusedElement && currentFocusedElement.id === 'playerScrubberTrack') {
                    if (typeof window.jumpSeekRelative === 'function') window.jumpSeekRelative(10);
                } else {
                    e.preventDefault();
                    navigateSpatial('right');
                }
            } else if (e.key === 'Enter' || e.key === 'Select' || e.keyCode === 13) {
                if (!isTextInput) {
                    e.preventDefault();
                    triggerFocusedAction();
                }
            }
        }
    }

    // =========================================================================
    // --- GESTION DES MANETTES DE JEU (GAMEPAD API) ---
    // =========================================================================

    function onGamepadConnected(e) {
        showGamepadHud(`🎮 Manette connectée : ${e.gamepad.id.slice(0, 24)}...`);
        if (!gamepadLoopId) {
            startGamepadLoop();
        }
        // Activer automatiquement le focus visuel TV
        document.body.classList.add('tv-focus-active');
        if (!currentFocusedElement) {
            focusInitialElement();
        }
    }

    function onGamepadDisconnected(e) {
        showGamepadHud("🔌 Manette déconnectée");
        const remaining = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
        if (remaining.length === 0 && gamepadLoopId) {
            cancelAnimationFrame(gamepadLoopId);
            gamepadLoopId = null;
        }
    }

    function showGamepadHud(message) {
        let hud = document.getElementById('tvGamepadHud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'tvGamepadHud';
            hud.className = 'tv-gamepad-hud';
            hud.innerHTML = `
                <div><span class="tv-hud-badge">A</span> Valider</div>
                <div><span class="tv-hud-badge">B</span> Retour</div>
                <div><span class="tv-hud-badge">X</span> Lecture/Pause</div>
                <div><span class="tv-hud-badge">Y</span> Plein écran</div>
                <div><span class="tv-hud-badge">LB/RB</span> ±10s</div>
            `;
            document.body.appendChild(hud);
        }

        hud.classList.remove('hidden');
        clearTimeout(hudHideTimeout);
        hudHideTimeout = setTimeout(() => {
            hud.classList.add('hidden');
        }, 4500);
    }

    function startGamepadLoop() {
        function pollGamepads() {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            let activePad = null;
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i] && gamepads[i].connected) {
                    activePad = gamepads[i];
                    break;
                }
            }

            if (activePad) {
                processGamepadInput(activePad);
            }

            gamepadLoopId = requestAnimationFrame(pollGamepads);
        }

        gamepadLoopId = requestAnimationFrame(pollGamepads);
    }

    function processGamepadInput(pad) {
        const now = Date.now();

        // 1. D-Pad boutons (12: Haut, 13: Bas, 14: Gauche, 15: Droite)
        const btnUp = pad.buttons[12]?.pressed;
        const btnDown = pad.buttons[13]?.pressed;
        const btnLeft = pad.buttons[14]?.pressed;
        const btnRight = pad.buttons[15]?.pressed;

        // 2. Joystick gauche (Axes 0: X, 1: Y)
        const axisX = pad.axes[0] || 0;
        const axisY = pad.axes[1] || 0;

        let stickUp = axisY < -AXIS_DEADZONE;
        let stickDown = axisY > AXIS_DEADZONE;
        let stickLeft = axisX < -AXIS_DEADZONE;
        let stickRight = axisX > AXIS_DEADZONE;

        const wantUp = btnUp || stickUp;
        const wantDown = btnDown || stickDown;
        const wantLeft = btnLeft || stickLeft;
        const wantRight = btnRight || stickRight;

        const isNavigating = wantUp || wantDown || wantLeft || wantRight;

        if (isNavigating) {
            const elapsed = now - lastGamepadAxesTime;
            const threshold = (lastGamepadAxesTime === 0) ? REPEAT_INITIAL_DELAY : REPEAT_CONTINUOUS_RATE;

            if (elapsed > threshold) {
                lastGamepadAxesTime = now;
                if (wantUp) navigateSpatial('up');
                else if (wantDown) navigateSpatial('down');
                else if (wantLeft) navigateSpatial('left');
                else if (wantRight) navigateSpatial('right');
            }
        } else {
            lastGamepadAxesTime = 0;
        }

        // 3. Boutons d'action (A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, Select = 8, Start = 9)
        function handleBtnEdge(index, action) {
            const isPressed = pad.buttons[index]?.pressed;
            const wasPressed = !!lastGamepadButtonStates[index];
            if (isPressed && !wasPressed) {
                action();
            }
            lastGamepadButtonStates[index] = isPressed;
        }

        // Bouton A (Croix PS) : Valider / Clic
        handleBtnEdge(0, () => {
            triggerFocusedAction();
        });

        // Bouton B (Rond PS) : Retour / Annuler
        handleBtnEdge(1, () => {
            handleTvBackAction();
        });

        // Bouton X (Carré PS) : Lecture / Pause
        handleBtnEdge(2, () => {
            const detailView = document.getElementById('detailView');
            if (detailView && detailView.style.display !== 'none') {
                if (typeof window.toggleCustomPlayPause === 'function') window.toggleCustomPlayPause();
            } else {
                const searchInput = document.getElementById('searchInput');
                if (searchInput) searchInput.focus();
            }
        });

        // Bouton Y (Triangle PS) : Plein écran
        handleBtnEdge(3, () => {
            if (typeof window.toggleCustomFullscreen === 'function') {
                window.toggleCustomFullscreen();
            } else {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen().catch(() => {});
                }
            }
        });

        // LB (Bouton 4) : Reculer de 10s
        handleBtnEdge(4, () => {
            if (typeof window.jumpSeekRelative === 'function') window.jumpSeekRelative(-10);
        });

        // RB (Bouton 5) : Avancer de 10s
        handleBtnEdge(5, () => {
            if (typeof window.jumpSeekRelative === 'function') window.jumpSeekRelative(10);
        });

        // Start (Bouton 9) : Paramètres
        handleBtnEdge(9, () => {
            if (typeof window.toggleSettingsModal === 'function') window.toggleSettingsModal();
        });
    }

    // =========================================================================
    // --- EXPOSITION GLOBALE & AUTO-DÉMARRAGE ---
    // =========================================================================

    window.toggleTvMode = toggleTvMode;
    window.enableTvMode = enableTvMode;
    window.disableTvMode = disableTvMode;
    window.onTvModePrefChange = onTvModePrefChange;
    window.navigateSpatial = navigateSpatial;
    window.setTvFocus = setTvFocus;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTvModule);
    } else {
        initTvModule();
    }

})();
