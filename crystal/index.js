import {
 Client,
 GatewayIntentBits,
 ActionRowBuilder,
 ButtonBuilder,
 ButtonStyle,
 EmbedBuilder
} from "discord.js";

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { v4 as uuid } from "uuid";
import { createInvoice } from "./utils/invoice.js";
import { createCrypto } from "./utils/crypto.js";

dotenv.config();

/* ================== Express ================== */

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => res.send("Crystal Store Online"));

app.listen(process.env.PORT || 20180);

/* ================== Products ================== */

const products = JSON.parse(fs.readFileSync("./products.json"));

/* ================== Discord ================== */

const client = new Client({
 intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent
 ]
});

/* ================== Ready ================== */

client.once("ready", async () => {
 console.log(`Logged in as ${client.user.tag}`);

 try {
  const panel = await client.channels.fetch(process.env.PANEL_CHANNEL_ID);

  if (!panel) return console.log("❌ PANEL_CHANNEL_ID غير صحيح");

  const row = new ActionRowBuilder().addComponents(
   new ButtonBuilder()
    .setCustomId("open")
    .setLabel("Open Ticket")
    .setEmoji("🎫")
    .setStyle(ButtonStyle.Primary)
  );

  await panel.send({
   embeds: [
    new EmbedBuilder()
     .setTitle("Crystal Store")
     .setDescription("اضغط لفتح تكت")
   ],
   components: [row]
  });

 } catch (err) {
  console.log("Panel Error:", err);
 }
});

/* ================== Buttons ================== */

client.on("interactionCreate", async i => {
 if (!i.isButton()) return;

 try {

  /* فتح تكت */

  if (i.customId === "open") {
   const ticket = await i.guild.channels.create({
    name: `ticket-${i.user.username}`,
    parent: process.env.TICKET_CATEGORY_ID
   });

   const row = new ActionRowBuilder();

   products.forEach(p => {
    row.addComponents(
     new ButtonBuilder()
      .setCustomId(`prod_${p.id}`)
      .setLabel(p.name)
      .setEmoji(p.emoji)
      .setStyle(ButtonStyle.Secondary)
    );
   });

   await ticket.send({
    content: `👋 مرحبًا ${i.user}\nاختر المنتج`,
    components: [row]
   });

   await i.reply({ content: "✅ تم فتح التكت", ephemeral: true });
  }

  /* اختيار منتج */

  if (i.customId.startsWith("prod_")) {
   const prod = products.find(x => `prod_${x.id}` === i.customId);
   if (!prod) return;

   const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
     .setCustomId(`crypto_${prod.id}`)
     .setLabel("Crypto")
     .setEmoji("🪙")
     .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
     .setLabel("Stripe")
     .setURL(prod.stripe)
     .setStyle(ButtonStyle.Link)
   );

   await i.channel.send({
    content: `اختر طريقة الدفع لـ ${prod.name}`,
    components: [row]
   });
  }

  /* كريبتو */

  if (i.customId.startsWith("crypto_")) {
   const id = i.customId.split("_")[1];
   const prod = products.find(p => p.id === id);
   if (!prod) return;

   const order = uuid();
   const pay = await createCrypto(prod.price, order, process.env);

   await i.channel.send(`💳 ادفع هنا:\n${pay.result.url}`);
  }

 } catch (e) {
  console.log("Interaction error:", e);
 }
});

/* ================== +dn ================== */

client.on("messageCreate", async m => {
 if (m.content === "+dn" && m.channel.name?.startsWith("ticket")) {

  try {
   const file = `./invoices/${uuid()}.pdf`;

   createInvoice(
    { buyer: m.channel.name, store: "Crystal Store", status: "Paid" },
    file
   );

   await m.channel.send({ files: [file] });

   const log = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
   if (log) await log.send(`🧾 عملية جديدة\n${m.channel.name}`);

   await m.channel.delete();

  } catch (e) {
   console.log("DN Error:", e);
  }
 }
});

/* ================== Login ================== */

client.login(process.env.DISCORD_TOKEN);

/* ================== Anti Crash ================== */

process.on("unhandledRejection", err => console.log(err));
process.on("uncaughtException", err => console.log(err));
