// ZEN-Core tone bank files (.svz): write them from library tones, and read them back as a container.
// The MC-707 loads these with SOUND > SOUND FILE from the SD card's ROLAND/SOUND folder. A bank is the
// same 1632-byte tone records as the update file and projects (zc-factory.js), inside a small container:
//
//   0x00  'SVZa', area count 2, revision 2, 6-byte stamp 'KY019$', 4 zero bytes
//   0x10  area table: 'DIFa' 'ZCOR' offset size, then 'PATa' 'ZCOR' offset size
//   0x30  DIFa: count 1, record size 32, info 20, 0, CRC-32, 32 zero bytes (a blank origin stamp)
//   0x64  PATa: count N, record size 1632, info 16+4N, 0, N CRC-32 words, then the N records
//
// Tested on an MC-707 at system 1.82: it loads these files, every parameter of a loaded tone reads back
// over SysEx as written, banks of up to 128 tones list in order and load the right record, and a tone
// loaded into a clip leaves the clip's notes, steps and motion alone. 128 is the most tones a bank holds
// here, because no larger bank has been tried; longer lists are split.
//
// Tones that play a user sample or multisample are left out by default: the sample stays in the project
// it came from, so the tone would be silent or wrong anywhere else.
//
// Container layout and checks from github.com/SeattleUser0/mc707-svz (MIT), whose container logic came
// from FANTOM Librarian (github.com/blackjid/fantom-librarian, MIT).
//
// Owns nothing. Reads nothing. Pure functions.
import { CRC_T } from '../core/crc.js';
import { FW_REC, fwRecord, fwTone } from './zc-factory.js';

/** Most tones in one bank: the largest size tested on an MC-707. */
export const SVZ_MAX = 128;
/* the preamble stamp: FANTOM's, which the MC-707 loads (so does ZENOLOGY's RC001) */
const STAMP = [0x4b, 0x59, 0x30, 0x31, 0x39, 0x24];

const crc32 = b => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put32 = (b, o, x) => {
  for (let i = 0; i < 4; i++) b[o + i] = (x >>> (8 * i)) & 0xff;
};
const text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/* one area's body: count, record size, info length, 0, a CRC per record, then the records */
function area(records, size) {
  const n = records.length,
    info = 16 + 4 * n,
    out = new Uint8Array(info + n * size);
  put32(out, 0, n);
  put32(out, 4, size);
  put32(out, 8, info);
  records.forEach((r, i) => {
    put32(out, 16 + 4 * i, crc32(r));
    out.set(r, info + i * size);
  });
  return out;
}

/**
 * A bank file from tone records (each FW_REC bytes, in bank order). Throws on none or more than SVZ_MAX.
 * @param {Uint8Array[]} records
 * @returns {Uint8Array}
 */
export function svzBuild(records) {
  if (!records.length) throw new Error('a bank needs at least one tone');
  if (records.length > SVZ_MAX) throw new Error('more than ' + SVZ_MAX + ' tones in one bank');
  const areas = [
    ['DIFa', area([new Uint8Array(32)], 32)],
    ['PATa', area(records, FW_REC)]
  ];
  const head = 0x10 + 16 * areas.length,
    out = new Uint8Array(head + areas.reduce((n, [, b]) => n + b.length, 0));
  out.set([0x53, 0x56, 0x5a, 0x61, areas.length, areas.length, ...STAMP]);
  let at = head;
  areas.forEach(([tag, body], i) => {
    const e = 0x10 + 16 * i;
    out.set(
      [...tag, ...'ZCOR'].map(c => c.charCodeAt(0)),
      e
    );
    put32(out, e + 8, at);
    put32(out, e + 12, body.length);
    out.set(body, at);
    at += body.length;
  });
  return out;
}

/**
 * Read a bank file's container: {records, problems}. records are the tone records of its PATa area
 * (none when it has no PATa, as model expansion files with only MDLa do). problems lists what does not
 * check out (a CRC, a size, an area past the end); a record whose CRC is wrong is still returned.
 * Not an .svz at all: {records: [], problems: ['not a ZEN-Core sound file']}.
 * @param {Uint8Array} b
 */
