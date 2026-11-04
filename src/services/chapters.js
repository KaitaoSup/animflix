/**
 * Détection de l'opening et de l'ending à partir des chapitres du fichier (MKV des fansubs : « Opening »,
 * « OP », « Ending », « Générique de fin »…). Lu par le même ffprobe que les pistes, sans coût réseau en plus.
 */

const OP_TITLE_RE = /^(?:op|opening|intro|ouverture|generique(?: de)? debut|generique d'ouverture)(?:$|[\s\d:_\-(]|song|theme)/;
const ED_TITLE_RE = /^(?:ed|ending|outro|credits?|generique(?: de)? fin|generique de cloture)(?:$|[\s\d:_\-(]|song|theme)/;

// Un générique dure en pratique 1 min 30 ; on écarte les chapitres trop courts ou trop longs (mal nommés)
const MIN_SKIP_SECONDS = 20;
const MAX_SKIP_SECONDS = 200;

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function toInterval(chapter, duration) {
  const start = parseFloat(chapter.start_time);
  let end = parseFloat(chapter.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (duration > 0) end = Math.min(end, duration);
  const length = end - start;
  if (start < 0 || length < MIN_SKIP_SECONDS || length > MAX_SKIP_SECONDS) return null;
  return { startTime: Math.round(start * 100) / 100, endTime: Math.round(end * 100) / 100 };
}

/**
 * @param {Array} chapters  chapitres ffprobe ({ start_time, end_time, tags: { title } })
 * @param {number} duration durée de l'épisode en secondes
 * @returns {{ op?: {startTime, endTime}, ed?: {startTime, endTime} } | null}
 */
export function detectSkipChapters(chapters, duration = 0) {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const result = {};
  const edCandidates = [];
  for (const chapter of chapters) {
    const title = normalizeTitle(chapter?.tags?.title);
    if (!title) continue;
    if (OP_TITLE_RE.test(title)) {
      const interval = toInterval(chapter, duration);
      if (interval && !result.op) result.op = interval;
    } else if (ED_TITLE_RE.test(title)) {
      const interval = toInterval(chapter, duration);
      if (interval) edCandidates.push(interval);
    }
  }
  // Un ending placé avant l'opening serait un chapitre mal nommé
  const ed = edCandidates.find(i => !result.op || i.startTime >= result.op.endTime);
  if (ed) result.ed = ed;
  return result.op || result.ed ? result : null;
}
