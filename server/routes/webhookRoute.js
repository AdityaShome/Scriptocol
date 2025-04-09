import express from "express";
import { probot } from "../probot.js";

const router = express.Router();

// Handle GitHub Webhooks
router.post("/", (req, res) => {
  console.log("📡 Webhook received!", req.body);
  res.status(200).send("✅ Webhook received!");
});

// Listen to PR & push events
probot.webhooks.on(["push", "pull_request"], async (context) => {
  const { owner, repo } = context.repo();
  console.log(`📡 Event received: ${context.name} for ${owner}/${repo}`);
});

export default router;
