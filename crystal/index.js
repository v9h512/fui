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

// Read products once at boot (keep file valid JSON)
const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));

/* ================== Helpers ================== */
const money = (n) => `$${Number(n).toFixed(2)}`;

function getTicketOwnerIdFromName(channelName = "") {
  // ticket-1234567890
  if (!channelName.startsWith("ticket-")) return null;
  return channelName.split("ticket-")[1] || null;
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  if (SUPPORT_ROLE_ID && member.roles?.cache?.has(SUPPORT_ROLE_ID)) return true;
  if (OWNER_ID && member.id === OWNER_ID) return true;
  return false;
}

async function findExistingTicketChannel(guild, userId) {
  // fetch to avoid cache-miss
  const chans = await guild.channels.fetch().catch(() => null);
  if (!chans) return null;
  return chans.find(
    (c) => c?.type === ChannelType.GuildText && c?.name === `ticket-${userId}`
  );
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
        "✅ Invoice PDF after delivery",
        "",
        "**Click the button below to open your ticket.**",
      ].join("\n")
    )
    .setFooter({ text: "Powered by Crystal System" });

const welcomeEmbed = (user) =>
  new EmbedBuilder()
    .setTitle("Welcome 👋")
    .setDescription(
      [
        `Hello ${user}!`,
        "",
        "This ticket is for your order.",
        "Please choose a product below to continue.",
      ].join("\n")
    );

const productsEmbed = () =>
  new EmbedBuilder()
    .setTitle("🛍️ Products")
    .setDescription(
      products
        .map((p) => `${p.emoji} **${p.name}** — ${money(p.price)} _(ETA: ${p.delivery})_`)
        .join("\n")
    )
    .setFooter({ text: "Select one product button to continue." });

const paymentMethodsEmbed = (prod) =>
  new EmbedBuilder()
    .setTitle("💳 Choose Payment Method")
    .setDescription(
      [
        `**Product:** ${prod.name}`,
        `**Total:** ${money(prod.price)}`,
        "",
        "Choose your payment method below:",
      ].join("\n")
    );

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
    lines.push("2) Complete the payment");
    lines.push("3) Wait for confirmation in this ticket");
  } else {
    lines.push("**Stripe (Card)**");
    lines.push("1) Click **Pay Now**");
    lines.push("2) Complete checkout");
    lines.push("3) Wait for confirmation in this ticket");
  }

  return new EmbedBuilder().setTitle("✅ Payment Instructions").setDescription(lines.join("\n"));
};

const paidEmbed = (order) =>
  new EmbedBuilder()
    .setTitle("✅ Payment Received")
    .setDescription(
      [
        `**Order ID:** \`${order.id}\``,
        `**Product:** ${order.product.name}`,
        `**Amount:** ${money(order.product.price)}`,
        `**Method:** ${order.payment.method}`,
        "",
        "Owner will deliver your order soon ✅",
        "After delivery, the ticket will be closed.",
      ].join("\n")
    )
    .setFooter({ text: "Thank you for your purchase!" });

/* ================== Express Web ================== */
const app = express();

// cryptomus expects JSON webhook
app.use("/webhook/cryptomus", express.json({ limit: "1mb" }));

// stripe expects RAW body for signature verification
app.use("/webhook/stripe", express.raw({ type: "application/json" }));

// static store website
app.use(express.static("public"));

app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/webhook/cryptomus", async (req, res) => {
  try {
    if (!isCryptomusWebhookTrusted(req, process.env))
      return res.status(401).send("untrusted");

    const payload = req.body || {};
    const orderId = payload?.order_id;
    const status = String(payload?.status || "").toLowerCase();

    if (!orderId) return res.status(200).send("no order id");

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
    console.log("Cryptomus webhook error:", e);
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
      // fallback (NOT recommended for prod)
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
          paidAmount: session?.amount_total
            ? `$${(session.amount_total / 100).toFixed(2)}`
            : null,
        });
        if (order) await notifyPaid(order);
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.log("Stripe webhook error:", e);
    return res.status(200).send("ok");
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`Web server started on port ${PORT}`));

