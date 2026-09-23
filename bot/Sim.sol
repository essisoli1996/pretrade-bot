// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// pretrade round-trip simulator. Never deployed: its runtime code is injected with an eth_call state override,
// so it has no constructor state and no immutables. It buys on the real v4 pool, then sells what it received,
// through the real PoolManager, hook and token transfer logic, and reports what came back.

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerMin {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

contract Sim {
    uint160 constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// stage: 0 = buy reverted, 1 = bought but the sell reverted, 2 = both went through.
    /// tokenOwed/quoteOwed: what the pool said we get. tokenGot/quoteBack: what actually arrived (transfer taxes show here).
    struct Result {
        uint8 stage;
        uint256 tokenOwed;
        uint256 tokenGot;
        uint256 quoteOwed;
        uint256 quoteBack;
        bytes revertData;
    }

    /// Buy with `quoteIn` of the quote currency, then sell everything received.
    /// If `sellOnly` is set, skip the buy and sell `sellAmount` the contract already holds (a funded "holder").
    function roundTrip(address pm, PoolKey calldata key, bool tokenIs0, uint256 quoteIn, bool sellOnly, uint256 sellAmount)
        external
        returns (Result memory r)
    {
        address token = tokenIs0 ? key.currency0 : key.currency1;
        address quote = tokenIs0 ? key.currency1 : key.currency0;
        uint256 sellQty = sellAmount;
        if (!sellOnly) {
            uint256 t0 = _bal(token);
            try this.swapStep(pm, key, !tokenIs0, quoteIn) returns (uint256 owed) {
                r.tokenOwed = owed;
            } catch (bytes memory err) {
                r.revertData = err;
                return r; // stage 0
            }
            r.tokenGot = _bal(token) - t0;
            sellQty = r.tokenGot;
        }
        r.stage = 1;
        uint256 q0 = _bal(quote);
        try this.swapStep(pm, key, tokenIs0, sellQty) returns (uint256 owed) {
            r.quoteOwed = owed;
        } catch (bytes memory err) {
            r.revertData = err;
            return r; // stage 1
        }
        r.quoteBack = _bal(quote) - q0;
        r.stage = 2;
    }

    /// External so roundTrip can catch a revert from it. Only this contract may call it.
    function swapStep(address pm, PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        require(msg.sender == address(this), "self only");
        bytes memory out = IPoolManagerMin(pm).unlock(abi.encode(key, zeroForOne, amountIn));
        return abi.decode(out, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        IPoolManagerMin pm = IPoolManagerMin(msg.sender);
        int256 delta = pm.swap(
            key,
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE),
            ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (address inC, int128 inD, address outC, int128 outD) =
            zeroForOne ? (key.currency0, d0, key.currency1, d1) : (key.currency1, d1, key.currency0, d0);
        if (inD < 0) {
            uint256 owe = uint256(uint128(-inD));
            if (inC == address(0)) {
                pm.settle{value: owe}();
            } else {
                pm.sync(inC);
                (bool ok, bytes memory ret) = inC.call(abi.encodeWithSelector(0xa9059cbb, address(pm), owe));
                require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "pay failed");
                pm.settle();
            }
        }
        uint256 got = outD > 0 ? uint256(uint128(outD)) : 0;
        if (got > 0) pm.take(outC, address(this), got);
        return abi.encode(got);
    }

    function _bal(address c) internal view returns (uint256) {
        return c == address(0) ? address(this).balance : IERC20Min(c).balanceOf(address(this));
    }

    receive() external payable {}
}
