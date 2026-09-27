const bucket = (o = {}) => ({
  calls: 0, sales: 0, info: 0, other: 0, personal: 0, success: 0, reachable: 0,
  conversion: null, avgScore: null, ...o,
});

const lb = (o = {}) => ({ calls: 0, incoming: 0, outgoing: 0, sales: 0, success: 0, ...o });

const introRow = (o = {}) => ({
  checked: 0, checkedIn: 0, checkedOut: 0, withName: 0, withCompany: 0, withBoth: 0,
  withNameIn: 0, withNameOut: 0, ...o,
});

const MONTHS = [
  { key: '2026-06', title: 'червень 2026' },
  { key: '2026-07', title: 'липень 2026' },
  { key: '2026-08', title: 'серпень 2026' },
];

const example = (quote, extra = {}) => ({
  quote, note: null, at: '2026-06-23T10:42:22.000Z', callId: null, start: null, end: null, ...extra,
});

const finding = (claim, examples) => ({ claim, why: 'бо так показують розмови', action: 'роби інакше', examples });

const manager = (name, byMonth, strengths = [], weaknesses = [], extra = {}) => ({
  name, display: name, byMonth, strengths, weaknesses, analysedDays: 60, days: 93, partial: false, ...extra,
});

const lineManager = (name, display, unknown, all, m6) => ({
  name, display, unknown,
  byMonth: { '2026-06': lb(m6), '2026-07': lb(), '2026-08': lb(), all: lb(all) },
});

