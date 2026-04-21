/**
 * iMessage Legacy Channel Plugin for OpenClaw
 * Uses SQLite polling + AppleScript sending + proper dispatch system
 * 
 * Features:
 * - Text messages (send/receive)
 * - Tapbacks/Reactions (receive)
 * - Attachments (images, audio, video processed via OpenClaw media pipeline)
 * - Reply threading (detect quoted replies)
 * - Contact name resolution
 * - Group chat support
 * - Duplicate prevention via active instance file
 */

import Database from "better-sqlite3";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);
let pluginRuntime = null;

// Active instance tracking via filesystem - survives hot reloads
const ACTIVE_INSTANCE_FILE = path.join(os.homedir(), ".openclaw/imessage-active-instance");

function claimActiveInstance(instanceId, log) {
  try {
    fs.writeFileSync(ACTIVE_INSTANCE_FILE, instanceId, "utf8");
    log?.info?.(`[iMessage][${instanceId}] Claimed active instance`);
    return true;
  } catch (e) {
    log?.error?.(`[iMessage] Failed to claim active: ${e.message}`);
    return false;
  }
}

function isActiveInstance(instanceId) {
  try {
    const active = fs.readFileSync(ACTIVE_INSTANCE_FILE, "utf8").trim();
    return active === instanceId;
  } catch {
    return false;
  }
}

// Tapback type mapping (associated_message_type in chat.db)
const TAPBACK_TYPES = {
  2000: "❤️",  // Love
  2001: "👍",  // Like  
  2002: "👎",  // Dislike
  2003: "😂",  // Laugh
  2004: "‼️",  // Emphasis
  2005: "❓",  // Question
  // 3000-3005 = remove tapback
};

// Contact name cache
let contactsDb = null;
let contactCache = new Map();

function normalizePhone(phone) {
  if (!phone) return null;
  let n = phone.replace(/[^\d+]/g, "");
  if (n.startsWith("+")) return n;
  if (n.length === 10) return "+1" + n;
  if (n.length === 11 && n.startsWith("1")) return "+" + n;
  return "+" + n;
}

function isAllowed(sender, allowFrom) {
  if (!sender || allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const ns = normalizePhone(sender);
  for (const a of allowFrom) {
    if (a === sender || (ns && normalizePhone(a) === ns)) return true;
  }
  return false;
}

/**
 * Resolve phone number to contact name using AddressBook database
 */
function resolveContactName(phone, log) {
  if (!phone) return null;
  
  const normalized = normalizePhone(phone);
  if (contactCache.has(normalized)) {
    return contactCache.get(normalized);
  }
  
  if (!contactsDb) {
    try {
      const sourcesDir = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
      if (fs.existsSync(sourcesDir)) {
        const sources = fs.readdirSync(sourcesDir);
        for (const source of sources) {
          const dbPath = path.join(sourcesDir, source, "AddressBook-v22.abcddb");
          if (fs.existsSync(dbPath)) {
            contactsDb = new Database(dbPath, { readonly: true });
            break;
          }
        }
      }
    } catch (e) {
      log?.debug?.(`[iMessage] Cannot open contacts DB: ${e.message}`);
    }
  }
  
  if (!contactsDb) return null;
  
  try {
    const digits = phone.replace(/\D/g, "").slice(-7);
    const result = contactsDb.prepare(`
      SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION
      FROM ZABCDPHONENUMBER p
      JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
      WHERE p.ZFULLNUMBER LIKE ?
      LIMIT 1
    `).get(`%${digits}`);
    
    if (result) {
      const name = [result.ZFIRSTNAME, result.ZLASTNAME].filter(Boolean).join(" ") || result.ZORGANIZATION;
      if (name) {
        contactCache.set(normalized, name);
        return name;
      }
    }
  } catch (e) {
    log?.debug?.(`[iMessage] Contact lookup error: ${e.message}`);
  }
  
  return null;
}

/**
 * Get attachment info for a message - returns paths and mime types for OpenClaw media pipeline
 */
function getAttachments(db, messageRowId, log) {
  try {
    const attachments = db.prepare(`
      SELECT a.filename, a.mime_type, a.total_bytes, a.transfer_name, a.uti
      FROM attachment a
      JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = ?
    `).all(messageRowId);
    
    return attachments.map(att => {
      let filepath = att.filename;
      if (filepath?.startsWith("~/")) {
        filepath = path.join(os.homedir(), filepath.slice(2));
      }
      
      const mimeType = att.mime_type || guessMimeType(att.uti, filepath);
      
      return {
        path: filepath,
        mimeType: mimeType,
        size: att.total_bytes,
        name: att.transfer_name || path.basename(filepath || "attachment")
      };
    }).filter(a => a.path && fs.existsSync(a.path));
  } catch (e) {
    log?.debug?.(`[iMessage] Attachment query error: ${e.message}`);
    return [];
  }
}

function guessMimeType(uti, filepath) {
  if (uti?.includes("jpeg") || uti?.includes("jpg")) return "image/jpeg";
  if (uti?.includes("png")) return "image/png";
  if (uti?.includes("gif")) return "image/gif";
  if (uti?.includes("heic")) return "image/heic";
  if (uti?.includes("mp4") || uti?.includes("movie")) return "video/mp4";
  if (uti?.includes("m4a") || uti?.includes("audio")) return "audio/m4a";
  if (uti?.includes("pdf")) return "application/pdf";
  
  const ext = path.extname(filepath || "").toLowerCase();
  const extMap = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".heic": "image/heic", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".m4a": "audio/m4a", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".pdf": "application/pdf"
  };
  return extMap[ext] || "application/octet-stream";
}

