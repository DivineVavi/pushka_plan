FROM node:22-bookworm-slim AS ui-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.mjs ./
COPY frontend/ ./frontend/
RUN npm run build

FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PUSHKA_DB=/var/lib/pushka/pushka.sqlite3 PORT=8000
WORKDIR /app
COPY pushka/ /app/pushka/
COPY certs/ /app/certs/
COPY --from=ui-build /app/static/ /app/static/
COPY data/catalog-snapshot.sqlite3 /app/data/catalog-snapshot.sqlite3
COPY requirements.txt /app/requirements.txt
COPY tests/ /app/tests/
# Build contexts unpacked with umask 077 must still be readable by the runtime user.
RUN chmod -R a+rX /app && useradd -r -u 10001 pushka && mkdir -p /var/lib/pushka && chown pushka:pushka /var/lib/pushka
USER pushka
EXPOSE 8000
CMD ["python", "-m", "pushka.server"]
