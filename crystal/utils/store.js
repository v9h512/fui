import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("./data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

export function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders: [] }, null, 2));
  }
}

export function loadOrders() {
  ensureDataFiles();
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
}

export function saveOrders(db) {
  ensureDataFiles();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(db, null, 2));
}

export function upsertOrder(order) {
  const db = loadOrders();
  const idx = db.orders.findIndex(o => o.id === order.id);
  if (idx === -1) db.orders.push(order);
  else db.orders[idx] = { ...db.orders[idx], ...order };
  saveOrders(db);
  return order;
}

export function getOrderById(id) {
  const db = loadOrders();
  return db.orders.find(o => o.id === id) || null;
}

export function getOrderByChannelId(channelId) {
  const db = loadOrders();
  return db.orders.find(o => o.channelId === channelId) || null;
}

export function markPaid(id, payment) {
  const order = getOrderById(id);
  if (!order) return null;
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.payment = { ...order.payment, ...payment };
  upsertOrder(order);
  return order;
}
