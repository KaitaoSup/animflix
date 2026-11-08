// =========================================================================
// --- EXPORT DU PLANNING VERS L'AGENDA (.ICS) ---
// =========================================================================
//
// Lien d'abonnement personnel (jeton secret) : Google Agenda, Apple Calendrier, Outlook… relisent
// les prochains épisodes des animes « En cours » (et « À voir » en option) toutes les heures environ.

const calendarExport = {
    open: false,
    path: null,
    loading: false,
    error: null,
    includePlanning: false
};

try { calendarExport.includePlanning = localStorage.getItem('animflix_calendar_planning') === '1'; } catch (e) {}

function calendarExportUrl() {
    if (!calendarExport.path) return '';
    return `${window.location.origin}${calendarExport.path}${calendarExport.includePlanning ? '?planning=1' : ''}`;
}

function calendarExportWebcalUrl() {
    return calendarExportUrl().replace(/^https?:/, 'webcal:');
}

function isCalendarExportPublicUrl() {
    const host = window.location.hostname;
    return window.location.protocol === 'https:'
        && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

async function loadCalendarExportLink(reset = false) {
    calendarExport.loading = true;
    calendarExport.error = null;
    refreshCalendarExportPanel();
    try {
        const res = await fetch(reset ? '/api/calendar/reset' : '/api/calendar', {
            method: reset ? 'POST' : 'GET',
            headers: getAuthHeaders(),
            credentials: 'include'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        calendarExport.path = data.path;
        if (reset) showToast("🔄 Nouveau lien créé : l'ancien ne fonctionne plus");
    } catch (err) {
        calendarExport.error = err.message;
    } finally {
        calendarExport.loading = false;
        refreshCalendarExportPanel();
    }
}

function toggleCalendarExportPanel() {
    calendarExport.open = !calendarExport.open;
    if (calendarExport.open && !calendarExport.path && !calendarExport.loading) {
        if (typeof currentAnimflixUser !== 'undefined' && currentAnimflixUser) loadCalendarExportLink();
    }
    refreshCalendarExportPanel();
    document.getElementById('calendarExportToggle')?.setAttribute('aria-expanded', String(calendarExport.open));
}

function setCalendarExportPlanning(checked) {
    calendarExport.includePlanning = !!checked;
    try { localStorage.setItem('animflix_calendar_planning', checked ? '1' : '0'); } catch (e) {}
    refreshCalendarExportPanel();
}

async function copyCalendarExportUrl() {
    const url = calendarExportUrl();
    if (!url) return;
    try {
        await navigator.clipboard.writeText(url);
        showToast('📋 Lien de l\'agenda copié');
    } catch (e) {
        const input = document.getElementById('calendarExportUrlInput');
        if (input) { input.focus(); input.select(); }
        showToast('Sélectionnez le lien puis copiez-le');
    }
}

async function resetCalendarExportLink() {
    const ok = typeof openUiDialog === 'function'
        ? await openUiDialog({
            title: 'Créer un nouveau lien ?',
            message: "L'ancien lien cessera de fonctionner : les agendas déjà abonnés devront être abonnés au nouveau lien.",
            okLabel: 'Nouveau lien', cancelLabel: 'Annuler', danger: true
        })
        : confirm("Créer un nouveau lien ? L'ancien cessera de fonctionner.");
    if (ok) loadCalendarExportLink(true);
}

function renderCalendarExportPanelBody() {
    const hasAccount = typeof currentAnimflixUser !== 'undefined' && currentAnimflixUser;
    if (!hasAccount) {
        return `<p class="cal-export-note">🔒 Connectez-vous à votre compte Animflix (lié à AniList) pour ajouter vos prochains épisodes à votre agenda.</p>
            <button type="button" class="btn-secondary" onclick="openAnimflixAuthModal('login')">Se connecter</button>`;
    }
    if (calendarExport.loading) {
        return `<p class="cal-export-note"><span class="spinner" style="width:16px;height:16px;border-width:2px;margin:0 8px 0 0;display:inline-block;vertical-align:middle;"></span>Préparation du lien…</p>`;
    }
    if (calendarExport.error) {
        return `<p class="cal-export-note cal-export-error">⚠️ ${escapeHtml(calendarExport.error)}</p>
            <button type="button" class="btn-secondary" onclick="loadCalendarExportLink()">Réessayer</button>`;
    }
    if (!calendarExport.path) return '';

    const url = calendarExportUrl();
    const webcal = calendarExportWebcalUrl();
    const googleUrl = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal);
    const publicUrl = isCalendarExportPublicUrl();
    return `
        <p class="cal-export-note">
            Les épisodes de vos animes <b>En cours</b> s'ajoutent à votre agenda (7 jours passés, 5 semaines à venir) et se mettent à jour tout seuls.
            Un clic sur un épisode dans l'agenda ouvre sa fiche dans Animflix.
        </p>
        <label class="cal-export-check">
            <input type="checkbox" ${calendarExport.includePlanning ? 'checked' : ''} onchange="setCalendarExportPlanning(this.checked)">
            Inclure aussi ma liste « À voir » (animes pas encore commencés)
        </label>
        <div class="cal-export-url">
            <input id="calendarExportUrlInput" type="text" readonly value="${escapeHtml(url)}" aria-label="Lien d'abonnement de l'agenda" onclick="this.select()">
            <button type="button" class="btn-secondary" onclick="copyCalendarExportUrl()">📋 Copier</button>
        </div>
        <div class="cal-export-actions">
            <a class="btn-secondary" href="${escapeHtml(webcal)}">📅 Ouvrir dans l'agenda de l'appareil</a>
            ${publicUrl ? `<a class="btn-secondary" href="${escapeHtml(googleUrl)}" target="_blank" rel="noopener">Google Agenda</a>` : ''}
            <button type="button" class="btn-secondary cal-export-reset" onclick="resetCalendarExportLink()" title="Si le lien a été partagé par erreur">🔄 Nouveau lien</button>
        </div>
        ${publicUrl ? '' : `<p class="cal-export-note cal-export-warn">ℹ️ Google Agenda et Outlook en ligne lisent l'agenda depuis Internet : ils ne peuvent pas joindre cette adresse locale. Utilisez l'adresse HTTPS publique du serveur (Tailscale Funnel), ou l'agenda d'un appareil sur le même réseau.</p>`}
        <p class="cal-export-note cal-export-small">🔐 Ce lien est personnel : toute personne qui l'a voit votre liste. « Nouveau lien » désactive l'ancien.</p>`;
}

function renderCalendarExportPanel() {
    return `<div id="scheduleCalendarPanel" class="cal-export-panel" ${calendarExport.open ? '' : 'hidden'}>
            <h3 class="cal-export-title">📅 Mes prochains épisodes dans mon agenda</h3>
            <div id="scheduleCalendarPanelBody">${calendarExport.open ? renderCalendarExportPanelBody() : ''}</div>
        </div>`;
}

function refreshCalendarExportPanel() {
    const panel = document.getElementById('scheduleCalendarPanel');
    if (!panel) return;
    panel.hidden = !calendarExport.open;
    const body = document.getElementById('scheduleCalendarPanelBody');
    if (body) body.innerHTML = calendarExport.open ? renderCalendarExportPanelBody() : '';
}

// Changement de compte : le lien appartient au compte précédent
function onCalendarExportAuthChanged() {
    calendarExport.path = null;
    calendarExport.error = null;
    if (calendarExport.open && typeof currentAnimflixUser !== 'undefined' && currentAnimflixUser) loadCalendarExportLink();
    else refreshCalendarExportPanel();
}
