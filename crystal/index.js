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

/* ================== Boot checks ================== */
ensureDataFiles();
fs.mkdirSync(path.resolve("./invoices"), { recursive: true });

const STORE_NAME = process.env.STORE_NAME || "Crystal Store";
const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

/* ================== Express (Web + Webhooks) ================== */
const app = express();

// Cryptomus webhook uses JSON
app.use("/webhook/cryptomus", express.json({ limit: "1mb" }));

// Stripe webhook must be RAW for signature verification
app.use("/webhook/stripe", express.raw({ type: "application/json" }));

// Static website
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
      // Verified webhook
      event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } else {
      // Fallback (NOT recommended for prod)
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

app.listen(PORT, () => console.log(`Web server started on port ${PORT}`));

/* ================== Discord ================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // needed for "+dn"
  ],
  partials: [Partials.Channel],
});

/* ====== Diagnostics for "bot offline" ====== */
console.log("DISCORD_TOKEN present?", Boolean(process.env.DISCORD_TOKEN));
console.log("DISCORD_TOKEN length:", process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.length : 0);

client.on("error", (e) => console.log("Discord client error:", e?.message || e));
client.on("shardError", (e) => console.log("Discord shard error:", e?.message || e));
client.on("warn", (w) => console.log("Discord warn:", w));
client.once(Events.ClientReady, () => {
  console.log("READY ✅", client.user.tag);
});

const money = (n) => `$${Number(n).toFixed(2)}`;

/* ====== Prevent double ticket creation (Fix: opens 2 tickets) ====== */
const creatingTickets = new Set(); // userId lock
const forceCloseCounter = new Map(); // channelId -> count

/* ====== Embeds ====== */
const panelEmbed = () =>
  new EmbedBuilder()
    .setTitle(`${STORE_NAME} — Support & Orders`)
    .setDescription(
      [
        "Open a private ticket to place an order or ask for help.",
        "",
        "✅ Fast delivery",
        "✅ Secure payments (Crypto / Stripe)",
        "✅ PDF invoice after delivery",
      ].join("\n")
    )
    .setFooter({ text: "Click the button below to open a ticket." });

const welcomeEmbed = (user) =>
  new EmbedBuilder()
    .setTitle("Welcome 👋")
    .setDescription(
      [
        `Hello ${user}!`,
        "",
        "Please choose a product below.",
        "After payment, you will receive confirmation in this ticket.",
      ].join("\n")
    );

const productsEmbed = () =>
  new EmbedBuilder()
    .setTitle("Products")
    .setDescription(products.map((p) => `${p.emoji} **${p.name}** — ${money(p.price)} _(ETA: ${p.delivery})_`).join("\n"))
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

/* ====== Slash command: /panel ====== */
async function registerCommands() {
  try {
    // global command registration may take time
    await client.application.commands.set([
      {
        name: "panel",
        description: "Send ticket panel to this channel",
        default_member_permissions: String(PermissionFlagsBits.Administrator),
      },
    ]);
    console.log("Commands registered ✅");
  } catch (e) {
    console.log("Command registration error:", e?.message || e);
  }
}

client.once(Events.ClientReady, async () => {
  await registerCommands();
});

/* ====== Interaction handler (slash + buttons) ====== */
client.on(Events.InteractionCreate, async (i) => {
  try {
    // Slash: /panel
    if (i.isChatInputCommand()) {
      if (i.commandName !== "panel") return;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("open_ticket")
          .setLabel("Open Ticket")
          .setEmoji("🎫")
          .setStyle(ButtonStyle.Primary)
      );

      await i.channel.send({ embeds: [panelEmbed()], components: [row] });
      await i.reply({ content: "✅ Panel sent.", ephemeral: true });
      return;
    }

    // Buttons
    if (!i.isButton()) return;

    // Open ticket
    if (i.customId === "open_ticket") {
      if (creatingTickets.has(i.user.id)) {
        return i.reply({ content: "⏳ Creating your ticket… please wait.", ephemeral: true });
      }

      creatingTickets.add(i.user.id);

      try {
        const existing = i.guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && c.name === `ticket-${i.user.id}`
        );
        if (existing) {
          creatingTickets.delete(i.user.id);
          return i.reply({ content: `⚠️ You already have a ticket: <#${existing.id}>`, ephemeral: true });
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

        if (process.env.SUPPORT_ROLE_ID) {
          overwrites.push({
            id: process.env.SUPPORT_ROLE_ID,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          });
        }

        if (process.env.OWNER_ID) {
          overwrites.push({
            id: process.env.OWNER_ID,
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
          parent: process.env.TICKET_CATEGORY_ID || null,
          permissionOverwrites: overwrites,
        });

        await ticket.send({ embeds: [welcomeEmbed(i.user)] });

        // Product buttons (max 5 per row)
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

        await i.reply({ content: `✅ Ticket created: <#${ticket.id}>`, ephemeral: true });
      } finally {
        creatingTickets.delete(i.user.id);
      }

      return;
    }

    // Choose product
    if (i.customId.startsWith("choose_prod:")) {
      const prodId = i.customId.split(":")[1];
      const prod = products.find((p) => p.id === prodId);
      if (!prod) return i.reply({ content: "❌ Product not found.", ephemeral: true });

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
      await i.reply({ content: "✅ Choose payment method below.", ephemeral: true });
      return;
    }

    // Pay by crypto
    if (i.customId.startsWith("pay_crypto:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const cb = `${PUBLIC_BASE_URL}/webhook/cryptomus`;

      const inv = await createCryptomusInvoice({
        amountUsd: order.product.price,
        orderId: order.id,
        description: `${STORE_NAME} | ${order.product.name}`,
        successUrl: PUBLIC_BASE_URL || undefined,
        callbackUrl: PUBLIC_BASE_URL ? cb : undefined,
        env: process.env,
      });

      upsertOrder({
        ...order,
        payment: { ...order.payment, method: "crypto", provider: "cryptomus", url: inv.url, transactionId: inv.uuid },
      });

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(inv.url)
      );

      await i.channel.send({ embeds: [paymentInstructionsEmbed("crypto", order)], components: [payRow] });
      await i.reply({ content: "✅ Payment link sent.", ephemeral: true });
      return;
    }

    // Pay by stripe
    if (i.customId.startsWith("pay_stripe:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const successUrl = `${PUBLIC_BASE_URL || "https://example.com"}/success?order=${order.id}`;
      const cancelUrl = `${PUBLIC_BASE_URL || "https://example.com"}/cancel?order=${order.id}`;

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
        payment: { ...order.payment, method: "stripe", provider: "stripe", url: session.url, transactionId: session.id },
      });

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(session.url)
      );

      await i.channel.send({ embeds: [paymentInstructionsEmbed("stripe", order)], components: [payRow] });
      await i.reply({ content: "✅ Checkout link sent.", ephemeral: true });
      return;
    }
  } catch (e) {
    console.log("Interaction error:", e?.message || e);
    try {
      if (i?.reply && !i.replied) await i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true });
    } catch {}
  }
});

