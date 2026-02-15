const { Telegraf } = require('telegraf');
const axios = require('axios');

// Global pot tracker (simulated – later use real Solana tx)
let currentPot = 0;
const rakeRate = 0.20; // 20%
const rakeWallet = '9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK'; // your Phantom address

const bot = new Telegraf('8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o');

// /start
bot.start((ctx) => ctx.reply('Degen Echo Bot online! Commands: /poll (start prediction), /stake <amount> (join pot), /chaos (sentiment score)'));

// /poll – dynamic anonymous poll with 1-hour auto-close + Binance API
bot.command('poll', async (ctx) => {
  let solPrice = 'unknown';
  try {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', {
      timeout: 5000  // 5-second timeout
    });
    solPrice = Number(response.data.price).toFixed(2);
  } catch (error) {
    console.error('Binance fetch failed:', error.message);
    solPrice = 'unknown (API error)';
  }

  const question = `Degen Echo – $SOL at $${solPrice} – next 1H vibe?`;

  try {
    const poll = await ctx.replyWithPoll(
      question,
      ['🚀 Pump', '💀 Dump', '🤷 Stagnate'],
      {
        is_anonymous: true,
        open_period: 3600  // 1 hour auto-close
      }
    );
    ctx.reply('Poll started! Closes in 1 hour. Stake with /stake 0.001 SOL');
  } catch (pollError) {
    ctx.reply('Error creating poll – try again!');
    console.error('Poll creation failed:', pollError.message);
  }
});

// /stake – simulate stake + 20% rake
bot.command('stake', (ctx) => {
  const args = ctx.message.text.split(' ');
  const amount = parseFloat(args[1]);

  if (!amount || amount <= 0) {
    return ctx.reply('Usage: /stake 0.001');
  }

  const rake = amount * rakeRate;
  currentPot += amount;

  ctx.reply(`Staked ${amount} SOL! Current pot: ${currentPot} SOL (rake cut: ${rake.toFixed(6)} SOL to ${rakeWallet})`);
});

// /chaos – simple random sentiment score
bot.command('chaos',
