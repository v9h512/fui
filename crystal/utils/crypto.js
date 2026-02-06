import fetch from "node-fetch";
import crypto from "crypto";
export function sign(body,key){
 return crypto.createHash("md5").update(Buffer.from(JSON.stringify(body)).toString("base64")+key).digest("hex");
}
export async function createCrypto(amount,order,env){
 const payload={amount:amount.toString(),currency:"USD",order_id:order};
 const res=await fetch("https://api.cryptomus.com/v1/payment",{
  method:"POST",
  headers:{merchant:env.CRYPTOMUS_MERCHANT,sign:sign(payload,env.CRYPTOMUS_API_KEY),"Content-Type":"application/json"},
  body:JSON.stringify(payload)
 });
 return res.json();
}