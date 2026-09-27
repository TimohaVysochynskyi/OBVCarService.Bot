import { PURPOSE_LABELS } from '../../../domain/call/purpose.js';
import { esc, plural, share } from './format.js';
import { PURPOSE_COLORS, PURPOSE_ORDER } from './tokens.js';
import { arrow } from './widgets.js';

function categoryTable(purposes, directions, total) {
  const rows = PURPOSE_ORDER.map((p) => {
    const count = purposes[p] || 0;
    const dir = directions[p] || { incoming: 0, outgoing: 0 };
    return `<tr class="border-b border-line last:border-0">
        <th scope="row" class="py-2 pr-2 text-left font-normal">
          <span class="mr-2 inline-block h-3 w-3 shrink-0 rounded-sm align-middle" style="background:${PURPOSE_COLORS[p]}"></span>${esc(PURPOSE_LABELS[p].plural)}
        </th>
        <td class="border-l border-line px-2 py-2 text-right font-semibold tabular-nums">${count}</td>
        <td class="border-l border-line px-2 py-2 text-right tabular-nums">${esc(share(count, total))}</td>
        <td class="border-l border-line px-2 py-2 text-right tabular-nums">${dir.incoming}</td>
        <td class="border-l border-line px-2 py-2 text-right tabular-nums">${dir.outgoing}</td>
      </tr>`;
  }).join('');

  const totalIn = PURPOSE_ORDER.reduce((n, p) => n + (directions[p]?.incoming || 0), 0);
  const totalOut = PURPOSE_ORDER.reduce((n, p) => n + (directions[p]?.outgoing || 0), 0);

  return `<div class="-mx-1 max-w-full overflow-x-auto px-1"><table class="w-auto border-collapse text-sm">
      <thead class="text-muted">
        <tr class="border-b border-line font-bold text-ink">
          <th class="py-2 pr-2 text-left">Категорія</th>
          <th class="border-l border-line px-2 py-2 text-right">Усього</th>
          <th class="border-l border-line px-2 py-2 text-right">Частка</th>
          <th class="border-l border-line px-2 py-2 text-right whitespace-nowrap">${arrow('in')} Вхідні</th>
          <th class="border-l border-line px-2 py-2 text-right whitespace-nowrap">${arrow('out')} Вихідні</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="border-t-2 border-line font-bold">
          <th scope="row" class="py-2 pr-2 text-left">Разом</th>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">${total}</td>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">100%</td>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">${totalIn}</td>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">${totalOut}</td>
        </tr>
      </tfoot>
    </table></div>`;
}

export {
  categoryTable,
};