/**
 * Get the original message text for a reply/tapback
 */
function getReplyContext(db, replyToGuid, log) {
  if (!replyToGuid) return null;
  
  try {
    let guid = replyToGuid;
    if (guid.includes("/")) guid = guid.split("/").pop();
    if (guid.startsWith("bp:")) guid = guid.slice(3);
    
    const original = db.prepare(`
      SELECT m.text, m.ROWID, m.is_from_me, m.date, h.id as sender
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.guid = ? LIMIT 1
    `).get(guid);
    
    if (original?.text) {
      // Determine sender name
      let senderName = "me";
      if (!original.is_from_me && original.sender) {
        senderName = resolveContactName(original.sender) || original.sender;
      }
      
      return { 
        guid, 
        text: original.text, 
        rowId: original.ROWID,
        sender: senderName,
        isFromMe: original.is_from_me === 1
      };
    }
  } catch (e) {
    log?.debug?.(`[iMessage] Reply context lookup error: ${e.message}`);
  }
  return null;
}

async function sendIMessage(recipient, text, log) {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "");
  
  const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}" of (service 1 whose service type is iMessage)`;
  try {
    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
    log?.info?.(`[iMessage] Sent to ${recipient}`);
    return true;
  } catch (err) {
    log?.error?.(`[iMessage] Send failed: ${err.message}`);
    return false;
  }
}

/**
 * Send a file via AppleScript
 */
async function sendMediaFile(recipient, filePath, log) {
  const script = `
    tell application "Messages"
      set targetService to (service 1 whose service type is iMessage)
      set targetBuddy to buddy "${recipient}" of targetService
      send POSIX file "${filePath}" to targetBuddy
    end tell
  `;
  try {
    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
    log?.info?.(`[iMessage] Sent media to ${recipient}: ${filePath}`);
    return true;
  } catch (err) {
    log?.error?.(`[iMessage] Media send failed: ${err.message}`);
    return false;
  }
}

