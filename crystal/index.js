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
const TICKET_PREFIX = "ticket-";

// مهم: حط رابط موقعك هنا في Render ENV (مثال: https://crystale.onrender.com)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

// قراءة المنتجات
const products = safeReadJSON("./products.json", []);
if (!Array.isArray(products) || products.length === 0) {
  console.log("⚠️ products.json empty or invalid. Make sure it is an array.");
}

/* ================== Express ================== */
const app = express();
app.use("/webhook/cryptomus", express.json({ limit: "1mb" }));
app.use("/webhook/stripe", express.raw({ type: "application/json" }));

app.use(express.static("public"));
app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/webhook/cryptomus", async (req, res) => {
  try {
    if (!isCryptomusWebhookTrusted(req, process.env)) {
      return res.status(401).send("untrusted");
    }

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
      // fallback (غير مفضل) إذا ما عندك STRIPE_WEBHOOK_SECRET
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
app.listen(PORT, () => console.log("Web server started on port", PORT));

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

/* ===== Debug / Stability ===== */
console.log("DISCORD_TOKEN present?", Boolean(process.env.DISCORD_TOKEN));
if (process.env.DISCORD_TOKEN) console.log("DISCORD_TOKEN length:", String(process.env.DISCORD_TOKEN).length);

client.on("error", (e) => console.log("Discord client error:", e));
client.on("shardError", (e) => console.log("Discord shard error:", e));
process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.log("uncaughtException:", err));

/* ===== Helpers ===== */
const money = (n) => `$${Number(n).toFixed(2)}`;

function safeReadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function ticketName(userId) {
  return `${TICKET_PREFIX}${userId}`;
}

async function findExistingTicketChannel(guild, userId) {
  // fetch كامل لتفادي مشكلة cache
  const channels = await guild.channels.fetch();
  return channels.find(
    (c) => c && c.type === ChannelType.GuildText && c.name === ticketName(userId)
  );
}

function panelEmbed() {
  return new EmbedBuilder()
    .setTitle(`${STORE_NAME} — Ticket Panel`)
    .setDescription(
      [
        "افتح تكت لطلب منتج أو للدعم.",
        "",
        "✅ تسليم سريع",
        "✅ دفع آمن (Crypto / Stripe)",
        "✅ فاتورة PDF بعد الإغلاق",
      ].join("\n")
    )
    .setFooter({ text: "اضغط Open Ticket" });
}

function welcomeEmbed(user) {
  return new EmbedBuilder()
    .setTitle("أهلًا 👋")
    .setDescription(
      [
        `مرحبًا ${user}!`,
        "",
        "📌 **خطوات الطلب:**",
        "1) اختر المنتج",
        "2) اختر طريقة الدفع",
        "3) ادفع من الرابط",
        "4) سيظهر تأكيد الدفع هنا تلقائيًا",
      ].join("\n")
    );
}