/* ================== Discord Bot ================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // for +dn
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Prevent double ticket creation (Lock per user for a few seconds)
const ticketLocks = new Map(); // userId => timestamp(ms)
function lockTicket(userId, ttlMs = 8000) {
  const now = Date.now();
  const last = ticketLocks.get(userId) || 0;
  if (now - last < ttlMs) return false;
  ticketLocks.set(userId, now);
  setTimeout(() => {
    // release after TTL
    if (ticketLocks.get(userId) === now) ticketLocks.delete(userId);
  }, ttlMs);
  return true;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register /panel command (guild scoped)
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
    console.log("Slash command /panel registered.");
  } catch (e) {
    console.log("Command registration error:", e);
  }
});

/* ---------- /panel command ---------- */
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

/* ---------- Buttons ---------- */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;

  try {
    /* ===== Open Ticket ===== */
    if (i.customId === "open_ticket") {
      // FAST ACK to avoid Discord retry (سبب شائع لفتح تكتين)
      await i.deferReply({ ephemeral: true });

      if (!lockTicket(i.user.id)) {
        return i.editReply("⏳ Please wait… your ticket is being created.");
      }

      const existing = await findExistingTicketChannel(i.guild, i.user.id);
      if (existing) {
        return i.editReply(`⚠️ You already have a ticket: <#${existing.id}>`);
      }

      const overwrites = [
        { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: i.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      if (SUPPORT_ROLE_ID) {
        overwrites.push({
          id: SUPPORT_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
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

      // Welcome
      await ticket.send({ embeds: [welcomeEmbed(i.user)] });

      // Products message (separate)
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

    /* ===== Choose Product ===== */
    if (i.customId.startsWith("choose_prod:")) {
      // only inside ticket channels
      if (!i.channel?.name?.startsWith("ticket-")) {
        return i.reply({ content: "❌ Use this inside your ticket.", ephemeral: true });
      }

      // only ticket owner or staff can choose
      const ownerId = getTicketOwnerIdFromName(i.channel.name);
      if (ownerId !== i.user.id && !isStaff(i.member)) {
        return i.reply({ content: "❌ Only the ticket owner can choose products.", ephemeral: true });
      }

      const prodId = i.customId.split(":")[1];
      const prod = products.find((p) => p.id === prodId);
      if (!prod) return i.reply({ content: "❌ Product not found.", ephemeral: true });

      // prevent creating many orders in same channel
      const existingOrder = getOrderByChannelId(i.channelId);
      if (existingOrder && existingOrder.status !== "paid") {
        return i.reply({
          content: `⚠️ You already have a pending order: \`${existingOrder.id}\`\nPlease complete payment or ask staff to close.`,
          ephemeral: true,
        });
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
        new ButtonBuilder()
          .setCustomId(`pay_crypto:${orderId}`)
          .setLabel("Crypto")
          .setEmoji("🪙")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`pay_stripe:${orderId}`)
          .setLabel("Stripe")
          .setEmoji("💳")
          .setStyle(ButtonStyle.Primary)
      );

      await i.channel.send({ embeds: [paymentMethodsEmbed(prod)], components: [row] });
      return i.reply({ content: "✅ Choose payment method below.", ephemeral: true });
    }

    /* ===== Pay Crypto ===== */
    if (i.customId.startsWith("pay_crypto:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const callbackUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/webhook/cryptomus` : undefined;

      const inv = await createCryptomusInvoice({
        amountUsd: order.product.price,
        orderId: order.id,
        description: `${STORE_NAME} | ${order.product.name}`,
        successUrl: PUBLIC_BASE_URL || undefined,
        callbackUrl,
        env: process.env,
      });

      upsertOrder({
        ...order,
        payment: {
          ...order.payment,
          method: "crypto",
          provider: "cryptomus",
          url: inv.url,
          transactionId: inv.uuid,
        },
      });

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(inv.url)
      );

      await i.channel.send({
        embeds: [paymentInstructionsEmbed("crypto", order)],
        components: [payRow],
      });

      return i.reply({ content: "✅ Crypto payment link sent.", ephemeral: true });
    }

    /* ===== Pay Stripe ===== */
    if (i.customId.startsWith("pay_stripe:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const base = PUBLIC_BASE_URL || "https://example.com";
      const successUrl = `${base}/success?order=${order.id}`;
      const cancelUrl = `${base}/cancel?order=${order.id}`;

      const session = await createStripeCheckout({
        env: process.env,
        amountUsd: order.product.price,
        orderId: order.id,
        productName: `${STORE_NAME} - ${order.product.name}`,
        successUrl,
        cancelUrl,
      });

      upsertOrder({
        ...order,
        payment: {
          ...order.payment,
          method: "stripe",
          provider: "stripe",
          url: session.url,
          transactionId: session.id,
        },
      });

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(session.url)
      );

      await i.channel.send({
        embeds: [paymentInstructionsEmbed("stripe", order)],
        components: [payRow],
      });

      return i.reply({ content: "✅ Stripe checkout link sent.", ephemeral: true });
    }
  } catch (e) {
    console.log("Button error:", e);
    try {
      if (i.deferred || i.replied) {
        await i.followUp({ content: `❌ Error: ${e.message}`, ephemeral: true });
      } else {
        await i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true });
      }
    } catch {}
  }
});

/* ================== Paid Notify ================== */
async function notifyPaid(order) {
  try {
    const ch = await client.channels.fetch(order.channelId).catch(() => null);
    if (!ch) return;

    await ch.send({
      embeds: [paidEmbed(order)],
      content: OWNER_ID ? `<@${OWNER_ID}>` : undefined,
    });
  } catch (e) {
    console.log("notifyPaid error:", e);
  }
}

/* ================== +dn Close & Invoice ================== */
client.on(Events.MessageCreate, async (m) => {
  try {
    if (!m.guild) return;
    if (!m.channel?.name?.startsWith("ticket-")) return;
    if (m.content?.trim() !== "+dn") return;

    const isOwner = OWNER_ID && m.author.id === OWNER_ID;
    const hasManage = m.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    if (!isOwner && !hasManage) return;

    const order = getOrderByChannelId(m.channel.id);

    // If not paid, require double +dn to force close
    if (order && order.status !== "paid") {
      const forceKey = `_force_${m.channel.id}`;
      globalThis[forceKey] = (globalThis[forceKey] || 0) + 1;
      if (globalThis[forceKey] < 2) {
        await m.channel.send("⚠️ Order not marked paid. Type `+dn` مرة ثانية للإغلاق الإجباري.");
        return;
      }
    }

    await m.channel.send("✅ Ticket will close in **10 seconds**…");

    // Create & DM invoice PDF
    if (order) {
      const invoiceId = `INV-${order.id.slice(0, 8).toUpperCase()}`;
      const pdfPath = path.resolve(`./invoices/${invoiceId}.pdf`);

      try {
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
      } catch (e) {
        console.log("Invoice PDF error:", e);
      }

      const user = await client.users.fetch(order.userId).catch(() => null);
      if (user) {
        await user
          .send({
            content: `🧾 Your invoice from **${STORE_NAME}** (Order: \`${order.id}\`). Thank you!`,
            files: fs.existsSync(pdfPath) ? [pdfPath] : [],
          })
          .catch(() => {});
      }

      // Log channel embed
      if (LOG_CHANNEL_ID) {
        const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logCh) {
          const logEmbed = new EmbedBuilder()
            .setTitle("🧾 New Completed Order")
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
    }

    setTimeout(() => m.channel.delete().catch(() => {}), 10_000);
  } catch (e) {
    console.log("MessageCreate error:", e);
  }
});

/* ================== Discord Login Debug ================== */
console.log("DISCORD_TOKEN present?", Boolean(process.env.DISCORD_TOKEN));
console.log("DISCORD_TOKEN length:", (process.env.DISCORD_TOKEN || "").length);

client.on("error", (e) => console.log("Discord client error:", e));
client.on("shardError", (e) => console.log("Discord shard error:", e));

client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK"))
  .catch((e) => console.log("Discord login FAILED:", e));

process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.log("uncaughtException:", err));
