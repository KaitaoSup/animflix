// =========================================================================
// --- COULEUR D'INTERFACE PRÉFÉRÉE (THÈME D'ACCENT) ---
// =========================================================================
// Chargé dans le <head>, avant l'affichage de la page : la couleur choisie est appliquée tout de suite,
// sans flash du rouge par défaut. Toutes les feuilles de style passent par les variables
// --primary, --primary-hover, --primary-light et --primary-rgb (pour les rgba(var(--primary-rgb), a)).

const STORAGE_KEY_THEME_COLOR = 'animflix_theme_color';
const DEFAULT_THEME_COLOR = '#e50914';

const THEME_PRESETS = [
    { label: 'Rouge Animflix', color: '#e50914' },
    { label: 'Orange', color: '#f2600c' },
    { label: 'Ambre', color: '#c77d00' },
    { label: 'Vert', color: '#16a34a' },
    { label: 'Turquoise', color: '#0ba3a3' },
    { label: 'Bleu', color: '#2563eb' },
    { label: 'Violet', color: '#7c3aed' },
    { label: 'Rose', color: '#e91e8c' }
];

// Bornes : l'accent doit rester visible sur le fond sombre (luminosité HSL minimale) et le texte
// blanc des boutons lisible dessus (luminance relative maximale, soit un contraste d'environ 3:1).
const THEME_MIN_LIGHTNESS = 0.35;
const THEME_MAX_LUMINANCE = 0.30;

function parseHexColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
    return '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }) {
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const hue = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}

// Luminance relative WCAG (0 = noir, 1 = blanc)
function relativeLuminance({ r, g, b }) {
    const lin = v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function shiftLightness(hsl, delta) {
    return rgbToHex(hslToRgb({ ...hsl, l: Math.min(1, Math.max(0, hsl.l + delta)) }));
}

// Ramène une couleur quelconque dans la plage lisible ; null si la valeur n'est pas une couleur #rrggbb
function normalizeThemeColor(hex) {
    const rgb = parseHexColor(hex);
    if (!rgb) return null;
    const hsl = rgbToHsl(rgb);
    if (hsl.l >= THEME_MIN_LIGHTNESS && relativeLuminance(rgb) <= THEME_MAX_LUMINANCE) return rgbToHex(rgb);
    // On garde la teinte et la saturation, seule la luminosité est corrigée
    let l = Math.max(THEME_MIN_LIGHTNESS, hsl.l);
    let out = parseHexColor(rgbToHex(hslToRgb({ ...hsl, l })));
    while (l > 0.2 && relativeLuminance(out) > THEME_MAX_LUMINANCE) {
        l -= 0.01;
        out = parseHexColor(rgbToHex(hslToRgb({ ...hsl, l })));
    }
    return rgbToHex(out);
}

function getThemeColor() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY_THEME_COLOR); } catch (e) {}
    return normalizeThemeColor(stored) || DEFAULT_THEME_COLOR;
}

