-- Which speech-to-text mode produced the stored segments. Needed because the switch to
-- multichannel_output_style=separate only helps calls transcribed AFTER it: older rows keep the
-- chopped-up turns that combined produced, and re-transcribing the whole archive does not fit into
-- one month of ElevenLabs credits. Without a durable marker a second pass could not tell where the
-- first one stopped, and would pay twice for the same calls.
--   'separate'     — per-channel transcription, whole turns, role read from the channel number.
--   'multichannel' — multichannel asked for, but the API answered in the flat shape (fallback).
--   'diarize'      — mono recording, content diarization.
--   'mono'         — checked and skipped: mono audio, re-transcribing cannot improve it.
--   NULL           — produced before 18.11.2026, i.e. unknown; this is what the backfill picks up.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS stt_mode TEXT;
CREATE INDEX IF NOT EXISTS calls_stt_mode ON calls (start_time) WHERE stt_mode IS NULL;
