---
name: WhatsApp self-chat delivery
description: Compatibility constraint for native-flow replies sent to the bot account's own WhatsApp chat.
---

When a command is sent in the bot account's own “Message yourself” chat, return standard text or image messages instead of native-flow interactions. Keep native-flow buttons enabled for other chats.

**Why:** A live screenshot showed no visible `/menu`, `/status`, or `/developers` response in self-chat even though the running bot logged native-flow sends. Standard text replies are the reliable fallback for that destination.

**How to apply:** Preserve self-chat detection and the standard-message fallback when changing command routing or reply formatting. Self-chat message keys can identify the account with an `@lid` JID and a phone JID in `remoteJidAlt`.
