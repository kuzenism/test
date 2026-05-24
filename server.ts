import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

// Gunakan folder dari env var DATA_DIR (Railway Volume), atau fallback ke folder saat ini (.)
const DATA_DIR = process.env.DATA_DIR || ".";

const ACCOUNTS_FILE = `${DATA_DIR}/accounts.json`;
const SETTINGS_FILE = `${DATA_DIR}/settings.json`;
const ACCOUNT_SETTINGS_FILE = `${DATA_DIR}/account_settings.json`;
const PORT = process.env.PORT || 3000;

interface AccountRecord {
  accountId: string;
  apiId: number;
  apiHash: string;
  sessionString: string;
}

interface PendingAuthState {
  accountId: string;
  apiId: number;
  apiHash: string;
  phone: string;
  phoneCodeHash?: string;
  client: TelegramClient;
}

interface BotSettings {
  isActive: boolean;
  autoDetect: boolean;
  targetGroups: string[];
  responses: { keyword: string; response: string }[];
  antiSpamDelay: number;
  requireEmojiPrefix: boolean; 
  filterWords: string[];
  filterWordsEnabled: boolean;
  allowedSenders: string[];
  allowedSendersEnabled: boolean;
}

const defaultSettings: BotSettings = {
  isActive: false,
  autoDetect: false,
  targetGroups: [],
  responses: [],
  antiSpamDelay: 1500,
  requireEmojiPrefix: false, 
  filterWords: [],
  filterWordsEnabled: false,
  allowedSenders: [],
  allowedSendersEnabled: false,
};

const sanitizeSettings = (input: Partial<BotSettings> | null | undefined): BotSettings => {
  const merged: BotSettings = {
    ...defaultSettings,
    ...(input || {}),
    responses: Array.isArray(input?.responses) ? input!.responses : defaultSettings.responses,
    targetGroups: Array.isArray(input?.targetGroups) ? input!.targetGroups : defaultSettings.targetGroups,
    filterWords: Array.isArray(input?.filterWords) ? input!.filterWords.map(String) : [],
    allowedSenders: Array.isArray(input?.allowedSenders) ? input!.allowedSenders.map(String) : [], // ← TAMBAH INI
  };
  const cleanedTargets = Array.from(
    new Set((merged.targetGroups || []).map((t) => String(t || "").trim()).filter(Boolean))
  );
  return {
    ...merged,
    targetGroups: cleanedTargets,
    antiSpamDelay: Number.isFinite(Number(merged.antiSpamDelay))
      ? Number(merged.antiSpamDelay)
      : defaultSettings.antiSpamDelay,
    requireEmojiPrefix: Boolean(merged.requireEmojiPrefix),
    filterWordsEnabled: Boolean(merged.filterWordsEnabled),
    allowedSendersEnabled: Boolean(merged.allowedSendersEnabled),
  };
};

// ─── Per-account settings ────────────────────────────────────────────────────

const accountSettingsMap = new Map<string, BotSettings>();

const loadAccountSettings = () => {
  if (!fs.existsSync(ACCOUNT_SETTINGS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNT_SETTINGS_FILE, "utf8"));
    if (typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, s] of Object.entries(raw)) {
        accountSettingsMap.set(String(id), sanitizeSettings(s as any));
      }
    }
  } catch {}
};

const saveAccountSettings = () => {
  const obj: Record<string, BotSettings> = {};
  for (const [id, s] of accountSettingsMap) obj[id] = s;
  fs.writeFileSync(ACCOUNT_SETTINGS_FILE, JSON.stringify(obj, null, 2));
};

const getAccountSettings = (accountId: string): BotSettings =>
  accountSettingsMap.get(accountId) || { ...defaultSettings };

const setAccountSettings = (accountId: string, settings: Partial<BotSettings>) => {
  const current = getAccountSettings(accountId);
  const updated = sanitizeSettings({ ...current, ...settings });
  accountSettingsMap.set(accountId, updated);
  saveAccountSettings();
  return updated;
};

loadAccountSettings();

// ─── Global settings (legacy fallback) ───────────────────────────────────────

let botSettings: BotSettings = defaultSettings;
if (fs.existsSync(SETTINGS_FILE)) {
  try {
    botSettings = sanitizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
  } catch {}
}
const saveSettings = () =>
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 2));

