# Custom notion-mcp image: extends the upstream mcp/notion image and patches
# the bundled CLI so the `update-a-block` operation sends a Notion-valid PATCH
# body (the upstream serializes the block content under a top-level `type` key,
# which Notion rejects with "body.type should be not present").
#
# The base is pinned by digest because the patch keys off the bundle's minified
# structure; a digest bump should be paired with a re-verify of the patcher.
#
# Ref IPC: groups/telegram_main/ipc-claudecode/requests/20260605-1045-notion-mcp-update-block-fix.md
FROM mcp/notion@sha256:4de8eb0de33402fcbd3740b4f4039918e4893155c7ea833c7a0c472001b88367

COPY patch-notion-mcp.cjs /tmp/patch-notion-mcp.cjs
RUN node /tmp/patch-notion-mcp.cjs && rm /tmp/patch-notion-mcp.cjs
