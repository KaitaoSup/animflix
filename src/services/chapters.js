/**
 * Détection des passages à sauter à partir des chapitres du fichier (MKV des fansubs : « Opening », « OP »,
 * « Ending », « Générique de fin », « Recap », « Preview », « Prochain épisode »…).
 * Lu par le même ffprobe que les pistes, sans coût réseau en plus.
 */

const OP_TITLE_RE = /^(?:op|opening|intro|ouverture|generique(?: de)? debut|generique d'ouverture)(?:$|[\s\d:_\-(]|song|theme)/;
const ED_TITLE_RE = /^(?:ed|ending|outro|credits?|generique(?: de)? fin|generique de cloture)(?:$|[\s\d:_\-(]|song|theme)/;
const RECAP_TITLE_RE = /^(?:recap|recapitulatif|resume|previously(?: on)?|precedemment|dans l'episode precedent|summary)(?:$|[\s\d:_\-(.])/;
const PREVIEW_TITLE_RE = /^(?:preview|next episode|next ep(?:isode)?\.?|next time|avant-premiere|apercu|prochain episode|prochainement|bande-annonce|teaser|yokoku|eyecatch preview)(?:$|[\s\d:_\-(.])/;

// Durées plausibles par type (au-delà : chapitre mal nommé)
const SEGMENT_BOUNDS = {
  op: { min: 20, max: 200 },
  ed: { min: 20, max: 200 },
  recap: { min: 10, max: 240 },
  preview: { min: 5, max: 120 }
};

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function toInterval(chapter, duration, { min, max }) {
  const start = parseFloat(chapter.start_time);
  let end = parseFloat(chapter.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (duration > 0) end = Math.min(end, duration);
  const length = end - start;
  if (start < 0 || length < min || length > max) return null;
  return { startTime: Math.round(start * 100) / 100, endTime: Math.round(end * 100) / 100 };
}

function segmentType(title) {
  if (OP_TITLE_RE.test(title)) return 'op';
  if (ED_TITLE_RE.test(title)) return 'ed';
  if (RECAP_TITLE_RE.test(title)) return 'recap';
  if (PREVIEW_TITLE_RE.test(title)) return 'preview';
  return null;
}

/**
 * @param {Array} chapters  chapitres ffprobe ({ start_time, end_time, tags: { title } })
 * @param {number} duration durée de l'épisode en secondes
 * @returns {{ op?, ed?, recap?, preview? } | null} intervalles { startTime, endTime } en secondes
 */
export function detectSkipChapters(chapters, duration = 0) {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const candidates = { op: [], ed: [], recap: [], preview: [] };
  for (const chapter of chapters) {
    const title = normalizeTitle(chapter?.tags?.title);
    if (!title) continue;
    const type = segmentType(title);
    if (!type) continue;
    const interval = toInterval(chapter, duration, SEGMENT_BOUNDS[type]);
    if (interval) candidates[type].push(interval);
  }

  const result = {};
  if (candidates.op.length) result.op = candidates.op[0];
  const afterOp = (i) => !result.op || i.startTime >= result.op.endTime;
  // Un ending placé avant l'opening serait un chapitre mal nommé
  const ed = candidates.ed.find(afterOp);
  if (ed) result.ed = ed;
  // Le récap est en début d'épisode : dans le premier tiers (ou avant l'opening)
  const recap = candidates.recap.find(i => (duration > 0 ? i.startTime < duration / 3 : true) || (result.op && i.endTime <= result.op.startTime + 1));
  if (recap) result.recap = recap;
  // L'aperçu du prochain épisode est à la fin : après l'ending, sinon dans le dernier quart
  const preview = candidates.preview.find(i => (result.ed ? i.startTime >= result.ed.startTime : (duration > 0 ? i.startTime >= duration * 0.75 : afterOp(i))));
  if (preview) result.preview = preview;

  return Object.keys(result).length ? result : null;
}
