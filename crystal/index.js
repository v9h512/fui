import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  Events,
} from "discord.js";
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";

import { createInvoicePDF } from "./utils/invoice.js";
import { createCryptomusInvoice, isCryptomusWebhookTrusted } from "./utils/crypto.js";
import { createStripeCheckout, getStripe } from "./utils/stripe.js";
import {
  upsertOrder,
  getOrderByChannelId,
  getOrderById,
  markPaid,
  ensureDataFiles,
} from "./utils/store.js";

dotenv.config();
ensureDataFiles();
fs.mkdirSync(path.resolve("./invoices"), { recursive: true });

/* ================== Config ================== */
const STORE_NAME = process.env.STORE_NAME || "Crystal Store";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const OWNER_ID = process.env.OWNER_ID || "";
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || "";
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || "";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));
const money = (n) => `$${Number(n).toFixed(2)}`;

/* ================== Express ================== */
const app = express();
app.use("/webhook/cryptomus", express.json({ limit: "1mb" }));
app.use("/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.static("public"));

app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/webhook/cryptomus", async (req, res) => {
  try {
    if (!isCryptomusWebhookTrusted(req, process.env)) return res.status(401).send("untrusted");

    const payload = req.body || {};
    const orderId = payload?.order_id;
    const status = String(payload?.status || "").toLowerCase();
    if (!orderId) return res.status(200).send("no order");

    const paidStatuses = new Set(["paid", "paid_over", "paid_partial"]);
    if (!paidStatuses.has(status)) return res.status(200).send("not paid");

    const order = markPaid(orderId, {
      method: "crypto",
      provider: "cryptomus",
      transactionId: payload?.uuid || payload?.txid || payload?.payment_uuid || null,
      paidAmount: payload?.amount || null,
    });
    if (order) await notifyPaid(order);

    return res.status(200).send("ok");
  } catch (e) {
    console.log("Cryptomus webhook error:", e?.message || e);
    return res.status(200).send("ok");
  }
});

