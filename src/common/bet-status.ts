/**
 * Canonical bet-status sets shared by the RG session accounting (BetsService.
 * sessionAccounting) and the operator REPORTING aggregation (ReportingService) so
 * the two money definitions can NEVER drift. Single source of truth.
 *
 *  - WAGERED = the stake was actually DEBITED. Excludes `reserving` (pre-debit) and
 *    `cancelling`/`cancelled` (refunded). An UNSETTLED `active` stake counts fully
 *    toward wagered (at-risk), the protective direction.
 *  - WON = a settled (or owed-but-claimed) win. `payout_pending` is an owed win.
 *
 * `betCount` in reporting counts rows in the WAGERED set (real placed stakes).
 */
export const WAGERED_STATUSES = ["active", "cashed_out", "busted", "payout_pending"] as const;
export const WON_STATUSES = ["cashed_out", "payout_pending"] as const;

const WAGERED_SET: ReadonlySet<string> = new Set(WAGERED_STATUSES);
const WON_SET: ReadonlySet<string> = new Set(WON_STATUSES);

export const isWageredStatus = (status: string): boolean => WAGERED_SET.has(status);
export const isWonStatus = (status: string): boolean => WON_SET.has(status);
