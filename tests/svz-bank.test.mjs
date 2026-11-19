// Tone bank files (.svz, zen/zc-svz.js): the container the MC-707 loads with SOUND > SOUND FILE.
// Written from library tones, read back as a container (any number of tones, checksums checked), at
// most 128 tones a file (the largest bank tried on an MC-707 at system 1.82), identical tones written
// once, tones that play a user sample left out. The layout is the one an MC-707 loaded and read back
// parameter for parameter (github.com/SeattleUser0/mc707-svz, docs/04-hardware-test-record.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, closeBrowser } from './helpers.mjs';

after(closeBrowser);

/* tones made in the page: n of them, each a little different, named T001 ... */
const MAKE = `const { FW_REC, fwRecord, newSound } = window.__app.zen.fw;
  const S = window.__app.zen.svz;
  const tone = (i, extra = {}) => {
    const snd = newSound('tone');
    snd.v['CMN.NAME'] = 'T' + String(i).padStart(3, '0');
    snd.v['CMN.LEVEL'] = i % 128;
    Object.assign(snd.v, extra);
    return { name: snd.v['CMN.NAME'], snd };
  };
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;`;

test('SVZ banks: the container is laid out byte for byte as the MC-707 loads it, and reads back', async () => {
  const { page, errors } = await openApp();
  const r = await page.evaluate(`(() => { ${MAKE}
    const list = [tone(1), tone(2), tone(3)];
    const recs = list.map(t => fwRecord(t.snd, new Uint8Array(FW_REC)));
    const b = S.svzBuild(recs);
    const head = String.fromCharCode(...b.subarray(0, 4)) + ' ' + [...b.subarray(4, 16)].join(',');
    const table = [String.fromCharCode(...b.subarray(0x10, 0x18)), u32(b, 0x18), u32(b, 0x1c),
      String.fromCharCode(...b.subarray(0x20, 0x28)), u32(b, 0x28), u32(b, 0x2c)];
    const back = S.svzRead(b), tones = S.svzTones(b);
    /* one flipped bit in tone 2 is caught; the other tones still come back */
    const bad = b.slice(); bad[0x64 + 16 + 4 * 3 + FW_REC + 100] ^= 1;
    return { len: b.length, head, table, n: back.records.length, problems: back.problems,
      same: back.records.every((x, i) => x.every((y, k) => y === recs[i][k])),
      names: tones.tones.map(t => t.name), level: tones.tones[2].snd.v['CMN.LEVEL'],
      bad: S.svzRead(bad).problems, notSvz: S.svzRead(new Uint8Array(64)).problems };
  })()`);
  assert.equal(r.len, 116 + 1636 * 3, 'size: 116 + 1636 per tone');
  assert.equal(r.head, 'SVZa 2,2,75,89,48,49,57,36,0,0,0,0', 'SVZa, two areas, stamp KY019$');
  assert.deepEqual(r.table, ['DIFaZCOR', 0x30, 52, 'PATaZCOR', 0x64, 16 + 4 * 3 + 1632 * 3]);
  assert.equal(r.n, 3);
  assert.deepEqual(r.problems, []);
  assert.ok(r.same, 'the records come back unchanged');
  assert.deepEqual(r.names, ['T001', 'T002', 'T003']);
  assert.equal(r.level, 3);
  assert.deepEqual(r.bad, ['tone 2: checksum does not match']);
  assert.deepEqual(r.notSvz, ['not a ZEN-Core sound file']);
  assert.deepEqual(errors, []);
});

test('SVZ banks: a bank of fewer than 8 tones imports (the old scan needed 8 in a row)', async () => {
  const { page, errors } = await openApp();
  const r = await page.evaluate(`(() => { ${MAKE}
    const b = S.svzBuild([tone(1), tone(2)].map(t => fwRecord(t.snd, new Uint8Array(FW_REC))));
    return { container: S.svzTones(b).tones.length, scan: window.__app.zen.fw.fwTones(b).length };
  })()`);
  assert.equal(r.container, 2);
  assert.equal(r.scan, 0, 'the run scan finds nothing in a small bank, which is why import reads the container');
  assert.deepEqual(errors, []);
});

