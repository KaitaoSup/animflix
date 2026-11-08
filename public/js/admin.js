// =========================================================================
// --- PAGE « SERVEUR » (ADMINISTRATEUR) : ÉTAT DES SERVICES, DISQUE, SAUVEGARDES ---
// =========================================================================

const ADMIN_LEVEL_LABELS = {
    ok: { icon: '✅', label: 'OK' },
    warn: { icon: '⚠️', label: 'Attention' },
    error: { icon: '❌', label: 'Problème' },
    off: { icon: '⏸', label: 'Désactivé' }
};

function isCurrentUserAdmin() {
    return !!(typeof currentAnimflixUser !== 'undefined' && currentAnimflixUser && currentAnimflixUser.isAdmin);
}

function adminFormatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
}

function adminFormatAgo(ms) {
    if (!Number.isFinite(ms)) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h`;
    return `${Math.round(h / 24)} jours`;
}

function adminFormatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function adminStatusPill(level, customLabel) {
    const l = ADMIN_LEVEL_LABELS[level] || ADMIN_LEVEL_LABELS.warn;
    return `<span class="admin-pill admin-pill-${escapeHtml(level)}">${l.icon} ${escapeHtml(customLabel || l.label)}</span>`;
}

function adminRow(label, value) {
    return `<div class="admin-kv"><span>${escapeHtml(label)}</span><b>${value}</b></div>`;
}

function renderAdminService(s) {
    const label = s.level === 'off' ? 'Désactivé'
        : !s.ok ? 'Hors ligne'
        : s.level === 'warn' ? 'Lent' : 'En ligne';
    const details = [];
    if (s.ok && Number.isFinite(s.latencyMs)) details.push(`${s.latencyMs} ms`);
    if (s.id === 'torrserver' && s.ok) details.push(`${s.torrents} torrent${s.torrents > 1 ? 's' : ''} chargé${s.torrents > 1 ? 's' : ''}`);
    if (s.id === 'nyaa' && s.url) details.push(escapeHtml(s.url));
    if (s.id === 'torznab' && s.level === 'off') details.push('Non configuré');
    if (s.id === 'tokyotosho' && s.level === 'off') details.push('Mode « Nyaa uniquement »');
    return `
        <div class="admin-card">
            <div class="admin-card-head">
                <span class="admin-card-title">${escapeHtml(s.name)}</span>
                ${adminStatusPill(s.level, label)}
            </div>
            <div class="admin-card-sub">${details.join(' · ') || '&nbsp;'}</div>
            ${s.error ? `<div class="admin-card-error">${escapeHtml(s.error)}</div>` : ''}
        </div>`;
}

function renderAdminReport(r) {
    const disk = r.storage.disk || {};
    const used = disk.total ? disk.total - disk.free : 0;
    const usedRatio = disk.total ? used / disk.total : 0;
    const b = r.backups;
    const n = r.notifier;
    const a = r.activity;
    const cacheTotal = r.storage.caches.reduce((s, c) => s + c.bytes, 0);

    return `
        <div class="admin-summary admin-summary-${escapeHtml(r.level)}">
            ${adminStatusPill(r.level, r.problems ? `${r.problems} point${r.problems > 1 ? 's' : ''} à vérifier` : 'Tout fonctionne')}
            <span class="admin-summary-time">Vérifié il y a ${adminFormatAgo(Date.now() - r.generatedAt)}</span>
            <button type="button" class="btn-sub-style admin-refresh" onclick="loadAdminHealth(true)">🔄 Relancer les tests</button>
        </div>

        <h3 class="admin-section-title">Services</h3>
        <div class="admin-grid">${r.services.map(renderAdminService).join('')}</div>

        <div class="admin-columns">
            <section>
                <h3 class="admin-section-title">Stockage ${adminStatusPill(r.storage.level)}</h3>
                <div class="admin-card">
                    ${disk.total ? `
                        <div class="admin-card-head">
                            <span class="admin-card-title">Disque</span>
                            <span class="admin-card-sub">${adminFormatBytes(disk.free)} libres sur ${adminFormatBytes(disk.total)}</span>
                        </div>
                        <div class="admin-meter" role="img" aria-label="Disque utilisé à ${Math.round(usedRatio * 100)} %">
                            <span class="admin-meter-fill admin-meter-${escapeHtml(disk.level)}" style="width: ${(usedRatio * 100).toFixed(1)}%"></span>
                        </div>
                        <div class="admin-card-sub">Utilisé à ${Math.round(usedRatio * 100)} %</div>
                    ` : `<div class="admin-card-error">Espace disque illisible : ${escapeHtml(disk.error || '')}</div>`}
                    <div class="admin-kv-list">
                        ${adminRow('Base de données', adminFormatBytes(r.storage.database.bytes))}
                        ${r.storage.caches.map(c => adminRow(`Cache ${c.name}`, `${adminFormatBytes(c.bytes)} <small>(${c.files} fichier${c.files > 1 ? 's' : ''})</small>`)).join('')}
                        ${adminRow('Total des caches', adminFormatBytes(cacheTotal))}
                    </div>
                </div>
            </section>

            <section>
                <h3 class="admin-section-title">Sauvegardes ${adminStatusPill(b.level)}</h3>
                <div class="admin-card">
                    ${b.latest ? `
                        ${adminRow('Dernière sauvegarde', `${escapeHtml(new Date(b.latest.at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }))} <small>(il y a ${adminFormatAgo(b.latest.ageMs)})</small>`)}
                        ${adminRow('Sauvegardes conservées', `${b.count} <small>(${adminFormatBytes(b.totalBytes)})</small>`)}
                    ` : `<div class="admin-card-error">Aucune sauvegarde trouvée.</div>`}
                    <div class="admin-card-sub" style="margin-top: 8px;">Une sauvegarde par jour, les 7 dernières sont gardées.</div>
                    <button type="button" class="btn-sub-style" style="margin-top: 10px;" onclick="runAdminBackup(this)">💾 Sauvegarder maintenant</button>
                </div>

                <h3 class="admin-section-title">Notifications d'épisodes ${adminStatusPill(n.level, n.enabled ? null : 'Désactivées')}</h3>
                <div class="admin-card">
                    ${adminRow('Comptes surveillés', String(n.subscribedUsers))}
                    ${adminRow('Dernière vérification', n.lastRunAt ? `il y a ${adminFormatAgo(Date.now() - n.lastRunAt)}` : 'pas encore')}
                    ${adminRow('Envoyées', `${n.lastSent} au dernier passage · ${n.totalSent} depuis le démarrage`)}
                    ${n.lastError ? `<div class="admin-card-error">${escapeHtml(n.lastError)}</div>` : ''}
                </div>
            </section>
        </div>

        <h3 class="admin-section-title">Activité</h3>
        <div class="admin-card admin-kv-grid">
            ${adminRow('Version', `v${escapeHtml(a.version)} <small>(Node ${escapeHtml(a.node)})</small>`)}
            ${adminRow('En marche depuis', adminFormatUptime(a.uptimeS))}
            ${adminRow('Mémoire', adminFormatBytes(a.memoryBytes))}
            ${adminRow('Transcodages en cours', `${a.streams.active} / ${a.streams.max}`)}
            ${adminRow('Décodeur', escapeHtml(a.hwAccel || 'logiciel'))}
            ${adminRow('Comptes', String(a.users ?? '—'))}
            ${adminRow('Sessions actives', String(a.sessions ?? '—'))}
            ${adminRow('Appareils notifiés', String(a.pushDevices ?? '—'))}
            ${adminRow('Éléments synchronisés', String(a.syncItems ?? '—'))}
        </div>`;
}

async function loadAdminHealth(force = false) {
    const el = document.getElementById('adminHealthContent');
    if (!el) return;
    const btn = el.querySelector('.admin-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Tests en cours…'; }
    try {
        const res = await fetch('/api/admin/health' + (force ? '?refresh=1' : ''), { headers: getAuthHeaders(), credentials: 'include' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!document.body.contains(el)) return;
        el.innerHTML = renderAdminReport(data);
    } catch (err) {
        el.innerHTML = `<div class="empty-state">⚠️ ${escapeHtml(err.message)}</div>`;
    }
}

async function runAdminBackup(btn) {
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/admin/backup', { method: 'POST', headers: getAuthHeaders(), credentials: 'include' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sauvegarde impossible');
        showToast((data.created ? '💾 ' : 'ℹ️ ') + data.message);
        loadAdminHealth();
    } catch (err) {
        showToast('❌ ' + err.message);
        if (btn) btn.disabled = false;
    }
}

/**
 * Après la vérification de session (démarrage, connexion, déconnexion) : l'accueil a pu s'afficher
 * avant (onglet « Serveur » absent, ou page Serveur en attente) -> nouvel affichage si besoin.
 */
function refreshAdminUi() {
    if (!document.getElementById('homeTabContent') || typeof renderHomeScreen !== 'function') return;
    const tab = typeof getActiveHomeTab === 'function' ? getActiveHomeTab() : 'home';
    const hasAdminTab = !!document.querySelector(`.home-tab-btn[onclick="switchHomeTab('admin')"]`);
    if (tab === 'admin' || hasAdminTab !== isCurrentUserAdmin()) renderHomeScreen();
}

function renderAdminTabHtml(container) {
    if (!window.animflixAuthReady) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 60px 20px; display: flex; gap: 12px; justify-content: center; align-items: center;">
                <div class="spinner" style="width: 20px; height: 20px; border-width: 3px; margin: 0;"></div> Vérification de la session…
            </div>`;
        return;
    }
    if (!isCurrentUserAdmin()) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 60px 20px;">
                🔒 Cette page est réservée à l'administrateur du serveur.
            </div>`;
        return;
    }
    container.innerHTML = `
        <div class="home-watching-section admin-page">
            <div class="home-watching-header">
                <div class="home-watching-title-group">
                    <h2 class="home-watching-title"><span style="font-size: 24px;">🛠️</span> État du serveur</h2>
                </div>
            </div>
            <div id="adminHealthContent">
                <div class="admin-card admin-loading"><div class="spinner" style="width: 20px; height: 20px; border-width: 3px; margin: 0;"></div> Vérification des services…</div>
            </div>
        </div>`;
    loadAdminHealth();
}

window.renderAdminTabHtml = renderAdminTabHtml;
window.loadAdminHealth = loadAdminHealth;
window.runAdminBackup = runAdminBackup;
window.isCurrentUserAdmin = isCurrentUserAdmin;
window.refreshAdminUi = refreshAdminUi;
