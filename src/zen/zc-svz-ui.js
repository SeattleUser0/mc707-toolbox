// Export tones from the Sound browser as MC-707 tone bank files (.svz): a folder, the picked sounds, or
// one sound. Or make banks straight from saved MC-707 projects (.mpj), one bank per project, the tone
// records copied as the MC-707 saved them. The files go to the computer's downloads; copy them to the SD card's ROLAND/SOUND folder and
// load a tone on the MC-707 with SOUND > SOUND FILE. Loading one into a clip changes only its sound.
//
// Reads: ZS (through the entries it is given). Calls up the layers through hooks (core/hooks.js).
import { el, toast } from '../core/dom.js';
import { hooks } from '../core/hooks.js';
import { soundOf } from './zc-sounds.js';
import { SVZ_MAX, svzBanks, svzBanksOf, svzProjectTones } from './zc-svz.js';

/**
 * Save library entries as bank files named after `name`. Kits and anything that is not a tone are
 * skipped; so are tones that play a user sample (their sample is not in the file). Returns the number
 * of files saved.
 * @param {object[]} entries  Sound browser entries (ZS.list items)
 * @param {string} name       a folder name, or a tone's name
 */
export async function exportSvz(entries, name) {
  /* the MC-707 shows the tone's own name (16 characters), so the library name goes into the tone */
  const tones = entries
    .filter(e => e.kind === 'tone')
    .map(e => {
      const snd = soundOf(e);
      snd.v['CMN.NAME'] = String(e.name).slice(0, 16);
      return { name: e.name, snd };
    });
  if (!tones.length) return (toast('Only tones go in a .svz bank; there are none here'), 0);
  return saveBanks(svzBanks(tones, name));
}

/* save the files of a bank set and say what went in */
async function saveBanks({ files, leftOut, merged }, label = '') {
  if (!files.length)
    return (toast(label + (label ? 'e' : 'E') + 'very tone plays a user sample, so there is nothing to save'), 0);
  let saved = 0;
  for (const f of files) if (await hooks.saveFile(f.file, new Blob([f.bytes]))) saved++;
  const n = files.reduce((a, f) => a + f.count, 0),
    notes = [
      files.length > 1 ? 'in ' + files.length + ' files of up to ' + SVZ_MAX : '',
      merged ? merged + ' identical copies written once' : '',
      leftOut.length ? leftOut.length + ' left out because they play a user sample' : ''
    ].filter(Boolean);
  if (saved)
    toast(
      (label ? label + 'saved ' : 'Saved ') +
        n +
        ' tone' +
        (n === 1 ? '' : 's') +
        (notes.length ? ' (' + notes.join('; ') + ')' : '') +
        '. Copy to ROLAND/SOUND on the SD card.'
    );
  return saved;
}

/**
 * Ask for MC-707 project files (.mpj, copied off the SD card) and save one tone bank per project,
 * named after the project. Every named tone of its clips, track sounds and user tones goes in, copied
 * byte for byte; the same rules as a folder export (128 a file, duplicates once, sample tones out).
 */
export function projectBanks() {
  const inp = el('input', { type: 'file', accept: '.mpj,.MPJ', multiple: true, style: 'display:none' });
  inp.onchange = async () => {
    const files = [...(inp.files || [])];
    inp.remove();
    for (const f of files) {
      let p = null;
      try {
        p = svzProjectTones(new Uint8Array(await f.arrayBuffer()));
      } catch (e) {
        p = null;
      }
      if (!p) {
        toast(f.name + ' is not an MC-707 project');
        continue;
      }
      if (!p.tones.length) {
        toast(f.name + ' has no named tones');
        continue;
      }
      /* named after the file, as the MC-707 names the project (the name inside can carry a save number) */
      const stem = f.name.replace(/\.mpj$/i, '');
      await saveBanks(svzBanksOf(p.tones, stem), stem + ': ');
    }
  };
  document.body.append(inp);
  inp.click();
}
