import { normalize } from './intro.js';


const MANAGER_ROLE = 'manager';
const CLIENT_ROLE = 'client';
const ROLE_LABELS = { manager: 'Менеджер', client: 'Клієнт' };

const ROLE_OK = 'ok';
const ROLE_INVERTED = 'inverted';
const ROLE_UNCLEAR = 'unclear';

const EDGE = '(?:^|[^\\p{L}])';

const MANAGER_MARKERS = [
  'автосервіс', 'автосервис', 'сервіс', 'сервис', 'сто', 'наш майстер', 'майстер', 'мастер',
  'запиш', 'записати', 'запишу', 'запишемо', 'запис на', 'на яку годину', 'на яке авто', 'яка марка',
  'яке авто', 'яка машина', 'діагностик', 'диагностик', 'вартість', 'коштує', 'стоит', 'по ціні',
  'приїжджайте', 'приезжайте', 'підʼїжджайте', 'подъезжайте', 'чим можу допомогти', 'чем могу помочь',
  'передзвоню', 'перезвоню', 'уточню', 'вільн', 'свободн', 'гарного дня', 'працюємо до', 'гривень', 'грн',
  'у нас є', 'наша адреса', 'запчастин', 'запчаст',
];

const ADDRESS_WORDS = [
  'алло', 'ало', 'алё', 'да', 'так', 'привіт', 'привет', 'вітаю', 'добрий день', 'доброго дня',
  'добрый день', 'здравствуйте', 'здрастуйте', 'слухаю', 'слушаю', 'ну',
];

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function introForms(name) {
  return [
    `(?:це|это)\\s+(?:знову\\s+|снова\\s+)?${name}`,
    `(?:мене|меня)\\s+(?:звати|зовут)\\s+${name}`,
    `(?:звати|зовут)\\s+${name}`,
    `${name}\\s+(?:вас\\s+)?(?:турбує|беспокоит|тревожит)`,
    `${name}\\s+на\\s+(?:зв|связи)`,
  ].map((body) => new RegExp(`${EDGE}${body}`, 'iu'));
}

function addressForms(name) {
  return ADDRESS_WORDS.map((word) => new RegExp(`${EDGE}${escapeRe(word)}[\\s,!.]+${name}`, 'iu'));
}

function speakerOfChannel(speakerIds, channel) {
  const id = `speaker_${channel}`;
  return speakerIds.includes(id) ? id : null;
}

function selfIntroSpeaker(turns, managerName) {
  const name = normalize(managerName).trim();
  if (name.length < 3) return null;
  const escaped = escapeRe(name);
  const intro = introForms(escaped);
  const address = addressForms(escaped);
  for (const turn of turns || []) {
    const text = normalize(turn.text);
    if (!text) continue;
    if (/\?\s*$/.test(text)) continue;
    if (address.some((re) => re.test(text))) continue;
    if (intro.some((re) => re.test(text))) return turn.speaker;
  }
  return null;
}

function keywordSpeaker(turns, speakerIds) {
  const score = Object.fromEntries(speakerIds.map((s) => [s, 0]));
  for (const turn of turns || []) {
    const text = String(turn.text || '').toLowerCase();
    for (const marker of MANAGER_MARKERS) if (text.includes(marker)) score[turn.speaker] += 1;
  }
  let best = null;
  let bestScore = 0;
  for (const sid of speakerIds) {
    if (score[sid] > bestScore) {
      bestScore = score[sid];
      best = sid;
    }
  }
  return best;
}

function transcriptFromSegments(segments) {
  return (segments || [])
    .map((s) => `${s.role === MANAGER_ROLE ? ROLE_LABELS.manager : ROLE_LABELS.client}: ${s.text}`)
    .join('\n\n');
}

function invertRoles(segments) {
  return (segments || []).map((s) => ({
    ...s,
    role: s.role === MANAGER_ROLE ? CLIENT_ROLE : MANAGER_ROLE,
  }));
}

function channelRatios({ manager, client }, managerChannel) {
  if (!manager || !client) return null;
  const ours = managerChannel === 1 ? 1 : 0;
  const theirs = ours === 1 ? 0 : 1;
  return {
    manager: manager[ours] / (manager[theirs] || 1),
    client: client[theirs] / (client[ours] || 1),
  };
}

function channelVerdict(energy, { managerChannel, margin }) {
  const ratio = channelRatios(energy, managerChannel);
  if (!ratio) return ROLE_UNCLEAR;
  if (ratio.manager > margin && ratio.client > margin) return ROLE_OK;
  if (ratio.manager < 1 / margin && ratio.client < 1 / margin) return ROLE_INVERTED;
  return ROLE_UNCLEAR;
}

export {
  MANAGER_ROLE,
  CLIENT_ROLE,
  ROLE_OK,
  ROLE_INVERTED,
  ROLE_UNCLEAR,
  speakerOfChannel,
  selfIntroSpeaker,
  keywordSpeaker,
  transcriptFromSegments,
  invertRoles,
  channelRatios,
  channelVerdict,
};
