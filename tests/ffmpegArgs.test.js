import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDirectArgs,
  buildTranscodeArgs,
  buildHlsArgs,
  needsAacConversion,
  isH264DirectCopy
} from '../src/services/ffmpegArgs.js';

const URL = 'http://127.0.0.1:8090/stream?link=x&index=1&play';
const AAC_INFO = { audioTracks: [{ index: 0, codec: 'aac' }, { index: 1, codec: 'opus' }], videoCodec: 'h264', videoPixFmt: 'yuv420p' };
const base = { torrUrl: URL, seekSeconds: 0, audioIndex: null, audioOffset: 0 };

function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
function inputCount(args) {
  return args.filter(a => a === '-i').length;
}

describe('needsAacConversion / isH264DirectCopy', () => {
  test('copie AAC/MP3, convertit le reste ou l\'inconnu', () => {
    assert.equal(needsAacConversion(AAC_INFO, null), false);
    assert.equal(needsAacConversion(AAC_INFO, 0), false);
    assert.equal(needsAacConversion(AAC_INFO, 1), true);
    assert.equal(needsAacConversion(AAC_INFO, 7), true);
    assert.equal(needsAacConversion(null, null), true);
  });
  test('H.264 8 bits seulement', () => {
    assert.equal(isH264DirectCopy(AAC_INFO), true);
    assert.equal(isH264DirectCopy({ videoCodec: 'h264', videoPixFmt: 'yuv420p10le' }), false);
    assert.equal(isH264DirectCopy({ videoCodec: 'hevc' }), false);
    assert.equal(isH264DirectCopy(null), false);
  });
});

describe('buildDirectArgs', () => {
  test('lecture simple : 1 entrée, copie vidéo + showinfo, audio par défaut optionnel', () => {
    const args = buildDirectArgs({ ...base, streamInfo: AAC_INFO });
    assert.equal(inputCount(args), 1);
    assert.ok(!args.includes('-ss'));
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 6),
      ['-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'showinfo']);
    assert.equal(args[args.lastIndexOf('-map') + 1], '0:a:0?');
    assert.equal(valueAfter(args, '-c:a'), 'copy');
    assert.equal(args.at(-1), 'pipe:1');
  });

  test('seek placé avant -i', () => {
    const args = buildDirectArgs({ ...base, seekSeconds: 120.5, streamInfo: AAC_INFO });
    assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
    assert.equal(valueAfter(args, '-ss'), '120.5');
  });

  test('piste audio choisie non-AAC : conversion', () => {
    const args = buildDirectArgs({ ...base, audioIndex: 1, streamInfo: AAC_INFO });
    assert.equal(args[args.lastIndexOf('-map') + 1], '0:a:1');
    assert.equal(valueAfter(args, '-c:a'), 'aac');
  });

  test('décalage audio : -itsoffset AVANT une 2e entrée, audio pris sur l\'entrée 1', () => {
    const args = buildDirectArgs({ ...base, seekSeconds: 30, audioIndex: 1, audioOffset: -0.7, streamInfo: AAC_INFO });
    assert.equal(inputCount(args), 2);
    const secondInput = args.lastIndexOf('-i');
    const offsetPos = args.indexOf('-itsoffset');
    assert.ok(offsetPos > args.indexOf('-i') && offsetPos < secondInput, '-itsoffset entre les deux -i');
    assert.equal(args[offsetPos + 1], '-0.7');
    // le seek s'applique aux deux entrées pour rester synchronisées
    assert.equal(args.filter(a => a === '-ss').length, 2);
    assert.ok(args.lastIndexOf('-ss') < secondInput);
    assert.equal(args[args.lastIndexOf('-map') + 1], '1:a:1');
    assert.equal(args[args.indexOf('-map') + 1], '0:v:0');
  });
});

