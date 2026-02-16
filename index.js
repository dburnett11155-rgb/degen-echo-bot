const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const { Connection, PublicKey } = require("@solana/web3.js");

// Solana coins (symbols for each exchange/RPC)
const coinConfigs = {
  SOL: { kraken: "SOL/USD", coingecko: "solana", solana: { poolId: "58oQChx4yWmvKdwLLZzBiLXAkJyqQcD4BXcRx4dg5Pc" } }, // Raydium SOL-USDC pool
  BONK: { kraken: "BONK/USD", coingecko: "bonk1", solana: { poolId: "E6Gtmit8rcoApeefHJKfJRNoS3wAHzQEtgQqfkdHwTNs" } }, // BONK-USDC pool
  WIF: { kraken: "WIF/USD", coingecko: "dogwifhat", solana: { poolId: "EKpQGSJtjMFqKZ9KQGPfgob1Q7iwsCwnO7Hc9ZXkB471" } }, // WIF-USDC pool
  JUP: { kraken: "JUP/USD", coingecko: "jupiter-ag", solana: { poolId: "CLHLa1JLrDc3mWj3M8rA4kmR6ar9dp5wM3Yf99s87Qh4" } } // JUP-USDC pool
};

// Real-time prices
const prices = {
  SOL: "unknown",
  BONK: "unknown",
  WIF: "unknown",
  JUP: "unknown"
};

// Per-poll data (message ID → {coin, startPrice, pot: 0, stakes: []})
const activePolls = {};

// Rake & stagnate
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const STAGNATE_RANGE = 0.5;

// Solana public RPC for on-chain backup
const solanaConnection = new Connection("https://api.mainnet-beta.solana.com");

// Current backup index (0 = kraken, 1 = coingecko, 2 = solana)
let currentBackupIndex = 0;

// Active WS or RPC
let ws = null;

// Connect to current backup
function connectBackup() {
  const backups = ["kraken", "coingecko", "solana"];
  const currentBackup = backups[currentBackupIndex];

  if (ws) ws.close();

  if (currentBackup === "kraken") {
    ws = new WebSocket("wss://ws.kraken.com");
    ws.on("open", () => {
      console.log("Kraken WebSocket connected");
      ws.send(JSON.stringify({
        event: "subscribe",
        pair: solanaCoins,
        subscription: { name: "ticker" }
      }));
    });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        if (Array.isArray(message) && message[1] && message[1].c) {
          const pair = message[3];
          const coin = pair.replace("/USD", "");
          prices[coin] = Number(message[1].c[0]).toFixed(6);
        }
      } catch (e) {
        console.error("Kraken parse error:", e.message);
      }
    });

  } else if (currentBackup === "coingecko") {
    ws = new WebSocket("wss://api.coingecko.com/api/v3/websocket");
    ws.on("open", () => {
      console.log("CoinGecko WebSocket connected");
      ws.send(JSON.stringify({
        type: "subscribe",
        symbols: Object.values(coinConfigs).map(c => c.coingecko)
      }));
    });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === "price_update" && message.symbol && message.price) {
          const coin = Object.keys(coinConfigs).find(k => coinConfigs[k].coingecko === message.symbol);
          if (coin) prices[coin] = Number(message.price).toFixed(6);
        }
      } catch (e) {
        console.error("CoinGecko parse error:", e.message);
      }
    });

  } else if (currentBackup === "solana") {
    // Solana RPC backup – fetch prices every 10s (not WebSocket)
    console.log("Switched to Solana RPC backup");
    setInterval(async () => {
      for (const coin in coinConfigs) {
        const poolId = coinConfigs[coin].solana.poolId;
        try {
          const account = await solanaConnection.getAccountInfo(new PublicKey(poolId));
          // Simplified – parse pool data for price (real code needs AMM math)
          // For now, placeholder (implement full if needed)
          prices[coin] = "on-chain-price-placeholder"; // Replace with real calc
        } catch (e) {
          console.error("Solana RPC failed for " + coin + ": " + e.message);
        }
      }
    }, 10000); // Update every 10s
    return; // No WS for Solana backup
  }

  ws.on("error", (error) => {
    console.error(`${currentBackup} WS error:`, error.message);
  });

  ws.on("close", () => {
    console.log(`${currentBackup} WS closed – switching to next backup...`);
    currentBackupIndex = (currentBackupIndex + 1) % backups.length;
    connectBackup();
  });
}

// Start with Kraken
connectBackup();

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll – creates 4 separate button polls with real-time prices
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

  for (let i = 0; i < Object.keys(coinConfigs).length; i++) {
    const coin = Object.keys(coinConfigs)[i];
    const pollNumber = i + 1;
    const price = prices[coin] || "unknown";

    const message = await ctx.reply(`Degen Echo #${pollNumber} – \[ {coin} at \]{price} – next 1H vibe?\nPot: 0 SOL`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Pump", callback_data: `vote_${pollNumber}_pump` },
            { text: "📉 Dump", callback_data: `vote_${pollNumber}_dump` },
            { text: "🟡 Stagnate", callback_data: `vote_${pollNumber}_stagnate` }
          ]
        ]
      }
    });

    activePolls[message.message_id] = {
      coin,
      pollNumber,
      pot: 0,
      stakes: []
    };
  }
});

// Handle button tap → ask for stake amount
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("vote_")) return;

  const [_, pollNumberStr, choice] = data.split("_");
  const pollNumber = parseInt(pollNumberStr);
  const pollId = ctx.callbackQuery.message.message_id;
  const pollData = activePolls[pollId];

  if (!pollData) return ctx.answerCbQuery("Poll expired");

  const userId = ctx.callbackQuery.from.id;

  // Ask for stake amount
  await ctx.reply(`How much SOL do you want to stake on \( {choice} for poll # \){pollNumber}? Reply with amount (e.g. 0.001)`);

  // Listen for reply
  const listener = bot.on("text", async (replyCtx) => {
    if (replyCtx.from.id !== userId) return;
    const amount = parseFloat(replyCtx.message.text.trim());

    if (!amount || amount <= 0) {
      return replyCtx.reply("Invalid amount – try again");
    }

    const rake = amount * rakeRate;
    pollData.pot += amount;
    pollData.stakes.push({ userId, amount });

    // Edit poll message to show updated pot
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      pollId,
      undefined,
      `Degen Echo #${pollData.pollNumber} – \[ {pollData.coin} at \]{prices[pollData.coin] || "unknown"} – next 1H vibe?\nPot: ${pollData.pot.toFixed(6)} SOL`,
      {
        reply_markup: ctx.callbackQuery.message.reply_markup
      }
    );

    await replyCtx.reply(`Staked ${amount} SOL on \( {choice} for poll # \){pollNumber}! Pot now: ${pollData.pot.toFixed(6)} SOL (rake: ${rake.toFixed(6)})`);
    bot.off("text", listener);
  });
});

// /chaos – random score
bot.command("chaos", (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
  ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
});

// Launch
bot.launch();
console.log("Degen Echo Bot is running");
