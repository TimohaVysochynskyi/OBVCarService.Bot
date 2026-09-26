import { PERSONAL_OPERATORS } from '../../core/phoneLines.js';

const jsonParam = (v) => (v == null ? null : JSON.stringify(v));

const PERSONAL_EXTENSIONS = Object.keys(PERSONAL_OPERATORS);

const SALES_FILTER = `(call_purpose = 'sales' OR call_purpose IS NULL)`;

const BLOCKED_FILTER = `deal_blocker IN ('no_slot','no_parts','out_of_scope')`;

const NOT_BLOCKED_FILTER = `(deal_blocker IS NULL OR deal_blocker NOT IN ('no_slot','no_parts','out_of_scope'))`;

const BLOCKER_COLUMNS_SQL = `
       COUNT(*) FILTER (WHERE ${SALES_FILTER} AND (${NOT_BLOCKED_FILTER} OR is_success))::int AS "reachableCount",
       COUNT(*) FILTER (WHERE ${BLOCKED_FILTER})::int AS "blockedCount",
       COUNT(*) FILTER (WHERE deal_blocker = 'no_slot')::int AS "blockedNoSlot",
       COUNT(*) FILTER (WHERE deal_blocker = 'no_parts')::int AS "blockedNoParts",
       COUNT(*) FILTER (WHERE deal_blocker = 'out_of_scope')::int AS "blockedOutOfScope"`;

const HAS_TEXT = `transcript IS NOT NULL AND transcript <> ''`;

const KYIV_MONTH = `to_char(start_time AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM')`;

const IS_PERSON = `manager_name !~ '^[0-9]+$'`;

export {
  jsonParam,
  PERSONAL_EXTENSIONS,
  SALES_FILTER,
  BLOCKED_FILTER,
  NOT_BLOCKED_FILTER,
  BLOCKER_COLUMNS_SQL,
  HAS_TEXT,
  KYIV_MONTH,
  IS_PERSON,
};
