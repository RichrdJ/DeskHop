FROM python:3.12-alpine

LABEL org.opencontainers.image.title="DeskHop Console" \
      org.opencontainers.image.description="Self-hosted remote support portaal en beheerconsole" \
      org.opencontainers.image.licenses="MIT"

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
  CMD python -c "import os,ssl,urllib.request as u; s='https' if os.environ.get('TLS_CERT') else 'http'; u.urlopen(s+'://127.0.0.1:'+os.environ.get('PORT','21114')+'/api/health', timeout=4, context=ssl._create_unverified_context())" || exit 1

CMD ["python", "/app/server/app.py"]
