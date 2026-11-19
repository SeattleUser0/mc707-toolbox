// Export tones from the Sound browser as MC-707 tone bank files (.svz): a folder, the picked sounds, or
// one sound. The files go to the computer's downloads; copy them to the SD card's ROLAND/SOUND folder and
// load a tone on the MC-707 with SOUND > SOUND FILE. Loading one into a clip changes only its sound.
//
// Reads: ZS (through the entries it is given). Calls up the layers through hooks (core/hooks.js).
import { toast } from '../core/dom.js';
import { hooks } from '../core/hooks.js';
import { soundOf } from './zc-sounds.js';
import { SVZ_MAX, svzBanks } from './zc-svz.js';

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
  const { files, leftOut, merged } = svzBanks(tones, name);
  if (!files.length) return (toast('Every one of these tones plays a user sample, so there is nothing to save'), 0);
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
      'Saved ' +
        n +
        ' tone' +
        (n === 1 ? '' : 's') +
        (notes.length ? ' (' + notes.join('; ') + ')' : '') +
        '. Copy to ROLAND/SOUND on the SD card.'
    );
  return saved;
}
