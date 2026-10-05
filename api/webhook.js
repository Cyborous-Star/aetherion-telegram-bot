// Aetherion royal telegraph — Telegram webhook for Vercel.
// One bot, many citizens: /nova, /seraphine, /juno, ... switch who answers.
// Requires env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN
// Optional: OPENAI_MODEL (default gpt-4o-mini)

const { kv } = require("@vercel/kv");
const citizens = require("../lib/citizens");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const HISTORY_LENGTH = 12;
const TELEGRAM_MAX = 4000;

async function telegram(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function citizenListText() {
  return citizens
    .list()
    .map((c) => `/${c.command} — ${c.name} ${c.emoji}`)
    .join("\n");
}

async function askCitizen(citizen, history, userMessage) {
  const messages = [
    { role: "system", content: citizen.systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  let reply = data.choices[0].message.content;
  if (reply.length > TELEGRAM_MAX) reply = reply.slice(0, TELEGRAM_MAX) + "…";
  return reply;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("Aetherion royal telegraph — Telegram sends updates here via POST.");
  }
  try {
    const update = req.body || {};
    const msg = update.message;
    if (!msg || !msg.text) return res.status(200).send("ok");

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();
    const userKey = `aetherion:user:${userId}`;

    if (text.startsWith("/")) {
      const cmd = text.slice(1).split(" ")[0].split("@")[0].toLowerCase();

      if (cmd === "start" || cmd === "citizens") {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `Welcome to the Aetherion royal telegraph 🦊\n\nChoose a citizen to speak with:\n${citizenListText()}\n\nThen just write your message. Use /who to see who you're talking to.`,
        });
        return res.status(200).send("ok");
      }

      if (cmd === "who") {
        const current = (await kv.get(`${userKey}:citizen`)) || citizens.defaultCitizen().command;
        const c = citizens.get(current) || citizens.defaultCitizen();
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `${c.emoji} You are speaking with ${c.name}.`,
        });
        return res.status(200).send("ok");
      }

      if (cmd === "forget") {
        const current = (await kv.get(`${userKey}:citizen`)) || citizens.defaultCitizen().command;
        await kv.del(`${userKey}:history:${current}`);
        await telegram("sendMessage", { chat_id: chatId, text: "Conversation cleared. A fresh start. ✨" });
        return res.status(200).send("ok");
      }

      const citizen = citizens.get(cmd);
      if (citizen) {
        await kv.set(`${userKey}:citizen`, citizen.command);
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `${citizen.emoji} You are now speaking with ${citizen.name}.\n${citizen.greeting}`,
        });
        return res.status(200).send("ok");
      }

      await telegram("sendMessage", {
        chat_id: chatId,
        text: `I don't know that command. Try /start to see the citizens of Aetherion.`,
      });
      return res.status(200).send("ok");
    }

    const selected = (await kv.get(`${userKey}:citizen`)) || citizens.defaultCitizen().command;
    const citizen = citizens.get(selected) || citizens.defaultCitizen();
    const historyKey = `${userKey}:history:${citizen.command}`;
    const history = (await kv.get(historyKey)) || [];

    const reply = await askCitizen(citizen, history, text);

    const updated = [...history, { role: "user", content: text }, { role: "assistant", content: reply }].slice(
      -HISTORY_LENGTH
    );
    await kv.set(historyKey, updated, { ex: 60 * 60 * 24 * 7 });

    await telegram("sendMessage", { chat_id: chatId, text: reply });
    return res.status(200).send("ok");
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(200).send("ok");
  }
};