test('SVZ banks: 128 tones a file, identical tones once, sample tones left out, same names kept', async () => {
  const { page, errors } = await openApp();
  const r = await page.evaluate(`(() => { ${MAKE}
    const many = Array.from({ length: 130 }, (_, i) => tone(i + 1));
    /* partial 2 on, PCM, user sample 7: not portable. Partial 3 points at a sample but is off: harmless */
    const smp = tone(900, { 'PMT.PMT2_PTL_SW': 1, 'PTL1.WAV_GTYPE': 2, 'PTL1.WAV_NUM_L': 7, 'SPTL1.OSC_TYPE': 0,
      'PTL2.WAV_GTYPE': 2 });
    const off = tone(901, { 'PTL2.WAV_GTYPE': 2, 'PTL2.WAV_NUM_L': 3 });
    const twin = tone(902, { 'CMN.NAME': 'T001' }); /* T001's name, different settings */
    const out = S.svzBanks([...many, many[0], smp, off, twin], 'Big Show!');
    const read = out.files.map(f => S.svzTones(f.bytes).tones.map(t => t.name));
    let threw = '';
    try { S.svzBuild(Array(129).fill(new Uint8Array(FW_REC))); } catch (e) { threw = e.message; }
    return { files: out.files.map(f => [f.file, f.count]), merged: out.merged, leftOut: out.leftOut,
      last: read[1], firstOfSecond: read[1][0], threw, needs: S.svzNeedsSample(smp.snd), offNeeds: S.svzNeedsSample(off.snd) };
  })()`);
  assert.deepEqual(
    r.files,
    [
      ['BIGSHOW.SVZ', 128],
      ['BIGSHOW2.SVZ', 4]
    ],
    'split at 128, named for the folder'
  );
  assert.equal(r.merged, 1, 'the second copy of T001 is written once');
  assert.deepEqual(r.leftOut, [{ name: 'T900', why: 'partial 2 plays user sample 7' }]);
  assert.deepEqual(r.last, ['T129', 'T130', 'T901', 'T001'], 'order kept; a different tone named T001 is kept');
  assert.match(r.threw, /more than 128/);
  assert.deepEqual(r.offNeeds, [], 'a sample on a partial that is off does not count');
  assert.deepEqual(errors, []);
});

test('SVZ banks: a folder saved from the Sound browser is a bank of its tones', async () => {
  const { page, errors } = await openApp();
  const z = 'window.__app.zen';
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.evaluate(`${z}.open(3, 0)`);
  await page.waitForTimeout(400);
  await page.evaluate(`${z}.browse()`);
  await page.waitForSelector('#zbOv');
  for (const name of ['Alpha', 'Bravo']) {
    await page.locator('#zbOv button', { hasText: 'Save this tone' }).click();
    await page.fill('#zbOv .zbName', name);
    await page.locator('#zbOv .zbForm button', { hasText: 'Save' }).click();
    await page.waitForTimeout(150);
  }
  await page.evaluate(`${z}.ZS.list.forEach(e => e.src === 'mine' && (e.folder = 'Leads'))`);
  await page.evaluate(`${z}.browse()`);
  await page.waitForSelector('#zbOv .zbBk:has-text("Leads")');
  await page.locator('#zbOv .zbBk', { hasText: 'Leads' }).click({ button: 'right' });
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.cmenu button.cmi', { hasText: 'Save the folder as a .svz tone bank…' }).click()
  ]);
  assert.equal(dl.suggestedFilename(), 'LEADS.SVZ');
  const bytes = [...(await import('node:fs')).readFileSync(await dl.path())];
  const r = await page.evaluate(b => {
    const x = window.__app.zen.svz.svzTones(Uint8Array.from(b));
    return { problems: x.problems, names: x.tones.map(t => t.name) };
  }, bytes);
  assert.deepEqual(r.problems, []);
  /* each tone carries its library name, which is what the MC-707's sound browser shows */
  assert.deepEqual(r.names.sort(), ['Alpha', 'Bravo']);
  assert.deepEqual(errors, []);
});

