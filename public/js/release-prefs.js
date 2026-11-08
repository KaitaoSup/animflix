// =========================================================================
// --- PRÉFÉRENCES DE RELEASE (GROUPES FAVORIS, RÉSOLUTION) POUR TRIER LES RÉSULTATS NYAA ---
// =========================================================================

const STORAGE_KEY_RELEASE_GROUPS = 'animflix_pref_release_groups';
const STORAGE_KEY_PREF_RESOLUTION = 'animflix_pref_resolution';

// Groupe d'une release : « [Erai-raws] Titre - 01 [1080p] » ou, à défaut, « Titre.S01E01.1080p.WEB.x264-GROUPE.mkv »
function extractReleaseGroup(title) {
    if (!title || typeof title !== 'string') return null;
    const bracket = title.trim().match(/^[\[【(]([^\]】)]{1,60})[\]】)]/);
    if (bracket) return bracket[1].trim();
    const suffix = title.trim().replace(/\.(mkv|mp4|avi)$/i, '').match(/-([A-Za-z0-9][A-Za-z0-9_.]{1,30})$/);
    return suffix ? suffix[1] : null;
}

function normalizeGroupName(name) {
    return String(name || '').toLowerCase().replace(/[\s_.\-]+/g, '');
}

// « Erai-raws, SubsPlease ; Tsundere-Raws » -> ['Erai-raws', 'SubsPlease', 'Tsundere-Raws'] (ordre = priorité)
function parseReleaseGroupList(str) {
    const seen = new Set();
    return String(str || '')
        .split(/[,;\n]+/)
        .map(s => s.trim().replace(/^\[|\]$/g, '').trim())
        .filter(s => {
            const n = normalizeGroupName(s);
            if (!n || seen.has(n)) return false;
            seen.add(n);
            return true;
        });
}

function detectTorrentResolution(t) {
    const text = `${(t && t.resolution) || ''} ${(t && t.titre) || ''}`;
    if (/2160p|\b4k\b|uhd/i.test(text)) return '2160p';
    if (/1080[pi]/i.test(text)) return '1080p';
    if (/720p/i.test(text)) return '720p';
    if (/480p|576p/i.test(text)) return '480p';
    return null;
}

function getReleasePrefs() {
    let groups = [];
    let resolution = 'any';
    try {
        groups = parseReleaseGroupList(localStorage.getItem(STORAGE_KEY_RELEASE_GROUPS) || '');
        resolution = localStorage.getItem(STORAGE_KEY_PREF_RESOLUTION) || 'any';
    } catch (e) {}
    return { groups, resolution };
}

function hasReleasePrefs(prefs) {
    return !!prefs && (prefs.groups.length > 0 || (prefs.resolution && prefs.resolution !== 'any'));
}

// Rang du groupe dans la liste des préférés (0 = le plus voulu), -1 s'il n'y figure pas
function releaseGroupRank(t, prefs) {
    const group = normalizeGroupName(extractReleaseGroup(t && t.titre));
    if (!group || !prefs || prefs.groups.length === 0) return -1;
    return prefs.groups.findIndex(g => normalizeGroupName(g) === group);
}

/**
 * Comparateur « Mes préférences » : un torrent sans seeders reste derrière (illisible quel que soit le groupe),
 * puis groupe préféré (dans l'ordre de la liste), puis résolution voulue, puis nombre de seeders.
 */
function compareByReleasePrefs(a, b, prefs) {
    const aliveA = (Number(a.seeders) || 0) > 0 ? 1 : 0;
    const aliveB = (Number(b.seeders) || 0) > 0 ? 1 : 0;
    if (aliveA !== aliveB) return aliveB - aliveA;

    // Source signalée par un lecteur (ne démarre pas / illisible) : après les autres
    const reportedA = a.reported ? 1 : 0;
    const reportedB = b.reported ? 1 : 0;
    if (reportedA !== reportedB) return reportedA - reportedB;

    const rankA = releaseGroupRank(a, prefs);
    const rankB = releaseGroupRank(b, prefs);
    const gA = rankA === -1 ? Infinity : rankA;
    const gB = rankB === -1 ? Infinity : rankB;
    if (gA !== gB) return gA < gB ? -1 : 1;

    if (prefs && prefs.resolution && prefs.resolution !== 'any') {
        const resA = detectTorrentResolution(a) === prefs.resolution ? 1 : 0;
        const resB = detectTorrentResolution(b) === prefs.resolution ? 1 : 0;
        if (resA !== resB) return resB - resA;
    }
    return (Number(b.seeders) || 0) - (Number(a.seeders) || 0);
}

// Tri proposé par défaut à chaque nouvelle recherche
function getDefaultSearchSort() {
    return hasReleasePrefs(getReleasePrefs()) ? 'preferred' : 'seeders';
}

// --- RÉGLAGES (MODALE PARAMÈTRES) ---

function loadReleasePrefsIntoSettings() {
    const groupsInput = document.getElementById('prefReleaseGroups');
    const resSelect = document.getElementById('prefResolution');
    try {
        if (groupsInput) groupsInput.value = localStorage.getItem(STORAGE_KEY_RELEASE_GROUPS) || '';
        if (resSelect) resSelect.value = localStorage.getItem(STORAGE_KEY_PREF_RESOLUTION) || 'any';
    } catch (e) {}
}

function saveReleasePrefsFromSettings() {
    const groupsInput = document.getElementById('prefReleaseGroups');
    const resSelect = document.getElementById('prefResolution');
    try {
        if (groupsInput) {
            const cleaned = parseReleaseGroupList(groupsInput.value).join(', ');
            groupsInput.value = cleaned;
            if (cleaned) localStorage.setItem(STORAGE_KEY_RELEASE_GROUPS, cleaned);
            else localStorage.removeItem(STORAGE_KEY_RELEASE_GROUPS);
        }
        if (resSelect) {
            if (resSelect.value && resSelect.value !== 'any') localStorage.setItem(STORAGE_KEY_PREF_RESOLUTION, resSelect.value);
            else localStorage.removeItem(STORAGE_KEY_PREF_RESOLUTION);
        }
    } catch (e) {}
}

window.saveReleasePrefsFromSettings = saveReleasePrefsFromSettings;
window.loadReleasePrefsIntoSettings = loadReleasePrefsIntoSettings;
