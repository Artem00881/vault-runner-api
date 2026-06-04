import type { LedgerType, LedgerRef } from "./ledger.service";
import type { WalletProvider, WalletTxResult } from "./wallet-provider";

/**
 * Per-wallet money router for demo / fun mode (Phase 3).
 *
 * In operator (real-money) mode the active WalletProvider is the operator's
 * seamless wallet. But a DEMO ("fun mode") session must play with PLAY MONEY and
 * must NEVER touch the operator's real wallet — including on the out-of-band
 * paths (server-driven auto-cashout, the payout reconciler, the reserving sweep)
 * that carry no socket / JWT and read only persisted rows.
 *
 * This router is the SINGLE money-routing choke point: every debit / credit /
 * rollback / getBalance is dispatched purely by `walletId` to either the internal
 * play-money ledger (demo) or the operator wallet (real). Demo and real wallets
 * are physically distinct journals — a demo session keys its wallet under a
 * separate `:demo` user tag — so `walletId` alone is a sufficient, tamper-proof
 * routing key: nothing the client sends can move a wallet's money to the wrong
 * source. BetsService / WalletController keep injecting the single WALLET_PROVIDER
 * and change zero money-call lines; the demo decision lives only here.
 *
 * FAIL-SAFE: routing keys on a wallet's persisted mode (via `isDemoWallet`). A wallet
 * with no session is play money (ledger). A genuine lookup error PROPAGATES — the
 * money move fails CLOSED into the recovery machinery (a credit → payout_pending →
 * reconciler; a debit → reservation released), never fail-OPEN to a fabricated ledger
 * credit for a real payout. Either way an unsure call NEVER reaches the operator's
 * real wallet: the threat we defend against is spending REAL operator money for a
 * play session.
 *
 * Only constructed in operator mode. Internal mode keeps using LedgerService
 * directly (everything is already play money — nothing to route).
 */
export class WalletRouter implements WalletProvider {
  constructor(
    private readonly ledger: WalletProvider, // internal play-money ledger (demo)
    private readonly operator: WalletProvider, // seamless operator wallet (real money)
    /** walletId → is this a demo (play-money) wallet? Fail-safe TRUE on any doubt. */
    private readonly isDemoWallet: (walletId: string) => Promise<boolean>,
  ) {}

  private async pick(walletId: string): Promise<WalletProvider> {
    return (await this.isDemoWallet(walletId)) ? this.ledger : this.operator;
  }

  async debit(
    walletId: string,
    amount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult> {
    return (await this.pick(walletId)).debit(walletId, amount, type, idempotencyKey, ref);
  }

  async credit(
    walletId: string,
    amount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult> {
    return (await this.pick(walletId)).credit(walletId, amount, type, idempotencyKey, ref);
  }

  async rollback(walletId: string, idempotencyKey: string, ref?: LedgerRef): Promise<void> {
    return (await this.pick(walletId)).rollback(walletId, idempotencyKey, ref);
  }

  async getBalance(walletId: string): Promise<bigint> {
    return (await this.pick(walletId)).getBalance(walletId);
  }
}