/* a project file with just enough for the reader: PRJ5, a section table, the clip tone bank (8 x 17) and
   the 64 user tones; everything else zero */
const PROJECT = `const PRJA = 0x100, prjSize = 0x3112f0 + 136 * FW_REC, USRA = PRJA + prjSize;
  const u8 = new Uint8Array(USRA + 0x10 + 64 * FW_REC);
  const put = (o, t) => [...t].forEach((c, i) => (u8[o + i] = c.charCodeAt(0)));
  const p32 = (o, x) => new DataView(u8.buffer).setUint32(o, x, true);
  put(2, 'PRJ5'); put(0x10, 'PRJaMC77'); p32(0x18, PRJA); p32(0x1c, prjSize);
  put(0x20, 'USRaMC77'); p32(0x28, USRA); p32(0x2c, 0x10 + 64 * FW_REC);
  put(PRJA + 0x10, 'My Show');
  const slot = (t, k, rec) => u8.set(rec, PRJA + 0x3112f0 + (t * 17 + k) * FW_REC);
  const user = (n, rec) => u8.set(rec, USRA + 0x10 + n * FW_REC);
  const rec = t => fwRecord(t.snd, new Uint8Array(FW_REC));`;

test('SVZ banks: a saved project becomes a bank, records copied as saved', async () => {
  const { page, errors } = await openApp();
  const r = await page.evaluate(`(() => { ${MAKE} ${PROJECT}
    const lead = rec(tone(1)); lead[18] = 240; lead[45] = 100; /* phrase bytes, as MC-707 projects hold them */
    const wide = rec(tone(2)); wide[330] = 64;                   /* a pan one above Roland's range, as saved */
    slot(0, 0, lead); slot(0, 3, lead); slot(0, 16, lead);       /* one tone in three slots */
    slot(2, 5, wide);
    slot(3, 0, rec(tone(900, { 'PMT.PMT2_PTL_SW': 1, 'PTL1.WAV_GTYPE': 2, 'PTL1.WAV_NUM_L': 7 })));
    slot(4, 0, rec({ snd: newSound('tone') }));                  /* Roland's initial tone: skipped */
    user(0, rec(tone(3)));
    const p = S.svzProjectTones(u8);
    const out = S.svzBanksOf(p.tones, p.project);
    const back = S.svzRead(out.files[0].bytes).records;
    return { project: p.project, where: p.tones.map(t => t.where), files: out.files.map(f => [f.file, f.count]),
      merged: out.merged, leftOut: out.leftOut, phrase: [back[0][18], back[0][45]], pan: back[1][330],
      notProject: S.svzProjectTones(new Uint8Array(100)) };
  })()`);
  assert.equal(r.project, 'My Show');
  assert.deepEqual(r.where, [
    'track 1 clip 1',
    'track 1 clip 4',
    'track 1 track sound',
    'track 3 clip 6',
    'track 4 clip 1',
    'user tone 1'
  ]);
  assert.deepEqual(r.files, [['MYSHOW.SVZ', 3]]);
  assert.equal(r.merged, 2, 'the tone in three slots is written once');
  assert.deepEqual(r.leftOut, [{ name: 'T900', why: 'partial 2 plays user sample 7' }]);
  assert.deepEqual(r.phrase, [240, 100], 'reserved phrase bytes kept');
  assert.equal(r.pan, 64, 'an out-of-range value kept as saved');
  assert.equal(r.notProject, null);
  assert.deepEqual(errors, []);
});
