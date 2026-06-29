// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IERC8316.sol";

/**
 * @title ERC20Lockable
 * @dev A transparent ERC-20 token that implements ERC-8316 (Programmable
 *      Settlement Locks) for balance locking.
 *
 *      A lock reserves an amount of the owner's balance for transfer to a
 *      fixed recipient. The current spender may spend the lock (transferring
 *      the amount to the recipient) or cancel it (releasing the reservation
 *      back to the owner). Locked balances are tracked as a subset of the
 *      owner's total balance and cannot be moved by ordinary transfers.
 *
 *      Because the underlying token is fully transparent, the operation is
 *      completely determined by the lock content (amount and recipient)
 *      captured at creation. There is no hidden state to bind, so this example
 *      leaves `spendCommitment` and `cancelCommitment` unrestricted (zero) and
 *      performs no commitment validation in spendLock/cancelLock. A
 *      privacy-preserving implementation would instead bind proofs, encrypted
 *      values, or nullifiers into the commitments and validate the supplied
 *      args against them.
 */
contract ERC20Lockable is ERC20, ERC20Burnable, Ownable, IERC8316 {
    struct CreateLockInputs {
        uint256 amount;
        address recipient;
    }

    struct TokenLock {
        address owner;
        address spender;
        CreateLockInputs content;
        bytes32 spendCommitment;
        bytes32 cancelCommitment;
        bool active;
    }

    // Type selector for the bytes returned by getLockContent (an
    // implementation-specific extension, ERC-8074 encoded).
    // bytes4(keccak256("ERC20LockContent(uint256 amount,address recipient)"))
    string public constant ERC20LockContentType =
        "ERC20LockContent(uint256 amount,address recipient)";
    bytes4 public constant ERC20LockContentSelector =
        bytes4(keccak256(bytes(ERC20LockContentType)));

    mapping(bytes32 => TokenLock) private _locks;
    mapping(address => uint256) private _lockedBalances;
    uint256 private _lockCounter;

    error InvalidAmount(uint256 amount);

    constructor(
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) Ownable(_msgSender()) {}

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    /**
     * @dev Override the balance update hook to ensure locked balances cannot be
     *      moved by ordinary transfers.
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from != address(0)) {
            uint256 unlockedBalance = balanceOf(from) - _lockedBalances[from];
            if (value > unlockedBalance) {
                revert ERC20InsufficientBalance(from, unlockedBalance, value);
            }
        }
        super._update(from, to, value);
    }

    /**
     * @dev Get the locked balance for an account.
     */
    function lockedBalanceOf(address account) external view returns (uint256) {
        return _lockedBalances[account];
    }

    /**
     * @dev Get the unlocked (available) balance for an account.
     */
    function unlockedBalanceOf(
        address account
    ) external view returns (uint256) {
        return balanceOf(account) - _lockedBalances[account];
    }

    /**
     * @dev Create a lock reserving `amount` of the caller's balance for
     *      transfer to `recipient`.
     */
    function createLock(
        bytes calldata createArgs,
        bytes32 spendCommitment,
        bytes32 cancelCommitment,
        bytes calldata data
    ) external returns (bytes32 lockId) {
        CreateLockInputs memory inputs = abi.decode(createArgs, (CreateLockInputs));
        require(inputs.amount > 0, InvalidAmount(inputs.amount));

        uint256 unlockedBalance = balanceOf(msg.sender) -
            _lockedBalances[msg.sender];
        require(
            inputs.amount <= unlockedBalance,
            ERC20InsufficientBalance(msg.sender, unlockedBalance, inputs.amount)
        );

        lockId = keccak256(
            abi.encode(address(this), msg.sender, ++_lockCounter)
        );

        _locks[lockId] = TokenLock({
            owner: msg.sender,
            spender: msg.sender,
            content: inputs,
            spendCommitment: spendCommitment,
            cancelCommitment: cancelCommitment,
            active: true
        });

        _lockedBalances[msg.sender] += inputs.amount;

        emit LockCreated(
            lockId,
            msg.sender,
            msg.sender,
            spendCommitment,
            cancelCommitment,
            data
        );
    }

    /**
     * @dev Update an existing lock's commitments (only while owner-controlled).
     */
    function updateLock(
        bytes32 lockId,
        bytes calldata /* updateArgs */,
        bytes32 spendCommitment,
        bytes32 cancelCommitment,
        bytes calldata data
    ) external {
        TokenLock storage lock = _locks[lockId];
        require(lock.active, LockNotActive(lockId));
        require(
            msg.sender == lock.spender,
            LockUnauthorized(lockId, lock.spender, msg.sender)
        );
        require(lock.spender == lock.owner, LockImmutable(lockId));

        lock.spendCommitment = spendCommitment;
        lock.cancelCommitment = cancelCommitment;

        emit LockUpdated(
            lockId,
            lock.owner,
            spendCommitment,
            cancelCommitment,
            data
        );
    }

    /**
     * @dev Delegate spending authority to another address.
     */
    function delegateLock(
        bytes32 lockId,
        bytes calldata /* delegateArgs */,
        address newSpender,
        bytes calldata data
    ) external {
        TokenLock storage lock = _locks[lockId];
        require(lock.active, LockNotActive(lockId));
        require(
            msg.sender == lock.spender,
            LockUnauthorized(lockId, lock.spender, msg.sender)
        );
        require(
            newSpender != address(0),
            LockInvalidSpender(lockId, newSpender)
        );

        address oldSpender = lock.spender;
        lock.spender = newSpender;

        emit LockDelegated(lockId, oldSpender, newSpender, data);
    }

    /**
     * @dev Spend the locked tokens (transfer to the recipient).
     */
    function spendLock(
        bytes32 lockId,
        bytes calldata /* spendArgs */,
        bytes calldata data
    ) external {
        TokenLock storage lock = _locks[lockId];
        require(lock.active, LockNotActive(lockId));
        require(
            msg.sender == lock.spender,
            LockUnauthorized(lockId, lock.spender, msg.sender)
        );

        uint256 amount = lock.content.amount;
        address owner = lock.owner;
        address recipient = lock.content.recipient;

        // Update state before the transfer (which may reenter) per ERC-8316
        // implementation-safety guidance.
        _lockedBalances[owner] -= amount;
        delete _locks[lockId];

        _transfer(owner, recipient, amount);

        emit LockSpent(lockId, msg.sender, data);
    }

    /**
     * @dev Cancel the lock, releasing the reserved tokens back to the owner.
     */
    function cancelLock(
        bytes32 lockId,
        bytes calldata /* cancelArgs */,
        bytes calldata data
    ) external {
        TokenLock storage lock = _locks[lockId];
        require(lock.active, LockNotActive(lockId));
        require(
            msg.sender == lock.spender,
            LockUnauthorized(lockId, lock.spender, msg.sender)
        );

        _lockedBalances[lock.owner] -= lock.content.amount;
        delete _locks[lockId];

        emit LockCancelled(lockId, msg.sender, data);
    }

    /**
     * @dev Get ERC-8316 lock information for an active lock.
     */
    function getLock(bytes32 lockId) external view returns (LockInfo memory) {
        TokenLock storage lock = _locks[lockId];
        require(lock.active, LockNotActive(lockId));
        return
            LockInfo({
                owner: lock.owner,
                spender: lock.spender,
                spendCommitment: lock.spendCommitment,
                cancelCommitment: lock.cancelCommitment
            });
    }

    /**
     * @dev Get the implementation-specific lock content (amount and recipient),
     *      prefixed with a type selector. This is an extension (not included in ERC-8316).
     */
    function getLockContent(
        bytes32 lockId
    ) external view returns (bytes memory) {
        TokenLock storage lock = _locks[lockId];
        require(lock.active, LockNotActive(lockId));
        return bytes.concat(ERC20LockContentSelector, abi.encode(lock.content));
    }

    /**
     * @dev Query whether a lock is currently active.
     */
    function isLockActive(bytes32 lockId) external view returns (bool) {
        return _locks[lockId].active;
    }
}
