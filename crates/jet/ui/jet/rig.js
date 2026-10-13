// The rig as the page sees it: its type, how a pose is laid out (ten anchors
// of six numbers each) and how a pose becomes an SVG path.

export const ANCHORS = 10;
export const STRIDE = 6; // point x,y · outgoing handle x,y · incoming handle x,y

/**
 * @typedef {object} Rig
 * @property {number} version
 * @property {number} unit
 * @property {number} stroke
 * @property {[number, number]} foot
 * @property {Record<string, number[]>} poses   60 numbers each
 * @property {Record<string, [number, number, number, number]>} eyes   left x,y · right x,y
 * @property {Record<string, [number, number, number]>} palette   r,g,b
 */

/**
 * @param {number[]} pose
 * @returns {string} SVG path data
 */
export function pathFrom(pose) {
  let d = 'M' + pose[0].toFixed(1) + ' ' + pose[1].toFixed(1);
  for (let i = 0; i < ANCHORS; i++) {
    const j = (i + 1) % ANCHORS;
    d += ' C' + pose[i * STRIDE + 2].toFixed(1) + ' ' + pose[i * STRIDE + 3].toFixed(1)
      + ' ' + pose[j * STRIDE + 4].toFixed(1) + ' ' + pose[j * STRIDE + 5].toFixed(1)
      + ' ' + pose[j * STRIDE].toFixed(1) + ' ' + pose[j * STRIDE + 1].toFixed(1);
  }
  return d + ' Z';
}