export function svzRead(b) {
  if (b.length < 0x10 || text(b, 0, 4) !== 'SVZa') return { records: [], problems: ['not a ZEN-Core sound file'] };
  const problems = [],
    records = [];
  for (let i = 0; i < b[4]; i++) {
    const e = 0x10 + 16 * i,
      tag = text(b, e, 4),
      off = u32(b, e + 8),
      size = u32(b, e + 12);
    if (e + 16 > b.length || off + size > b.length || size < 16) {
      problems.push(tag + ' does not fit in the file');
      continue;
    }
    if (tag !== 'PATa') continue;
    const n = u32(b, off),
      rs = u32(b, off + 4),
      info = u32(b, off + 8);
    if (rs !== FW_REC || info + n * rs !== size) {
      problems.push('PATa: ' + n + ' records of ' + rs + ' bytes do not fill its ' + size + ' bytes');
      continue;
    }
    for (let k = 0; k < n; k++) {
      const r = b.slice(off + info + k * rs, off + info + (k + 1) * rs);
      if (crc32(r) !== u32(b, off + 16 + 4 * k)) problems.push('tone ' + (k + 1) + ': checksum does not match');
      records.push(r);
    }
  }
  return { records, problems };
}

/**
 * The tones of a bank file: {tones: [{name, snd}], skipped, problems}. skipped counts records that do not
 * decode (a value outside the MC-707's range) and blank ones. An empty result with no problems means the
 * file has no tone area.
 * @param {Uint8Array} b
 */
export function svzTones(b) {
  const { records, problems } = svzRead(b),
    tones = [];
  let skipped = 0;
  for (const r of records) {
    const snd = fwTone(r, 0),
      name = snd && snd.v['CMN.NAME'];
    if (!snd || !name || /^init tone$/i.test(name)) skipped++;
    else tones.push({ name, snd });
  }
  return { tones, skipped, problems };
}

/**
 * What a tone plays from a user sample or multisample: the partials that are on, use a PCM wave and
 * point at wave group 2 (user sample) or 3 (multisample). Such a tone needs its project's samples.
 * @param {{v:object}} snd
 * @returns {string[]} e.g. ['partial 2 plays user sample 7']
 */
export function svzNeedsSample(snd) {
  const v = snd.v,
    out = [];
  for (let p = 0; p < 4; p++) {
    const g = v['PTL' + p + '.WAV_GTYPE'];
    if (g !== 2 && g !== 3) continue;
    if (v['PMT.PMT' + (p + 1) + '_PTL_SW'] !== 1 || v['SPTL' + p + '.OSC_TYPE'] !== 0) continue;
    out.push(
      'partial ' + (p + 1) + ' plays ' + (g === 2 ? 'user sample ' : 'multisample ') + v['PTL' + p + '.WAV_NUM_L']
    );
  }
  return out;
}

/* a name the MC-707's sound file browser shows: up to 8 letters and digits, upper case */
const stemOf = s =>
  (
    String(s)
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase() || 'TONES'
  ).slice(0, 8);

/**
 * Bank files for a list of tones: [{file, bytes, count}], plus leftOut [{name, why}] (they play a sample)
 * and merged (how many were byte for byte the same as an earlier tone and written once). More than
 * SVZ_MAX tones make several files: NAME.SVZ, NAME2.SVZ ... Tones that share a name but differ are all kept.
 * @param {{name:string, snd:{v:object}}[]} list  tones (kind 'tone'), in bank order
 * @param {string} name  what to call the file (a folder name, say)
 * @param {boolean} [withSamples=false]  keep tones that play a user sample
 */
export function svzBanks(list, name, withSamples = false) {
  const leftOut = [],
    seen = new Set(),
    records = [];
  let merged = 0;
  for (const { name: nm, snd } of list) {
    const why = svzNeedsSample(snd);
    if (why.length && !withSamples) {
      leftOut.push({ name: nm, why: why.join(', ') });
      continue;
    }
    const r = fwRecord(snd, new Uint8Array(FW_REC)),
      key = r.join(',');
    if (seen.has(key)) {
      merged++;
      continue;
    }
    seen.add(key);
    records.push(r);
  }
  const stem = stemOf(name),
    files = [];
  for (let i = 0; i < records.length; i += SVZ_MAX) {
    const k = i / SVZ_MAX,
      file = k ? stem.slice(0, 8 - String(k + 1).length) + (k + 1) : stem;
    const part = records.slice(i, i + SVZ_MAX);
    files.push({ file: file + '.SVZ', bytes: svzBuild(part), count: part.length });
  }
  return { files, leftOut, merged };
}
