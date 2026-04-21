# OpenJimmy Public

macOS iMessage plugin built around local SQLite polling and AppleScript delivery.

Stack: Node.js, better-sqlite3, AppleScript, macOS system permissions  
I owned: local Messages integration, polling loop, dedupe behavior, setup flow, and plugin packaging  
Origin Lab relevance: local-system integration, permissions, process boundaries, reliability on end-user machines, and plugin-style ownership

## What It Does

- Reads incoming iMessage traffic directly from the local `chat.db`
- Normalizes senders, attachments, replies, and group-chat context
- Hands messages to an agent runtime
- Sends replies back out through Messages.app via AppleScript

No cloud relay is required. The whole flow runs on the Mac.

## Quickstart

```bash
git clone https://github.com/woodbeary/openjimmy-public.git
cd openjimmy-public
pnpm install
pnpm setup
```

The setup wizard checks:

1. macOS version
2. Full Disk Access for the Messages database
3. Local plugin configuration
4. Basic runtime connectivity

## Example Config

```yaml
channels:
  imessage-legacy:
    plugin: "/absolute/path/to/openjimmy-public"
    ownerNumbers:
      - "+19995551234"
    allowedNumbers:
      - "+19995555678"
    pollInterval: 2000
    debug: false
```

## How It Works

1. Poll the Messages SQLite store for new rows
2. Filter and normalize inbound events
3. Resolve reply context and attachment metadata
4. Dispatch to the runtime
5. Send the final text reply with AppleScript

## Why This Matters

This is the kind of pragmatic boundary work I like: taking a system the OS was not really designed as a plugin surface for, then making it reliable enough for real use with explicit permissions, local state, and failure handling.

## Requirements

- macOS 11+
- Node.js 18+
- `pnpm`
- Full Disk Access for the terminal app you use
- Automation permission for Terminal -> Messages

## Security / Public Mirror Notes

- This public mirror preserves the working plugin surface and setup flow
- It intentionally excludes private history and unrelated development context