// ─── Accounts ────────────────────────────────────────────────────────────────

const accounts: AccountRecord[] = (() => {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item?.accountId && item?.apiId && item?.apiHash && item?.sessionString)
      .map((item) => ({
        accountId: String(item.accountId),
        apiId: Number(item.apiId),
        apiHash: String(item.apiHash),
        sessionString: String(item.sessionString),
      }));
  } catch {
    return [];
  }
})();

const liveClients = new Map<string, TelegramClient>();
const pendingAuthByAccount = new Map<string, PendingAuthState>();

const upsertAccount = (record: AccountRecord) => {
  const idx = accounts.findIndex((a) => a.accountId === record.accountId);
  if (idx >= 0) accounts[idx] = record;
  else accounts.push(record);
};

const removeAccount = (accountId: string) => {
  const idx = accounts.findIndex((a) => a.accountId === accountId);
  if (idx >= 0) accounts.splice(idx, 1);
};

const saveAccounts = () =>
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));

// ─── Express + Socket.IO ─────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
app.use(express.json());

// Dipangkas ke 30 agar log dashboard enteng dan hemat RAM
const MAX_LOG_HISTORY = 30; 
const logHistory: { message: string; type: "info" | "success" | "error" | "bot"; timestamp: string }[] = [];

const broadcastLog = (message: string, type: "info" | "success" | "error" | "bot" = "info") => {
  const entry = { message, type, timestamp: new Date().toLocaleTimeString() };
  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_HISTORY) logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY);
  io.emit("bot-log", entry);
  console.log(`[${type.toUpperCase()}] ${message}`);
};

io.on("connection", (socket) => {
  for (const entry of logHistory) socket.emit("bot-log", entry);
  socket.emit("bot-log", {
    message: `Dashboard tersambung. ${logHistory.length} log cached.`,
    type: "info",
    timestamp: new Date().toLocaleTimeString(),
  });
});

// ─── Utilities ────────────────────────────────────────────────────────────────

const fetchWithTimeout = (promise: Promise<any>, ms = 15000) => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("API Timeout (Stuck)")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const normalizeTarget = (value: string) => value.trim().toLowerCase().replace(/^@/, "");

const normalizeNumericId = (value: string) => {
  const n = normalizeTarget(value);
  if (!/^-?\d+$/.test(n)) return n;
  return n.replace(/^-100/, "").replace(/^-/, "");
};

