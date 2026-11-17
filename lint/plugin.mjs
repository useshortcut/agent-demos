import { logOnlySummaries } from './log-only-summaries.mjs';
import { paginateV4Lists } from './paginate-v4-lists.mjs';
import { switchOnDiscriminant } from './switch-on-discriminant.mjs';

export const rules = {
  'switch-on-discriminant': switchOnDiscriminant,
  'paginate-v4-lists': paginateV4Lists,
  'log-only-summaries': logOnlySummaries,
};

export default { meta: { name: 'agent-demos' }, rules };
