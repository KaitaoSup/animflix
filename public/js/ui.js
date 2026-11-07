// =========================================================================
// --- ANIMFLIX UI KIT : DIALOGUES, SQUELETTES DE CHARGEMENT, AFFICHES DE REPLI ---
// =========================================================================

// Affiche de repli locale (SVG en data-URI) : aucune dépendance à un service externe
function posterFallback(name) {
    const label = String(name || 'Anime').trim();
    const initials = label.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'A';
    const safe = initials.replace(/[<>&"']/g, '');
    // Image en data-URI : les variables CSS n'y sont pas résolues, on y inscrit la couleur du thème
    const accent = (typeof getThemeColor === 'function') ? getThemeColor() : '#e50914';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.12"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>` +
        `<rect width="300" height="450" fill="#141414"/><rect width="300" height="450" fill="url(#g)"/>` +
        `<text x="150" y="245" font-family="Segoe UI,Roboto,Arial,sans-serif" font-size="96" font-weight="800" fill="${accent}" fill-opacity="0.55" text-anchor="middle">${safe}</text>` +
        `</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Attribut onerror prêt à insérer dans un template HTML (évite les boucles si le repli échoue)
function posterOnErrorAttr(name) {
    return `onerror="this.onerror=null;this.src=posterFallback(${jsArg(name || 'Anime')})"`;
}

// --- SQUELETTES DE CHARGEMENT ---

function renderSkeletonCards(count = 12) {
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
            <div class="card skeleton-card" aria-hidden="true">
                <div class="skeleton-block skeleton-poster"></div>
                <div class="card-info">
                    <div class="skeleton-block skeleton-line"></div>
                    <div class="skeleton-block skeleton-line skeleton-line-short"></div>
                </div>
            </div>`;
    }
    return html;
}

// Grille complète (pour un conteneur qui n'est pas déjà une .grid)
function renderSkeletonGrid(count = 12, label = 'Chargement…') {
    return `<div class="grid skeleton-grid" role="status" aria-label="${escapeHtml(label)}">${renderSkeletonCards(count)}</div>`;
}

// --- DIALOGUES (REMPLACENT alert / confirm NATIFS) ---

let activeUiDialog = null;

function closeUiDialog(result) {
    if (!activeUiDialog) return;
    const { overlay, resolve, previousFocus, onKey } = activeUiDialog;
    activeUiDialog = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    resolve(result);
}

function openUiDialog({ title, message, okLabel = 'OK', cancelLabel = null, danger = false }) {
    // Un seul dialogue à la fois : le précédent est considéré comme annulé
    if (activeUiDialog) closeUiDialog(false);

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'uiDialogOverlay';
        overlay.className = 'anilist-modal-overlay ui-dialog-overlay';
        overlay.style.display = 'flex';

        const titleId = 'uiDialogTitle';
        const msgId = 'uiDialogMessage';
        const messageHtml = escapeHtml(message || '').replace(/\n/g, '<br>');
        overlay.innerHTML = `
            <div class="ui-dialog" role="${cancelLabel ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${msgId}">
                <h3 id="${titleId}" class="ui-dialog-title">${escapeHtml(title || 'Animflix')}</h3>
                <p id="${msgId}" class="ui-dialog-message">${messageHtml}</p>
                <div class="ui-dialog-actions">
                    ${cancelLabel ? `<button type="button" class="btn-secondary ui-dialog-cancel">${escapeHtml(cancelLabel)}</button>` : ''}
                    <button type="button" class="ui-dialog-ok ${danger ? 'ui-dialog-danger' : ''}">${escapeHtml(okLabel)}</button>
                </div>
            </div>`;

        const okBtn = overlay.querySelector('.ui-dialog-ok');
        const cancelBtn = overlay.querySelector('.ui-dialog-cancel');
        okBtn.addEventListener('click', () => closeUiDialog(true));
        if (cancelBtn) cancelBtn.addEventListener('click', () => closeUiDialog(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeUiDialog(false); });

        // Échap = annuler, Tab reste piégé dans le dialogue
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeUiDialog(false);
            } else if (e.key === 'Tab') {
                const focusables = [cancelBtn, okBtn].filter(Boolean);
                const idx = focusables.indexOf(document.activeElement);
                e.preventDefault();
                const next = e.shiftKey ? (idx <= 0 ? focusables.length - 1 : idx - 1) : (idx + 1) % focusables.length;
                focusables[next].focus();
            }
        };

        activeUiDialog = { overlay, resolve, previousFocus: document.activeElement, onKey };
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        // Action destructive : le focus part sur « Annuler » pour éviter une validation par réflexe
        (danger && cancelBtn ? cancelBtn : okBtn).focus();
    });
}

/** Remplace confirm() : résout true si l'utilisateur valide. */
function uiConfirm(message, opts = {}) {
    return openUiDialog({
        title: opts.title || 'Confirmation',
        message,
        okLabel: opts.okLabel || 'Confirmer',
        cancelLabel: opts.cancelLabel || 'Annuler',
        danger: !!opts.danger
    });
}

/** Remplace alert(). */
function uiAlert(message, opts = {}) {
    return openUiDialog({ title: opts.title || 'Animflix', message, okLabel: opts.okLabel || 'OK' });
}

function isUiDialogOpen() {
    return !!activeUiDialog;
}

function cancelUiDialog() {
    closeUiDialog(false);
}

window.posterFallback = posterFallback;
window.posterOnErrorAttr = posterOnErrorAttr;
window.renderSkeletonCards = renderSkeletonCards;
window.renderSkeletonGrid = renderSkeletonGrid;
window.uiConfirm = uiConfirm;
window.uiAlert = uiAlert;
window.isUiDialogOpen = isUiDialogOpen;
window.cancelUiDialog = cancelUiDialog;