app.post("/webhook/stripe", async (req, res) => {
  try {
    const stripe = getStripe(process.env);
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (whSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } else {
      event = JSON.parse(req.body.toString("utf8"));
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session?.metadata?.orderId;

      if (orderId) {
        const order = markPaid(orderId, {
          method: "stripe",
          provider: "stripe",
          transactionId: session?.payment_intent || session?.id || null,
          paidAmount: session?.amount_total ? `$${(session.amount_total / 100).toFixed(2)}` : null,
        });
        if (order) await notifyPaid(order);
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.log("Stripe webhook error:", e?.message || e);
    return res.status(200).send("ok");
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Web server started on port ${PORT}`));

/* ================== Discord ================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

/* ================== Ticket anti-double lock ================== */
const creatingTickets = new Map(); // userId -> timestamp
function acquireLock(userId, ttlMs = 8000) {
  const now = Date.now();
  const last = creatingTickets.get(userId) || 0;
  if (now - last < ttlMs) return false;
  creatingTickets.set(userId, now);
  setTimeout(() => {
    if (creatingTickets.get(userId) === now) creatingTickets.delete(userId);
  }, ttlMs);
  return true;
}

async function findExistingTicket(guild, userId) {
  const chans = await guild.channels.fetch().catch(() => null);
  if (!chans) return null;
  return chans.find((c) => c?.type === ChannelType.GuildText && c?.name === `ticket-${userId}`);
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  if (SUPPORT_ROLE_ID && member.roles?.cache?.has(SUPPORT_ROLE_ID)) return true;
  if (OWNER_ID && member.id === OWNER_ID) return true;
  return false;
}

/* ================== Embeds ================== */
const panelEmbed = () =>
  new EmbedBuilder()
    .setTitle(`${STORE_NAME} — Ticket Panel`)
    .setDescription(
      [
        "Open a ticket to order or get support.",
        "",
        "✅ Fast delivery",
        "✅ Secure payments (Crypto / Stripe)",
        "✅ PDF invoice after delivery",
        "",
        "**Click the button below to open your ticket.**",
      ].join("\n")
    )
    .setFooter({ text: "Click Open Ticket" });

const welcomeEmbed = (user) =>
  new EmbedBuilder()
    .setTitle("Welcome 👋")
    .setDescription(
      [
        `Hello ${user}!`,
        "",
        "Choose a product below to continue.",
        "After payment you will receive confirmation in this ticket.",
      ].join("\n")
    );

const productsEmbed = () =>
  new EmbedBuilder()
    .setTitle("Products")
    .setDescription(
      products.map((p) => `${p.emoji} **${p.name}** — ${money(p.price)} _(ETA: ${p.delivery})_`).join("\n")
    )
    .setFooter({ text: "Select one product to continue." });

const paymentMethodsEmbed = (prod) =>
  new EmbedBuilder()
    .setTitle("Choose Payment Method")
    .setDescription(`**Product:** ${prod.name}\n**Total:** ${money(prod.price)}\n\nSelect one option:`);

const paymentInstructionsEmbed = (method, order) => {
  const lines = [
    `**Order ID:** \`${order.id}\``,
    `**Product:** ${order.product.name}`,
    `**Total:** ${money(order.product.price)}`,
    "",
  ];

  if (method === "crypto") {
    lines.push("**Crypto (Cryptomus)**");
    lines.push("1) Click **Pay Now**");
    lines.push("2) Complete payment");
    lines.push("3) Wait for confirmation here");
  } else {
    lines.push("**Stripe (Card)**");
    lines.push("1) Click **Pay Now**");
    lines.push("2) Complete checkout");
    lines.push("3) Wait for confirmation here");
  }

  return new EmbedBuilder().setTitle("Payment").setDescription(lines.join("\n"));
};

/* ================== Ready + Command registration ================== */
client.once(Events.ClientReady, async () => {
  console.log("✅ READY:", client.user.tag);

  // Register /panel in every guild
  try {
    const guilds = await client.guilds.fetch();
    for (const [, g] of guilds) {
      const guild = await client.guilds.fetch(g.id);
      await guild.commands.set([
        {
          name: "panel",
          description: "Send ticket panel to this channel",
          default_member_permissions: String(PermissionFlagsBits.Administrator),
        },
      ]);
    }
    console.log("Commands registered ✅");
  } catch (e) {
    console.log("Command registration error:", e?.message || e);
  }
});

/* ================== /panel ================== */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "panel") return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_ticket")
      .setLabel("Open Ticket")
      .setEmoji("🎫")
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.channel.send({ embeds: [panelEmbed()], components: [row] });
  await interaction.reply({ content: "✅ Panel sent.", ephemeral: true });
});

