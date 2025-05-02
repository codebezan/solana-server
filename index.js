
import fetch from 'node-fetch';
import axios from 'axios';
import bs58 from 'bs58';
import 'dotenv/config';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

import { sleep, fetchWithRetry, axiosGetWithRetry } from './helpers.js';
import { amountToUiAmount } from '@solana/spl-token';






// Constants
const JUPITER_API = "https://quote-api.jup.ag/v6";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const SOL_SWAP_AMOUNT = 0.003;
const BUY_THRESHOLD = 0.01;
const GROWTH_THRESHOLD = 0.20;
const CMC_API_KEY = "be5863ba-45ef-430b-8e80-e2e70e80a4ae"; // put your key here

// Wallet setup
const WALLET_SECRET = process.env.WALLET_SECRET;
if (!WALLET_SECRET) {
  console.error("❌ WALLET_SECRET missing");
  process.exit(1);
}
const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_SECRET));
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Track token states
let trackedTokens = new Map(); // tokenAddress => { initialPrice, buyPrice }
let finishedTokens = new Set(); // already bought and sold

// Get token price in USD
async function getTokenPrice(tokenAddress) {
    try {
      const url = `${JUPITER_API}/quote?inputMint=${tokenAddress}&outputMint=${USDC_MINT}&amount=1000000&slippageBps=50`;
      const res = await fetchWithRetry(url);
      const data = await res.json();
      if (!data || data.error) return null;
      const inAmt = parseFloat(data.inAmount) / 1_000_000;
      const outAmt = parseFloat(data.outAmount) / 1_000_000;
      return outAmt / inAmt;
    } catch (err) {
      console.error('Price fetch failed', err);
      return null;
    }
  }
  

// Get token balance in wallet
async function getTokenBalance(tokenMint) {
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const res = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: mintPubkey,
    });
    if (res.value.length === 0) return 0;
    return res.value[0].account.data.parsed.info.tokenAmount.uiAmount;
  } catch {
    return 0;
  }
}











const TARGET_GAIN = 0.30; // 30%

// Store your initial prices
let trackedPrices = new Map(); // tokenAddress => initialPrice
async function checkMyTokens() {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
  );

  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    const tokenAddress = info.mint;
    const decimals = info.tokenAmount.decimals;
    const rawAmount = info.tokenAmount.amount;
    const amount = Number(rawAmount) / 10 ** decimals;

    if (amount === 0) continue;
    if (finishedTokens.has(tokenAddress)) continue;

    const currentPrice = await getTokenPrice(tokenAddress);
    if (!currentPrice) continue;

    if (!trackedPrices.has(tokenAddress)) {
      trackedPrices.set(tokenAddress, {
        lastPrice: currentPrice,
        totalGain: 0,
        buyTime: null
      });
      console.log(`🔍 Start tracking ${tokenAddress} at $${currentPrice}`);
      continue;
    }

    let { lastPrice, totalGain, buyTime } = trackedPrices.get(tokenAddress);
    const percentGain = (currentPrice - lastPrice) / lastPrice;
    const updatedGain = totalGain + percentGain;

    if (!buyTime) {
      buyTime = Date.now();
    }

    trackedPrices.set(tokenAddress, {
      lastPrice: currentPrice,
      totalGain: updatedGain,
      buyTime
    });

    const timeSinceBuy = (Date.now() - buyTime) / 1000; // in seconds

    if (updatedGain >= TARGET_GAIN || timeSinceBuy > 59 * 60) {
      console.log(`🚀 Selling ${tokenAddress}: gain ${(updatedGain * 100).toFixed(2)}% | held for ${Math.floor(timeSinceBuy / 60)} min`);
      const sold = await swapTokenForSol(tokenAddress);

      if (sold) {
        console.log(`✅ Sold ${tokenAddress} successfully`);
        trackedPrices.delete(tokenAddress);
        finishedTokens.add(tokenAddress);
      } else {
        console.log(`❌ Sell failed for ${tokenAddress}, will retry next check`);
      }
    } else {
      console.log(`⏳ ${tokenAddress} total gain: ${(updatedGain * 100).toFixed(2)}%, holding...`);
    }
  }
}

  
  
// Run every minute







// Swap SOL → Token
async function swapSolForToken(tokenAddress) {
  try {
    const amountIn = Math.round(SOL_SWAP_AMOUNT * LAMPORTS_PER_SOL);
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${SOL_ADDRESS}&outputMint=${tokenAddress}&amount=${amountIn}&slippageBps=50`;
    const quote = await (await fetch(quoteUrl)).json();
    if (!quote || quote.error) return false;

    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });

    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) return false;

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
    const latestBlockhash = await connection.getLatestBlockhash();
    tx.message.recentBlockhash = latestBlockhash.blockhash;
    tx.sign([wallet]);

    const sig = await connection.sendTransaction(tx);
    console.log(`✅ Bought ${tokenAddress}: https://solscan.io/tx/${sig}`);
    return true;
  } catch {
    return false;
  }
}

