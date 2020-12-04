import { expect } from "chai";
import { BigNumber, Contract, TypedDataDomain } from "ethers";
import { artifacts, ethers, waffle } from "hardhat";

import {
  Order,
  OrderKind,
  SettlementEncoder,
  SigningScheme,
  allowanceManagerAddress,
  domain,
  computeOrderUid,
  hashOrder,
} from "../src/ts";

import { builtAndDeployedMetadataCoincide } from "./bytecode";

interface Transfer {
  owner: string;
  token: string;
  amount: BigNumber;
}

function parseTransfers(transfers: unknown[][][]): [Transfer[], Transfer[]] {
  const parseTransfer = (transfer: unknown[]) => ({
    owner: transfer[0] as string,
    token: transfer[1] as string,
    amount: transfer[2] as BigNumber,
  });

  return [transfers[0].map(parseTransfer), transfers[1].map(parseTransfer)];
}

function toNumberLossy(value: BigNumber): number {
  // NOTE: BigNumber throws an exception when if is outside the range of
  // representable integers for JavaScript's double precision floating point
  // numbers. For some tests, that is OK, so perform a lossy conversion.
  return parseInt(value.toString());
}

describe("GPv2Settlement", () => {
  const [deployer, owner, solver, ...traders] = waffle.provider.getWallets();

  let authenticator: Contract;
  let settlement: Contract;
  let testDomain: TypedDataDomain;

  beforeEach(async () => {
    const GPv2AllowListAuthentication = await ethers.getContractFactory(
      "GPv2AllowListAuthentication",
      deployer,
    );
    authenticator = await GPv2AllowListAuthentication.deploy(owner.address);

    const GPv2Settlement = await ethers.getContractFactory(
      "GPv2SettlementTestInterface",
      deployer,
    );
    settlement = await GPv2Settlement.deploy(authenticator.address);

    const { chainId } = await ethers.provider.getNetwork();
    testDomain = domain(chainId, settlement.address);
  });

  describe("domainSeparator", () => {
    it("should have an EIP-712 domain separator", async () => {
      expect(await settlement.domainSeparatorTest()).to.equal(
        ethers.utils._TypedDataEncoder.hashDomain(testDomain),
      );
    });

    it("should have a different replay protection for each deployment", async () => {
      const GPv2Settlement = await ethers.getContractFactory(
        "GPv2SettlementTestInterface",
        deployer,
      );
      const settlement2 = await GPv2Settlement.deploy(authenticator.address);

      expect(await settlement.domainSeparatorTest()).to.not.equal(
        await settlement2.domainSeparatorTest(),
      );
    });
  });

  describe("allowanceManager", () => {
    it("should deploy an allowance manager", async () => {
      const deployedAllowanceManager = await settlement.allowanceManagerTest();
      expect(
        await builtAndDeployedMetadataCoincide(
          deployedAllowanceManager,
          "GPv2AllowanceManager",
        ),
      ).to.be.true;
    });

    it("should result in a deterministic address", async () => {
      expect(await settlement.allowanceManagerTest()).to.equal(
        allowanceManagerAddress(settlement.address),
      );
    });

    it("should have the settlement contract as the recipient", async () => {
      const ADDRESS_BYTE_LENGTH = 20;

      // NOTE: In order to avoid having the allowance manager add a public
      // accessor for its recipient just for testing, which would add minor
      // costs at both deployment time and runtime, just read the contract code
      // to get the immutable value.
      const buildInfo = await artifacts.getBuildInfo(
        "src/contracts/GPv2AllowanceManager.sol:GPv2AllowanceManager",
      );
      if (buildInfo === undefined) {
        throw new Error("missing GPv2AllowanceManager build info");
      }

      const [[recipientImmutableReference]] = Object.values(
        buildInfo.output.contracts["src/contracts/GPv2AllowanceManager.sol"]
          .GPv2AllowanceManager.evm.deployedBytecode.immutableReferences || {},
      );

      const deployedAllowanceManager = await settlement.allowanceManagerTest();
      const code = await ethers.provider.send("eth_getCode", [
        deployedAllowanceManager,
        "latest",
      ]);
      const recipient = ethers.utils.hexlify(
        ethers.utils
          .arrayify(code)
          .subarray(recipientImmutableReference.start)
          .subarray(recipientImmutableReference.length - ADDRESS_BYTE_LENGTH)
          .slice(0, ADDRESS_BYTE_LENGTH),
      );

      expect(ethers.utils.getAddress(recipient)).to.equal(settlement.address);
    });
  });

  describe("filledAmount", () => {
    it("is zero for an uninitialized order", async () => {
      const orderUid = "0x".padEnd(66, "0");
      expect(await settlement.filledAmount(orderUid)).to.equal(
        ethers.constants.Zero,
      );
    });
  });

  describe("settle", () => {
    it("rejects transactions from non-solvers", async () => {
      await expect(settlement.settle([], [], [], [], [])).to.be.revertedWith(
        "GPv2: not a solver",
      );
    });

    it("accepts transactions from solvers", async () => {
      await authenticator.connect(owner).addSolver(solver.address);
      // TODO - this will have to be changed when other constraints become active
      // and when settle function no longer reverts.
      await expect(
        settlement.connect(solver).settle([], [], [], [], []),
      ).revertedWith("Final: not yet implemented");
    });
  });

  describe("invalidateOrder", () => {
    it("sets filled amount of the caller's order to max uint256", async () => {
      const orderDigest = "0x".padEnd(66, "1");
      const orderUid = computeOrderUid(orderDigest, traders[0].address);

      await settlement.connect(traders[0]).invalidateOrder(orderDigest);
      expect(await settlement.filledAmount(orderUid)).to.equal(
        ethers.constants.MaxUint256,
      );
    });
  });

  describe("computeTradeExecutions", () => {
    const sellToken = `0x${"11".repeat(20)}`;
    const buyToken = `0x${"22".repeat(20)}`;
    const prices = {
      [sellToken]: 1,
      [buyToken]: 2,
    };
    const partialOrder = {
      sellToken,
      buyToken,
      sellAmount: ethers.utils.parseEther("42"),
      buyAmount: ethers.utils.parseEther("13.37"),
      validTo: 0xffffffff,
      appData: 0,
      feeAmount: ethers.constants.Zero,
    };

    it("should compute in/out transfers for multiple trades", async () => {
      const tradeCount = 10;
      const encoder = new SettlementEncoder(testDomain);
      for (let i = 0; i < tradeCount; i++) {
        await encoder.signEncodeTrade(
          {
            ...partialOrder,
            kind: OrderKind.BUY,
            partiallyFillable: true,
          },
          ethers.utils.parseEther("0.7734"),
          traders[0],
          SigningScheme.TYPED_DATA,
        );
      }

      const [inTransfers, outTransfers] = parseTransfers(
        await settlement.callStatic.computeTradeExecutionsTest(
          encoder.tokens,
          encoder.clearingPrices(prices),
          encoder.encodedTrades,
        ),
      );

      expect(inTransfers.length).to.equal(tradeCount);
      expect(outTransfers.length).to.equal(tradeCount);
    });

    it("should revert if the order expired", async () => {
      const { timestamp } = await ethers.provider.getBlock("latest");
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        {
          ...partialOrder,
          validTo: timestamp - 1,
          kind: OrderKind.SELL,
          partiallyFillable: false,
        },
        0,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      await expect(
        settlement.computeTradeExecutionsTest(
          encoder.tokens,
          encoder.clearingPrices(prices),
          encoder.encodedTrades,
        ),
      ).to.be.revertedWith("order expired");
    });

    it("should revert if the limit price is not respected", async () => {
      const sellAmount = ethers.utils.parseEther("100.0");
      const sellPrice = 1;
      const buyAmount = ethers.utils.parseEther("1.0");
      const buyPrice = 1000;

      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        {
          ...partialOrder,
          sellAmount,
          buyAmount,
          kind: OrderKind.SELL,
          partiallyFillable: false,
        },
        0,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      expect(toNumberLossy(sellAmount.mul(sellPrice))).not.to.be.gte(
        toNumberLossy(buyAmount.mul(buyPrice)),
      );
      await expect(
        settlement.callStatic.computeTradeExecutionsTest(
          encoder.tokens,
          encoder.clearingPrices({
            [sellToken]: sellPrice,
            [buyToken]: buyPrice,
          }),
          encoder.encodedTrades,
        ),
      ).to.be.revertedWith("limit price not respected");
    });

    it("should not revert if the clearing price is exactly at the limit price", async () => {
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        {
          ...partialOrder,
          kind: OrderKind.SELL,
          partiallyFillable: false,
        },
        0,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      const { sellAmount, buyAmount } = partialOrder;
      const executions = settlement.callStatic.computeTradeExecutionsTest(
        encoder.tokens,
        encoder.clearingPrices({
          [sellToken]: buyAmount,
          [buyToken]: sellAmount,
        }),
        encoder.encodedTrades,
      );
      await expect(executions).to.not.be.reverted;

      const [, [{ amount: executedBuyAmount }]] = parseTransfers(
        await executions,
      );
      expect(executedBuyAmount).to.deep.equal(buyAmount);
    });

    describe("Order Executed Amounts", () => {
      const { sellAmount, buyAmount } = partialOrder;
      const executedAmount = ethers.utils.parseEther("10.0");
      const computeTradeExecutionForOrderVariant = async ({
        kind,
        partiallyFillable,
      }: Pick<Order, "kind" | "partiallyFillable">) => {
        const encoder = new SettlementEncoder(testDomain);
        await encoder.signEncodeTrade(
          {
            ...partialOrder,
            kind,
            partiallyFillable,
          },
          executedAmount,
          traders[0],
          SigningScheme.TYPED_DATA,
        );

        const [
          [{ amount: executedSellAmount }],
          [{ amount: executedBuyAmount }],
        ] = parseTransfers(
          await settlement.callStatic.computeTradeExecutionsTest(
            encoder.tokens,
            encoder.clearingPrices(prices),
            encoder.encodedTrades,
          ),
        );

        const [sellPrice, buyPrice] = [
          prices[partialOrder.sellToken],
          prices[partialOrder.buyToken],
        ];

        return { executedSellAmount, sellPrice, executedBuyAmount, buyPrice };
      };

      it("should compute amounts for fill-or-kill sell orders", async () => {
        const {
          executedSellAmount,
          sellPrice,
          executedBuyAmount,
          buyPrice,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.SELL,
          partiallyFillable: false,
        });

        expect(executedSellAmount).to.deep.equal(sellAmount);
        expect(executedBuyAmount).to.deep.equal(
          sellAmount.mul(sellPrice).div(buyPrice),
        );
      });

      it("should respect the limit price for fill-or-kill sell orders", async () => {
        const {
          executedBuyAmount,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.SELL,
          partiallyFillable: false,
        });

        expect(executedBuyAmount.gt(buyAmount)).to.be.true;
      });

      it("should compute amounts for fill-or-kill buy orders", async () => {
        const {
          executedSellAmount,
          sellPrice,
          executedBuyAmount,
          buyPrice,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.BUY,
          partiallyFillable: false,
        });

        expect(executedSellAmount).to.deep.equal(
          buyAmount.mul(buyPrice).div(sellPrice),
        );
        expect(executedBuyAmount).to.deep.equal(buyAmount);
      });

      it("should respect the limit price for fill-or-kill buy orders", async () => {
        const {
          executedSellAmount,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.BUY,
          partiallyFillable: false,
        });

        expect(executedSellAmount.lt(sellAmount)).to.be.true;
      });

      it("should compute amounts for partially fillable sell orders", async () => {
        const {
          executedSellAmount,
          sellPrice,
          executedBuyAmount,
          buyPrice,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.SELL,
          partiallyFillable: true,
        });

        expect(executedSellAmount).to.deep.equal(executedAmount);
        expect(executedBuyAmount).to.deep.equal(
          executedAmount.mul(sellPrice).div(buyPrice),
        );
      });

      it("should respect the limit price for partially fillable sell orders", async () => {
        const {
          executedSellAmount,
          executedBuyAmount,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.SELL,
          partiallyFillable: true,
        });

        expect(
          executedBuyAmount
            .mul(sellAmount)
            .gt(executedSellAmount.mul(buyAmount)),
        ).to.be.true;
      });

      it("should compute amounts for partially fillable buy orders", async () => {
        const {
          executedSellAmount,
          sellPrice,
          executedBuyAmount,
          buyPrice,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.BUY,
          partiallyFillable: true,
        });

        expect(executedSellAmount).to.deep.equal(
          executedAmount.mul(buyPrice).div(sellPrice),
        );
        expect(executedBuyAmount).to.deep.equal(executedAmount);
      });

      it("should respect the limit price for partially fillable buy orders", async () => {
        const {
          executedSellAmount,
          executedBuyAmount,
        } = await computeTradeExecutionForOrderVariant({
          kind: OrderKind.BUY,
          partiallyFillable: true,
        });

        expect(
          executedBuyAmount
            .mul(sellAmount)
            .gt(executedSellAmount.mul(buyAmount)),
        ).to.be.true;
      });
    });

    describe("Order Executed Fees", () => {
      const { sellAmount, buyAmount } = partialOrder;
      const feeAmount = ethers.utils.parseEther("10");
      const { [sellToken]: sellPrice, [buyToken]: buyPrice } = prices;
      const computeInTransferForOrderVariant = async (
        { kind, partiallyFillable }: Pick<Order, "kind" | "partiallyFillable">,
        executedAmount?: BigNumber,
      ) => {
        const encoder = new SettlementEncoder(testDomain);
        await encoder.signEncodeTrade(
          {
            ...partialOrder,
            feeAmount,
            kind,
            partiallyFillable,
          },
          executedAmount || 0,
          traders[0],
          SigningScheme.TYPED_DATA,
        );

        const [[inTransfer]] = parseTransfers(
          await settlement.callStatic.computeTradeExecutionsTest(
            encoder.tokens,
            encoder.clearingPrices(prices),
            encoder.encodedTrades,
          ),
        );

        return inTransfer.amount;
      };

      it("should add the full fee for fill-or-kill sell orders", async () => {
        const transferAmount = await computeInTransferForOrderVariant({
          kind: OrderKind.SELL,
          partiallyFillable: false,
        });

        expect(transferAmount).to.deep.equal(sellAmount.add(feeAmount));
      });

      it("should add the full fee for fill-or-kill buy orders", async () => {
        const transferAmount = await computeInTransferForOrderVariant({
          kind: OrderKind.BUY,
          partiallyFillable: false,
        });

        const executedSellAmount = buyAmount.mul(buyPrice).div(sellPrice);
        expect(transferAmount).to.deep.equal(executedSellAmount.add(feeAmount));
      });

      it("should add portion of fees for partially filled sell orders", async () => {
        const executedSellAmount = sellAmount.div(3);
        const executedFee = feeAmount.div(3);

        const transferAmount = await computeInTransferForOrderVariant(
          { kind: OrderKind.SELL, partiallyFillable: true },
          executedSellAmount,
        );

        expect(transferAmount).to.deep.equal(
          executedSellAmount.add(executedFee),
        );
      });

      it("should add portion of fees for partially filled buy orders", async () => {
        const executedBuyAmount = buyAmount.div(4);
        const executedFee = feeAmount.div(4);

        const transferAmount = await computeInTransferForOrderVariant(
          { kind: OrderKind.BUY, partiallyFillable: true },
          executedBuyAmount,
        );

        const executedSellAmount = executedBuyAmount
          .mul(buyPrice)
          .div(sellPrice);
        expect(transferAmount).to.deep.equal(
          executedSellAmount.add(executedFee),
        );
      });
    });

    describe("Order Filled Amounts", () => {
      const { sellAmount, buyAmount } = partialOrder;
      const readOrderFilledAmountAfterProcessing = async (
        { kind, partiallyFillable }: Pick<Order, "kind" | "partiallyFillable">,
        executedAmount?: BigNumber,
      ) => {
        const order = {
          ...partialOrder,
          kind,
          partiallyFillable,
        };
        const encoder = new SettlementEncoder(testDomain);
        await encoder.signEncodeTrade(
          order,
          executedAmount || 0,
          traders[0],
          SigningScheme.TYPED_DATA,
        );

        await settlement.computeTradeExecutionsTest(
          encoder.tokens,
          encoder.clearingPrices(prices),
          encoder.encodedTrades,
        );

        const orderUid = computeOrderUid(hashOrder(order), traders[0].address);
        const filledAmount = await settlement.filledAmount(orderUid);

        return filledAmount;
      };

      it("should fill the full sell amount for fill-or-kill sell orders", async () => {
        const filledAmount = await readOrderFilledAmountAfterProcessing({
          kind: OrderKind.SELL,
          partiallyFillable: false,
        });

        expect(filledAmount).to.deep.equal(sellAmount);
      });

      it("should fill the full buy amount for fill-or-kill buy orders", async () => {
        const filledAmount = await readOrderFilledAmountAfterProcessing({
          kind: OrderKind.BUY,
          partiallyFillable: false,
        });

        expect(filledAmount).to.deep.equal(buyAmount);
      });

      it("should fill the executed amount for partially filled sell orders", async () => {
        const executedSellAmount = sellAmount.div(3);
        const filledAmount = await readOrderFilledAmountAfterProcessing(
          { kind: OrderKind.SELL, partiallyFillable: true },
          executedSellAmount,
        );

        expect(filledAmount).to.deep.equal(executedSellAmount);
      });

      it("should fill the executed amount for partially filled buy orders", async () => {
        const executedBuyAmount = buyAmount.div(4);
        const filledAmount = await readOrderFilledAmountAfterProcessing(
          { kind: OrderKind.BUY, partiallyFillable: true },
          executedBuyAmount,
        );

        expect(filledAmount).to.deep.equal(executedBuyAmount);
      });
    });

    it("should ignore the executed trade amount for fill-or-kill orders", async () => {
      const order = {
        ...partialOrder,
        kind: OrderKind.BUY,
        partiallyFillable: false,
      };

      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        { ...order, appData: 0 },
        0,
        traders[0],
        SigningScheme.TYPED_DATA,
      );
      await encoder.signEncodeTrade(
        { ...order, appData: 1 },
        ethers.utils.parseEther("1.0"),
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      const [inTransfers, outTransfers] = parseTransfers(
        await settlement.callStatic.computeTradeExecutionsTest(
          encoder.tokens,
          encoder.clearingPrices(prices),
          encoder.encodedTrades,
        ),
      );

      expect(inTransfers[0]).to.deep.equal(inTransfers[1]);
      expect(outTransfers[0]).to.deep.equal(outTransfers[1]);
    });
  });

  describe("computeTradeExecution", () => {
    it("should not allocate additional memory", async () => {
      expect(
        await settlement.callStatic.computeTradeExecutionMemoryTest(),
      ).to.deep.equal(ethers.constants.Zero);
    });
  });
});