const normalizeForKeyword = (value: string) =>
  (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const matchesSingleKeyword = (rawText: string, singleKeyword: string): boolean => {
  const k = singleKeyword.toLowerCase().trim();
  if (!k) return false;

  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  try {
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(rawText)) return true;
  } catch {}

  const nt = normalizeForKeyword(rawText);
  const nk = normalizeForKeyword(k);
  if (!nk) return false;
  try {
    const nEscaped = nk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${nEscaped}(?![a-z0-9])`).test(nt);
  } catch {}

  return false;
};

const containsKeyword = (rawText: string, keyword: string): string | false => {
  const parts = (keyword || "").split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (matchesSingleKeyword(rawText, part)) return part;
  }
  return false;
};

const toIdVariants = (value: unknown): string[] => {
  if (value == null) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  const numeric = raw.replace(/^-100/, "").replace(/^-/, "");
  if (!/^\d+$/.test(numeric)) return [raw];
  return Array.from(new Set([raw, numeric, `-${numeric}`, `-100${numeric}`]));
};

const linkedChatCache = new Map<string, string[]>();

const getLinkedChatCandidates = async (
  accountId: string,
  tgClient: TelegramClient,
  chat: any
): Promise<string[]> => {
  if (!chat || (chat.className !== "Channel" && chat.className !== "Chat")) return [];
  const key = `${accountId}:${chat.className}:${String(chat.id || "")}`;
  if (linkedChatCache.has(key)) return linkedChatCache.get(key)!;
  try {
    const full =
      chat.className === "Channel"
        ? await tgClient.invoke(new Api.channels.GetFullChannel({ channel: chat }))
        : await tgClient.invoke(new Api.messages.GetFullChat({ chatId: chat.id }));
    const linkedId = (full as any)?.fullChat?.linkedChatId;
    const candidates = toIdVariants(linkedId);
    linkedChatCache.set(key, candidates);
    return candidates;
  } catch {
    linkedChatCache.set(key, []);
    return [];
  }
};

const matchesConfiguredTarget = (
  accountId: string,
  message: any,
  sender: any,
  chat: any,
  extraCandidates: string[] = []
) => {
  const settings = getAccountSettings(accountId);
  if (settings.autoDetect) return true;
  const activeTargets = settings.targetGroups.map((t) => String(t || "").trim()).filter(Boolean);
  if (!activeTargets.length) return true;

  const candidates = [
    sender?.username,
    sender?.id ? String(sender.id) : "",
    chat?.title,
    message?.chat?.username,
    message?.chat?.title,
    message?.chat?.id ? String(message.chat.id) : "",
    message?.peerId?.channelId ? String(message.peerId.channelId) : "",
    message?.peerId?.chatId ? String(message.peerId.chatId) : "",
    ...extraCandidates,
  ]
    .filter(Boolean)
    .map(normalizeTarget);

  const numericCandidates = candidates.map(normalizeNumericId);

  return activeTargets.some((target) => {
    const nt = normalizeTarget(target);
    const nn = normalizeNumericId(target);
    return (
      candidates.includes(nt) ||
      candidates.some((c) => c.endsWith(nt)) ||
      numericCandidates.includes(nn) ||
      numericCandidates.some((c) => c.endsWith(nn))
    );
  });
};

// ─── Message Queue ────────────────────────────────────────────────────────────

const responseQueueByAccount = new Map<string, { targetId: any; replyTo: number; message: string }[]>();
const processingQueueAccounts = new Set<string>();
const queuedReplySet = new Set<string>();

const formatTargetId = (targetId: any) => {
  const channelId = targetId?.channelId ? String(targetId.channelId) : "";
  const chatId = targetId?.chatId ? String(targetId.chatId) : "";
  const userId = targetId?.userId ? String(targetId.userId) : "";
  const picked = channelId || chatId || userId || String(targetId || "");
  if (/^\d+$/.test(picked)) return `-100${picked}`;
  return picked;
};

const processQueue = async (accountId: string) => {
  const queue = responseQueueByAccount.get(accountId) || [];
  const client = liveClients.get(accountId);
  if (processingQueueAccounts.has(accountId) || queue.length === 0 || !client?.connected) return;

  processingQueueAccounts.add(accountId);
  const task = queue.shift();

  if (task) {
    try {
      await fetchWithTimeout(
        client.sendMessage(task.targetId, { message: task.message, replyTo: task.replyTo }),
        15000
      );
      broadcastLog(`[${accountId}] Pesan terkirim (replyTo: ${task.replyTo})`, "success");
      const delay = getAccountSettings(accountId).antiSpamDelay || 2000;
      await new Promise((r) => setTimeout(r, delay));
    } catch (err: any) {
      if (err.message?.includes("FLOOD_WAIT_")) {
        const secs = parseInt(err.message.match(/\d+/)?.[0] || "10");
        broadcastLog(`[${accountId}] Flood wait ${secs}s...`, "error");
        queue.unshift(task);
        await new Promise((r) => setTimeout(r, secs * 1000));
      } else if (err.message?.includes("CHAT_ADMIN_REQUIRED")) {
        broadcastLog(
          `[${accountId}] Butuh izin admin di ${formatTargetId(task.targetId)}`,
          "error"
        );
      } else {
        broadcastLog(`[${accountId}] Kirim gagal: ${err.message}`, "error");
      }
    }
  }

  processingQueueAccounts.delete(accountId);
  processQueue(accountId);
};

const addToQueue = (accountId: string, targetId: any, replyTo: number, message: string) => {
  const replyKey = `${accountId}:${replyTo}:${message}`;
  if (queuedReplySet.has(replyKey)) return; 

  queuedReplySet.add(replyKey);
  if (queuedReplySet.size > 2000) queuedReplySet.clear();

  if (!responseQueueByAccount.has(accountId)) responseQueueByAccount.set(accountId, []);
  const queue = responseQueueByAccount.get(accountId)!;
  queue.push({ targetId, replyTo, message });
  processQueue(accountId);
};

// ─── Message Processing ───────────────────────────────────────────────────────

const processedMessageKeys = new Set<string>();
const repliedThreadKeys = new Set<string>();
const pollCursorByTarget = new Map<string, number>();
const pollingTimerByAccount = new Map<string, NodeJS.Timeout>();
const pollingAccounts = new Set<string>();

const resolveReplyTarget = async (message: any, chat: any) => {
  try {
    const inputChat = await message?.getInputChat?.();
    if (inputChat) return inputChat;
  } catch {}
  if (chat) return chat;
  return message?.peerId;
};

const getDiscussionMsgId = async (
  tgClient: TelegramClient,
  channel: any,
  channelMsgId: number
): Promise<{ discussionMsgId: number; discussionChat: any } | null> => {
  try {
    const result: any = await tgClient.invoke(
      new Api.messages.GetDiscussionMessage({ peer: channel, msgId: channelMsgId })
    );
    const msgs: any[] = result?.messages || [];
    const chats: any[] = result?.chats || [];
    if (!msgs.length) return null;
    const discussionMsgId = Number(msgs[0]?.id || 0);
    if (!discussionMsgId) return null;
    const discussionChat =
      chats.find((c: any) => c.megagroup) ||
      chats.find((c: any) => !c.broadcast) ||
      chats[0] || null;
    return { discussionMsgId, discussionChat };
  } catch {
    return null;
  }
};

const resolveDiscussionReplyTarget = async (
  accountId: string,
  tgClient: TelegramClient,
  chat: any
) => {
  try {
    const candidates = await getLinkedChatCandidates(accountId, tgClient, chat);
    for (const candidate of candidates) {
      try {
        return await tgClient.getEntity(candidate);
      } catch {}
    }
  } catch {}
  return resolveReplyTarget(null, chat);
};

const handleIncomingMessage = async (
  accountId: string,
  tgClient: TelegramClient,
  message: any,
  source: "event" | "poll"
) => {
  const settings = getAccountSettings(accountId);
  if (!settings.isActive || !message) return;

  const rawText = String(message.message || "").trim();
  if (!rawText || message.out) return;

  // ─── PROTEKSI JEBAKAN BOT (postAuthor filter) ─────────────────────────────
  if (settings.allowedSendersEnabled) {
    const rawPostAuthor = String((message as any)?.postAuthor || "").trim().toLowerCase();
    const fwdPostAuthor = String((message as any)?.fwdFrom?.postAuthor || "").trim().toLowerCase();
    const fwdFromName = String((message as any)?.fwdFrom?.fromName || "").trim().toLowerCase();
    const savedFromPeer = String((message as any)?.fwdFrom?.savedFromPeer || "").trim().toLowerCase();
    
    // Pesan dari menfess (di-forward ke channel) biasanya menyimpan signature di fwdPostAuthor
    const finalAuthor = rawPostAuthor || fwdPostAuthor || fwdFromName || savedFromPeer;
    
    if (settings.allowedSenders && settings.allowedSenders.length > 0) {
      if (!settings.allowedSenders.includes(finalAuthor)) {
        // Abaikan pesan diam-diam jika author tidak ada di dalam daftar yang diizinkan
        return;
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const msgText = rawText.toLowerCase();

  if (settings.requireEmojiPrefix) {
    const startsWithEmoji = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(rawText.trim());
    if (!startsWithEmoji) return;
  }

  if (settings.filterWordsEnabled && settings.filterWords && settings.filterWords.length > 0) {
    const isBlocked = settings.filterWords.some(word => matchesSingleKeyword(msgText, word));
    if (isBlocked) return;
  }

  let detectedKeyword = "";
  let match = undefined;

  const flattenedResponses: { keyword: string; originalResponse: any }[] = [];
  settings.responses.forEach((r) => {
    const parts = (r.keyword || "").split(",").map((p) => p.trim()).filter(Boolean);
    parts.forEach((part) => {
      flattenedResponses.push({ keyword: part, originalResponse: r });
    });
  });

  flattenedResponses.sort((a, b) => b.keyword.length - a.keyword.length);

  for (const item of flattenedResponses) {
    if (matchesSingleKeyword(msgText, item.keyword)) {
      detectedKeyword = item.keyword;
      match = item.originalResponse;
      break;
    }
  }

  if (!match) return;

  const sender: any = await message.getSender().catch(() => null);
  const chat: any = await message.getChat().catch(() => null);
  const peer: any = message?.peerId;
  const hasGroupPeer = Boolean(peer?.channelId || peer?.chatId);
  const isGroup = Boolean(
    hasGroupPeer || (chat && (chat.className === "Chat" || chat.className === "Channel"))
  );
  if (!isGroup) return;

  const replyMeta: any = (message as any)?.replyTo;
  const isFwd = Boolean((message as any)?.fwdFrom || (message as any)?.forward);
  const sourceClass = String(chat?.className || "");
  const fwdChannelPostIdEarly = Number((message as any)?.fwdFrom?.channelPost || 0);
  const isBroadcastChannel = Boolean((chat as any)?.broadcast);
  const isChannelPeer = Boolean(peer?.channelId);

  if (!isBroadcastChannel && !isChannelPeer) {
    if (sourceClass !== "Channel" && !fwdChannelPostIdEarly && !isFwd) {
      return;
    }
  }

  if (sender && sender.className === "User" && !sender.bot) return;

  const isForwardedIntoDiscussion = isFwd && sourceClass !== "Channel";
  const threadTopId = isForwardedIntoDiscussion
    ? Number(message.id || 0)
    : (Number(replyMeta?.replyToTopId || 0) ||
       Number(replyMeta?.replyToMsgId || 0) ||
       Number(message.id || 0));

  const fwdChannelPostId = Number((message as any)?.fwdFrom?.channelPost || 0);
  const fwdChannelId = String((message as any)?.fwdFrom?.fromId?.channelId || "");
  const canonicalPeerId = fwdChannelId || String(peer?.channelId || peer?.chatId || peer?.userId || "unknown");
  const canonicalMsgId = fwdChannelPostId || Number(message?.id || 0);
  const dedupeKey = `${accountId}:${canonicalPeerId}:${canonicalMsgId}`;

  if (processedMessageKeys.has(dedupeKey)) return;
  processedMessageKeys.add(dedupeKey);
  if (processedMessageKeys.size > 5000) processedMessageKeys.clear();

  const linkedCandidates = await getLinkedChatCandidates(accountId, tgClient, chat);
  if (!matchesConfiguredTarget(accountId, message, sender, chat, linkedCandidates)) return;

  const threadKey = `${accountId}:${canonicalPeerId}:${canonicalMsgId}:${detectedKeyword || "custom"}`;
  if (repliedThreadKeys.has(threadKey)) return;

  repliedThreadKeys.add(threadKey);
  if (repliedThreadKeys.size > 10000) repliedThreadKeys.clear();

  broadcastLog(
    `[${accountId}] [TRIGGER][${source}] keyword="${detectedKeyword}" | teks="${rawText.slice(0, 100)}"`,
    "bot"
  );

  const finalResponse = match.response;

  try {
    let effectiveChat = chat;
    if (isFwd) {
      const fwdFromId = (message as any)?.fwdFrom?.fromId;
      if (fwdFromId) {
        try {
          const resolved = await tgClient.getEntity(fwdFromId);
          if (resolved) effectiveChat = resolved;
        } catch {}
      }
    }

    let replyTarget: any;
    let replyMsgId = threadTopId;

    if (String(effectiveChat?.className || "") === "Channel") {
      const disc = await getDiscussionMsgId(tgClient, effectiveChat, threadTopId);
      if (disc) {
        replyTarget = disc.discussionChat || await resolveDiscussionReplyTarget(accountId, tgClient, effectiveChat);
        replyMsgId = disc.discussionMsgId;
      } else {
        replyTarget = await resolveDiscussionReplyTarget(accountId, tgClient, effectiveChat);
      }
    } else {
      replyTarget = await resolveReplyTarget(message, chat);
    }

    // Langsung masukkan ke antrean (anti-spam delay ditangani oleh proses antrean)
    addToQueue(accountId, replyTarget, replyMsgId, finalResponse);

  } catch (err: any) {
    broadcastLog(`[${accountId}] Error final execution: ${err.message}`, "error");
  }
};

// ─── Polling Fallback ────────────────────────────────────────────────────────

const startPollingFallback = (accountId: string, tgClient: TelegramClient) => {
  if (pollingTimerByAccount.has(accountId)) return;

  const timer = setInterval(async () => {
    const client = liveClients.get(accountId);
    const settings = getAccountSettings(accountId);

    if (client && !client.connected && settings.isActive) {
      broadcastLog(`[${accountId}] Bot terputus/offline. Mencoba reconnect...`, "error");
      try {
        await client.connect();
        broadcastLog(`[${accountId}] Reconnect otomatis berhasil!`, "success");
      } catch (e) {
        return; 
      }
    }

    if (pollingAccounts.has(accountId) || !client?.connected || !settings.isActive) return;
    pollingAccounts.add(accountId);

    try {
      const targets = settings.targetGroups.map((t) => String(t || "").trim()).filter(Boolean);
      for (const target of targets) {
        try {
          const entity: any = await tgClient.getEntity(target);
          let pollEntities: any[] = [entity];

          if (entity?.className === "Channel") {
            try {
              const full = await tgClient.invoke(
                new Api.channels.GetFullChannel({ channel: entity })
              );
              const linkedId = (full as any)?.fullChat?.linkedChatId;
              if (linkedId) {
                const linked: any = await tgClient.getEntity(`-100${String(linkedId)}`);
                pollEntities = [linked];
              }
            } catch {}
          }

          for (const pollEntity of pollEntities) {
            const list: any[] = (await fetchWithTimeout(
              tgClient.getMessages(pollEntity, { limit: 20 }),
              15000
            )) as any[];

            const sorted = [...(list || [])].sort(
              (a: any, b: any) => Number(a?.id || 0) - Number(b?.id || 0)
            );
            const targetKey = normalizeTarget(
              `${accountId}:${target}:${String(pollEntity?.id || "unknown")}`
            );
            const hasCursor = pollCursorByTarget.has(targetKey);
            const cursor = pollCursorByTarget.get(targetKey) || 0;
            let maxSeen = cursor;

            if (!hasCursor) {
              const latestId = sorted.length ? Number(sorted[sorted.length - 1]?.id || 0) : 0;
              pollCursorByTarget.set(targetKey, latestId);
              continue;
            }

            for (const msg of sorted) {
              const id = Number(msg?.id || 0);
              if (!id) continue;
              if (id <= cursor) {
                if (id > maxSeen) maxSeen = id;
                continue;
              }
              if (id > maxSeen) maxSeen = id;
              await handleIncomingMessage(accountId, tgClient, msg, "poll");
            }

            pollCursorByTarget.set(targetKey, maxSeen);
          }
        } catch {}
      }
    } finally {
      pollingAccounts.delete(accountId);
    }
  }, 6000);

  pollingTimerByAccount.set(accountId, timer);
};

const setupBotCore = (accountId: string, tgClient: TelegramClient) => {
  startPollingFallback(accountId, tgClient);
  tgClient.addEventHandler(async (event) => {
    await handleIncomingMessage(accountId, tgClient, event.message, "event");
  }, new NewMessage({}));
};

// ─── API Routes ───────────────────────────────────────────────────────────────

app.post("/api/accounts/start-all", (req, res) => {
  accounts.forEach(acc => {
    setAccountSettings(acc.accountId, { isActive: true });
  });
  broadcastLog("Semua akun telah AKTIF (Start All).", "success");
  res.json({ success: true });
});

app.post("/api/accounts/stop-all", (req, res) => {
  accounts.forEach(acc => {
    setAccountSettings(acc.accountId, { isActive: false });
  });
  broadcastLog("Semua akun telah DIMATIKAN (Stop All).", "error");
  res.json({ success: true });
});

app.get("/api/config", (_req, res) => {
  const accountStatuses = accounts.map((a) => ({
    accountId: a.accountId,
    connected: liveClients.get(a.accountId)?.connected || false,
    hasSession: Boolean(a.sessionString),
    isActive: getAccountSettings(a.accountId).isActive,
  }));
  res.json({
    connected: accountStatuses.some((a) => a.connected),
    accounts: accountStatuses,
    settings: botSettings,
    hasSession: accountStatuses.some((a) => a.hasSession),
  });
});

app.get("/api/accounts", (_req, res) => {
  res.json({
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      connected: liveClients.get(a.accountId)?.connected || false,
      hasSession: Boolean(a.sessionString),
    })),
  });
});

app.get("/api/logs", (_req, res) => {
  res.json({ logs: [...logHistory].reverse() });
});

app.get("/api/account/:accountId/info", async (req, res) => {
  const accId = String(req.params.accountId || "").trim();
  const client = liveClients.get(accId);
  if (!client?.connected) return res.json({ phone: null, username: null, firstName: null, lastName: null });
  try {
    const me: any = await client.getMe();
    res.json({
      firstName: me?.firstName || null,
      lastName: me?.lastName || null,
      username: me?.username || null,
      phone: me?.phone || null,
    });
  } catch {
    res.json({ phone: null, username: null, firstName: null, lastName: null });
  }
});

app.post("/api/accounts/:accountId/rename", (req, res) => {
  const oldId = String(req.params.accountId || "").trim();
  const newId = String(req.body?.newId || "").trim();
  if (!oldId || !newId) return res.status(400).json({ error: "oldId dan newId wajib diisi" });
  if (oldId === newId) return res.status(400).json({ error: "Nama sama" });
  if (accounts.find((a) => a.accountId === newId)) return res.status(400).json({ error: "Nama sudah digunakan" });

  const account = accounts.find((a) => a.accountId === oldId);
  if (!account) return res.status(404).json({ error: "Akun tidak ditemukan" });

  account.accountId = newId;

  const client = liveClients.get(oldId);
  if (client) { liveClients.set(newId, client); liveClients.delete(oldId); }

  const acSettings = accountSettingsMap.get(oldId);
  if (acSettings) { accountSettingsMap.set(newId, acSettings); accountSettingsMap.delete(oldId); }

  const timer = pollingTimerByAccount.get(oldId);
  if (timer) { pollingTimerByAccount.set(newId, timer); pollingTimerByAccount.delete(oldId); }

  const queue = responseQueueByAccount.get(oldId);
  if (queue) { responseQueueByAccount.set(newId, queue); responseQueueByAccount.delete(oldId); }

  if (processingQueueAccounts.has(oldId)) { processingQueueAccounts.delete(oldId); processingQueueAccounts.add(newId); }
  if (pollingAccounts.has(oldId)) { pollingAccounts.delete(oldId); pollingAccounts.add(newId); }

  saveAccounts();
  saveAccountSettings();
  broadcastLog(`Akun "${oldId}" di-rename ke "${newId}".`, "info");
  res.json({ success: true, newId });
});

app.post("/api/settings", (req, res) => {
  botSettings = sanitizeSettings({ ...botSettings, ...req.body });
  saveSettings();
  res.json({ success: true });
});

app.get("/api/account/:accountId/settings", (req, res) => {
  const accId = String(req.params.accountId || "").trim();
  if (!accId) return res.status(400).json({ error: "accountId required" });
  res.json(getAccountSettings(accId));
});

app.post("/api/account/:accountId/settings", (req, res) => {
  const accId = String(req.params.accountId || "").trim();
  if (!accId) return res.status(400).json({ error: "accountId required" });
  const updated = setAccountSettings(accId, req.body);
  broadcastLog(`[${accId}] Pengaturan diperbarui.`, "info");
  res.json(updated);
});

app.post("/api/account/:accountId/resolve-target", async (req, res) => {
  const accId = String(req.params.accountId || "").trim();
  const target = String(req.body?.target || "").trim();
  if (!accId || !target) {
    return res.status(400).json({ error: "accountId dan target wajib diisi" });
  }

  const client = liveClients.get(accId);
  if (!client?.connected) {
    return res.status(400).json({ error: "Akun tidak terkoneksi" });
  }

  try {
    const entity: any = await client.getEntity(target);
    const rawId = entity?.id ? String(entity.id) : "";
    const normalizedId = rawId ? `-100${rawId}` : target;
    res.json({
      id: normalizedId,
      rawId,
      title: entity?.title || entity?.firstName || entity?.username || target,
      type: entity?.className || "unknown",
      username: entity?.username || null,
      membersCount: entity?.participantsCount || null,
    });
  } catch (e: any) {
    res.status(400).json({ error: `Tidak bisa resolve: ${e.message}` });
  }
});

// ─── LOGIN DENGAN MANUAL INPUT API ID & API HASH ───────────────────────────────

app.post("/api/tg/connect", async (req, res) => {
  // Sekarang apiId dan apiHash ditangkap langsung dari body request frontend
  const { accountId, phone, apiId, apiHash } = req.body;

  if (!accountId || !phone || !apiId || !apiHash) {
    return res.status(400).json({ 
      error: "accountId, phone, apiId, dan apiHash wajib diisi secara manual!" 
    });
  }

  try {
    const oldPending = pendingAuthByAccount.get(accountId);
    if (oldPending) {
      await oldPending.client.disconnect().catch(() => undefined);
      pendingAuthByAccount.delete(accountId);
    }

    const clientApiId = Number(apiId);
    const clientApiHash = String(apiHash).trim();

    // Menggunakan API ID & Hash manual dari user
    const tempClient = new TelegramClient(new StringSession(""), clientApiId, clientApiHash, {
      connectionRetries: 5,
      deviceModel: "StabilNet Server Bot",
      systemVersion: "Linux/NodeJS",
      appVersion: "1.0.0",
    });
    
    await tempClient.connect();
    
    const { phoneCodeHash } = await tempClient.sendCode(
      { apiId: clientApiId, apiHash: clientApiHash },
      String(phone)
    );

    // Disimpan di map pending untuk digunakan di rute /verify nanti
    pendingAuthByAccount.set(accountId, {
      accountId,
      apiId: clientApiId,
      apiHash: clientApiHash,
      phone: String(phone),
      phoneCodeHash,
      client: tempClient,
    });

    broadcastLog(`[${accountId}] Kode OTP dikirim ke ${phone} via Manual API`, "info");
    res.json({ success: true, phoneCodeHash });
  } catch (e: any) {
    broadcastLog(`[${accountId}] Gagal kirim OTP: ${e.message}`, "error");
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tg/verify", async (req, res) => {
  const { accountId: rawAccountId, phone, code, password } = req.body;
  const accountId = String(rawAccountId || "").trim();
  if (!accountId) return res.status(400).json({ error: "accountId wajib diisi" });

  const pending = pendingAuthByAccount.get(accountId);
  if (!pending) {
    return res.status(400).json({ error: "Belum ada sesi connect untuk akun ini" });
  }

  try {
    await pending.client.start({
      phoneNumber: async () => String(phone || pending.phone),
      phoneCode: async () => code,
      password: async () => password,
      onError: (e) => { throw e; },
    });

    const oldLive = liveClients.get(accountId);
    if (oldLive && oldLive !== pending.client) {
      await oldLive.disconnect().catch(() => undefined);
    }

    const oldTimer = pollingTimerByAccount.get(accountId);
    if (oldTimer) {
      clearInterval(oldTimer);
      pollingTimerByAccount.delete(accountId);
    }

    liveClients.set(accountId, pending.client);
    const sessionString = String(pending.client.session.save());

    // Otomatis tersimpan ke file json dengan API ID kustom yang diinput tadi
    upsertAccount({
      accountId,
      apiId: pending.apiId,
      apiHash: pending.apiHash,
      sessionString,
    });
    saveAccounts();

    setupBotCore(accountId, pending.client);
    setAccountSettings(accountId, { isActive: true });
    pendingAuthByAccount.delete(accountId);

    broadcastLog(`[${accountId}] Akun berhasil terhubung dengan API ID Kustom!`, "success");
    res.json({ success: true });
  } catch (e: any) {
    broadcastLog(`[${accountId}] Verifikasi gagal: ${e.message}`, "error");
    res.status(500).json({ error: e.message });
  }
});

// ─── Frontend Serving ────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== "production";

if (isDev) {
  // Development: Use Vite dev server
  const vite = await createViteServer({
    server: { middlewareMode: true },
  });
  app.use(vite.middlewares);
} else {
  // Production: Serve built React app from dist/
  const distPath = path.join(__dirname, "dist");
  app.use(express.static(distPath));
}

// SPA Fallback: All routes return index.html for React Router
app.get("*", (req, res) => {
  if (isDev) {
    // In dev mode, let Vite handle it
    res.sendFile(path.join(__dirname, "index.html"));
  } else {
    // In production, serve dist/index.html
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  }
});

// ─── Static Files (Vite build output) ────────────────────────────────────────
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Sajikan folder dist hasil `vite build`
app.use(express.static(join(__dirname, "dist")));

// Catch-all: kembalikan index.html untuk semua route frontend
app.get("*", (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});
// ─────────────────────────────────────────────────────────────────────────────

// Baris ini sudah ada — JANGAN dipindah, biarkan tetap di paling bawah
httpServer.listen(PORT, () => {
  console.log(`[INFO] Server berjalan di port ${PORT}`);
});
