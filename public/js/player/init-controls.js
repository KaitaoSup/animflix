    // --- MINIATURES DE PRÉVISUALISATION TIMELINE (VISUAL SCRUBBING CACHE) ---
    let thumbHoverTimer = null;
    let lastRequestedThumbKey = null;
    const loadedThumbnailUrls = new Set();

    // Initialisation du lecteur vidéo et de sa barre interactive
    function initCustomPlayerControls() {
        const video = document.getElementById('videoPlayer');
        const wrapper = document.getElementById('playerVideoWrapper');
        const scrubberContainer = document.getElementById('playerScrubberContainer');
        const scrubberTrack = document.getElementById('playerScrubberTrack');
        const scrubberProgress = document.getElementById('playerScrubberProgress');
        const scrubberTooltip = document.getElementById('playerScrubberTooltip');
        const playIcon = document.getElementById('customPlayIcon');
        const volumeSlider = document.getElementById('customVolumeSlider');

        if (!video || !wrapper) return;

        // 1. Progression continue et affichage
        video.addEventListener('timeupdate', updatePlayerProgress);

        // 2. Événements Play / Pause
        video.addEventListener('play', () => {
            if (playIcon) playIcon.textContent = '❚❚';
            resetControlsTimer();
        });
        video.addEventListener('pause', () => {
            if (playIcon) playIcon.textContent = '▶';
            showControls();
        });

        // 3. GESTES TACTILES MOBILE (DOUBLE-TAP SEEK -10S / +10S & CONTRÔLES)
        let lastTouchTime = 0;
        let lastTouchSide = null;
        let touchSeekAccumulated = 0;
        let touchSeekTimer = null;
        let singleTapTimer = null;
        let touchStartX = 0;
        let touchStartY = 0;
        let isTouchMoving = false;
        let lastTouchTimestamp = 0;

        function showTouchSeekFeedback(side, seconds) {
            const overlayLeft = document.getElementById('touchSeekOverlayLeft');
            const overlayRight = document.getElementById('touchSeekOverlayRight');
            const textLeft = document.getElementById('touchSeekTextLeft');
            const textRight = document.getElementById('touchSeekTextRight');

            if (touchSeekTimer) {
                clearTimeout(touchSeekTimer);
                touchSeekTimer = null;
            }

            if (side === 'left' && overlayLeft && textLeft) {
                textLeft.textContent = `-${seconds}s`;
                if (overlayRight) overlayRight.classList.remove('active');
                overlayLeft.classList.remove('active');
                void overlayLeft.offsetWidth; // Forcer le reflow CSS
                overlayLeft.classList.add('active');
            } else if (side === 'right' && overlayRight && textRight) {
                textRight.textContent = `+${seconds}s`;
                if (overlayLeft) overlayLeft.classList.remove('active');
                overlayRight.classList.remove('active');
                void overlayRight.offsetWidth; // Forcer le reflow CSS
                overlayRight.classList.add('active');
            }

            touchSeekTimer = setTimeout(() => {
                if (overlayLeft) overlayLeft.classList.remove('active');
                if (overlayRight) overlayRight.classList.remove('active');
                touchSeekAccumulated = 0;
                lastTouchSide = null;
            }, 650);
        }

        let controlsWereHiddenAtTouchStart = false;

        video.addEventListener('touchstart', (e) => {
            lastTouchTimestamp = Date.now();
            isTouchMoving = false;
            // Mémorise si les contrôles étaient masqués au moment du toucher
            controlsWereHiddenAtTouchStart = wrapper ? wrapper.classList.contains('hide-controls') : false;
            if (e.touches && e.touches[0]) {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
            }
        }, { passive: true });

        video.addEventListener('touchmove', (e) => {
            if (e.touches && e.touches[0]) {
                const diffX = Math.abs(e.touches[0].clientX - touchStartX);
                const diffY = Math.abs(e.touches[0].clientY - touchStartY);
                if (diffX > 15 || diffY > 15) {
                    isTouchMoving = true;
                }
            }
        }, { passive: true });

        video.addEventListener('touchend', (e) => {
            lastTouchTimestamp = Date.now();
            if (isTouchMoving) return;

            const now = Date.now();
            const rect = video.getBoundingClientRect();
            const clientX = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : touchStartX;
            const ratio = (clientX - rect.left) / rect.width;
            const side = ratio < 0.35 ? 'left' : (ratio > 0.65 ? 'right' : 'center');

            const timeDiff = now - lastTouchTime;

            // Détection du double-tap ou multi-tap successif (dans les 340ms)
            if (timeDiff < 340 && (lastTouchSide === side || (lastTouchSide && lastTouchSide !== 'center' && side !== 'center'))) {
                if (singleTapTimer) {
                    clearTimeout(singleTapTimer);
                    singleTapTimer = null;
                }

                const activeSide = (lastTouchSide && lastTouchSide !== 'center' && side !== 'center') ? lastTouchSide : side;

                if (activeSide === 'left') {
                    touchSeekAccumulated = (touchSeekAccumulated > 0) ? touchSeekAccumulated + 10 : 10;
                    jumpSeekRelative(-10);
                    showTouchSeekFeedback('left', touchSeekAccumulated);
                } else if (activeSide === 'right') {
                    touchSeekAccumulated = (touchSeekAccumulated > 0) ? touchSeekAccumulated + 10 : 10;
                    jumpSeekRelative(10);
                    showTouchSeekFeedback('right', touchSeekAccumulated);
                } else if (activeSide === 'center') {
                    touchSeekAccumulated = 0;
                    toggleCustomPlayPause();
                }

                lastTouchTime = now;
                lastTouchSide = activeSide;
                return;
            }

            // Premier tap enregistré -> attendre pour confirmer s'il s'agit d'un simple tap
            lastTouchTime = now;
            lastTouchSide = side;

            if (singleTapTimer) clearTimeout(singleTapTimer);
            singleTapTimer = setTimeout(() => {
                singleTapTimer = null;
                // Si les contrôles étaient cachés lors du tap -> les afficher et les laisser 4.5s
                if (controlsWereHiddenAtTouchStart) {
                    showControls();
                    resetControlsTimer(4500);
                } else {
                    // Si les contrôles étaient déjà visibles -> le tap simple les masque immédiatement
                    wrapper.classList.add('hide-controls');
                    if (controlsHideTimeout) {
                        clearTimeout(controlsHideTimeout);
                        controlsHideTimeout = null;
                    }
                }
                touchSeekAccumulated = 0;
                lastTouchSide = null;
            }, 260);
        });

        // 4. Clic souris (Desktop) : clic simple = Play/Pause, double-clic = Plein écran
        let clickTimeout = null;
        video.addEventListener('click', (e) => {
            e.stopPropagation();
            // Ignorer les clics émulés consécutifs à un toucher tactile mobile
            if (Date.now() - lastTouchTimestamp < 500) {
                return;
            }

            if (clickTimeout) {
                clearTimeout(clickTimeout);
                clickTimeout = null;
                togglePlayerFullscreen();
            } else {
                clickTimeout = setTimeout(() => {
                    clickTimeout = null;
                    toggleCustomPlayPause();
                }, 220);
            }
        });

        // Empêcher les clics sur l'overlay de contrôle d'interférer avec le double-tap du lecteur
        const customPlayerOverlay = document.getElementById('customPlayerOverlay');
        if (customPlayerOverlay) {
            customPlayerOverlay.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                resetControlsTimer(4500);
            }, { passive: true });
            customPlayerOverlay.addEventListener('click', (e) => {
                e.stopPropagation();
                resetControlsTimer(4500);
            });
        }

        // Fermeture de la carte HUD P2P au clic à l'extérieur
        document.addEventListener('click', (e) => {
            const card = document.getElementById('playerP2pHudCard');
            const btn = document.getElementById('playerP2pBtn');
            if (card && card.style.display === 'block') {
                if (!card.contains(e.target) && (!btn || !btn.contains(e.target))) {
                    card.style.display = 'none';
                    if (btn) btn.classList.remove('active');
                    isP2pHudOpen = false;
                }
            }
        });

        // 5. Disparition auto des contrôles
        wrapper.addEventListener('mousemove', () => resetControlsTimer(4000));
        wrapper.addEventListener('mouseleave', () => {
            if (!video.paused && !isScrubbing) {
                wrapper.classList.add('hide-controls');
            }
        });

        // 5. Timeline Scrubber interactif (clic, glisser-déposer fluide & miniatures au survol)
        if (scrubberContainer && scrubberTrack) {
            function getRatio(e) {
                let clientX = e.clientX;
                if (e.touches && e.touches.length > 0) {
                    clientX = e.touches[0].clientX;
                } else if (e.changedTouches && e.changedTouches.length > 0) {
                    clientX = e.changedTouches[0].clientX;
                }
                const rect = scrubberTrack.getBoundingClientRect();
                if (!rect.width) return 0;
                return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            }

            function updateScrubVisual(ratio) {
                const pct = ratio * 100;
                if (scrubberProgress) scrubberProgress.style.width = pct + '%';
                const targetSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));
                const curLabel = document.getElementById('playerDisplayCurrent');
                if (curLabel) curLabel.textContent = formatTimestamp(targetSec);
            }

            function updateTooltip(e) {
                if (!scrubberTooltip) return;
                let clientX = e.clientX;
                if (e.touches && e.touches.length > 0) {
                    clientX = e.touches[0].clientX;
                } else if (e.changedTouches && e.changedTouches.length > 0) {
                    clientX = e.changedTouches[0].clientX;
                }
                const rect = scrubberTrack.getBoundingClientRect();
                if (!rect.width) return;
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const hoverSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));

                const timeTextEl = document.getElementById('playerScrubberTimeText');
                const thumbWrapEl = document.getElementById('playerScrubberThumbWrap');
                const thumbImgEl = document.getElementById('playerScrubberThumbImg');
                const chapterBadgeEl = document.getElementById('playerScrubberChapterBadge');

                if (timeTextEl) {
                    timeTextEl.textContent = formatTimestamp(hoverSec);
                } else {
                    scrubberTooltip.textContent = formatTimestamp(hoverSec);
                }

                // Détection si le curseur survole l'Opening ou l'Ending AniSkip
                if (chapterBadgeEl) {
                    const op = currentAniSkipIntervals?.op;
                    const ed = currentAniSkipIntervals?.ed;
                    if (op && hoverSec >= op.startTime && hoverSec <= op.endTime) {
                        chapterBadgeEl.textContent = '⏭️ OPENING';
                        chapterBadgeEl.style.display = 'inline-block';
                        chapterBadgeEl.style.background = 'rgba(245, 158, 11, 0.92)';
                        chapterBadgeEl.style.color = '#000';
                    } else if (ed && hoverSec >= ed.startTime && hoverSec <= ed.endTime) {
                        chapterBadgeEl.textContent = '⏭️ ENDING';
                        chapterBadgeEl.style.display = 'inline-block';
                        chapterBadgeEl.style.background = 'rgba(56, 189, 248, 0.92)';
                        chapterBadgeEl.style.color = '#000';
                    } else {
                        chapterBadgeEl.style.display = 'none';
                    }
                }

                // Chargement de la miniature 16:9 par paliers de 5 secondes
                if (currentActiveMagnet && thumbWrapEl && thumbImgEl) {
                    const bucket = Math.max(0, Math.floor(hoverSec / 5) * 5);
                    const clientId = getOrCreateClientId();
                    const thumbUrl = `/api/thumbnail?magnet=${encodeURIComponent(currentActiveMagnet)}&fileIndex=${encodeURIComponent(currentActiveFileIndex)}&t=${bucket}&clientId=${encodeURIComponent(clientId)}`;
                    const thumbKey = `${currentActiveMagnet}_${currentActiveFileIndex}_${bucket}`;

                    if (loadedThumbnailUrls.has(thumbUrl)) {
                        if (thumbImgEl.dataset.currentUrl !== thumbUrl) {
                            thumbImgEl.src = thumbUrl;
                            thumbImgEl.dataset.currentUrl = thumbUrl;
                        }
                        thumbWrapEl.style.display = 'block';
                        scrubberTooltip.classList.add('has-thumb');
                    } else if (lastRequestedThumbKey !== thumbKey) {
                        if (thumbHoverTimer) clearTimeout(thumbHoverTimer);
                        thumbHoverTimer = setTimeout(() => {
                            lastRequestedThumbKey = thumbKey;
                            const preload = new Image();
                            preload.onload = () => {
                                loadedThumbnailUrls.add(thumbUrl);
                                thumbImgEl.src = thumbUrl;
                                thumbImgEl.dataset.currentUrl = thumbUrl;
                                thumbWrapEl.style.display = 'block';
                                scrubberTooltip.classList.add('has-thumb');
                            };
                            preload.src = thumbUrl;
                        }, 110);
                    }
                }

                const halfTooltip = thumbWrapEl && thumbWrapEl.style.display !== 'none' ? 90 : 28;
                const offsetLeft = Math.max(halfTooltip, Math.min(rect.width - halfTooltip, clientX - rect.left));
                scrubberTooltip.style.left = offsetLeft + 'px';
                scrubberTooltip.style.display = 'flex';
            }

            scrubberContainer.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                isScrubbing = true;
                scrubberContainer.classList.add('scrubbing');
                const ratio = getRatio(e);
                updateScrubVisual(ratio);
                updateTooltip(e);
            });

            scrubberContainer.addEventListener('mousemove', (e) => {
                if (!isScrubbing) {
                    updateTooltip(e);
                }
            });

            scrubberContainer.addEventListener('mouseleave', () => {
                if (thumbHoverTimer) {
                    clearTimeout(thumbHoverTimer);
                    thumbHoverTimer = null;
                }
                if (!isScrubbing && scrubberTooltip) {
                    scrubberTooltip.style.display = 'none';
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (isScrubbing) {
                    e.preventDefault();
                    resetControlsTimer();
                    const ratio = getRatio(e);
                    updateScrubVisual(ratio);
                    updateTooltip(e);
                }
            });

            window.addEventListener('mouseup', (e) => {
                if (isScrubbing) {
                    isScrubbing = false;
                    scrubberContainer.classList.remove('scrubbing');
                    if (scrubberTooltip) scrubberTooltip.style.display = 'none';
                    const ratio = getRatio(e);
                    const targetSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));
                    seekVideoTo(targetSec);
                }
            });

            scrubberContainer.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // Touch events pour tablettes et mobiles
            scrubberContainer.addEventListener('touchstart', (e) => {
                isScrubbing = true;
                scrubberContainer.classList.add('scrubbing');
                const ratio = getRatio(e);
                updateScrubVisual(ratio);
                updateTooltip(e);
            }, { passive: true });

            window.addEventListener('touchmove', (e) => {
                if (isScrubbing) {
                    resetControlsTimer();
                    const ratio = getRatio(e);
                    updateScrubVisual(ratio);
                    updateTooltip(e);
                }
            }, { passive: true });

            window.addEventListener('touchend', (e) => {
                if (isScrubbing) {
                    isScrubbing = false;
                    scrubberContainer.classList.remove('scrubbing');
                    if (scrubberTooltip) scrubberTooltip.style.display = 'none';
                    const ratio = getRatio(e);
                    const targetSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));
                    seekVideoTo(targetSec);
                }
            });
        }

        if (volumeSlider) {
            volumeSlider.value = video.volume;
        }
    }