describe('buildTranscodeArgs', () => {
  test('CPU : libx264, -threads avant -i', () => {
    const args = buildTranscodeArgs({ ...base, hwAccel: 'none' });
    assert.equal(valueAfter(args, '-c:v'), 'libx264');
    assert.ok(args.indexOf('-threads') < args.indexOf('-i'));
    assert.equal(valueAfter(args, '-c:a'), 'aac');
  });
  test('VAAPI : périphérique initialisé avant -i', () => {
    const args = buildTranscodeArgs({ ...base, hwAccel: 'vaapi', vaapiDevice: '/dev/dri/renderD128' });
    assert.equal(valueAfter(args, '-init_hw_device'), 'vaapi=va:/dev/dri/renderD128');
    assert.ok(args.indexOf('-init_hw_device') < args.indexOf('-i'));
    assert.equal(valueAfter(args, '-c:v'), 'h264_vaapi');
  });
  test('NVENC', () => {
    assert.equal(valueAfter(buildTranscodeArgs({ ...base, hwAccel: 'nvenc' }), '-c:v'), 'h264_nvenc');
  });
  test('décalage audio : 2 entrées', () => {
    const args = buildTranscodeArgs({ ...base, audioOffset: 1.5, hwAccel: 'none' });
    assert.equal(inputCount(args), 2);
    assert.equal(args[args.lastIndexOf('-map') + 1], '1:a:0?');
  });
});

describe('buildHlsArgs', () => {
  const hls = { ...base, segmentPattern: '/c/hls/p/seg_%05d.ts', m3u8Path: '/c/hls/p/index.m3u8', hwAccel: 'vaapi', vaapiDevice: '/dev/dri/renderD128' };

  test('H.264 : remux sans réencodage même si VAAPI dispo', () => {
    const args = buildHlsArgs({ ...hls, streamInfo: AAC_INFO });
    assert.equal(valueAfter(args, '-c:v'), 'copy');
    assert.equal(valueAfter(args, '-bsf:v'), 'h264_mp4toannexb');
    assert.ok(!args.includes('-init_hw_device'));
    assert.equal(valueAfter(args, '-hls_segment_filename'), hls.segmentPattern);
    assert.equal(args.at(-1), hls.m3u8Path);
  });
  test('HEVC : transcodage matériel', () => {
    const args = buildHlsArgs({ ...hls, streamInfo: { videoCodec: 'hevc', audioTracks: [] } });
    assert.equal(valueAfter(args, '-c:v'), 'h264_vaapi');
    assert.equal(valueAfter(args, '-c:a'), 'aac');
  });
  test('H.264 copié + seek : seek rapide sur l\'image clé, audio copié', () => {
    const args = buildHlsArgs({ ...hls, seekSeconds: 772, streamInfo: AAC_INFO });
    assert.ok(args.includes('-noaccurate_seek'));
    assert.equal(valueAfter(args, '-c:a'), 'copy');
  });
  test('réencodage + seek : seek précis et audio réencodé (sinon timeline décalée)', () => {
    const args = buildHlsArgs({ ...hls, seekSeconds: 772, streamInfo: { videoCodec: 'av1', audioTracks: [{ index: 0, codec: 'aac' }] } });
    assert.ok(!args.includes('-noaccurate_seek'));
    assert.equal(valueAfter(args, '-ss'), '772');
    assert.equal(valueAfter(args, '-c:a'), 'aac');
  });
  test('réencodage sans seek : audio AAC toujours copié', () => {
    const args = buildHlsArgs({ ...hls, streamInfo: { videoCodec: 'av1', audioTracks: [{ index: 0, codec: 'aac' }] } });
    assert.equal(valueAfter(args, '-c:a'), 'copy');
  });
});

describe('buildTranscodeArgs (seek)', () => {
  test('seek précis : vidéo et audio coupés au même instant', () => {
    const args = buildTranscodeArgs({ ...base, seekSeconds: 772, hwAccel: 'none' });
    assert.ok(!args.includes('-noaccurate_seek'));
    assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  });
});
