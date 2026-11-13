import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { getSetting } from './settings.js';
import { transcribe } from './ai/speech.js';
import { describeImage, photoText } from './ai/vision.js';
import { handleIncoming, addNote } from './inbox.js';

export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export function saveMedia(buffer, ext = 'ogg') {
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext.replace(/[^a-z0-9]/gi, '')}`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
  return file;
}

// A customer sent a voice note: keep the audio, turn it into text, then treat it like a typed message.
export async function handleVoiceNote({ buffer, ext, duration, ...incoming }) {
  const audio = saveMedia(buffer, ext);
  const meta = { audio, duration, voice: true };
  if (!getSetting('voice').enabled) {
    const id = handleIncoming({ ...incoming, text: '🎤 Voice note', meta, autoReply: false });
    if (id) addNote(id, 'Voice notes are not turned into text. Turn it on under AI engine → Voice notes.');
    return;
  }
  try {
    const { text, language } = await transcribe(buffer);
    if (!text) throw new Error('No speech found in the recording');
    handleIncoming({ ...incoming, text, meta: { ...meta, transcribed: true, spokenLanguage: language || null } });
  } catch (err) {
    console.error('[voice] Transcription failed:', err.message);
    const id = handleIncoming({ ...incoming, text: '🎤 Voice note', meta: { ...meta, transcribeError: err.message }, autoReply: false });
    if (id) addNote(id, `Could not turn this voice note into text: ${err.message}`);
  }
}

// A photo (with or without a caption): keep the picture, let the local vision model describe it,
// then treat caption + description like a typed message.
export async function handleImage({ buffer, caption = '', ...incoming }) {
  const image = saveMedia(buffer, 'jpg');
  const meta = { image, caption: caption || null };
  const vision = getSetting('vision');
  let note = null;
  if (vision.enabled) {
    try {
      const description = await describeImage(buffer, caption);
      return handleIncoming({ ...incoming, text: photoText(caption, description), meta: { ...meta, described: true } });
    } catch (err) {
      console.error('[vision] Could not describe the photo:', err.message);
      note = `Could not read this photo: ${err.message}`;
      meta.imageError = err.message;
    }
  } else {
    note = 'Photos are not read by the AI. Turn it on under AI engine → Photos.';
    meta.imageError = 'off';
  }
  // Without a description, a caption can still be answered; a bare photo waits for the team.
  const id = handleIncoming({ ...incoming, text: caption || '📷 Photo', meta, autoReply: !!caption && incoming.autoReply !== false });
  if (id && note) addNote(id, note);
}
