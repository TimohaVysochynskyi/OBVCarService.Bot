const DIRECTIONS = ['in', 'out'];

const DIRECTION_LABELS = {
  in: { icon: '📥', title: 'Вхідний', about: 'Клієнт зателефонував нам' },
  out: { icon: '📤', title: 'Вихідний', about: 'Ми зателефонували клієнту' },
};

const BINOTEL_CALL_TYPE = { 0: 'in', 1: 'out' };

function directionOf(callType) {
  if (callType === null || callType === undefined || callType === '') return null;
  return BINOTEL_CALL_TYPE[Number(callType)] ?? null;
}

const directionLabel = (direction) => DIRECTION_LABELS[direction]?.title || null;

export { DIRECTIONS, DIRECTION_LABELS, directionOf, directionLabel };