function applyThemeColor(hex) {
    const color = normalizeThemeColor(hex) || DEFAULT_THEME_COLOR;
    const rootStyle = document.documentElement.style;

    if (color === DEFAULT_THEME_COLOR) {
        // Couleur d'origine : on laisse les valeurs ajustées à la main de style.css
        ['--primary', '--primary-hover', '--primary-light', '--primary-rgb'].forEach(v => rootStyle.removeProperty(v));
    } else {
        const rgb = parseHexColor(color);
        const hsl = rgbToHsl(rgb);
        rootStyle.setProperty('--primary', color);
        rootStyle.setProperty('--primary-hover', shiftLightness(hsl, -0.09));
        rootStyle.setProperty('--primary-light', shiftLightness(hsl, Math.min(0.15, 0.72 - hsl.l)));
        rootStyle.setProperty('--primary-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    }

    // Barre d'état du navigateur / de la PWA
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    return color;
}

// Enregistre la préférence (synchronisée entre appareils via sync.js) et l'applique
function setThemeColor(hex) {
    const color = normalizeThemeColor(hex);
    if (!color) return;
    try {
        if (color === DEFAULT_THEME_COLOR) localStorage.removeItem(STORAGE_KEY_THEME_COLOR);
        else localStorage.setItem(STORAGE_KEY_THEME_COLOR, color);
    } catch (e) {}
    applyThemeColor(color);
    renderThemeColorSettings();
    if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
}

// --- RÉGLAGES (MODALE PARAMÈTRES) ---

function renderThemeColorSettings() {
    const current = getThemeColor();
    const list = document.getElementById('themeColorSwatches');
    if (list) {
        const isPreset = THEME_PRESETS.some(p => p.color === current);
        list.innerHTML = THEME_PRESETS.map(p => {
            const active = p.color === current;
            return `<button type="button" class="theme-swatch${active ? ' active' : ''}" role="radio" aria-checked="${active}"
                        style="--swatch: ${p.color}" title="${p.label}" aria-label="${p.label}"
                        onclick="setThemeColor('${p.color}')"></button>`;
        }).join('') + (isPreset ? '' : `<span class="theme-swatch active" role="radio" aria-checked="true" style="--swatch: ${current}" title="Couleur personnalisée"></span>`);
    }
    const picker = document.getElementById('prefThemeColor');
    if (picker && document.activeElement !== picker) picker.value = current;
}

// Aperçu en direct pendant que l'utilisateur fait glisser le sélecteur ; enregistrement à la validation
function previewThemeColor(hex) {
    applyThemeColor(hex);
}

function commitThemeColor(hex) {
    setThemeColor(hex);
    const picker = document.getElementById('prefThemeColor');
    if (picker) picker.value = getThemeColor();
}

// --- FOND : SOMBRE (DÉFAUT) OU NOIR OLED ---
// Propre à chaque appareil (non synchronisé) : le noir pur est surtout utile sur un écran OLED.
const STORAGE_KEY_BG_THEME = 'animflix_bg_theme';

function getBackgroundTheme() {
    try { return localStorage.getItem(STORAGE_KEY_BG_THEME) === 'oled' ? 'oled' : 'dark'; } catch (e) { return 'dark'; }
}

function applyBackgroundTheme(value) {
    if (value === 'oled') document.documentElement.setAttribute('data-bg', 'oled');
    else document.documentElement.removeAttribute('data-bg');
}

function setBackgroundTheme(value) {
    const v = value === 'oled' ? 'oled' : 'dark';
    try {
        if (v === 'oled') localStorage.setItem(STORAGE_KEY_BG_THEME, 'oled');
        else localStorage.removeItem(STORAGE_KEY_BG_THEME);
    } catch (e) {}
    applyBackgroundTheme(v);
    const sel = document.getElementById('prefBackgroundTheme');
    if (sel) sel.value = v;
}

// --- COULEUR PROPRE À CHAQUE ANIME (FICHE ANIME) ---
// AniList fournit la couleur dominante de l'affiche (coverImage.color) : la fiche reprend cette couleur
// pour ses boutons, sa bannière et ses tuiles, ramenée dans la plage lisible comme la couleur d'interface.
const STORAGE_KEY_ANIME_ACCENT = 'animflix_anime_accent';

function isAnimeAccentEnabled() {
    try { return localStorage.getItem(STORAGE_KEY_ANIME_ACCENT) !== 'off'; } catch (e) { return true; }
}

function setAnimeAccentEnabled(enabled) {
    try {
        if (enabled) localStorage.removeItem(STORAGE_KEY_ANIME_ACCENT);
        else localStorage.setItem(STORAGE_KEY_ANIME_ACCENT, 'off');
    } catch (e) {}
    if (typeof refreshAnimePageAccent === 'function') refreshAnimePageAccent();
}

// Déclarations CSS (--primary, --primary-hover, --primary-light, --primary-rgb, --anime-accent) pour
// une couleur d'anime, ou '' (couleur d'interface conservée) si l'option est coupée ou la couleur invalide
function animeAccentStyle(hex) {
    if (!isAnimeAccentEnabled()) return '';
    const color = normalizeThemeColor(hex);
    if (!color) return '';
    const rgb = parseHexColor(color);
    const hsl = rgbToHsl(rgb);
    // Couleur presque grise (affiche en noir et blanc) : pas d'intérêt, on garde l'accent de l'interface
    if (hsl.s < 0.18) return '';
    return [
        `--primary: ${color}`,
        `--primary-hover: ${shiftLightness(hsl, -0.09)}`,
        `--primary-light: ${shiftLightness(hsl, Math.min(0.15, 0.72 - hsl.l))}`,
        `--primary-rgb: ${rgb.r}, ${rgb.g}, ${rgb.b}`,
        `--anime-accent: ${color}`
    ].join('; ') + ';';
}

window.getBackgroundTheme = getBackgroundTheme;
window.setBackgroundTheme = setBackgroundTheme;
window.isAnimeAccentEnabled = isAnimeAccentEnabled;
window.setAnimeAccentEnabled = setAnimeAccentEnabled;
window.animeAccentStyle = animeAccentStyle;
window.getThemeColor = getThemeColor;
window.applyThemeColor = applyThemeColor;
window.setThemeColor = setThemeColor;
window.renderThemeColorSettings = renderThemeColorSettings;
window.previewThemeColor = previewThemeColor;
window.commitThemeColor = commitThemeColor;

applyThemeColor(getThemeColor());
applyBackgroundTheme(getBackgroundTheme());
