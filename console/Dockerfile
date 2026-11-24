FROM python:3.12-alpine

LABEL org.opencontainers.image.title="DeskHop Console" \
      org.opencontainers.image.description="Self-hosted remote support portaal en beheerconsole" \
      org.opencontainers.image.licenses="MIT"

ARG VERSION=dev
ENV APP_VERSION=$VERSION

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    WEB_DIR=/app/web \
    PORT=21114 \
    SERVER_KEY_FILE=/server-data/id_ed25519.pub

RUN addgroup -S deskhop && adduser -S -G deskhop -h /app deskhop \
 && mkdir -p /data && chown deskhop:deskhop /data

WORKDIR /app
COPY server/ /app/server/
COPY web/ /app/web/

USER deskhop
VOLUME ["/data"]
EXPOSE 21114

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python /app/server/healthcheck.py

CMD ["python", "/app/server/app.py"]