/* ====== Payment notification ====== */
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

    await ch.send({
      embeds: [embed],
      content: process.env.OWNER_ID ? `<@${process.env.OWNER_ID}>` : undefined,
    });
  } catch (e) {
    console.log("notifyPaid error:", e?.message || e);
  }
}

/* ====== Close ticket with +dn ====== */
client.on(Events.MessageCreate, async (m) => {
  try {
    if (!m.guild) return;
    if (!m.channel?.name?.startsWith("ticket-")) return;
    if (m.content?.trim() !== "+dn") return;

    const isOwner = process.env.OWNER_ID && m.author.id === process.env.OWNER_ID;
    const hasManage = m.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    if (!isOwner && !hasManage) return;

    const order = getOrderByChannelId(m.channel.id);

    // If not paid, require double +dn
    if (order && order.status !== "paid") {
      const c = (forceCloseCounter.get(m.channel.id) || 0) + 1;
      forceCloseCounter.set(m.channel.id, c);
      if (c < 2) {
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

      if (process.env.LOG_CHANNEL_ID) {
        const logCh = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
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
          await logCh.send({ embeds: [logEmbed] });
        }
      }
    }

    setTimeout(() => m.channel.delete().catch(() => {}), 10_000);
  } catch (e) {
    console.log("Message handler error:", e?.message || e);
  }
});

/* ====== Process safety ====== */
process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err?.message || err));
process.on("uncaughtException", (err) => console.log("uncaughtException:", err?.message || err));

/* ====== Login ====== */
client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK ✅"))
  .catch((e) => console.log("Discord login FAILED ❌:", e?.message || e));