/* ================== Buttons ================== */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;

  try {
    /* ---- Open ticket ---- */
    if (i.customId === "open_ticket") {
      await i.deferReply({ ephemeral: true });

      if (!acquireLock(i.user.id)) return i.editReply("⏳ Creating your ticket… please wait.");

      const existing = await findExistingTicket(i.guild, i.user.id);
      if (existing) return i.editReply(`⚠️ You already have a ticket: <#${existing.id}>`);

      const overwrites = [
        { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: i.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
      ];

      if (SUPPORT_ROLE_ID) {
        overwrites.push({
          id: SUPPORT_ROLE_ID,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        });
      }

      if (OWNER_ID) {
        overwrites.push({
          id: OWNER_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        });
      }

      const ticket = await i.guild.channels.create({
        name: `ticket-${i.user.id}`,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID || null,
        permissionOverwrites: overwrites,
      });

      await ticket.send({ embeds: [welcomeEmbed(i.user)] });

      const rows = [];
      let row = new ActionRowBuilder();
      let count = 0;

      for (const p of products) {
        if (count === 5) {
          rows.push(row);
          row = new ActionRowBuilder();
          count = 0;
        }
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`choose_prod:${p.id}`)
            .setLabel(`${p.name} (${money(p.price)})`)
            .setEmoji(p.emoji)
            .setStyle(ButtonStyle.Secondary)
        );
        count++;
      }
      if (count) rows.push(row);

      await ticket.send({ embeds: [productsEmbed()], components: rows });
      return i.editReply(`✅ Ticket created: <#${ticket.id}>`);
    }

    /* ---- Choose product ---- */
    if (i.customId.startsWith("choose_prod:")) {
      if (!i.channel?.name?.startsWith("ticket-")) return i.reply({ content: "❌ Use this inside your ticket.", ephemeral: true });

      const ticketOwner = i.channel.name.replace("ticket-", "");
      if (ticketOwner !== i.user.id && !isStaff(i.member)) return i.reply({ content: "❌ Only ticket owner or staff.", ephemeral: true });

      const prodId = i.customId.split(":")[1];
      const prod = products.find((p) => p.id === prodId);
      if (!prod) return i.reply({ content: "❌ Product not found.", ephemeral: true });

      const existingOrder = getOrderByChannelId(i.channelId);
      if (existingOrder && existingOrder.status !== "paid") {
        return i.reply({ content: `⚠️ You already have a pending order: \`${existingOrder.id}\``, ephemeral: true });
      }

      const orderId = uuid();
      const order = {
        id: orderId,
        status: "pending",
        createdAt: new Date().toISOString(),
        guildId: i.guildId,
        channelId: i.channelId,
        userId: i.user.id,
        userTag: i.user.tag,
        product: { id: prod.id, name: prod.name, price: prod.price },
        payment: { method: null, provider: null, url: null, transactionId: null, paidAmount: null },
      };

      upsertOrder(order);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pay_crypto:${orderId}`).setLabel("Crypto").setEmoji("🪙").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pay_stripe:${orderId}`).setLabel("Stripe").setEmoji("💳").setStyle(ButtonStyle.Primary)
      );

      await i.channel.send({ embeds: [paymentMethodsEmbed(prod)], components: [row] });
      return i.reply({ content: "✅ Choose payment method below.", ephemeral: true });
    }

    /* ---- Pay crypto ---- */
    if (i.customId.startsWith("pay_crypto:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const cb = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/webhook/cryptomus` : undefined;

      const inv = await createCryptomusInvoice({
        amountUsd: order.product.price,
        orderId: order.id,
        description: `${STORE_NAME} | ${order.product.name}`,
        successUrl: PUBLIC_BASE_URL || undefined,
        callbackUrl: cb,
        env: process.env,
      });

      upsertOrder({ ...order, payment: { ...order.payment, method: "crypto", provider: "cryptomus", url: inv.url, transactionId: inv.uuid } });

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(inv.url)
      );

      await i.channel.send({ embeds: [paymentInstructionsEmbed("crypto", order)], components: [payRow] });
      return i.reply({ content: "✅ Payment link sent.", ephemeral: true });
    }

    /* ---- Pay stripe ---- */
    if (i.customId.startsWith("pay_stripe:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const base = PUBLIC_BASE_URL || "https://example.com";
      const successUrl = `${base}/success?order=${encodeURIComponent(order.id)}`;
      const cancelUrl = `${base}/cancel?order=${encodeURIComponent(order.id)}`;

      const session = await createStripeCheckout({
        env: process.env,
        amountUsd: order.product.price,
        orderId: order.id,
        productName: `${STORE_NAME} - ${order.product.name}`,
        successUrl,
        cancelUrl,
      });

      upsertOrder({ ...order, payment: { ...order.payment, method: "stripe", provider: "stripe", url: session.url, transactionId: session.id } });

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(session.url)
      );

      await i.channel.send({ embeds: [paymentInstructionsEmbed("stripe", order)], components: [payRow] });
      return i.reply({ content: "✅ Checkout link sent.", ephemeral: true });
    }
  } catch (e) {
    console.log("Interaction error:", e?.message || e);
    try {
      if (i.deferred || i.replied) await i.followUp({ content: `❌ Error: ${e.message}`, ephemeral: true });
      else await i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true });
    } catch {}
  }
});