function productsEmbed() {
  const list = products
    .map((p) => `${p.emoji} **${p.name}** — ${money(p.price)} _(ETA: ${p.delivery})_`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("المنتجات")
    .setDescription(list || "لا توجد منتجات حالياً.")
    .setFooter({ text: "اختر منتجًا للمتابعة." });
}

function paymentMethodsEmbed(prod) {
  return new EmbedBuilder()
    .setTitle("اختيار طريقة الدفع")
    .setDescription(
      [
        `**المنتج:** ${prod.name}`,
        `**المبلغ:** ${money(prod.price)}`,
        "",
        "اختر طريقة الدفع من الأزرار:",
      ].join("\n")
    );
}

function paymentInstructionsEmbed(method, order) {
  const lines = [
    `**Order ID:** \`${order.id}\``,
    `**Product:** ${order.product.name}`,
    `**Total:** ${money(order.product.price)}`,
    "",
  ];

  if (method === "crypto") {
    lines.push("**Crypto (Cryptomus)**");
    lines.push("1) اضغط **Pay Now**");
    lines.push("2) ادفع");
    lines.push("3) انتظر التأكيد هنا");
  } else {
    lines.push("**Stripe (Card)**");
    lines.push("1) اضغط **Pay Now**");
    lines.push("2) أكمل الدفع");
    lines.push("3) انتظر التأكيد هنا");
  }

  return new EmbedBuilder().setTitle("الدفع").setDescription(lines.join("\n"));
}

function paidEmbed(order) {
  const invoiceId = `INV-${order.id.slice(0, 8).toUpperCase()}`;
  return new EmbedBuilder()
    .setTitle("✅ تم استلام الدفع")
    .setDescription(
      [
        `**Invoice:** \`${invoiceId}\``,
        `**Order ID:** \`${order.id}\``,
        `**Product:** ${order.product.name}`,
        `**Amount:** ${money(order.product.price)}`,
        `**Method:** ${order.payment.method}`,
        order.payment.transactionId ? `**Tx:** \`${order.payment.transactionId}\`` : null,
        "",
        "✅ سيتم التسليم قريبًا.",
        "🔒 للإغلاق: الأونر يكتب `+dn` داخل التكت.",
      ]
        .filter(Boolean)
        .join("\n")
    );
}

/* ================== Slash Command (/panel) ================== */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // تسجيل أمر /panel (سهل وسريع)
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
    console.log("Commands registered.");
  } catch (e) {
    console.log("Command registration error:", e);
  }
});

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