const channel = {
  id: "imessage-legacy",
  meta: { id: "imessage-legacy", label: "iMessage Local", blurb: "SQLite + AppleScript", aliases: [] },
  capabilities: { 
    chatTypes: ["direct", "group"], 
    media: true,
    reactions: false,  // Can't send tapbacks programmatically
    replies: true
  },
  reload: { configPrefixes: ["channels.imessage-legacy"] },
  
  config: {
    listAccountIds: (cfg) => cfg.channels?.["imessage-legacy"]?.enabled ? ["default"] : [],
    resolveAccount: (cfg, accountId = "default") => {
      const c = cfg.channels?.["imessage-legacy"] ?? {};
      return { accountId, enabled: c.enabled ?? false, configured: Boolean(c.enabled),
        config: { 
          pollIntervalMs: c.pollIntervalMs ?? 1000, 
          dmPolicy: c.dmPolicy ?? "allowlist", 
          allowFrom: c.allowFrom ?? [],
          includeTapbacks: c.includeTapbacks ?? true,
          resolveContactNames: c.resolveContactNames ?? true
        }
      };
    },
    defaultAccountId: () => "default",
    resolveAllowFrom: ({ cfg }) => cfg.channels?.["imessage-legacy"]?.allowFrom ?? [],
  },
  
  security: { resolveDmPolicy: ({ account }) => ({ policy: account.config.dmPolicy ?? "allowlist", allowFrom: account.config.allowFrom ?? [] }) },
  messaging: { normalizeTarget: (t) => normalizePhone(t) || t },
  
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, log }) => {
      const success = await sendIMessage(to, text, log);
      return success ? { ok: true, channel: "imessage-legacy" } : { ok: false, error: "Send failed" };
    },
    sendMedia: async ({ to, text, mediaUrl, mediaPath, log }) => {
      let success = true;
      
      // Send local file if available
      const localPath = mediaPath || (mediaUrl?.startsWith("file://") ? mediaUrl.slice(7) : null);
      if (localPath && fs.existsSync(localPath)) {
        success = await sendMediaFile(to, localPath, log);
      }
      
      // Send text caption
      if (text && success) {
        success = await sendIMessage(to, text, log);
      } else if (!localPath && mediaUrl) {
        // Fallback: send URL as text
        const fullText = text ? `${text}\n${mediaUrl}` : mediaUrl;
        success = await sendIMessage(to, fullText, log);
      }
      
      return success ? { ok: true, channel: "imessage-legacy" } : { ok: false, error: "Send failed" };
    }
  },
  
  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg, abortSignal, log } = ctx;
      const pollMs = account.config.pollIntervalMs ?? 1000;
      const allowFrom = (account.config.allowFrom ?? []).map(s => normalizePhone(s) || s);
      const includeTapbacks = account.config.includeTapbacks ?? true;
      const resolveNames = account.config.resolveContactNames ?? true;
      
      const instanceId = Math.random().toString(36).slice(2, 6);
      
      // Claim active instance - this kills zombie instances by invalidating their ID
      claimActiveInstance(instanceId, log);
      
      log?.info(`[iMessage] Starting poll=${pollMs}ms allow=${allowFrom.length} tapbacks=${includeTapbacks}`);
      
      const finalizeInboundContext = pluginRuntime?.channel?.reply?.finalizeInboundContext;
      const dispatchReplyFromConfig = pluginRuntime?.channel?.reply?.dispatchReplyFromConfig;
      const createReplyDispatcherWithTyping = pluginRuntime?.channel?.reply?.createReplyDispatcherWithTyping;
      
      if (!finalizeInboundContext || !dispatchReplyFromConfig || !createReplyDispatcherWithTyping) {
        log?.error("[iMessage] Missing dispatch functions from runtime");
        return () => {};
      }
      
      const dbPath = path.join(os.homedir(), "Library/Messages/chat.db");
      const statePath = path.join(os.homedir(), ".openclaw/imessage-legacy-state.json");
      
      let db;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch (err) {
        log?.error(`[iMessage] Cannot open database: ${err.message}`);
        return () => {};
      }
      
      let state = { lastRowId: 0, processedIds: [] };
      try { if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
      if (!state.processedIds) state.processedIds = [];
      if (!state.lastRowId) {
        state.lastRowId = db.prepare("SELECT MAX(ROWID) as m FROM message").get()?.m ?? 0;
        log?.info(`[iMessage] Init rowId=${state.lastRowId}`);
      }
      
      let running = true;
      let pollTimer = null;
      
      const cleanup = () => {
        if (!running) return;
        running = false;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        try { db.close(); } catch {}
        try { contactsDb?.close(); contactsDb = null; } catch {}
        contactCache.clear();
        log?.info(`[iMessage][${instanceId}] Stopped and cleaned up`);
      };
      
      abortSignal?.addEventListener("abort", cleanup);
      
      log?.info(`[iMessage] Instance ${instanceId} created`);
      
      async function poll() {
        if (!running) return;
        
        // Check if we're still the active instance - if not, stop polling
        if (!isActiveInstance(instanceId)) {
          log?.info(`[iMessage][${instanceId}] No longer active instance, stopping`);
          cleanup();
          return;
        }
        
        try {
          const maxId = db.prepare("SELECT MAX(ROWID) as m FROM message").get()?.m ?? 0;
          
          if (maxId > state.lastRowId) {
            const msgs = db.prepare(`
              SELECT m.ROWID, m.guid, m.text, m.is_from_me, m.associated_message_type,
                     m.associated_message_guid, m.reply_to_guid, m.thread_originator_guid,
                     m.cache_has_attachments,
                     h.id as sender, c.chat_identifier, c.style
              FROM message m 
              LEFT JOIN handle h ON m.handle_id = h.ROWID
              LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
              LEFT JOIN chat c ON cmj.chat_id = c.ROWID
              WHERE m.ROWID > ? AND m.is_from_me = 0 
              GROUP BY m.ROWID
              ORDER BY m.ROWID LIMIT 20
            `).all(state.lastRowId);
            
            const toProcess = [];
            for (const msg of msgs) {
              state.lastRowId = Math.max(state.lastRowId, msg.ROWID);
              if (!msg.sender) continue;
              if (!isAllowed(msg.sender, allowFrom)) continue;
              if (state.processedIds.includes(msg.ROWID)) continue;
              state.processedIds.push(msg.ROWID);
              
              // Handle tapbacks
              if (msg.associated_message_type >= 2000 && msg.associated_message_type < 4000) {
                if (!includeTapbacks) continue;
                const emoji = TAPBACK_TYPES[msg.associated_message_type];
                const isRemove = msg.associated_message_type >= 3000;
                if (!emoji || isRemove) continue;
                
                const context = getReplyContext(db, msg.associated_message_guid, log);
                msg.tapbackText = `${emoji} reacted to: "${context?.text || 'message'}"`;
              }
              
              // Skip if no text and no attachments and no tapback
              if (!msg.text?.trim() && !msg.cache_has_attachments && !msg.tapbackText) continue;
              
              toProcess.push(msg);
            }
            
            if (state.processedIds.length > 100) state.processedIds = state.processedIds.slice(-100);
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
            
            for (const msg of toProcess) {
              const isGroup = msg.style === 43 || msg.chat_identifier?.startsWith("chat");
              const chatId = isGroup ? msg.chat_identifier : msg.sender;
              
              // Resolve contact name
              const contactName = resolveNames ? resolveContactName(msg.sender, log) : null;
              const senderName = contactName || msg.sender;
              
              // Get attachments for OpenClaw media pipeline
              let mediaPaths = [];
              let mediaTypes = [];
              if (msg.cache_has_attachments) {
                const attachments = getAttachments(db, msg.ROWID, log);
                for (const att of attachments) {
                  mediaPaths.push(att.path);
                  mediaTypes.push(att.mimeType);
                }
                if (attachments.length > 0) {
                  log?.info(`[iMessage] Message has ${attachments.length} attachments: ${mediaTypes.join(', ')}`);
                }
              }
              
              // Get reply context if this is a quote-reply
              let replyContext = null;
              const replyGuid = msg.reply_to_guid || msg.thread_originator_guid;
              if (replyGuid) {
                replyContext = getReplyContext(db, replyGuid, log);
              }
              
              // Build message text
              let bodyText = msg.tapbackText || msg.text || "";
              
              // Add clean reply context if present
              if (replyContext && !msg.tapbackText) {
                bodyText = `[Quoting ${replyContext.sender}: "${replyContext.text}"]\n${bodyText}`;
              }
              
              if (!bodyText.trim() && mediaPaths.length === 0) continue;
              
              log?.info(`[iMessage][${instanceId}] ROWID=${msg.ROWID} From ${senderName}: "${bodyText.slice(0, 50)}" media=${mediaPaths.length}`);
              
              try {
                const sessionKey = isGroup 
                  ? `agent:main:imessage-legacy:group:${chatId}`
                  : `agent:main:main`;
                
                // Create inbound context with media paths for OpenClaw pipeline
                const inboundCtx = finalizeInboundContext({
                  Body: bodyText,
                  RawBody: msg.text || "",
                  CommandBody: bodyText,
                  BodyForAgent: bodyText,
                  BodyForCommands: bodyText,
                  From: isGroup ? `imessage-legacy:group:${chatId}` : `imessage-legacy:${msg.sender}`,
                  To: msg.sender,
                  SessionKey: sessionKey,
                  AccountId: account.accountId,
                  ChatType: isGroup ? "group" : "direct",
                  ConversationLabel: senderName,
                  SenderName: senderName,
                  SenderId: msg.sender,
                  Provider: "imessage-legacy",
                  Surface: "imessage-legacy",
                  MessageSid: `imsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  Timestamp: Date.now(),
                  CommandAuthorized: true,
                  OriginatingChannel: "imessage-legacy",
                  OriginatingTo: msg.sender,
                  // Media paths for OpenClaw's media understanding pipeline
                  MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
                  MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
                });
                
                const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
                  deliver: async (payload, { kind }) => {
                    if (payload?.text) {
                      log?.info(`[iMessage] Delivering ${kind}: "${payload.text.slice(0, 50)}"`);
                      await sendIMessage(chatId, payload.text, log);
                    }
                    if (payload?.mediaPath && fs.existsSync(payload.mediaPath)) {
                      await sendMediaFile(chatId, payload.mediaPath, log);
                    }
                  },
                  onError: (err) => {
                    log?.error(`[iMessage] Dispatch error: ${err.message}`);
                  }
                });
                
                await dispatchReplyFromConfig({ ctx: inboundCtx, cfg, dispatcher, replyOptions });
                markDispatchIdle();
                
              } catch (err) {
                log?.error(`[iMessage] Dispatch error: ${err.stack || err.message}`);
              }
            }
          }
        } catch (err) {
          log?.error(`[iMessage][${instanceId}] Poll error: ${err.message}`);
        }
        
        if (running) {
          pollTimer = setTimeout(poll, pollMs);
        }
      }
      
      poll();
      return cleanup;
    }
  }
};

export default {
  id: "imessage-legacy",
  name: "iMessage Legacy",
  register(api) {
    pluginRuntime = api.runtime;
    api.registerChannel({ plugin: channel });
    api.logger.info("[iMessage Legacy] Registered with tapback, media, reply, and contact support");
  }
};