/* ================== Paid notify ================== */
async function notifyPaid(order) {
  try {
    const ch = await client.channels.fetch(order.channelId).catch(() => null);
    if (!ch) return;

    const embed = new EmbedBuilder()
      .setTitle("✅ Payment Received")
      .setDescription(
        [
          `**Order ID:** \`${order.id}\``,
          `**Product:** ${order.product.name}`,
          `**Amount:** ${money(order.product.price)}`,
          `**Method:** ${order.payment.method}`,
          "",
          "Owner can deliver and close with `+dn`.",
        ].join("\n")
      );

    await ch.send({ embeds: [embed], content: OWNER_ID ? `<@${OWNER_ID}>` : undefined });

    if (LOG_CHANNEL_ID) {
      const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (logCh) {
        const logEmbed = new EmbedBuilder()
          .setTitle("🧾 Order Paid")
          .setDescription(
            [
              `**Buyer:** <@${order.userId}> (${order.userTag})`,
              `**Order ID:** \`${order.id}\``,
              `**Product:** ${order.product.name}`,
              `**Payment:** ${order.payment.method}`,
              `**Amount:** ${money(order.product.price)}`,
            ].join("\n")
          );
        await logCh.send({ embeds: [logEmbed] }).catch(() => {});
      }
    }
  } catch (e) {
    console.log("notifyPaid error:", e?.message || e);
  }
}

/* ================== +dn close ================== */
client.on(Events.MessageCreate, async (m) => {
  try {
    if (!m.guild) return;
    if (!m.channel?.name?.startsWith("ticket-")) return;
    if (m.content?.trim() !== "+dn") return;

    const isOwner = OWNER_ID && m.author.id === OWNER_ID;
    const hasManage = m.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    if (!isOwner && !hasManage) return;

    const order = getOrderByChannelId(m.channel.id);

    if (order && order.status !== "paid") {
      const k = `_force_${m.channel.id}`;
      globalThis[k] = (globalThis[k] || 0) + 1;
      if (globalThis[k] < 2) {
        await m.channel.send("⚠️ Order not marked paid. Type `+dn` مرة ثانية للإغلاق الإجباري.");
        return;
      }
    }

    await m.channel.send("✅ Ticket will close in **10 seconds**…");

    if (order) {
      const invoiceId = `INV-${order.id.slice(0, 8).toUpperCase()}`;
      const pdfPath = path.resolve(`./invoices/${invoiceId}.pdf`);

      await createInvoicePDF(
        {
          storeName: STORE_NAME,
          orderId: order.id,
          invoiceId,
          buyerTag: order.userTag,
          buyerId: order.userId,
          productName: order.product.name,
          amountUsd: order.product.price,
          paymentMethod: order.payment.method || "-",
          paymentAmount: order.payment.paidAmount || money(order.product.price),
          transactionId: order.payment.transactionId || "-",
          createdAt: new Date().toISOString(),
        },
        pdfPath
      );

      const user = await client.users.fetch(order.userId).catch(() => null);
      if (user) {
        await user
          .send({
            content: `🧾 Your invoice from **${STORE_NAME}** (Order: \`${order.id}\`). Thank you!`,
            files: [pdfPath],
          })
          .catch(() => {});
      }
    }

    setTimeout(() => m.channel.delete().catch(() => {}), 10_000);
  } catch (e) {
    console.log("MessageCreate error:", e?.message || e);
  }
});

/* ================== Process safety ================== */
process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err?.message || err));
process.on("uncaughtException", (err) => console.log("uncaughtException:", err?.message || err));

/* ================== Discord Login (Robust + Diagnose) ================== */
const token = (process.env.DISCORD_TOKEN || "").trim();
console.log("DISCORD_TOKEN present?", Boolean(token));
console.log("DISCORD_TOKEN length:", token.length);
console.log("About to login to Discord...");

client.on("shardDisconnect", (event, shardId) => {
  console.log("SHARD DISCONNECT", shardId, "code:", event?.code, "reason:", event?.reason);
});
client.on("shardReconnecting", (shardId) => console.log("SHARD RECONNECTING", shardId));
client.on("shardResume", (shardId) => console.log("SHARD RESUMED", shardId));
client.on("invalidated", () => console.log("CLIENT INVALIDATED (token/session invalid)"));

client
  .login(token)
  .then(() => console.log("✅ Discord login OK"))
  .catch((e) => {
    console.log("❌ Discord login FAILED:", e);
    process.exit(1);
  });

// إذا ظل معلق بدون READY، نعيد تشغيل العملية (Render يعيد تشغيلها)
setTimeout(() => {
  if (!client.isReady?.()) {
    console.log("❌ Discord not ready after 30s -> restarting process...");
    process.exit(1);
  }
}, 30000);