const report = {
  generatedAt: '2026-09-22T10:00:00.000Z',
  period: { start: '2026-06-19T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
  totals: {
    calls: 1880, seconds: 142200, hours: 39.5, managers: 3,
    purposes: { sales: 218, info: 567, other: 1086, personal: 9 },
  },
  months: MONTHS,
  directions: {
    sales: { incoming: 118, outgoing: 100, unknown: 0 },
    info: { incoming: 321, outgoing: 246, unknown: 0 },
    other: { incoming: 624, outgoing: 462, unknown: 0 },
    personal: { incoming: 9, outgoing: 0, unknown: 0 },
  },
  lines: [
    {
      number: '901', kind: 'shared', name: null, phone: '0754738200',
      byMonth: {
        '2026-06': lb({ calls: 60, incoming: 58, outgoing: 2, sales: 9, success: 4 }),
        '2026-07': lb({ calls: 40, incoming: 39, outgoing: 1, sales: 3, success: 1 }),
        '2026-08': lb(),
        all: lb({ calls: 100, incoming: 97, outgoing: 3, sales: 12, success: 5 }),
      },
      managers: [
        lineManager('Андрій', 'Андрій', false, { calls: 36, incoming: 36 }, { calls: 20, incoming: 20 }),
        lineManager('Роман', 'Роман', false, { calls: 32, incoming: 32 }, { calls: 18, incoming: 18 }),
        lineManager('Володимир', 'Володимир', false, { calls: 7, incoming: 7 }, { calls: 4, incoming: 4 }),
        lineManager('901', 'None', true, { calls: 25, incoming: 22, outgoing: 3 }, { calls: 18, incoming: 16, outgoing: 2 }),
      ],
    },
    {
      number: '903', kind: 'personal', name: 'Роман', phone: '0734738200',
      byMonth: {
        '2026-06': lb({ calls: 800, incoming: 400, outgoing: 400 }),
        '2026-07': lb({ calls: 711, incoming: 419, outgoing: 292 }),
        '2026-08': lb(),
        all: lb({ calls: 1511, incoming: 819, outgoing: 692, sales: 200, success: 90 }),
      },
    },
  ],
  intro: {
    managers: [
      {
        name: 'Роман', display: 'Роман',
        byMonth: {
          '2026-06': introRow({ checked: 100, checkedIn: 60, checkedOut: 40, withName: 8, withCompany: 2, withBoth: 2 }),
          '2026-07': introRow({ checked: 50, checkedIn: 30, checkedOut: 20, withName: 2 }),
          '2026-08': introRow(),
          all: introRow({ checked: 150, checkedIn: 90, checkedOut: 60, withName: 10, withCompany: 2, withBoth: 2 }),
        },
      },
      {
        name: 'Андрій', display: 'Андрій',
        byMonth: {
          '2026-06': introRow({ checked: 10, checkedIn: 4, checkedOut: 6, withName: 1, withCompany: 1, withBoth: 1 }),
          '2026-07': introRow(),
          '2026-08': introRow(),
          all: introRow({ checked: 10, checkedIn: 4, checkedOut: 6, withName: 1, withCompany: 1, withBoth: 1 }),
        },
      },
    ],
    total: introRow({ checked: 160, withName: 11, withCompany: 3 }),
  },
  managers: [
    manager(
      'Роман',
      {
        '2026-06': bucket({ calls: 30, sales: 10, success: 3, reachable: 9, conversion: 33, avgScore: 6.1, personal: 1 }),
        '2026-07': bucket({ calls: 28, sales: 8, success: 4, reachable: 8, conversion: 50, avgScore: 7.4 }),
        '2026-08': bucket({ calls: 25, sales: 6, success: 4, reachable: 6, conversion: 67, avgScore: 8.2 }),
        all: bucket({ calls: 83, sales: 24, success: 11, reachable: 23, conversion: 48, avgScore: 7.2, personal: 1 }),
      },
      [finding('Добре виявляє потребу', [
        example('А що саме турбує? <b>Опишіть</b> симптоми', { callId: 111, start: 12.5, end: 15, audio: 'audio/aaa111.mp3', audioSeconds: 11 }),
        example('Без таймкоду & без аудіо'),
      ])],
      [finding('Перебиває клієнта', [
        example('Зрозуміло, так ось —', { callId: 222, start: 40, end: 44, audio: 'audio/bbb222.mp3', audioSeconds: 10, note: 'клієнт не договорив' }),
      ])]
    ),
    manager('Андрій', {
      '2026-06': bucket({ calls: 10, sales: 4, success: 1, reachable: 4, conversion: 25, avgScore: 5.5 }),
      '2026-07': bucket(),
      '2026-08': bucket(),
      all: bucket({ calls: 18, sales: 6, success: 3, reachable: 6, conversion: 50, avgScore: 5.8 }),
    }, [], [], { partial: true }),
    manager('Володимир', { all: bucket({ calls: 5 }) }),
  ],
  series: {
    Роман: {
      all: [{ month: '2026-06', sales: 10, success: 3 }],
      '2026-06': [{ day: '2026-06-01', sales: 1, success: 0 }],
    },
  },
  stages: [
    { stage: 'закриття угоди', count: 79 },
    { stage: 'допродаж', count: 9 },
  ],
  declines: {
    buckets: { no_slot: 23, no_parts: 1, out_of_scope: 12 },
    bucketLabels: { no_slot: 'Черга', no_parts: 'Деталі', out_of_scope: 'Не наш профіль' },
    bucketTitles: { no_slot: 'Немає вільного місця', no_parts: 'Відсутність деталей', out_of_scope: 'Не наш профіль' },
    serviceTotal: 36,
    cases: [{
      at: '2026-07-02T09:00:00.000Z', manager: 'Роман', bucket: 'no_slot', bucketLabel: 'Черга',
      bucketTitle: 'Немає вільного місця', reason: 'Зайнято, немає вільного часу',
      quote: 'Сьогодні все розписано', clientName: 'Олег "Петрович"', clientPhone: '+380671112233',
    }],
    reasons: [
      { key: 'busy', label: 'Зайнято, немає вільного часу', side: 'service', count: 20 },
      { key: 'price', label: 'Не влаштувала ціна', side: 'client', count: 9 },
    ],
    coverage: { notBooked: 97, notBookedBlocked: 7, clientExplained: 90, unchecked: 0, blockerUnchecked: 0 },
  },
};

export { report, MONTHS, bucket, lb, introRow };
