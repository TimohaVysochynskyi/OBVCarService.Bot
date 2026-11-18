import { engineStatsText } from './engineStats.js';
import { showScreen } from '../../platform/telegram/ui.js';
import { mainMenu } from '../menu/keyboards.js';

async function openEngineStats(ctx) {
  const text = await engineStatsText();
  await showScreen(ctx, text, mainMenu(ctx.role));
}

export { openEngineStats };
