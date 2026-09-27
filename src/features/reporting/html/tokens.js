const PURPOSE_ORDER = ['sales', 'info', 'other', 'personal'];

const PURPOSE_COLORS = { sales: '#3b6fb0', info: '#2f7d58', other: '#8c5aa8', personal: '#7b5334' };

const MANAGER_COLORS = ['#2f7d58', '#3b6fb0', '#b5603a', '#8c5aa8', '#4f7a8c'];

const WORK_DAY_HOURS = 8;

const IN_COLOR = '#2f7d58';

const OUT_COLOR = '#1d4ed8';

const CARD = 'rounded-2xl border border-line bg-card p-4 sm:p-5 mb-4';

const H2 = 'text-lg sm:text-xl font-semibold mb-3';

const H3 = 'text-sm uppercase tracking-wide text-muted font-semibold mt-6 mb-3';

const LEAD = 'text-muted mb-4';

const TAB =
  'rounded-full border border-line bg-[#fafbfc] px-3 py-1.5 text-xs cursor-pointer transition ' +
  'hover:border-muted aria-selected:bg-accent aria-selected:border-accent aria-selected:text-white';

export {
  CARD,
  H2,
  H3,
  IN_COLOR,
  LEAD,
  MANAGER_COLORS,
  OUT_COLOR,
  PURPOSE_COLORS,
  PURPOSE_ORDER,
  TAB,
  WORK_DAY_HOURS,
};
