import type { Signer } from "ethers";
import { ethers } from "hardhat";
import type { ERC20Lockable } from "../../typechain-types";

export const ERC20_CREATE_LOCK_INPUTS_TYPE =
  "tuple(uint256 amount, address recipient)";

// Type string returned (selector-prefixed) by ERC20Lockable.getLockContent.
// Must match ERC20Lockable.ERC20LockContentType.
export const ERC20_LOCK_CONTENT_TYPE =
  "ERC20LockContent(uint256 amount,address recipient)";

export function encodeCreateLockInputs(
  amount: bigint,
  recipient: string,
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [ERC20_CREATE_LOCK_INPUTS_TYPE],
    [{ amount, recipient }],
  );
}

/**
 * Create a lock in an ERC20Lockable token and return its lock ID.
 *
 * @param token     The ERC20Lockable contract instance
 * @param owner     The signer who will own the lock
 * @param amount    The amount to lock (in wei)
 * @param recipient The address that will receive tokens when the lock is spent
 * @returns         The lock ID as a hex string
 */
export async function createTokenLock(
  token: ERC20Lockable,
  owner: Signer,
  amount: bigint,
  recipient: string,
): Promise<string> {
  const createInputs = encodeCreateLockInputs(amount, recipient);

  const tx = await token
    .connect(owner)
    .createLock(createInputs, ethers.ZeroHash, ethers.ZeroHash, "0x");
  const receipt = await tx.wait();

  const lockCreatedEvent = receipt!.logs.find((log) => {
    try {
      return token.interface.parseLog(log)?.name === "LockCreated";
    } catch {
      return false;
    }
  });

  if (!lockCreatedEvent) {
    throw new Error("LockCreated event not found");
  }

  return token.interface.parseLog(lockCreatedEvent)!.args[0];
}
