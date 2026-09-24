// Loads every module that declares an editable prompt, so /prompt shows the full list.
//
// ⚠️ Without this, a prompt would be missing from the menu purely because the bot happened not to
// import the module that defines it — and it would look like the feature lost a setting rather than
// like a missing import. Adding a prompt anywhere means adding its module here.

import '../core/callPurpose.js';
import '../core/managerIntro.js';
import '../core/analyzeCall.js';
import '../core/classifyCall.js';
import '../core/dealBlocker.js';
import '../core/clientDecline.js';
import '../core/classifyPersonal.js';
import '../core/identifyManager.js';
import './analyze.js';
import './kb.js';

export { listPrompts, promptsInGroup, groupsOf, entryOf, promptInfo, savePrompt, resetPrompt, jobOf, JOBS } from '../core/prompts.js';
