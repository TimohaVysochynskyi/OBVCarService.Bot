import { decodePcm } from './ffmpeg.js';
import { probeChannels } from './meta.js';
import { MANAGER_ROLE } from '../../domain/call/roles.js';


const SAMPLE_RATE = 8000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2;

function rmsOfSpan(pcm, from, to) {
  const frames = Math.floor(pcm.length / BYTES_PER_FRAME);
  const first = Math.max(0, Math.floor(from * SAMPLE_RATE));
  const last = Math.min(frames, Math.ceil(to * SAMPLE_RATE));
  let left = 0;
  let right = 0;
  let counted = 0;
  for (let i = first; i < last; i += 1) {
    const a = pcm.readInt16LE(i * BYTES_PER_FRAME);
    const b = pcm.readInt16LE(i * BYTES_PER_FRAME + 2);
    left += a * a;
    right += b * b;
    counted += 1;
  }
  if (!counted) return [0, 0];
  return [Math.sqrt(left / counted), Math.sqrt(right / counted)];
}

function weightedMeans(pcm, segments) {
  const sides = { manager: [0, 0, 0], client: [0, 0, 0] };
  for (const seg of segments || []) {
    if (seg?.start == null || seg?.end == null || seg.end <= seg.start) continue;
    const [left, right] = rmsOfSpan(pcm, seg.start, seg.end);
    const span = seg.end - seg.start;
    const side = seg.role === MANAGER_ROLE ? sides.manager : sides.client;
    side[0] += left * span;
    side[1] += right * span;
    side[2] += span;
  }
  if (!sides.manager[2] || !sides.client[2]) return null;
  return {
    manager: [sides.manager[0] / sides.manager[2], sides.manager[1] / sides.manager[2]],
    client: [sides.client[0] / sides.client[2], sides.client[1] / sides.client[2]],
  };
}

async function measureRoleChannels(filePath, segments) {
  const channels = await probeChannels(filePath);
  if (!channels || channels < CHANNELS) return { mono: true, manager: null, client: null };
  const pcm = await decodePcm(filePath, { rate: SAMPLE_RATE, channels: CHANNELS });
  const means = weightedMeans(pcm, segments);
  if (!means) return { mono: false, manager: null, client: null };
  return { mono: false, ...means };
}

export { measureRoleChannels };
