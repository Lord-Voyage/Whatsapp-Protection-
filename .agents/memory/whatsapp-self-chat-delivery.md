---
name: WhatsApp private-chat delivery
description: Compatibility constraint for native-flow replies sent to WhatsApp direct messages.
---

Return standard text or image replies in all direct private chats, including the bot account's own “Message yourself” chat. Keep native-flow buttons enabled in groups.

**Why:** The user reports that commands and native buttons work in groups, while private and self chats only show the `/pair` response. A live screenshot showed no visible `/menu`, `/status`, or `/developers` response in self-chat even though the running bot logged native-flow sends.

**How to apply:** Preserve the standard-message fallback for DMs and ensure it includes command shortcuts and the channel URL. Do not disable group buttons. Self-chat message keys can identify the account with an `@lid` JID and a phone JID in `remoteJidAlt`.
