import PDFDocument from "pdfkit";
import fs from "fs";
export function createInvoice(data,file){
 const doc=new PDFDocument();
 doc.pipe(fs.createWriteStream(file));
 doc.fontSize(22).text("Crystal Store Invoice");
 doc.moveDown();
 Object.entries(data).forEach(([k,v])=>doc.text(`${k}: ${v}`));
 doc.moveDown();
 doc.text("Thank you for shopping with Crystal Store");
 doc.end();
}