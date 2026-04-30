---
name: agent
description: "Skill for the Agent area of driago. 44 symbols across 10 files."
---

# Agent

44 symbols | 10 files | Cohesion: 65%

## When to Use

- Working with code in `src/`
- Understanding how handleWhatsAppMessage, triggerWebhooks, getApi work
- Modifying agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/agent/context-injector.js` | createDocumentContext, injectDocumentContext, getContextInfo, clearAllContexts, cleanupExpiredContexts (+4) |
| `src/agent/deepseek.js` | extractKeywords, getKnowledgeContext, getRecentKnowledge, getSystemPrompt, getConversationHistory (+4) |
| `src/agent/driago_deepseek.js` | getSystemPrompt, getKnowledgeContext, getConversationHistory, saveMessage, removeAsterisks (+2) |
| `src/agent/claude.js` | getSystemPrompt, getKnowledgeContext, getConversationHistory, saveMessage, processMessage |
| `src/agent/evolution.js` | getApi, normalizePhone, resolveLid, sendMessage |
| `src/agent/document-processor.js` | downloadFromWaha, extractTextFromPdf, optimizeText, processDocument |
| `src/agent/driago_webhooks.js` | handleDocumentMessage, handleWhatsAppMessage |
| `src/db/database.js` | getDb, initSchema |
| `src/routes/webhooks.js` | handleWhatsAppMessage |
| `src/routes/api.js` | triggerWebhooks |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `handleWhatsAppMessage` | Function | `src/routes/webhooks.js` | 24 |
| `triggerWebhooks` | Function | `src/routes/api.js` | 375 |
| `getApi` | Function | `src/agent/evolution.js` | 6 |
| `normalizePhone` | Function | `src/agent/evolution.js` | 14 |
| `resolveLid` | Function | `src/agent/evolution.js` | 22 |
| `sendMessage` | Function | `src/agent/evolution.js` | 40 |
| `handleDocumentMessage` | Function | `src/agent/driago_webhooks.js` | 25 |
| `handleWhatsAppMessage` | Function | `src/agent/driago_webhooks.js` | 107 |
| `createDocumentContext` | Function | `src/agent/context-injector.js` | 12 |
| `injectDocumentContext` | Function | `src/agent/context-injector.js` | 34 |
| `getDb` | Function | `src/db/database.js` | 8 |
| `initSchema` | Function | `src/db/database.js` | 17 |
| `extractKeywords` | Function | `src/agent/deepseek.js` | 13 |
| `getKnowledgeContext` | Function | `src/agent/deepseek.js` | 24 |
| `getRecentKnowledge` | Function | `src/agent/deepseek.js` | 67 |
| `getContextInfo` | Function | `src/agent/context-injector.js` | 138 |
| `clearAllContexts` | Function | `src/agent/context-injector.js` | 178 |
| `cleanupExpiredContexts` | Function | `src/agent/context-injector.js` | 187 |
| `getSystemPrompt` | Function | `src/agent/driago_deepseek.js` | 22 |
| `getKnowledgeContext` | Function | `src/agent/driago_deepseek.js` | 28 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ProcessMessage → InitSchema` | cross_community | 6 |
| `ProcessMessage → InitSchema` | cross_community | 6 |
| `HandleWhatsAppMessage → InitSchema` | cross_community | 5 |
| `ProcessMessage → InitSchema` | cross_community | 4 |
| `HandleWhatsAppMessage → NormalizePhone` | intra_community | 4 |
| `HandleWhatsAppMessage → GetApi` | intra_community | 4 |
| `HandleWhatsAppMessage → CreateDocumentContext` | intra_community | 4 |
| `ProcessMessage → ExtractKeywords` | cross_community | 3 |
| `HandleWhatsAppMessage → GetApi` | intra_community | 3 |
| `HandleWhatsAppMessage → NormalizePhone` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "handleWhatsAppMessage"})` — see callers and callees
2. `gitnexus_query({query: "agent"})` — find related execution flows
3. Read key files listed above for implementation details
