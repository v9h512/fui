import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

export function ensureInvoicesDir() {
  fs.mkdirSync(path.resolve("./invoices"), { recursive: true });
}

export function createInvoicePDF(data, filePath) {
  ensureInvoicesDir();
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const {
    storeName,
    orderId,
    invoiceId,
    buyerTag,
    buyerId,
    productName,
    amountUsd,
    paymentMethod,
    paymentAmount,
    transactionId,
    createdAt,
  } = data;

  doc.fontSize(20).text(storeName || "Store");
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#666").text("INVOICE / RECEIPT");
  doc.moveDown(1);

  doc.fillColor("#000").fontSize(12);
  doc.text(`Invoice ID: ${invoiceId}`);
  doc.text(`Order ID:   ${orderId}`);
  doc.text(`Date:       ${createdAt}`);
  doc.moveDown(1);

  doc.fontSize(12).text("Billed To", { underline: true });
  doc.moveDown(0.3);
  doc.text(`Customer: ${buyerTag}`);
  doc.text(`User ID:   ${buyerId}`);
  doc.moveDown(1);

  doc.fontSize(12).text("Order Details", { underline: true });
  doc.moveDown(0.4);

  function row(label, value) {
    doc.fillColor("#111").text(label, 50, doc.y, { width: 180 });
    doc.fillColor("#000").text(value, 240, doc.y, { width: 305 });
    doc.moveDown(0.7);
  }

  row("Product", productName);
  row("Price (USD)", `$${Number(amountUsd).toFixed(2)}`);
  row("Payment Method", paymentMethod);
  row("Paid Amount", paymentAmount || "-");
  row("Transaction / Ref", transactionId || "-");

  doc.moveDown(1);
  doc.fillColor("#666").fontSize(10).text("Thank you for your purchase.", { align: "left" });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}