// Swap Token → SOL
// Swap Token → SOL (sells your entire balance)
async function swapTokenForSol(tokenAddress) {
  try {
    // 1. find your SPL token account for this mint
    const res = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(tokenAddress) }
    );
    if (res.value.length === 0) {
      console.log("⚠️ No token account found for", tokenAddress);
      return false;
    }

    // 2. pull out uiAmount and decimals
    const info = res.value[0].account.data.parsed.info.tokenAmount;
    const balance = info.uiAmount || 0;
    const decimals = info.decimals;
    if (balance === 0) {
      console.log("⚠️ You have zero balance, nothing to sell");
      return false;
    }
    console.log(`🔎 Current balance: ${balance} tokens`)

    // 3. convert to base units using the actual decimals
    const amountIn = Math.floor(balance * 10 ** decimals);
    console.log(`💱 Swapping ALL ${balance} (${amountIn} base units)`);

    // 4. get a quote
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${tokenAddress}` +
                     `&outputMint=${SOL_ADDRESS}` +
                     `&amount=${amountIn}&slippageBps=50`;
    const quote = await (await fetch(quoteUrl)).json();
    if (!quote || quote.error) {
      console.log("❌ Quote failed:", quote?.error || "no quote");
      return false;
    }

    // 5. do the swap
    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });
    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) {
      console.log("❌ No swap transaction returned");
      return false;
    }

    // 6. sign & send
    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapData.swapTransaction, "base64")
    );
    const latest = await connection.getLatestBlockhash();
    tx.message.recentBlockhash = latest.blockhash;
    tx.sign([wallet]);

    const sig = await connection.sendTransaction(tx);
    console.log(`💸 Sold all tokens: https://solscan.io/tx/${sig}`);
    return true;

  } catch (err) {
    console.log(`❌ Sell failed: ${err.message}`);
    return false;
  }
}


// Check tracked tokens
async function checkTrackedTokens() {
  for (const [tokenAddress, info] of trackedTokens.entries()) {
    if (finishedTokens.has(tokenAddress)) continue; // skip sold tokens
    if (info.buyPrice) continue; // skip already bought

    const price = await getTokenPrice(tokenAddress);
    if (!price) continue;

    if (!info.lastPrice) {
      trackedTokens.set(tokenAddress, {
        ...info,
        lastPrice: price,
        totalGain: 0
      });
      console.log(`👀 Watching ${tokenAddress} starting at $${price}`);
      continue;
    }

    const percentGain = (price - info.lastPrice) / info.lastPrice;
    const updatedGain = (info.totalGain || 0) + percentGain;

    trackedTokens.set(tokenAddress, {
      ...info,
      lastPrice: price,
      totalGain: updatedGain
    });

    if (updatedGain >= BUY_THRESHOLD) {
      console.log(`📈 ${tokenAddress} up ${(updatedGain * 100).toFixed(2)}%, buying…`);
      const bought = await swapSolForToken(tokenAddress);

      if (bought) {
        const now = Date.now();
        trackedTokens.set(tokenAddress, {
          ...info,
          buyPrice: price,
          lastPrice: price,
          totalGain: 0,
          buyTime: now
        });

        trackedPrices.set(tokenAddress, {
          lastPrice: price,
          totalGain: 0,
          buyTime: now
        });

        console.log(`✅ Bought ${tokenAddress} at $${price}`);
      } else {
        console.log(`❌ Buy failed for ${tokenAddress}, will retry later`);
      }
    } else {
      console.log(`⏳ ${tokenAddress} total gain: ${(updatedGain * 100).toFixed(2)}%, waiting…`);
    }
  }
}



  
// Get new tokens from CoinMarketCap
async function fetchNewSolanaTokens() {
  try {
    const headers = { 'X-CMC_PRO_API_KEY': CMC_API_KEY };
    const res = await axiosGetWithRetry(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest',
      { headers, params: { sort: 'date_added', limit: 100 } }
    );

    const solanaTokens = res.data.data.filter(token =>
      token.platform?.name === 'Solana' &&
      !trackedTokens.has(token.platform.token_address) &&
      !finishedTokens.has(token.platform.token_address)
    );

    for (const token of solanaTokens) {
      if (trackedTokens.size >= 100) break;

      const address = token.platform.token_address;
      const price = await getTokenPrice(address);
      if (price) {
        console.log(`🆕 Tracking ${token.name} (${token.symbol}) at $${price}`);
        trackedTokens.set(address, { initialPrice: price, buyPrice: null });
      }
    }
  } catch (err) {
    console.log("❌ Error fetching tokens:", err.message);
  }
}

// Main loop
// main loop that never dies on disconnect
async function mainLoop() {
  while (true) {
    try {
      await fetchNewSolanaTokens();   // look for new tokens
      await checkTrackedTokens();     // check if new ones should be bought
      await checkMyTokens();          // 🔥 check if held tokens should be sold
    } catch (err) {
      console.log("⚠️ Network (or other) error:", err.message);
      console.log("⏳ Waiting 30s before retry...");
      await sleep(30_000);
      continue;
    }
    console.log("✅ Loop done, sleeping 2 min...");
    await sleep(2 * 60_000);
  }
}


// start it
mainLoop();
