import { expect } from "chai";
import type { Signer } from "ethers";
import { ethers } from "hardhat";
import type { ERC20Lockable } from "../typechain-types";
import {
  createTokenLock,
  encodeCreateLockInputs,
  ERC20_CREATE_LOCK_INPUTS_TYPE,
  ERC20_LOCK_CONTENT_TYPE,
} from "./helpers/erc20-lockable";

describe("ERC20Lockable (ERC-8316 example)", function () {
  let token: ERC20Lockable;
  let owner: Signer;
  let alice: Signer;
  let bob: Signer;
  let charlie: Signer;

  let aliceAddress: string;
  let bobAddress: string;
  let charlieAddress: string;

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    aliceAddress = await alice.getAddress();
    bobAddress = await bob.getAddress();
    charlieAddress = await charlie.getAddress();

    const ERC20LockableFactory =
      await ethers.getContractFactory("ERC20Lockable");
    token = (await ERC20LockableFactory.connect(owner).deploy(
      "LockableToken",
      "LOCK",
    )) as ERC20Lockable;

    await token.connect(owner).mint(aliceAddress, ethers.parseEther("1000"));
  });

  describe("Basic ERC20 functionality", function () {
    it("should have correct name and symbol", async function () {
      expect(await token.name()).to.equal("LockableToken");
      expect(await token.symbol()).to.equal("LOCK");
    });

    it("should allow normal transfers when no locks exist", async function () {
      await token.connect(alice).transfer(bobAddress, ethers.parseEther("100"));

      expect(await token.balanceOf(aliceAddress)).to.equal(
        ethers.parseEther("900"),
      );
      expect(await token.balanceOf(bobAddress)).to.equal(
        ethers.parseEther("100"),
      );
    });

    it("should show correct locked and unlocked balances", async function () {
      expect(await token.lockedBalanceOf(aliceAddress)).to.equal(0);
      expect(await token.unlockedBalanceOf(aliceAddress)).to.equal(
        ethers.parseEther("1000"),
      );
    });
  });

  describe("Lock creation and management", function () {
    it("should create a lock successfully", async function () {
      const amount = ethers.parseEther("200");

      const lockId = await createTokenLock(token, alice, amount, bobAddress);

      expect(await token.lockedBalanceOf(aliceAddress)).to.equal(amount);
      expect(await token.unlockedBalanceOf(aliceAddress)).to.equal(
        ethers.parseEther("800"),
      );
      expect(await token.balanceOf(aliceAddress)).to.equal(
        ethers.parseEther("1000"),
      );

      expect(lockId).to.be.a("string");
      expect(lockId).to.have.length.greaterThan(0);
      expect(await token.isLockActive(lockId)).to.equal(true);

      const lockInfo = await token.getLock(lockId);
      expect(lockInfo.owner).to.equal(aliceAddress);
      expect(lockInfo.spender).to.equal(aliceAddress);

      const content = await token.getLockContent(lockId);
      const expectedSelector = ethers.id(ERC20_LOCK_CONTENT_TYPE).slice(0, 10);
      expect(content.slice(0, 10)).to.equal(expectedSelector);
      const [inputs] = ethers.AbiCoder.defaultAbiCoder().decode(
        [ERC20_CREATE_LOCK_INPUTS_TYPE],
        "0x" + content.slice(10),
      );
      expect(inputs.amount).to.equal(amount);
      expect(inputs.recipient).to.equal(bobAddress);
    });

    it("should revert when locking a zero amount", async function () {
      const createInputs = encodeCreateLockInputs(0n, bobAddress);

      await expect(
        token
          .connect(alice)
          .createLock(createInputs, ethers.ZeroHash, ethers.ZeroHash, "0x"),
      ).to.be.revertedWithCustomError(token, "InvalidAmount");
    });

    it("should revert when trying to lock more than unlocked balance", async function () {
      const amount = ethers.parseEther("1500"); // more than alice's balance
      const createInputs = encodeCreateLockInputs(amount, bobAddress);

      await expect(
        token
          .connect(alice)
          .createLock(createInputs, ethers.ZeroHash, ethers.ZeroHash, "0x"),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });

    it("should prevent transfers when insufficient unlocked balance", async function () {
      const lockAmount = ethers.parseEther("800");

      await createTokenLock(token, alice, lockAmount, bobAddress);

      await expect(
        token.connect(alice).transfer(bobAddress, ethers.parseEther("300")),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");

      await token.connect(alice).transfer(bobAddress, ethers.parseEther("100"));
      expect(await token.unlockedBalanceOf(aliceAddress)).to.equal(
        ethers.parseEther("100"),
      );
    });
  });

  describe("Lock update and mutability", function () {
    let lockId: string;
    const newSpendCommitment = ethers.keccak256(
      ethers.toUtf8Bytes("new spend commitment"),
    );

    beforeEach(async function () {
      lockId = await createTokenLock(
        token,
        alice,
        ethers.parseEther("300"),
        bobAddress,
      );
    });

    it("should allow the owner to update commitments while owner-controlled", async function () {
      await token
        .connect(alice)
        .updateLock(lockId, "0x", newSpendCommitment, ethers.ZeroHash, "0x");

      const lockInfo = await token.getLock(lockId);
      expect(lockInfo.spendCommitment).to.equal(newSpendCommitment);
    });

    it("should revert update from a non-spender", async function () {
      await expect(
        token
          .connect(bob)
          .updateLock(lockId, "0x", newSpendCommitment, ethers.ZeroHash, "0x"),
      ).to.be.revertedWithCustomError(token, "LockUnauthorized");
    });
  });

  describe("Lock spending", function () {
    let lockId: string;

    beforeEach(async function () {
      lockId = await createTokenLock(
        token,
        alice,
        ethers.parseEther("300"),
        bobAddress,
      );
    });

    it("should spend lock successfully and delete it", async function () {
      const initialAliceBalance = await token.balanceOf(aliceAddress);
      const initialBobBalance = await token.balanceOf(bobAddress);

      await expect(token.connect(alice).spendLock(lockId, "0x", "0x"))
        .to.emit(token, "LockSpent")
        .withArgs(lockId, aliceAddress, "0x");

      expect(await token.balanceOf(aliceAddress)).to.equal(
        initialAliceBalance - ethers.parseEther("300"),
      );
      expect(await token.balanceOf(bobAddress)).to.equal(
        initialBobBalance + ethers.parseEther("300"),
      );

      expect(await token.lockedBalanceOf(aliceAddress)).to.equal(0);
      expect(await token.isLockActive(lockId)).to.equal(false);
      await expect(token.getLock(lockId)).to.be.revertedWithCustomError(
        token,
        "LockNotActive",
      );
    });

    it("should revert if non-spender tries to spend", async function () {
      await expect(
        token.connect(bob).spendLock(lockId, "0x", "0x"),
      ).to.be.revertedWithCustomError(token, "LockUnauthorized");
    });

    it("should revert when spending an already-spent lock", async function () {
      await token.connect(alice).spendLock(lockId, "0x", "0x");
      await expect(
        token.connect(alice).spendLock(lockId, "0x", "0x"),
      ).to.be.revertedWithCustomError(token, "LockNotActive");
    });
  });

  describe("Lock cancellation", function () {
    let lockId: string;

    beforeEach(async function () {
      lockId = await createTokenLock(
        token,
        alice,
        ethers.parseEther("300"),
        bobAddress,
      );
    });

    it("should cancel lock successfully and delete it", async function () {
      const initialAliceBalance = await token.balanceOf(aliceAddress);

      await expect(token.connect(alice).cancelLock(lockId, "0x", "0x"))
        .to.emit(token, "LockCancelled")
        .withArgs(lockId, aliceAddress, "0x");

      // No token transfer occurred; the reservation is released.
      expect(await token.balanceOf(aliceAddress)).to.equal(initialAliceBalance);
      expect(await token.lockedBalanceOf(aliceAddress)).to.equal(0);
      expect(await token.unlockedBalanceOf(aliceAddress)).to.equal(
        initialAliceBalance,
      );

      await expect(token.getLock(lockId)).to.be.revertedWithCustomError(
        token,
        "LockNotActive",
      );
    });

    it("should revert if non-spender tries to cancel", async function () {
      await expect(
        token.connect(bob).cancelLock(lockId, "0x", "0x"),
      ).to.be.revertedWithCustomError(token, "LockUnauthorized");
    });
  });

  describe("Lock delegation", function () {
    let lockId: string;

    beforeEach(async function () {
      lockId = await createTokenLock(
        token,
        alice,
        ethers.parseEther("300"),
        bobAddress,
      );
    });

    it("should delegate authority and let the new spender finalize", async function () {
      await expect(
        token.connect(alice).delegateLock(lockId, "0x", charlieAddress, "0x"),
      )
        .to.emit(token, "LockDelegated")
        .withArgs(lockId, aliceAddress, charlieAddress, "0x");

      const lockInfo = await token.getLock(lockId);
      expect(lockInfo.spender).to.equal(charlieAddress);
      expect(lockInfo.owner).to.equal(aliceAddress); // owner unchanged

      await token.connect(charlie).spendLock(lockId, "0x", "0x");
      expect(await token.balanceOf(bobAddress)).to.equal(
        ethers.parseEther("300"),
      );
    });

    it("should revert when delegating to the zero address", async function () {
      await expect(
        token
          .connect(alice)
          .delegateLock(lockId, "0x", ethers.ZeroAddress, "0x"),
      ).to.be.revertedWithCustomError(token, "LockInvalidSpender");
    });

    it("should strip authority from the previous spender after delegation", async function () {
      await token
        .connect(alice)
        .delegateLock(lockId, "0x", charlieAddress, "0x");

      await expect(
        token.connect(alice).spendLock(lockId, "0x", "0x"),
      ).to.be.revertedWithCustomError(token, "LockUnauthorized");
    });

    it("should make commitments immutable once delegated to a non-owner", async function () {
      await token
        .connect(alice)
        .delegateLock(lockId, "0x", charlieAddress, "0x");

      await expect(
        token
          .connect(charlie)
          .updateLock(
            lockId,
            "0x",
            ethers.keccak256(ethers.toUtf8Bytes("new spend commitment")),
            ethers.ZeroHash,
            "0x",
          ),
      ).to.be.revertedWithCustomError(token, "LockImmutable");
    });

    it("should allow updates again once authority returns to the owner", async function () {
      await token
        .connect(alice)
        .delegateLock(lockId, "0x", charlieAddress, "0x");
      await token
        .connect(charlie)
        .delegateLock(lockId, "0x", aliceAddress, "0x");

      const newSpendCommitment = ethers.keccak256(
        ethers.toUtf8Bytes("restored owner control"),
      );
      await token
        .connect(alice)
        .updateLock(lockId, "0x", newSpendCommitment, ethers.ZeroHash, "0x");

      const lockInfo = await token.getLock(lockId);
      expect(lockInfo.spendCommitment).to.equal(newSpendCommitment);
    });
  });
});
