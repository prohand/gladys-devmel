# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

FROM node:24-alpine

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
# libstdc++: the AirSend Web Service binary below links against it.
RUN apk add --no-cache dumb-init libstdc++

# -----------------------------------------------------------------------------
# The AirSend Web Service, bundled.
#
# It is the HTTP server that speaks the box's protocol on the LAN; Devmel ships
# it as a tarball of per-architecture binaries and its own Home Assistant add-on
# installs it exactly like this. Shipping it here is what lets the integration
# serve the local channel on 127.0.0.1:33863 with nothing to install next to
# Gladys (see src/devmel/service.js, which runs and supervises it).
#
# Only the binary for the image's architecture is kept. The build FAILS if the
# tarball does not carry it: better a red build than an image whose local
# channel silently cannot work.
# -----------------------------------------------------------------------------
ARG TARGETARCH
ARG AIRSEND_SERVICE_URL="http://devmel.com/dl/AirSendWebService.tgz"
RUN set -eux; \
    mkdir -p /opt/airsend; \
    wget -q -O /tmp/airsend.tgz "$AIRSEND_SERVICE_URL"; \
    tar -xzf /tmp/airsend.tgz -C /opt/airsend; \
    rm /tmp/airsend.tgz; \
    case "$TARGETARCH" in \
      amd64) keep="x86_64" ;; \
      arm64) keep="arm64" ;; \
      arm)   keep="arm armhf" ;; \
      386)   keep="x86" ;; \
      *)     keep="$TARGETARCH" ;; \
    esac; \
    found=""; \
    for arch in $keep; do \
      if [ -f "/opt/airsend/bin/unix/$arch/AirSendWebService" ]; then found="$found $arch"; fi; \
    done; \
    [ -n "$found" ] || { echo "No AirSendWebService binary for $TARGETARCH"; exit 1; }; \
    for dir in /opt/airsend/bin/unix/*; do \
      case " $found " in *" $(basename "$dir") "*) ;; *) rm -rf "$dir" ;; esac; \
    done; \
    chmod -R a+rX /opt/airsend; \
    find /opt/airsend/bin -type f -exec chmod a+rx {} +

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime. The AirSend Web Service runs
# with it as its working directory: it drops its pid file where it starts, and
# everything else is read-only.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
