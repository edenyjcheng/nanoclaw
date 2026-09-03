# OAuth refresher sidecar. No dependencies beyond Node's built-in fetch —
# nothing to install, nothing to keep patched.
FROM node:22-slim

ENV NODE_ENV=production
ENV TZ=America/New_York

WORKDIR /app
COPY refresh.js ./

# Non-root: this process holds the refresh token, so it gets no more privilege
# than it needs. The state file is mounted at /state, owned by this uid.
USER node

CMD ["node", "refresh.js"]
