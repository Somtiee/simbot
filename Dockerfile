# ──────────────────────────────────────────────────────────────────────────────
# Simcluster Farmer – Railway Dockerfile
#
# Uses node:20-bookworm-slim as base and installs every Chromium system library
# explicitly via apt-get. This completely avoids the nixpacks aptPkgs issues
# that were causing "libglib-2.0.so.0: cannot open shared object file".
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS base

# Install all Chromium/Playwright system dependencies in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libasound2 \
    libgtk-3-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ──────────────────────────────────────────────────────────────────────────────
# Install Node dependencies
# ──────────────────────────────────────────────────────────────────────────────
COPY package.json package-lock.json* ./
RUN npm ci

# ──────────────────────────────────────────────────────────────────────────────
# Download Playwright browser binaries to a known path
# We do NOT use --with-deps here because system deps are already installed above.
# ──────────────────────────────────────────────────────────────────────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium chromium-headless-shell

# ──────────────────────────────────────────────────────────────────────────────
# Build Next.js
# ──────────────────────────────────────────────────────────────────────────────
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Runtime — same image so all libs + browsers are available
# ──────────────────────────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["npm", "start"]
