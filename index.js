const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");

// Your anchor prices (current as of February 15, 2026)
const anchorPrices = {
  SOL: 89.76,
  BONK: 0.00000642,
  WIF: 0.23,
  JUP: 0.163
};

// Solana coins
const solanaCoins = ["SOL", "BONK", "WIF", "JUP"];

// Solana public RPC
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Pulse history (last 10 vectors [delta, tps, skips])
let pulseHistory = [];

// Current pulse-derived prices and direction (start from anchors)
const prices = {
  SOL: { value: anchorPrices.SOL.toFixed(2), direction: "unknown" },
  BONK: { value: anchorPrices.BONK.toFixed(8), direction: "unknown" },
  WIF: { value: anchorPrices.WIF.toFixed(2), direction: "unknown" },
  JUP: { value: anchorPrices.JUP.toFixed(3), direction: "unknown" }
};

// Stagnate range
const STAGNATE_RANGE = 0.5;

// Per-poll data (message ID → {coin, pot: 0, stakes: []})
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDD
