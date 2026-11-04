# ERC-8316 Examples

Reference example and tests for ERC-8316: Programmable Settlement Locks

Forum discussion: https://ethereum-magicians.org/t/erc-8316-programmable-settlement-locks/28861 <br/>
Pull request: https://github.com/ethereum/ERCs/pull/1840

## ERC-8316 summary

ERC-8316 defines an interface for **programmable settlement locks**: a
prepared, value-bearing operation controlled by a single current spender,
with predefined spend and cancel paths secured by
implementation-specific commitments. The standard defines the lock
lifecycle and authority model in a way that is agnostic to the underlying
asset, meaning that it can be implemented across assets of varying types.
A coordinator can then treat a lock as a fixed, finalizable settlement object
without needing to fully understand the underlying token, state transitions, or validation logic.

Lifecycle, captured by [`IERC8316`](contracts/interfaces/IERC8316.sol):

- `createLock` / `updateLock` — an owner prepares a lock and may revise its
  `spendCommitment` / `cancelCommitment` while owner-controlled.
- `delegateLock` — transfers authority to a new spender (e.g. a coordinating
  contract). Once delegated to a non-owner, the commitments become immutable.
- `spendLock` / `cancelLock` — the current spender finalizes the lock along one
  of the two prepared paths; the lock then becomes permanently inactive.
- `getLock` / `isLockActive` — inspection.

Key invariant: while a lock is active and the caller is its current spender, the
implementation **must not** block finalization through expiries, pauses, or
admin overrides.
Broader coordination rules (timeouts, multi-leg atomicity) belong to the
spender, which may itself be a coordinating contract.

## ERC-20 example

[`ERC20Lockable`](contracts/ERC20Lockable.sol) is a transparent ERC-20 token
(based on OpenZeppelin) that implements `IERC8316`. A lock is one of three kinds:

| Kind | Created by | Reserves | Spend | Cancel |
| --- | --- | --- | --- | --- |
| Transfer | `createLock`, the holder | the holder's balance | transfers it to the recipient | releases the reservation |
| Burn | `createBurnLock`, the holder | the holder's balance | burns it | releases the reservation |
| Mint | `createMintLock`, the token owner | nothing | mints the amount to the recipient | drops the lock |

- **Locked balances** are a subset of the total balance and cannot be moved by
  ordinary transfers (enforced in the `_update` hook).
- Spend and cancel may be delegated to a coordinator.

Because the token is fully transparent, the operation is entirely determined by
the lock content (kind, amount and recipient) captured at creation. Two
extensions outside ERC-8316 expose it: `getLockContent` returns it while the
lock is active, as `ERC20LockContent(uint8 kind,uint256 amount,address recipient)`
behind its ERC-8074 selector, and `ERC20LockCreated(lockId, owner, kind, amount, recipient, data)`,
emitted after `LockCreated`, records it for indexers. There is no hidden
state to bind, so this example leaves the commitments unrestricted (zero) and
performs no commitment validation. A privacy-preserving implementation would
instead bind proofs, encrypted values, or nullifiers into the commitments and
validate the supplied `spendArgs` / `cancelArgs` against them.

## Privacy-preserving implementations (Paladin)

The transparent ERC-20 above is the simplest possible implementation. The
standard's real motivation is atomic settlement across systems with different
visibility models, where a coordinator can finalize a lock without seeing the
underlying state.

[Paladin](https://github.com/LF-Decentralized-Trust-labs/paladin) provides
implementations of privacy-preserving token domains that fit this shape:

- **Noto** — notary-validated UTXO tokens, where token states are private and a
  notary attests to valid transitions.
- **Zeto** — zero-knowledge UTXO tokens, where transfers are proven valid via
  ZK proofs without revealing amounts or parties.

In these domains a lock can be delegated to a coordinating contract and later
spent or cancelled along its committed paths, while the proof, encrypted value,
or nullifier required to finalize it remains bound into the commitment rather
than exposed to the coordinator.

The lock interface in these examples derives from Paladin's earlier
`ILockableCapability` prototype, a precursor to ERC-8316. That prototype
already largely matches the standard's struct, events, and function signatures (and will evolve to align fully if further changes are adopted for ERC-8316).

The [swap example](https://github.com/LFDT-Paladin/paladin/blob/main/examples/swap/src/index.ts) in the Paladin repository shows an example using these privacy-preserving tokens.

## Usage

```bash
npm install
npm run build   # compile contracts + generate TypeChain types
npm test        # run the standalone test suite
```