/* ================== Ticket / Buttons ================== */
const openingLock = new Set(); // يمنع فتح تكتين بسبب ضغطتين بسرعة

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;

  try {
    /* ===== Open Ticket ===== */
    if (i.customId === "open_ticket") {
      if (openingLock.has(i.user.id)) {
        return i.reply({ content: "⏳ لحظة… جاري إنشاء التكت.", ephemeral: true });
      }
      openingLock.add(i.user.id);

      try {
        // فحص أقوى (fetch)
        const existing = await findExistingTicketChannel(i.guild, i.user.id);
        if (existing) {
          return i.reply({
            content: `⚠️ عندك تكت مفتوح بالفعل: <#${existing.id}>`,
            ephemeral: true,
          });
        }

        await i.deferReply({ ephemeral: true });

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
          name: ticketName(i.user.id),
          type: ChannelType.GuildText,
          parent: process.env.TICKET_CATEGORY_ID || null,
          permissionOverwrites: overwrites,
        });

        // 1) ترحيب
        await ticket.send({ embeds: [welcomeEmbed(i.user)] });

        // 2) قائمة المنتجات + أزرار
        const rows = buildProductButtons();
        await ticket.send({ embeds: [productsEmbed()], components: rows });

        await i.editReply({ content: `✅ Ticket created: <#${ticket.id}>` });
      } finally {
        openingLock.delete(i.user.id);
      }
      return;
    }

    /* ===== Choose Product ===== */
    if (i.customId.startsWith("choose_prod:")) {
      const prodId = i.customId.split(":")[1];
      const prod = products.find((p) => p.id === prodId);
      if (!prod) return i.reply({ content: "❌ Product not found.", ephemeral: true });

      // نسمح فقط لصاحب التكت (الذي اسم القناة ticket-USERID)
      const expected = ticketName(i.user.id);
      if (i.channel?.name && i.channel.name.startsWith(TICKET_PREFIX) && i.channel.name !== expected) {
        return i.reply({ content: "❌ هذا التكت ليس لك.", ephemeral: true });
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
      await i.reply({ content: "✅ اختر طريقة الدفع من الرسالة.", ephemeral: true });
      return;
    }

    /* ===== Pay Crypto ===== */
    if (i.customId.startsWith("pay_crypto:")) {
      await i.deferReply({ ephemeral: true });

      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.editReply("❌ Order not found.");
      if (order.channelId !== i.channelId) return i.editReply("❌ هذا الطلب ليس في هذا التكت.");
      if (order.status === "paid") return i.editReply("✅ Already paid.");

      // callback webhook
      const cb = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/webhook/cryptomus` : undefined;

      const inv = await createCryptomusInvoice({
        amountUsd: order.product.price,
        orderId: order.id,
        description: `${STORE_NAME} | ${order.product.name}`,
        successUrl: PUBLIC_BASE_URL || undefined,
        callbackUrl: cb,
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

      await i.editReply("✅ تم إرسال رابط الدفع (Crypto).");
      return;
    }

    /* ===== Pay Stripe ===== */
    if (i.customId.startsWith("pay_stripe:")) {
      await i.deferReply({ ephemeral: true });

      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.editReply("❌ Order not found.");
      if (order.channelId !== i.channelId) return i.editReply("❌ هذا الطلب ليس في هذا التكت.");
      if (order.status === "paid") return i.editReply("✅ Already paid.");

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

      await i.editReply("✅ تم إرسال رابط الدفع (Stripe).");
      return;
    }
  } catch (e) {
    console.log("Button error:", e);
    try {
      if (i.deferred) return i.editReply(`❌ Error: ${e.message}`);
      return i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true });
    } catch {}
  }
});

/* ================== Paid Notify ================== */
async function notifyPaid(order) {
  try {
    const ch = await client.channels.fetch(order.channelId).catch(() => null);
    if (!ch) return;

    const mention = process.env.OWNER_ID ? `<@${process.env.OWNER_ID}>` : undefined;
    await ch.send({ embeds: [paidEmbed(order)], content: mention });

    // إرسال سجل في روم اللوق
    if (process.env.LOG_CHANNEL_ID) {
      const logCh = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
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
        await logCh.send({ embeds: [logEmbed] });
      }
    }
  } catch (e) {
    console.log("notifyPaid error:", e);
  }
}

/* ================== +dn Close ================== */
client.on(Events.MessageCreate, async (m) => {
  try {
    if (!m.guild) return;
    if (!m.channel?.name?.startsWith(TICKET_PREFIX)) return;
    if (m.content?.trim() !== "+dn") return;

    const isOwner = process.env.OWNER_ID && m.author.id === process.env.OWNER_ID;
    const hasManage = m.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
    if (!isOwner && !hasManage) return;

    const order = getOrderByChannelId(m.channel.id);

    // إذا ما دفع، اطلب تأكيد (مرتين)
    if (order && order.status !== "paid") {
      const forceKey = `_force_${m.channel.id}`;
      globalThis[forceKey] = (globalThis[forceKey] || 0) + 1;

      if (globalThis[forceKey] < 2) {
        await m.channel.send("⚠️ الطلب غير مدفوع حسب النظام. اكتب `+dn` مرة ثانية للإغلاق الإجباري.");
        return;
      }
    }

    await m.channel.send("✅ سيتم إغلاق التكت خلال **10 ثواني**…");

    // إنشاء PDF + إرسال للعميل
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
            content: `🧾 فاتورتك من **${STORE_NAME}** (Order: \`${order.id}\`) — شكرًا لك!`,
            files: [pdfPath],
          })
          .catch(() => {});
      }

      // سجل إنه اكتمل
      if (process.env.LOG_CHANNEL_ID) {
        const logCh = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
        if (logCh) {
          const logEmbed = new EmbedBuilder()
            .setTitle("✅ Order Completed")
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
    console.log("+dn handler error:", e);
  }
});

/* ================== Buttons Builder ================== */
function buildProductButtons() {
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
        .setEmoji(p.emoji || "🛒")
        .setStyle(ButtonStyle.Secondary)
    );

    count++;
  }

  if (count) rows.push(row);
  return rows;
}

/* ================== Login ================== */
console.log("About to login to Discord...");
client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK"))
  .catch((e) => console.log("Discord login FAILED:", e));
