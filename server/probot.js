import { Probot } from "probot";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const privateKey = fs.readFileSync("./privateKey.pem", "utf8").trim();

export const probot = new Probot({
  appId: Number(process.env.APP_ID),
  privateKey,
  secret: process.env.WEBHOOK_SECRET,
});
