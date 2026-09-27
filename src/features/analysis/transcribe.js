import { withRetry } from '../../shared/retry.js';
import { fetchOk } from '../../shared/http.js';
import { transcribeDiarized } from '../../platform/elevenlabs/client.js';

async function toBlob(audio) {
  if (typeof audio === 'string') {
    const blob = await withRetry(
      async () => {
        console.log(`[transcribe] downloading recording from ${audio}`);
        const res = await fetchOk('recording', 'завантаження запису', audio);
        return res.blob();
      },
      { attempts: 3, delayMs: 1000, label: 'download recording' }
    );
    return blob;
  }
  if (Buffer.isBuffer(audio)) return new Blob([audio], { type: 'audio/mpeg' });
  if (audio && typeof audio.arrayBuffer === 'function') return audio;
  throw new Error('transcribeAudio: expected a Buffer, Blob or URL string');
}

async function transcribeAudio(audio, { managerName, audioPath } = {}) {
  const audioBlob = await toBlob(audio);
  console.log(`[transcribe] audio ready: ${audioBlob.size} bytes`);

  const result = await transcribeDiarized(audioBlob, managerName, { audioPath });
  console.log(
    `[transcribe] ElevenLabs OK — ${result.transcript.length} chars (diarized, ${result.segments?.length ?? 0} segments)`
  );
  return result;
}

export { transcribeAudio };
