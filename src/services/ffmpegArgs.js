// --- CONSTRUCTION DES ARGUMENTS FFMPEG (fonctions pures, sans effet de bord) ---
// Toute la logique de lignes de commande des modes Direct / Transcodage / HLS est ici,
// pour pouvoir la tester sans lancer FFmpeg ni TorrServer.

const FRAGMENTED_MP4_OUTPUT = [
  '-sn',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
  '-f', 'mp4',
  'pipe:1'
];

const AAC_STEREO = ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];

/**
 * Seek avant `-i`.
 * - Vidéo copiée (`accurate = false`) : le flux démarre forcément sur l'image clé précédant le seek ;
 *   `-noaccurate_seek` fait démarrer l'audio au même endroit, et ce point est mesuré pour caler les sous-titres.
 * - Vidéo réencodée (`accurate = true`) : FFmpeg coupe vidéo ET audio réencodé exactement au temps demandé.
 *   Avec `-noaccurate_seek`, seule la vidéo était coupée : l'audio commençait à l'image clé précédente,
 *   le lecteur calait son 0 dessus et toute la lecture (sous-titres compris) était décalée de plusieurs secondes.
 */
function seekArgs(seekSeconds, accurate = false) {
  if (!(seekSeconds > 0)) return [];
  return accurate ? ['-ss', `${seekSeconds}`] : ['-noaccurate_seek', '-ss', `${seekSeconds}`];
}

/**
 * Entrées FFmpeg + mapping audio/vidéo.
 *
 * `-itsoffset` est une option d'ENTRÉE : pour décaler uniquement l'audio, le flux est ouvert une
 * seconde fois avec le décalage, la vidéo venant de l'entrée 0 et l'audio de l'entrée 1.
 * (Placé après le `-i` unique, FFmpeg refuse de démarrer : "cannot be applied to output url".)
 *
 * `videoCodecArgs` s'insère entre le mapping vidéo et le mapping audio (ordre historique des modes).
 */
function inputAndMapArgs({ torrUrl, seekSeconds, accurateSeek = false, audioIndex, audioOffset, preInputArgs = [], videoCodecArgs = [] }) {
  const seek = seekArgs(seekSeconds, accurateSeek);
  const args = [...seek, ...preInputArgs, '-i', torrUrl];
  let audioInput = 0;

  if (audioOffset !== 0) {
    args.push(...seek, '-itsoffset', `${audioOffset}`, '-i', torrUrl);
    audioInput = 1;
  }

  args.push('-map', '0:v:0', ...videoCodecArgs);
  args.push('-map', audioIndex !== null ? `${audioInput}:a:${audioIndex}` : `${audioInput}:a:0?`);
  return args;
}

/**
 * Piste audio effectivement lue : celle demandée, sinon la première
 */
export function chooseAudioTrack(streamInfo, audioIndex) {
  const tracks = streamInfo?.audioTracks || [];
  return audioIndex !== null ? tracks.find(a => a.index === audioIndex) : tracks[0];
}

/**
 * AAC/MP3 sont lisibles partout : copie directe. Sinon (ou piste inconnue) : conversion AAC stéréo.
 */
export function needsAacConversion(streamInfo, audioIndex) {
  const track = chooseAudioTrack(streamInfo, audioIndex);
  return !track || (track.codec !== 'aac' && track.codec !== 'mp3');
}

/**
 * La vidéo H.264 8 bits peut être remuxée telle quelle en HLS
 */
export function isH264DirectCopy(streamInfo) {
  return Boolean(streamInfo) &&
    streamInfo.videoCodec === 'h264' &&
    (!streamInfo.videoPixFmt || streamInfo.videoPixFmt === 'yuv420p');
}

/**
 * MODE DIRECT : vidéo copiée sans réencodage, MP4 fragmenté sur stdout.
 * Le bsf `showinfo` journalise le PTS de la 1re image (calcul du décalage keyframe après un seek).
 */
export function buildDirectArgs({ torrUrl, seekSeconds, audioIndex, audioOffset, streamInfo }) {
  return [
    '-threads', '0',
    ...inputAndMapArgs({
      torrUrl, seekSeconds, audioIndex, audioOffset,
      videoCodecArgs: ['-c:v', 'copy', '-bsf:v', 'showinfo']
    }),
    ...(needsAacConversion(streamInfo, audioIndex) ? AAC_STEREO : ['-c:a', 'copy']),
    ...FRAGMENTED_MP4_OUTPUT
  ];
}

/**
 * MODE TRANSCODAGE : H.264 via VAAPI, NVENC ou libx264 selon l'accélération détectée
 */
export function buildTranscodeArgs({ torrUrl, seekSeconds, audioIndex, audioOffset, hwAccel, vaapiDevice }) {
  let preInputArgs = [];
  let videoArgs;

  if (hwAccel === 'vaapi') {
    preInputArgs = ['-init_hw_device', `vaapi=va:${vaapiDevice}`, '-filter_hw_device', 'va'];
    videoArgs = ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '24'];
  } else if (hwAccel === 'nvenc') {
    videoArgs = ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'constqp', '-qp', '26'];
  } else {
    preInputArgs = ['-threads', '0'];
    videoArgs = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '25', '-pix_fmt', 'yuv420p'];
  }

  return [
    ...inputAndMapArgs({ torrUrl, seekSeconds, accurateSeek: true, audioIndex, audioOffset, preInputArgs }),
    ...videoArgs,
    ...AAC_STEREO,
    ...FRAGMENTED_MP4_OUTPUT
  ];
}

/**
 * MODE HLS : segments .ts de 3 s dans `sessionDir`, playlist `m3u8Path`
 */
export function buildHlsArgs({ torrUrl, seekSeconds, audioIndex, audioOffset, streamInfo, hwAccel, vaapiDevice, segmentPattern, m3u8Path }) {
  let preInputArgs = [];
  let videoCodecArgs;
  const videoIsCopied = isH264DirectCopy(streamInfo);
  // Vidéo réencodée après un seek : un audio copié ne peut pas être coupé au temps exact (il démarrerait
  // avant la vidéo et décalerait toute la timeline) : le réencoder pour qu'il démarre avec elle.
  const audioArgs = needsAacConversion(streamInfo, audioIndex) || (!videoIsCopied && seekSeconds > 0)
    ? AAC_STEREO
    : ['-c:a', 'copy'];

  if (videoIsCopied) {
    videoCodecArgs = ['-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb'];
  } else if (hwAccel === 'vaapi') {
    preInputArgs = ['-init_hw_device', `vaapi=va:${vaapiDevice}`, '-filter_hw_device', 'va'];
    videoCodecArgs = ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '24'];
  } else if (hwAccel === 'nvenc') {
    videoCodecArgs = ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-cq', '26'];
  } else {
    videoCodecArgs = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p'];
  }

  return [
    '-threads', '0',
    ...inputAndMapArgs({ torrUrl, seekSeconds, accurateSeek: !videoIsCopied, audioIndex, audioOffset, preInputArgs, videoCodecArgs }),
    ...audioArgs,
    '-sn',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_init_time', '2',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', segmentPattern,
    m3u8Path
  ];
}
